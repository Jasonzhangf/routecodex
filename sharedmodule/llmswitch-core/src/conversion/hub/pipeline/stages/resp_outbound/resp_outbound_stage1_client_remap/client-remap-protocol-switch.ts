import { buildAnthropicResponseFromChat } from '../../../../response/response-runtime.js';
import { type JsonObject } from '../../../../types/json.js';
import { normalizeArgsBySchema } from '../../../../../args-mapping.js';
import type { BridgeToolDefinition } from '../../../../../types/bridge-message-types.js';
import { normalizeResponsesToolCallIds } from '../../../../../shared/responses-tool-utils.js';
import { isShellToolName } from '../../../../../../tools/tool-description-utils.js';
import {
  applyClientPassthroughPatchWithNative,
  buildResponsesPayloadFromChatWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import {
  resolveAliasMapFromSemantics,
  resolveClientToolsRawFromSemantics
} from './chat-process-semantics-bridge.js';

export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ClientRemapProtocolSwitchOptions {
  payload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  requestSemantics?: JsonObject;
}

type IndexedClientTool = {
  declaredName: string;
  tool: BridgeToolDefinition;
};

type ClientToolIndex = {
  byExactLower: Map<string, IndexedClientTool>;
  byStrippedLower: Map<string, IndexedClientTool>;
  byFamily: Map<string, IndexedClientTool>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripFunctionNamespace(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('functions.')) {
    return trimmed.slice('functions.'.length).trim();
  }
  if (lowered.startsWith('function.')) {
    return trimmed.slice('function.'.length).trim();
  }
  return trimmed;
}

function resolveToolFamily(raw: string): string {
  const strippedLower = stripFunctionNamespace(raw).toLowerCase();
  if (!strippedLower) {
    return '';
  }
  if (isShellToolName(strippedLower) || strippedLower === 'terminal') {
    return 'shell_like';
  }
  if (strippedLower === 'apply_patch') {
    return 'apply_patch';
  }
  if (strippedLower === 'write_stdin') {
    return 'write_stdin';
  }
  return strippedLower;
}

function extractClientToolIndex(
  clientToolsRaw?: BridgeToolDefinition[]
): ClientToolIndex {
  const byExactLower = new Map<string, IndexedClientTool>();
  const byStrippedLower = new Map<string, IndexedClientTool>();
  const byFamily = new Map<string, IndexedClientTool>();
  for (const tool of clientToolsRaw ?? []) {
    const functionBag = asRecord(tool.function);
    const rawName =
      (typeof functionBag?.name === 'string' ? functionBag.name : undefined)
      ?? (typeof tool.name === 'string' ? tool.name : undefined);
    const normalizedName = typeof rawName === 'string' ? rawName.trim() : '';
    if (!normalizedName) {
      continue;
    }
    const entry: IndexedClientTool = {
      declaredName: normalizedName,
      tool
    };
    const exactLower = normalizedName.toLowerCase();
    const strippedLower = stripFunctionNamespace(normalizedName).toLowerCase();
    const family = resolveToolFamily(normalizedName);
    if (!byExactLower.has(exactLower)) {
      byExactLower.set(exactLower, entry);
    }
    if (strippedLower && !byStrippedLower.has(strippedLower)) {
      byStrippedLower.set(strippedLower, entry);
    }
    if (family && !byFamily.has(family)) {
      byFamily.set(family, entry);
    }
  }
  return { byExactLower, byStrippedLower, byFamily };
}

function resolveClientToolFromIndex(index: ClientToolIndex, rawName: string): IndexedClientTool | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  const exactLower = trimmed.toLowerCase();
  const strippedLower = stripFunctionNamespace(trimmed).toLowerCase();
  const family = resolveToolFamily(trimmed);
  return (
    index.byExactLower.get(exactLower)
    ?? index.byExactLower.get(strippedLower)
    ?? index.byStrippedLower.get(strippedLower)
    ?? (family ? index.byFamily.get(family) : undefined)
  );
}

function remapChatToolCallsToClientNames(
  payload: JsonObject,
  clientToolsRaw?: BridgeToolDefinition[]
): string[] {
  const toolIndex = extractClientToolIndex(clientToolsRaw);
  if (!toolIndex.byExactLower.size) {
    return [];
  }
  const unknownNames: string[] = [];
  const seenUnknown = new Set<string>();
  const pushUnknown = (name: string) => {
    const key = name.trim();
    if (!key || seenUnknown.has(key)) {
      return;
    }
    seenUnknown.add(key);
    unknownNames.push(key);
  };
  const readSchema = (entry: IndexedClientTool | undefined): unknown => {
    const functionBag = asRecord(entry?.tool.function);
    return functionBag?.parameters;
  };

  const choices = Array.isArray((payload as Record<string, unknown>).choices)
    ? ((payload as Record<string, unknown>).choices as unknown[])
    : [];
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message);
    const toolCalls = Array.isArray(message?.tool_calls) ? (message?.tool_calls as unknown[]) : [];
    for (const toolCall of toolCalls) {
      const functionBag = asRecord(asRecord(toolCall)?.function);
      const currentName = typeof functionBag?.name === 'string' ? functionBag.name.trim() : '';
      if (!currentName) {
        continue;
      }
      const matchedTool = resolveClientToolFromIndex(toolIndex, currentName);
      if (!matchedTool) {
        pushUnknown(currentName);
        continue;
      }
      functionBag!.name = matchedTool.declaredName;
      const schema = readSchema(matchedTool);
      const rawArgs = functionBag?.arguments;
      let parsedArgs: unknown = rawArgs;
      if (typeof rawArgs === 'string') {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          parsedArgs = rawArgs;
        }
      }
      const normalized = normalizeArgsBySchema(parsedArgs, schema as any);
      if (normalized.ok && normalized.value) {
        try {
          functionBag!.arguments = JSON.stringify(normalized.value);
        } catch {
          // keep existing args when client-arg serialization fails
        }
      }
    }
  }
  return unknownNames;
}

function remapResponsesToolCallsToClientNames(
  payload: JsonObject,
  clientToolsRaw?: BridgeToolDefinition[]
): string[] {
  const toolIndex = extractClientToolIndex(clientToolsRaw);
  if (!toolIndex.byExactLower.size) {
    return [];
  }
  const unknownNames: string[] = [];
  const seenUnknown = new Set<string>();
  const pushUnknown = (name: string) => {
    const key = name.trim();
    if (!key || seenUnknown.has(key)) {
      return;
    }
    seenUnknown.add(key);
    unknownNames.push(key);
  };

  const requiredActionCalls = Array.isArray((payload as any)?.required_action?.submit_tool_outputs?.tool_calls)
    ? ((payload as any).required_action.submit_tool_outputs.tool_calls as unknown[])
    : [];
  for (const call of requiredActionCalls) {
    const callBag = asRecord(call);
    if (!callBag) {
      continue;
    }
    const rawName = typeof callBag.name === 'string' ? callBag.name.trim() : '';
    if (!rawName) {
      continue;
    }
    const matched = resolveClientToolFromIndex(toolIndex, rawName);
    if (!matched) {
      pushUnknown(rawName);
      continue;
    }
    callBag.name = matched.declaredName;
  }

  const outputItems = Array.isArray((payload as any)?.output) ? ((payload as any).output as unknown[]) : [];
  for (const item of outputItems) {
    const itemBag = asRecord(item);
    if (!itemBag) {
      continue;
    }
    const type = typeof itemBag.type === 'string' ? itemBag.type.trim().toLowerCase() : '';
    if (type !== 'function_call') {
      continue;
    }
    const rawName = typeof itemBag.name === 'string' ? itemBag.name.trim() : '';
    if (!rawName) {
      continue;
    }
    const matched = resolveClientToolFromIndex(toolIndex, rawName);
    if (!matched) {
      pushUnknown(rawName);
      continue;
    }
    itemBag.name = matched.declaredName;
  }

  return unknownNames;
}

function assertNoUnknownToolNames(args: {
  requestId: string;
  clientProtocol: ClientProtocol;
  unknownNames: string[];
  clientToolsRaw?: BridgeToolDefinition[];
}): void {
  const uniqueUnknown = Array.from(new Set(args.unknownNames.map((name) => name.trim()).filter(Boolean)));
  if (!uniqueUnknown.length) {
    return;
  }
  const declaredNames = (args.clientToolsRaw ?? [])
    .map((tool) => {
      const fn = asRecord(tool.function);
      const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
      if (fnName) {
        return fnName;
      }
      const topName = typeof tool.name === 'string' ? tool.name.trim() : '';
      return topName || '';
    })
    .filter(Boolean);
  const declaredPreview = declaredNames.slice(0, 20).join(', ');
  throw new Error(
    `[client-remap] tool name mismatch after remap: unknown=[${uniqueUnknown.join(', ')}]` +
    ` protocol=${args.clientProtocol} requestId=${args.requestId}` +
    (declaredPreview ? ` declared=[${declaredPreview}]` : ' declared=[none]')
  );
}

function enforceClientToolNameContract(
  options: ClientRemapProtocolSwitchOptions,
  payload: JsonObject,
  toolsRaw?: BridgeToolDefinition[]
): void {
  const hasClientTools = Array.isArray(toolsRaw) && toolsRaw.length > 0;
  if (!hasClientTools) {
    return;
  }

  const unknownFromChat = remapChatToolCallsToClientNames(payload, toolsRaw);
  const unknownFromResponses = remapResponsesToolCallsToClientNames(payload, toolsRaw);
  assertNoUnknownToolNames({
    requestId: options.requestId,
    clientProtocol: options.clientProtocol,
    unknownNames: [...unknownFromChat, ...unknownFromResponses],
    clientToolsRaw: toolsRaw
  });
}

export function buildClientPayloadForProtocol(options: ClientRemapProtocolSwitchOptions): JsonObject {
  let clientPayload: JsonObject;
  const toolsRaw = resolveClientToolsRawFromSemantics(options.requestSemantics) as BridgeToolDefinition[] | undefined;
  if (options.clientProtocol === 'openai-chat') {
    clientPayload = options.payload;
  } else if (options.clientProtocol === 'anthropic-messages') {
    clientPayload = buildAnthropicResponseFromChat(options.payload, {
      aliasMap: resolveAliasMapFromSemantics(options.requestSemantics)
    });
  } else {
    clientPayload = buildResponsesPayloadFromChatWithNative(options.payload, {
      requestId: options.requestId,
      ...(toolsRaw ? { toolsRaw } : {})
    }) as JsonObject;
  }

  const patchedPayload = applyClientPassthroughPatchWithNative(
    clientPayload,
    options.payload
  ) as JsonObject;
  Object.assign(clientPayload as Record<string, unknown>, patchedPayload as Record<string, unknown>);
  if (options.clientProtocol === 'openai-responses') {
    normalizeResponsesToolCallIds(clientPayload as Record<string, unknown>);
  }
  enforceClientToolNameContract(options, clientPayload, toolsRaw);
  return clientPayload;
}

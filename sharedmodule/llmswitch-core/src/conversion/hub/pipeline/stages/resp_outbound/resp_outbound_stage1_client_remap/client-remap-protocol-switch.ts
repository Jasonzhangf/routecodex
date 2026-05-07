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
import { normalizeOpenaiChatReasoningOutboundWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
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
  responseSemantics?: JsonObject;
}

function shouldLogClientRemapDebug(payload: JsonObject): boolean {
  const governance =
    payload?.__rcc_tool_governance &&
    typeof payload.__rcc_tool_governance === 'object' &&
    !Array.isArray(payload.__rcc_tool_governance)
      ? (payload.__rcc_tool_governance as Record<string, unknown>)
      : undefined;
  return governance?.textHarvestApplied === true;
}

type IndexedClientTool = {
  declaredName: string;
  namespace?: string;
  tool: BridgeToolDefinition;
};

type ClientToolIndex = {
  byExactLower: Map<string, IndexedClientTool>;
  byStrippedLower: Map<string, IndexedClientTool>;
  byCanonicalLower: Map<string, IndexedClientTool>;
  byCompactLower: Map<string, IndexedClientTool>;
  byFamily: Map<string, IndexedClientTool>;
  byNamespaceName: Map<string, IndexedClientTool>;
};

function readSchema(entry: IndexedClientTool | undefined): unknown {
  const functionBag = asRecord(entry?.tool.function);
  return functionBag?.parameters ?? (entry?.tool as any)?.parameters;
}

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

function namespaceJoiner(namespace: string): string {
  return /(__|[_.\/-])$/.test(namespace.trim()) ? '' : '__';
}

function buildNamespaceAlias(namespace: string, rawName: string): string {
  const ns = namespace.trim();
  const name = rawName.trim();
  if (!ns || !name) {
    return '';
  }
  return `${ns}${namespaceJoiner(ns)}${name}`;
}

function buildNamespaceLookupKey(namespace: string, rawName: string): string {
  const ns = namespace.trim().toLowerCase();
  const name = rawName.trim().toLowerCase();
  return ns && name ? `${ns}::${name}` : '';
}

function toCanonicalToolName(raw: string): string {
  const stripped = stripFunctionNamespace(raw).toLowerCase().trim();
  if (!stripped) {
    return '';
  }
  return stripped
    .replace(/[\s_-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function toCompactToolName(raw: string): string {
  const canonical = toCanonicalToolName(raw);
  if (!canonical) {
    return '';
  }
  return canonical.replace(/[._-]/g, '');
}

function resolveToolFamily(raw: string): string {
  const canonicalLower = toCanonicalToolName(raw);
  if (!canonicalLower) {
    return '';
  }
  const shellCandidate = canonicalLower.replace(/\./g, '_');
  if (isShellToolName(canonicalLower) || isShellToolName(shellCandidate) || canonicalLower === 'terminal') {
    return 'shell_like';
  }
  if (canonicalLower === 'apply.patch' || canonicalLower === 'apply_patch') {
    return 'apply_patch';
  }
  if (canonicalLower === 'write.stdin' || canonicalLower === 'write_stdin') {
    return 'write_stdin';
  }
  return canonicalLower;
}

function extractClientToolIndex(
  clientToolsRaw?: BridgeToolDefinition[]
): ClientToolIndex {
  const byExactLower = new Map<string, IndexedClientTool>();
  const byStrippedLower = new Map<string, IndexedClientTool>();
  const byCanonicalLower = new Map<string, IndexedClientTool>();
  const byCompactLower = new Map<string, IndexedClientTool>();
  const byFamily = new Map<string, IndexedClientTool>();
  const byNamespaceName = new Map<string, IndexedClientTool>();
  const register = (entry: IndexedClientTool, rawName: string) => {
    const normalizedName = typeof rawName === 'string' ? rawName.trim() : '';
    if (!normalizedName) {
      return;
    }
    const exactLower = normalizedName.toLowerCase();
    const strippedLower = stripFunctionNamespace(normalizedName).toLowerCase();
    const canonicalLower = toCanonicalToolName(normalizedName);
    const compactLower = toCompactToolName(normalizedName);
    const family = resolveToolFamily(normalizedName);
    if (!byExactLower.has(exactLower)) {
      byExactLower.set(exactLower, entry);
    }
    if (strippedLower && !byStrippedLower.has(strippedLower)) {
      byStrippedLower.set(strippedLower, entry);
    }
    if (canonicalLower && !byCanonicalLower.has(canonicalLower)) {
      byCanonicalLower.set(canonicalLower, entry);
    }
    if (compactLower && !byCompactLower.has(compactLower)) {
      byCompactLower.set(compactLower, entry);
    }
    if (family && !byFamily.has(family)) {
      byFamily.set(family, entry);
    }
  };
  for (const tool of clientToolsRaw ?? []) {
    const toolType = typeof (tool as any)?.type === 'string' ? String((tool as any).type).trim().toLowerCase() : 'function';
    if (toolType === 'namespace') {
      const namespace = typeof (tool as any)?.name === 'string' ? String((tool as any).name).trim() : '';
      const childTools = Array.isArray((tool as any)?.tools) ? ((tool as any).tools as Array<Record<string, unknown>>) : [];
      for (const child of childTools) {
        const childFunction = asRecord((child as any).function);
        const rawChildName =
          (typeof childFunction?.name === 'string' ? childFunction.name : undefined)
          ?? (typeof (child as any)?.name === 'string' ? String((child as any).name) : undefined);
        const childName = typeof rawChildName === 'string' ? rawChildName.trim() : '';
        if (!namespace || !childName) {
          continue;
        }
        const entry: IndexedClientTool = {
          declaredName: childName,
          namespace,
          tool: child as unknown as BridgeToolDefinition
        };
        const namespaceKey = buildNamespaceLookupKey(namespace, childName);
        if (namespaceKey && !byNamespaceName.has(namespaceKey)) {
          byNamespaceName.set(namespaceKey, entry);
        }
        register(entry, childName);
        const alias = buildNamespaceAlias(namespace, childName);
        if (alias) {
          register(entry, alias);
        }
      }
      continue;
    }
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
    register(entry, normalizedName);
  }
  return { byExactLower, byStrippedLower, byCanonicalLower, byCompactLower, byFamily, byNamespaceName };
}

function resolveClientToolFromIndex(index: ClientToolIndex, rawName: string, namespace?: string): IndexedClientTool | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  const namespaceKey = namespace ? buildNamespaceLookupKey(namespace, trimmed) : '';
  if (namespaceKey && index.byNamespaceName.has(namespaceKey)) {
    return index.byNamespaceName.get(namespaceKey);
  }
  const exactLower = trimmed.toLowerCase();
  const strippedLower = stripFunctionNamespace(trimmed).toLowerCase();
  const canonicalLower = toCanonicalToolName(trimmed);
  const compactLower = toCompactToolName(trimmed);
  const family = resolveToolFamily(trimmed);
  return (
    index.byExactLower.get(exactLower)
    ?? index.byExactLower.get(strippedLower)
    ?? index.byStrippedLower.get(strippedLower)
    ?? (canonicalLower ? index.byCanonicalLower.get(canonicalLower) : undefined)
    ?? (canonicalLower ? index.byStrippedLower.get(canonicalLower) : undefined)
    ?? (compactLower ? index.byCompactLower.get(compactLower) : undefined)
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
      const namespace = typeof (toolCall as any)?.namespace === 'string' ? String((toolCall as any).namespace) : undefined;
      const matchedTool = resolveClientToolFromIndex(toolIndex, currentName, namespace);
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
  const normalizeCallArgumentsByDeclaredSchema = (
    callBag: Record<string, unknown>,
    matched: IndexedClientTool
  ) => {
    const schema = readSchema(matched);
    const rawArgs = callBag.arguments ?? callBag.input;
    let parsedArgs: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        parsedArgs = rawArgs;
      }
    }
    const normalized = normalizeArgsBySchema(parsedArgs, schema as any);
    if (!(normalized.ok && normalized.value)) {
      return;
    }
    try {
      const serialized = JSON.stringify(normalized.value);
      callBag.arguments = serialized;
      const functionBag = asRecord(callBag.function);
      if (functionBag) {
        functionBag.arguments = serialized;
      }
      if ('input' in callBag) {
        callBag.input = normalized.value as Record<string, unknown>;
      }
    } catch {
      // keep existing args when client-arg serialization fails
    }
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
    const namespace = typeof callBag.namespace === 'string' ? callBag.namespace : undefined;
    const matched = resolveClientToolFromIndex(toolIndex, rawName, namespace);
    if (!matched) {
      pushUnknown(rawName);
      continue;
    }
    callBag.name = matched.declaredName;
    if (matched.namespace) {
      callBag.namespace = matched.namespace;
    }
    const functionBag = asRecord(callBag.function);
    if (functionBag) {
      functionBag.name = matched.declaredName;
    }
    normalizeCallArgumentsByDeclaredSchema(callBag, matched);
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
    const namespace = typeof itemBag.namespace === 'string' ? itemBag.namespace : undefined;
    const matched = resolveClientToolFromIndex(toolIndex, rawName, namespace);
    if (!matched) {
      pushUnknown(rawName);
      continue;
    }
    itemBag.name = matched.declaredName;
    if (matched.namespace) {
      itemBag.namespace = matched.namespace;
    }
    const functionBag = asRecord(itemBag.function);
    if (functionBag) {
      functionBag.name = matched.declaredName;
    }
    normalizeCallArgumentsByDeclaredSchema(itemBag, matched);
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
  const error = new Error(
    `[client-remap] tool name mismatch after remap: unknown=[${uniqueUnknown.join(', ')}]` +
      ` protocol=${args.clientProtocol} requestId=${args.requestId}` +
      (declaredPreview ? ` declared=[${declaredPreview}]` : ' declared=[none]')
  ) as Error & {
    code?: string;
    statusCode?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  error.code = 'CLIENT_TOOL_NAME_MISMATCH';
  error.statusCode = 502;
  error.retryable = true;
  error.details = {
    unknownToolNames: uniqueUnknown,
    declaredToolNames: declaredNames,
    protocol: args.clientProtocol,
    requestId: args.requestId
  };
  throw error;
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
  const shouldLogDebug = shouldLogClientRemapDebug(options.payload);
  if (options.clientProtocol === 'openai-chat') {
    clientPayload = normalizeOpenaiChatReasoningOutboundWithNative(options.payload) as JsonObject;
  } else if (options.clientProtocol === 'anthropic-messages') {
    clientPayload = buildAnthropicResponseFromChat(options.payload, {
      aliasMap: resolveAliasMapFromSemantics(options.requestSemantics)
    });
  } else {
    if (shouldLogDebug) {
      console.log('[CLIENT-REMAP:DEBUG] input payload choices[0].finish_reason:', (options.payload as any)?.choices?.[0]?.finish_reason);
      console.log('[CLIENT-REMAP:DEBUG] input payload choices[0].message.tool_calls count:', (options.payload as any)?.choices?.[0]?.message?.tool_calls?.length);
    }
    clientPayload = buildResponsesPayloadFromChatWithNative(options.payload, {
      requestId: options.requestId,
      responseSemantics: options.responseSemantics,
      ...(toolsRaw ? { toolsRaw } : {})
    }) as JsonObject;
  }

  if (shouldLogDebug) {
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload status:', (clientPayload as any)?.status);
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload output count:', (clientPayload as any)?.output?.length);
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload output types:', (clientPayload as any)?.output?.map((o: any) => o.type));
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload required_action:', JSON.stringify((clientPayload as any)?.required_action)?.slice(0, 200));
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

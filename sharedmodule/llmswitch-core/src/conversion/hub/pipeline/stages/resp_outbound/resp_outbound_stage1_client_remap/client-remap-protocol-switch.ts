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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractClientToolNameMap(
  clientToolsRaw?: BridgeToolDefinition[]
): Map<string, BridgeToolDefinition> {
  const map = new Map<string, BridgeToolDefinition>();
  for (const tool of clientToolsRaw ?? []) {
    const functionBag = asRecord(tool.function);
    const rawName =
      (typeof functionBag?.name === 'string' ? functionBag.name : undefined)
      ?? (typeof tool.name === 'string' ? tool.name : undefined);
    const normalizedName = typeof rawName === 'string' ? rawName.trim() : '';
    if (!normalizedName) {
      continue;
    }
    map.set(normalizedName.toLowerCase(), tool);
  }
  return map;
}

function remapChatToolCallsToClientNames(
  payload: JsonObject,
  clientToolsRaw?: BridgeToolDefinition[]
): void {
  const toolMap = extractClientToolNameMap(clientToolsRaw);
  if (!toolMap.size) {
    return;
  }
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
      const normalizedCurrentName = currentName.toLowerCase();
      const matchedTool = toolMap.get(normalizedCurrentName)
        ?? (isShellToolName(normalizedCurrentName)
          ? Array.from(toolMap.entries()).find(([toolName]) => isShellToolName(toolName))?.[1]
          : undefined);
      if (!matchedTool) {
        continue;
      }
      const matchedFunction = asRecord(matchedTool.function);
      const clientName =
        (typeof matchedFunction?.name === 'string' ? matchedFunction.name : undefined)
        ?? (typeof matchedTool.name === 'string' ? matchedTool.name : undefined)
        ?? currentName;
      functionBag!.name = clientName;
      const schema = matchedFunction?.parameters;
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
}

export function buildClientPayloadForProtocol(options: ClientRemapProtocolSwitchOptions): JsonObject {
  let clientPayload: JsonObject;
  const toolsRaw = resolveClientToolsRawFromSemantics(options.requestSemantics) as BridgeToolDefinition[] | undefined;
  if (options.clientProtocol === 'openai-chat') {
    clientPayload = options.payload;
    remapChatToolCallsToClientNames(clientPayload, toolsRaw);
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
  return clientPayload;
}

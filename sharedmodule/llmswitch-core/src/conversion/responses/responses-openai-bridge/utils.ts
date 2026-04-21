import type { BridgeInputItem } from '../../types/bridge-message-types.js';
import { sanitizeResponsesFunctionName } from '../../shared/responses-tool-utils.js';
import { isJsonObject, jsonClone } from '../../hub/types/json.js';
import type { JsonObject, JsonValue } from '../../hub/types/json.js';
import type { ResponsesRequestContext } from './types.js';

export const RESPONSES_TOOL_PASSTHROUGH_KEYS = [
  'temperature',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'user',
  'top_p',
  'prompt_cache_key',
  'reasoning',
  'logit_bias',
  'seed'
] as const;

export const RESPONSES_REQUEST_PARAMETER_KEYS = [
  'model',
  'temperature',
  'top_p',
  'top_k',
  'prompt_cache_key',
  'reasoning',
  'max_tokens',
  'max_output_tokens',
  'response_format',
  'tool_choice',
  'parallel_tool_calls',
  'service_tier',
  'truncation',
  'include',
  'store',
  'text',
  'user',
  'logit_bias',
  'seed',
  'stop',
  'stop_sequences',
  'modalities'
] as const;

export function pickObjectFields(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      picked[key] = value[key];
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}

export function collectResponsesRequestParameters(
  payload: Record<string, unknown> | undefined,
  options?: {
    streamHint?: boolean | undefined;
  }
): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  let params = pickObjectFields(payload, RESPONSES_REQUEST_PARAMETER_KEYS);
  if (options?.streamHint !== undefined) {
    (params ??= {}).stream = options.streamHint;
  }
  return params && Object.keys(params).length ? params : undefined;
}

export function buildSlimResponsesBridgeContext(
  context: ResponsesRequestContext | undefined
): Record<string, unknown> | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }
  const slim: Record<string, unknown> = {};
  if (Array.isArray(context.input) && context.input.length) {
    slim.input = context.input;
  }
  if (Array.isArray(context.originalSystemMessages) && context.originalSystemMessages.length) {
    slim.originalSystemMessages = context.originalSystemMessages;
  }
  if (typeof context.systemInstruction === 'string' && context.systemInstruction.trim().length) {
    slim.systemInstruction = context.systemInstruction;
  }
  if (typeof context.toolCallIdStyle === 'string' && context.toolCallIdStyle.trim().length) {
    slim.toolCallIdStyle = context.toolCallIdStyle;
  }
  if (context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)) {
    slim.metadata = context.metadata as Record<string, unknown>;
  }
  return Object.keys(slim).length ? slim : undefined;
}

export function buildSlimBridgeDecisionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return pickObjectFields(metadata, ['toolCallIdStyle', 'bridgeHistory']);
}

export function sanitizeCapturedResponsesInput(
  input: BridgeInputItem[] | undefined
): BridgeInputItem[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return input;
  }
  const acceptedCallIds = new Set<string>();
  let sawFunctionCalls = false;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const type = typeof (entry as any).type === 'string' ? String((entry as any).type).trim().toLowerCase() : '';
    if (type !== 'function_call') {
      continue;
    }
    sawFunctionCalls = true;
    const sanitizedName = sanitizeResponsesFunctionName((entry as any).name);
    if (!sanitizedName) {
      continue;
    }
    const callId = typeof (entry as any).call_id === 'string' ? String((entry as any).call_id).trim() : '';
    if (callId) {
      acceptedCallIds.add(callId);
    }
  }
  const out: BridgeInputItem[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const type = typeof (entry as any).type === 'string' ? String((entry as any).type).trim().toLowerCase() : '';
    if (type === 'function_call') {
      const sanitizedName = sanitizeResponsesFunctionName((entry as any).name);
      if (!sanitizedName) {
        continue;
      }
      const rawName = typeof (entry as any).name === 'string' ? String((entry as any).name) : '';
      const next =
        rawName === sanitizedName
          ? entry
          : ({ ...(entry as Record<string, unknown>), name: sanitizedName } as BridgeInputItem);
      out.push(next);
      continue;
    }
    if (type === 'function_call_output') {
      const callId = typeof (entry as any).call_id === 'string' ? String((entry as any).call_id).trim() : '';
      if (!callId || (sawFunctionCalls && !acceptedCallIds.has(callId))) {
        continue;
      }
    }
    out.push(entry);
  }
  return out;
}

export function extractMetadataExtraFields(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const extras = (metadata as Record<string, unknown>).extraFields;
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
    return extras as Record<string, unknown>;
  }
  return undefined;
}

export function stripToolControlFieldsFromContextMetadata(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  if (!metadata) {
    return undefined;
  }
  const cloned = jsonClone(metadata) as JsonObject;
  const extras = cloned.extraFields;
  if (!extras || !isPlainObject(extras)) {
    return cloned;
  }
  delete (extras as Record<string, unknown>).tool_choice;
  delete (extras as Record<string, unknown>).parallel_tool_calls;
  if (Object.keys(extras as Record<string, unknown>).length === 0) {
    delete cloned.extraFields;
  }
  return cloned;
}

export function stripToolControlFieldsFromParameterObject(
  value: JsonObject | undefined
): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  const cloned = jsonClone(value) as JsonObject;
  delete cloned.tool_choice;
  delete cloned.parallel_tool_calls;
  return Object.keys(cloned).length ? cloned : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  let current: any = value;
  const seen = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
    seen.add(current);
    if ('choices' in current || 'message' in current) break;
    if ('data' in current && typeof (current as any).data === 'object') {
      current = (current as any).data;
      continue;
    }
    break;
  }
  return current as Record<string, unknown>;
}

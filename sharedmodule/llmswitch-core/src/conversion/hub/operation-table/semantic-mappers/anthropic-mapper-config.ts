import { type JsonObject, type JsonValue } from '../../types/json.js';

export interface AnthropicPayload extends JsonObject {
  model?: string;
  messages?: JsonValue;
  tools?: JsonValue;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  metadata?: JsonObject;
  stream?: boolean;
  tool_choice?: JsonValue;
  thinking?: JsonValue;
  output_config?: JsonValue;
  system?: JsonValue;
}

export const ANTHROPIC_PARAMETER_KEYS: readonly (keyof AnthropicPayload | 'stop')[] = [
  'model',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking',
  'output_config'
];

export const ANTHROPIC_TOP_LEVEL_FIELDS = new Set<string>([
  'model',
  'messages',
  'tools',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking',
  'output_config'
]);

export const PASSTHROUGH_METADATA_PREFIX = 'rcc_passthrough_';
export const PASSTHROUGH_PARAMETERS: readonly string[] = ['tool_choice'];
export const RESPONSES_DROPPED_PARAMETER_KEYS: readonly string[] = [
  'prompt_cache_key',
  'parallel_tool_calls',
  'service_tier',
  'truncation',
  'include',
  'store'
];

export function sanitizeAnthropicPayload(payload: JsonObject): JsonObject {
  for (const key of Object.keys(payload)) {
    if (!ANTHROPIC_TOP_LEVEL_FIELDS.has(key)) {
      delete payload[key];
    }
  }
  return payload;
}

export function collectAnthropicParameters(payload: AnthropicPayload): JsonObject | undefined {
  const params: JsonObject = {};
  for (const key of ANTHROPIC_PARAMETER_KEYS) {
    if (payload[key as keyof AnthropicPayload] !== undefined) {
      params[key] = payload[key as keyof AnthropicPayload] as JsonValue;
    }
  }
  if (Array.isArray(payload.stop_sequences)) {
    params.stop = payload.stop_sequences;
  }
  return Object.keys(params).length ? params : undefined;
}

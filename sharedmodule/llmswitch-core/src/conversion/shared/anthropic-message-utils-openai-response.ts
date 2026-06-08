import { buildAnthropicFromOpenAIChatWithNative } from '../../native/router-hotpath/native-compat-action-semantics.js';

type Unknown = Record<string, unknown>;

export interface BuildAnthropicFromOpenAIOptions {
  toolNameMap?: Record<string, string>;
  requestId?: string;
}

export function buildAnthropicFromOpenAIChat(oa: unknown, options?: BuildAnthropicFromOpenAIOptions): Unknown {
  return buildAnthropicFromOpenAIChatWithNative(
    (oa ?? {}) as Unknown,
    options as Unknown | undefined,
  ) as Unknown;
}

export function coerceAnthropicAliasRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

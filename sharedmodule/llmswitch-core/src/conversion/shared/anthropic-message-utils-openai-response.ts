import { buildAnthropicFromOpenAIChatWithNative } from '../../native/router-hotpath/native-compat-action-semantics.js';

type Unknown = Record<string, unknown>;

interface BuildAnthropicFromOpenAIOptions {
  toolNameMap?: Record<string, string>;
  requestId?: string;
}

export function buildAnthropicFromOpenAIChat(oa: unknown, options?: BuildAnthropicFromOpenAIOptions): Unknown {
  return buildAnthropicFromOpenAIChatWithNative(
    (oa ?? {}) as Unknown,
    options as Unknown | undefined,
  ) as Unknown;
}

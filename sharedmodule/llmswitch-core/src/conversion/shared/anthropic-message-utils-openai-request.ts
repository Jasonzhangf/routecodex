import { buildAnthropicFromOpenAIChatWithNative } from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

type Unknown = Record<string, unknown>;

export function buildAnthropicRequestFromOpenAIChat(
  chatReq: unknown,
  options?: { requestId?: string },
): Unknown {
  return buildAnthropicFromOpenAIChatWithNative(
    (chatReq ?? {}) as Unknown,
    options as Unknown | undefined,
  ) as Unknown;
}

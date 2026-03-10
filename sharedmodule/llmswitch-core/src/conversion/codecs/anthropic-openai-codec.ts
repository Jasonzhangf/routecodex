import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import { buildAnthropicRequestFromOpenAIChat } from '../shared/anthropic-message-utils.js';
import {
  buildAnthropicFromOpenAIChatWithNative,
  buildOpenAIChatFromAnthropicWithNative
} from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export function buildOpenAIChatFromAnthropic(
  payload: unknown,
  options?: { includeToolCallIds?: boolean }
): { messages: unknown[] } & Record<string, unknown> {
  const result = buildOpenAIChatFromAnthropicWithNative(
    (payload ?? {}) as Record<string, unknown>,
    options as Record<string, unknown> | undefined
  );
  return ((result.request as Record<string, unknown> | undefined) ?? {}) as {
    messages: unknown[];
  } & Record<string, unknown>;
}

export function buildAnthropicFromOpenAIChat(
  payload: unknown,
  options?: { toolNameMap?: Record<string, string>; requestId?: string; entryEndpoint?: string }
): Record<string, unknown> {
  return buildAnthropicFromOpenAIChatWithNative(
    (payload ?? {}) as Record<string, unknown>,
    options as Record<string, unknown> | undefined
  );
}

export { buildAnthropicRequestFromOpenAIChat };

export class AnthropicOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'anthropic-openai';
  private initialized = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _dependencies: any) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async convertRequest(payload: any, _profile: ConversionProfile, context: ConversionContext): Promise<any> {
    if (!this.initialized) await this.initialize();

    const native = buildOpenAIChatFromAnthropicWithNative(payload ?? {}, {
      includeToolCallIds: true
    });
    const request =
      native.request && typeof native.request === 'object'
        ? { ...(native.request as Record<string, unknown>) }
        : {};
    const aliasMap =
      native.anthropicToolNameMap && typeof native.anthropicToolNameMap === 'object'
        ? (native.anthropicToolNameMap as Record<string, unknown>)
        : undefined;

    if (aliasMap && Object.keys(aliasMap).length > 0) {
      context.metadata = context.metadata ?? {};
      (context.metadata as Record<string, unknown>).anthropicToolNameMap = aliasMap;
    }

    return request;
  }

  async convertResponse(payload: any, _profile: ConversionProfile, context: ConversionContext): Promise<any> {
    if (!this.initialized) await this.initialize();

    const aliasMap =
      context.metadata && typeof context.metadata === 'object'
        ? ((context.metadata as Record<string, unknown>).anthropicToolNameMap as Record<string, string> | undefined)
        : undefined;

    return buildAnthropicFromOpenAIChatWithNative((payload ?? {}) as Record<string, unknown>, {
      toolNameMap: aliasMap,
      requestId: context.requestId,
      entryEndpoint: context.entryEndpoint ?? context.endpoint
    });
  }
}

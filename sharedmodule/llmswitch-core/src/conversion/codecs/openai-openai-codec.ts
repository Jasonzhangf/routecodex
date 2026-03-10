import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import {
  runOpenAIRequestCodecWithNative,
  runOpenAIResponseCodecWithNative
} from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export class OpenAIOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'openai-openai';
  private initialized = false;
  private ctxMap: Map<string, { stream?: boolean; entryEndpoint?: string }> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: any) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async convertRequest(payload: any, _profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();

    const requestId = context.requestId ?? `req_${Date.now()}`;
    try {
      const wantsStream = !!(
        (payload && typeof payload === 'object' && (payload as any).stream === true) ||
        context?.stream === true ||
        (context?.metadata && (context.metadata as any).stream === true)
      );
      const entryEndpoint = String(context.entryEndpoint || context.endpoint || '');
      this.ctxMap.set(requestId, { stream: wantsStream, entryEndpoint });
    } catch {
      // ignore context capture failures
    }

    return runOpenAIRequestCodecWithNative((payload ?? {}) as Record<string, unknown>, {
      preserveStreamField: true,
      requestId,
      entryEndpoint: context.entryEndpoint ?? context.endpoint,
      endpoint: context.endpoint,
      stream: context.stream,
      metadata: context.metadata ?? {}
    });
  }

  async convertResponse(payload: any, _profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const ctx = context.requestId ? this.ctxMap.get(context.requestId) : undefined;
    if (context.requestId) {
      this.ctxMap.delete(context.requestId);
    }

    return runOpenAIResponseCodecWithNative((payload ?? {}) as Record<string, unknown>, {
      stream: ctx?.stream === true,
      endpoint: context.entryEndpoint || context.endpoint || ctx?.entryEndpoint,
      requestId: context.requestId,
      reasoningMode: (context.metadata as Record<string, unknown> | undefined)?.reasoningMode,
      idPrefixBase: 'reasoning_choice'
    });
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

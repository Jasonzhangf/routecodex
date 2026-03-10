import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import {
  runResponsesOpenAIRequestCodecWithNative,
  runResponsesOpenAIResponseCodecWithNative
} from '../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export class ResponsesOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'responses-openai';
  private initialized = false;
  private ctxMap: Map<string, Record<string, unknown>> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: any) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async convertRequest(
    payload: any,
    _profile: ConversionProfile,
    context: ConversionContext
  ): Promise<any> {
    await this.ensureInit();

    const requestId = context.requestId ?? `req_${Date.now()}`;
    const native = runResponsesOpenAIRequestCodecWithNative(
      (payload ?? {}) as Record<string, unknown>,
      { requestId }
    );

    const request =
      native.request && typeof native.request === 'object' && !Array.isArray(native.request)
        ? (native.request as Record<string, unknown>)
        : {};
    const capturedContext =
      native.context && typeof native.context === 'object' && !Array.isArray(native.context)
        ? ({
            ...(native.context as Record<string, unknown>),
            requestId,
            endpoint: context.endpoint ?? context.entryEndpoint,
            entryEndpoint: context.entryEndpoint,
            targetProtocol: _profile.outgoingProtocol,
            metadata:
              native.context &&
              typeof (native.context as Record<string, unknown>).metadata === 'object' &&
              !Array.isArray((native.context as Record<string, unknown>).metadata)
                ? ((native.context as Record<string, unknown>).metadata as Record<string, unknown>)
                : (context.metadata ?? {})
          } as Record<string, unknown>)
        : {
            requestId,
            endpoint: context.endpoint ?? context.entryEndpoint,
            entryEndpoint: context.entryEndpoint,
            targetProtocol: _profile.outgoingProtocol,
            metadata: context.metadata ?? {}
          };

    this.ctxMap.set(requestId, capturedContext);
    return request;
  }

  async convertResponse(
    payload: any,
    _profile: ConversionProfile,
    context: ConversionContext
  ): Promise<any> {
    await this.ensureInit();
    const requestId = context.requestId;
    const stored = requestId ? this.ctxMap.get(requestId) : undefined;
    if (requestId) {
      this.ctxMap.delete(requestId);
    }

    const nativeContext: Record<string, unknown> = {
      ...(stored ?? {}),
      requestId: requestId ?? (stored?.requestId as string | undefined),
      endpoint: context.endpoint ?? stored?.endpoint,
      entryEndpoint: context.entryEndpoint ?? context.endpoint ?? stored?.entryEndpoint,
      metadata:
        (stored?.metadata && typeof stored.metadata === 'object' && !Array.isArray(stored.metadata)
          ? stored.metadata
          : context.metadata) ?? {}
    };

    return runResponsesOpenAIResponseCodecWithNative(
      (payload ?? {}) as Record<string, unknown>,
      nativeContext
    );
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

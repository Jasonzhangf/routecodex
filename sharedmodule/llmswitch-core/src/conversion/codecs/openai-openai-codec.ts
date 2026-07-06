import {
  runOpenAIRequestCodecWithNative,
  runOpenAIResponseCodecWithNative
} from '../../native/router-hotpath/native-compat-action-semantics.js';

type OpenAICodecContext = {
  requestId?: string;
  endpoint?: string;
  entryEndpoint?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
};

export class OpenAIOpenAIConversionCodec {
  readonly id = 'openai-openai';
  private initialized = false;
  private ctxMap: Map<string, { stream?: boolean; entryEndpoint?: string; createdAt?: number }> = new Map();
  private static readonly CTX_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_CTX = 2048;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: any) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async convertRequest(payload: any, _profile: unknown, context: OpenAICodecContext): Promise<any> {
    await this.ensureInit();
    this.pruneCtxMap();

    const requestId = context.requestId ?? `req_${Date.now()}`;
    try {
      const wantsStream = !!(
        (payload && typeof payload === 'object' && (payload as any).stream === true) ||
        context?.stream === true ||
        (context?.metadata && (context.metadata as any).stream === true)
      );
      const entryEndpoint = String(context.entryEndpoint || context.endpoint || '');
      this.ctxMap.set(requestId, { stream: wantsStream, entryEndpoint, createdAt: Date.now() });
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

  async convertResponse(payload: any, _profile: unknown, context: OpenAICodecContext): Promise<any> {
    await this.ensureInit();
    this.pruneCtxMap();
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

  private pruneCtxMap(): void {
    const now = Date.now();
    for (const [requestId, record] of this.ctxMap.entries()) {
      const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0;
      if (createdAt > 0 && now - createdAt > OpenAIOpenAIConversionCodec.CTX_TTL_MS) {
        this.ctxMap.delete(requestId);
      }
    }
    if (this.ctxMap.size < OpenAIOpenAIConversionCodec.MAX_CTX) {
      return;
    }
    const sorted = [...this.ctxMap.entries()].sort((a, b) => {
      const aAt = typeof a[1].createdAt === 'number' ? a[1].createdAt : 0;
      const bAt = typeof b[1].createdAt === 'number' ? b[1].createdAt : 0;
      return aAt - bAt;
    });
    const removeCount = Math.ceil(sorted.length * 0.25);
    for (let i = 0; i < removeCount; i += 1) {
      this.ctxMap.delete(sorted[i][0]);
    }
  }
}

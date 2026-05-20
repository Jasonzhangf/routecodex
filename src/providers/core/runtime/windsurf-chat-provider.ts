/**
 * WindsurfChatProvider
 *
 * 支持两种 transport backend:
 *   - HTTP  → WindsurfAPI :3003 (OpenAI Chat Completions API)
 *   - gRPC  → Language Server :lsPort (绕过 WindsurfAPI，直接调 LS gRPC)
 *
 * 通过 config.extensions.windsurf.transportBackend 切换，默认 HTTP。
 */

import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  normalizeWindsurfProviderRuntimeOptions,
  WINDSURF_COMPATIBILITY_PROFILE,
  WINDSURF_DEFAULT_BASE_URL,
  WINDSURF_DEFAULT_COMPLETION_ENDPOINT,
  WINDSURF_DEFAULT_LS_PORT,
  type WindsurfTransportBackend,
} from '../contracts/windsurf-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { startGrpcStream, type WindsurfMessage } from './grpc/windsurf-grpc-bridge.js';

export class WindsurfChatProvider extends HttpTransportProvider {
  private _transportBackend: WindsurfTransportBackend | undefined;
  private _lsPort: number = WINDSURF_DEFAULT_LS_PORT;
  private _csrfToken: string = '';

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'windsurf',
        baseUrl: (config.config.baseUrl || WINDSURF_DEFAULT_BASE_URL).trim(),
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: (config.config.overrides?.endpoint || WINDSURF_DEFAULT_COMPLETION_ENDPOINT).trim(),
        },
      },
    };
    super(cfg, dependencies, 'windsurf-chat-provider');

    const ext = normalizeWindsurfProviderRuntimeOptions(
      config.config.extensions as UnknownObject | undefined
    );
    this._transportBackend = ext.transportBackend;
    this._lsPort = ext.lsPort ?? WINDSURF_DEFAULT_LS_PORT;
    this._csrfToken = ext.csrfToken ?? '';
  }

  // ─── Transport detection ────────────────────────────────

  private get isGrpcMode(): boolean {
    return this._transportBackend === 'grpc';
  }

  private get isHttpMode(): boolean {
    return this._transportBackend === 'http' || !this._transportBackend;
  }

  // ─── Service profile ───────────────────────────────────

  protected override getServiceProfile() {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: WINDSURF_DEFAULT_COMPLETION_ENDPOINT,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      streamingModes: ['sse'],
    };
  }

  // ─── Health check ─────────────────────────────────────

  public override async checkHealth(): Promise<boolean> {
    const ext = normalizeWindsurfProviderRuntimeOptions(
      this.config.config.extensions as UnknownObject | undefined
    );

    if (this.isGrpcMode) {
      // gRPC health: try grpcUnary to LS port
      try {
        const { grpcUnary } = await import('./grpc/grpc-client.js');
        const empty = Buffer.alloc(0);
        await grpcUnary(this._lsPort, this._csrfToken, '/exa.language_server_pb.LanguageServerService/Heartbeat', Buffer.concat([Buffer.from([0,0,0,0,0]), empty]), 3000);
        return true;
      } catch {
        return false;
      }
    }

    // HTTP health
    const endpoint = ext.healthCheckEndpoint || '/v1/models';
    const timeout = ext.healthCheckTimeoutMs ?? 5000;
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.config.config.baseUrl || WINDSURF_DEFAULT_BASE_URL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
    return this.performHealthCheck(url);
  }

  // ─── SSE intent detection ──────────────────────────────

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const streamIntent = this.readStreamIntent(request);
    if (streamIntent) return true;
    return super.wantsUpstreamSse(request, context);
  }

  private readStreamIntent(request: UnknownObject): boolean {
    if (request && typeof request === 'object') {
      const body = (request as Record<string, unknown>).body;
      if (body && typeof body === 'object') {
        return Boolean((body as Record<string, unknown>).stream);
      }
      return Boolean((request as Record<string, unknown>).stream);
    }
    return false;
  }



  private classifyAuthFailure(error: unknown): 'permanent' | 'cooldown' | null {
    const msg = String((error as { message?: string })?.message || error || '').toLowerCase();
    if (/invalid api key|unauthorized|unauthenticated|authentication failed|auth failed/.test(msg)) {
      return 'permanent';
    }
    if (/rate limit|too many requests|quota|temporar|timeout|econnreset|upstream unavailable/.test(msg)) {
      return 'cooldown';
    }
    return null;
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    if (!this.isHttpMode) {
      return super.sendRequestInternal(request);
    }

    try {
      return await super.sendRequestInternal(request);
    } catch (error) {
      const authProvider = this.authProvider;
      if (!(authProvider instanceof ApiKeyAuthProvider)) {
        throw error;
      }
      const rotator = authProvider.getRotator();
      const classification = this.classifyAuthFailure(error);
      if (!rotator || !classification) {
        throw error;
      }
      if (classification === 'permanent') {
        rotator.disableCurrent('permanent');
      } else {
        rotator.disableCurrent('cooldown', 5 * 60 * 1000);
      }
      const nextKey = rotator.rotate();
      if (!nextKey) {
        throw error;
      }
      await authProvider.initialize();
      return await super.sendRequestInternal(request);
    }
  }

  // ─── gRPC streaming override ───────────────────────────
  //
  // Subclass of HttpTransportProvider can't easily override sendRequestInternal
  // (it's private). Instead we override the SSE wrapper which calls sendRequestInternal.
  // For gRPC mode, we bypass the entire HTTP layer and stream directly via gRPC.

  protected override async wrapUpstreamSseResponse(
    stream: NodeJS.ReadableStream,
    context: ProviderContext,
  ): Promise<UnknownObject> {
    if (!this.isGrpcMode) {
      return super.wrapUpstreamSseResponse(stream, context);
    }

    // For gRPC mode, the stream parameter is actually a custom emitter
    // passed through from sendRequestInternal. We re-emit via SSE format.
    const { Readable } = await import('stream');
    const sseStream = new Readable();
    sseStream._read = () => {};

    const sseEmit = (text: string) => {
      sseStream.push(`data: ${JSON.stringify({
        choices: [{ delta: { content: text }, index: 0, finish_reason: null }],
        model: (context as any).model || '',
      })}\n\n`);
    };

    const sseDone = () => {
      sseStream.push(`data: ${JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        model: (context as any).model || '',
      })}\n\n`);
      sseStream.push(null);
    };

    // Pass the emitter via context so the caller can feed chunks
    (context as any)._grpcBridgeEmitter = { sseEmit, sseDone };
    return sseStream as unknown as UnknownObject;
  }

  // ─── Tool call conversion ─────────────────────────────
  //
  // In gRPC mode, tool_calls are passed as text to the LS (RawGetChatMessage
  // doesn't support native tool_calls). The caller should provide tools via
  // the OpenAI tools[] field; we convert them to text in preprocessRequest.

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    if (!this.isGrpcMode) {
      const req = await super.preprocessRequest(request);
      const body = ((req as Record<string, unknown>).body as Record<string, unknown>) || (req as Record<string, unknown>);
      if (typeof body.model === 'string' && body.model.startsWith('windsurf.')) {
        body.model = body.model.slice('windsurf.'.length);
      }
      return req;
    }

    // gRPC mode: convert tools[] to text preamble, strip HTTP-specific fields
    const req = { ...request } as Record<string, unknown>;
    const body = (req.body as Record<string, unknown>) || req;
    const tools = body.tools as Array<Record<string, unknown>> | undefined;

    if (Array.isArray(tools) && tools.length > 0) {
      const preamble = tools.map(t => {
        const fn = (t.function as Record<string, string>) || {};
        return `- ${fn.name || t.type || 'unknown'}: ${fn.description || ''}\n  params: ${fn.parameters ? JSON.stringify(fn.parameters) : '{}'}`;
      }).join('\n');
      body.tools_preamble = `[Available tools]\n${preamble}`;
      delete body.tools;
    }

    if (typeof body.model === 'string' && body.model.startsWith('windsurf.')) {
      body.model = body.model.slice('windsurf.'.length);
    }

    return req;
  }

  // ─── Model mapping ────────────────────────────────────
  //
  // Windsurf model → enum. This is a simplified mapping.
  // Full model catalog is at WindsurfAPI/src/models.js.

  private resolveModelEnum(modelName: string | undefined): number {
    if (!modelName) return 0;
    const name = modelName.toLowerCase();
    if (name.includes('claude-4.5-opus-thinking')) return 392;
    if (name.includes('claude-4.5-opus')) return 391;
    if (name.includes('claude-4.5-sonnet-thinking')) return 354;
    if (name.includes('claude-4.5-sonnet')) return 353;
    if (name.includes('claude-4.5-haiku')) return 0;
    if (name.includes('gpt-5.4-high')) return 391;
    if (name.includes('claude-4.1-opus-thinking')) return 329;
    if (name.includes('claude-4.1-opus')) return 328;
    if (name.includes('claude-4-opus-thinking')) return 291;
    if (name.includes('claude-4-opus')) return 290;
    if (name.includes('claude-4-sonnet-thinking')) return 282;
    if (name.includes('claude-4-sonnet')) return 281;
    if (name.includes('claude-3.7-sonnet-thinking')) return 227;
    if (name.includes('claude-3.7-sonnet')) return 226;
    if (name.includes('claude-3.5-sonnet')) return 166;
    if (name.includes('claude-3.7-haiku')) return 0;
    if (name.includes('claude-3-haiku')) return 0;
    return 0;
  }

  // ─── Public: start gRPC stream (for internal use) ───
  //
  // Called by the HTTP server layer via a custom context flag when in gRPC mode.
  // The actual streaming is initiated via startGrpcStream; this method is
  // a bridge between the provider interface and the gRPC layer.

  public startGrpcChat(
    apiKey: string,
    messages: WindsurfMessage[],
    modelName: string | undefined,
    callbacks: {
      onChunk: (text: string) => void;
      onDone: () => void;
      onError: (err: Error) => void;
    },
  ): void {
    const modelEnum = this.resolveModelEnum(modelName);

    startGrpcStream(apiKey, messages, {
      lsPort: this._lsPort,
      csrfToken: this._csrfToken,
      modelEnum,
      modelName,
      onChunk: (text, done) => {
        if (!done) callbacks.onChunk(text);
        else callbacks.onDone();
      },
      onError: callbacks.onError,
    });
  }
}

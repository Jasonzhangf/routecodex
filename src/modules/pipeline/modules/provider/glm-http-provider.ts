/**
 * GLM HTTP Provider
 *
 * Minimal raw-HTTP provider for Zhipu GLM Coding Plan endpoint.
 * Uses explicit Authorization header and avoids SDK quirks.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from 'rcc-debugcenter';

const DEFAULT_GLM_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4';

export class GLMHTTPProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'glm-http-provider';
  readonly providerType = 'glm';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;

    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
    } catch {
      this.isDebugEnhanced = false;
    }
  }

  async initialize(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;
    const auth = providerConfig.auth as any;
    if (!auth || (auth.type !== 'apikey' && auth.type !== 'bearer') || !((auth.apiKey || auth.token))) {
      throw new Error('GLMHTTPProvider requires auth.apiKey (or bearer token)');
    }
    // Normalize to bearer token at runtime
    const token = String(auth.apiKey || auth.token).trim();
    this.authContext = { type: 'bearer', token } as AuthContext;
    this.isInitialized = true;
  }

  async processIncoming(request: UnknownObject): Promise<UnknownObject> {
    const resp = await this.sendChat(request);
    return resp.data as UnknownObject;
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  async sendRequest(request: UnknownObject): Promise<ProviderResponse> {
    return this.sendChat(request);
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.authContext = null;
  }

  getStatus(): { id: string; type: string; providerType: string; isInitialized: boolean; hasAuth: boolean } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      hasAuth: !!this.authContext,
    };
  }

  private getBaseUrl(): string {
    const providerConfig = this.config.config as ProviderConfig;
    return providerConfig.baseUrl || DEFAULT_GLM_BASE;
  }

  private async sendChat(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized || !this.authContext?.token) {
      throw new Error('GLMHTTPProvider is not initialized');
    }

    const start = Date.now();
    const endpoint = `${this.getBaseUrl()}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: (request as any)?.model,
      messages: (request as any)?.messages || [],
      temperature: (request as any)?.temperature,
      max_tokens: (request as any)?.max_tokens,
      top_p: (request as any)?.top_p,
      stream: Boolean((request as any)?.stream) || false,
      tools: (request as any)?.tools,
      response_format: (request as any)?.response_format,
    };

    // Allow per-request override
    const overrideKeyRaw = (request as any)?.__rcc_overrideApiKey as string | undefined;
    const token = overrideKeyRaw
      ? (overrideKeyRaw.toLowerCase().startsWith('bearer ') ? overrideKeyRaw.slice(7).trim() : overrideKeyRaw.trim())
      : this.authContext.token!;

    if (this.isDebugEnhanced && this.debugEventBus) {
      this.debugEventBus.publish({
        sessionId: 'system',
        moduleId: this.id,
        operationId: 'glm_http_request_start',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: { endpoint, model: payload.model }
      });
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'RouteCodex/GLMHTTPProvider'
      },
      body: JSON.stringify(payload)
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`GLM API error: ${res.status} ${res.statusText} - ${text}`);
      err.type = 'server';
      err.statusCode = res.status;
      err.details = { upstream: text ? { text } : undefined, provider: { vendor: 'glm', baseUrl: this.getBaseUrl(), moduleType: this.type } };
      err.retryable = res.status >= 500 || res.status === 429;
      if (this.isDebugEnhanced && this.debugEventBus) {
        this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_error', timestamp: Date.now(), type: 'error', position: 'middle', data: { status: res.status, elapsed } });
      }
      throw err;
    }

    const data = await res.json();
    if (this.isDebugEnhanced && this.debugEventBus) {
      this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_success', timestamp: Date.now(), type: 'end', position: 'middle', data: { status: res.status, elapsed } });
    }

    return {
      data,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      metadata: { requestId: `glm-${Date.now()}`, processingTime: elapsed, model: (request as any)?.model }
    };
  }
}

export default GLMHTTPProvider;


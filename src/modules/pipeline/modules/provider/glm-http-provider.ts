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

  async checkHealth(): Promise<boolean> {
    // Basic health check - try to make a simple request to the provider
    try {
      const providerConfig = this.config.config as ProviderConfig;
      const baseUrl = (providerConfig.baseUrl || DEFAULT_GLM_BASE).replace(/\/+$/, '');
      
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.authContext?.token || ''}`,
          'Content-Type': 'application/json'
        }
      });
      
      return response.ok;
    } catch (error) {
      this.logger.logError(error, { provider: this.id, method: 'checkHealth' });
      return false;
    }
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
    // Normalize messages/content for GLM (expects plain strings)
    const rawMessages = (request as any)?.messages || [];
    const normalizedMessages = Array.isArray(rawMessages)
      ? rawMessages.map((m: any) => {
          // Normalize role: GLM supports 'system' | 'user' | 'assistant'
          let role: string = m?.role || 'user';
          if (role === 'tool') { role = 'user'; }
          if (!['system','user','assistant'].includes(role)) { role = 'user'; }

          const msg: any = { role };

          // Merge content and tool_calls into a plain text content for GLM
          const parts: string[] = [];

          const c = m?.content;
          if (c !== undefined && c !== null) {
            if (typeof c === 'string') {
              parts.push(c);
            } else if (Array.isArray(c)) {
              const text = c
                .map((p: any) => (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
                .filter((s: string) => s)
                .join('\n');
              if (text) {parts.push(text);}
            } else if (typeof c === 'object') {
              try { parts.push(JSON.stringify(c)); } catch { parts.push(String(c)); }
            } else {
              parts.push(String(c));
            }
          }

          // If assistant tool_calls exist, append a readable summary so GLM can consume context
          if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
            const callsText = m.tool_calls.map((tc: any, idx: number) => {
              const name = tc?.function?.name || tc?.type || `tool_${idx}`;
              let argsStr = '';
              const args = tc?.function?.arguments;
              if (typeof args === 'string') { argsStr = args; }
              else if (args && typeof args === 'object') { try { argsStr = JSON.stringify(args); } catch { argsStr = String(args); } }
              return `[tool_call:${name}] ${argsStr}`.trim();
            }).join('\n');
            if (callsText) {parts.push(callsText);}
          }

          msg.content = parts.join('\n').trim();
          return msg;
        })
      : [];

    const payload: Record<string, unknown> = {
      model: (request as any)?.model,
      messages: normalizedMessages,
      temperature: (request as any)?.temperature,
      max_tokens: (request as any)?.max_tokens,
      top_p: (request as any)?.top_p,
      // Force non-stream to avoid text/event-stream parsing issues
      stream: false,
      // Avoid sending unsupported fields by GLM to reduce 1210 errors
      // tools and response_format omitted intentionally
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

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
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

// Coding Plan base URL (previously in use, required in this environment)
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
      if (String(process.env.ROUTECODEX_ENABLE_DEBUGCENTER || '0') === '1') {
        this.debugEventBus = DebugEventBus.getInstance();
        this.isDebugEnhanced = true;
      } else {
        this.debugEventBus = null;
        this.isDebugEnhanced = false;
      }
    } catch {
      this.debugEventBus = null;
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
    // Passthrough payload as-is. Do not sanitize/trim/strip tool_calls.
    const payloadObj: Record<string, unknown> = { ...(request as any) };

    const token = this.authContext.token!;

    if (this.isDebugEnhanced && this.debugEventBus) {
      this.debugEventBus.publish({
        sessionId: 'system',
        moduleId: this.id,
        operationId: 'glm_http_request_start',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: { endpoint, model: (payloadObj as any).model }
      });
    }

    // Persist final payload snapshot
    try {
      const dir = path.join(homedir(), '.routecodex', 'codex-samples');
      await fs.mkdir(dir, { recursive: true });
      const outPath = path.join(dir, `provider-out-glm_${Date.now()}_${Math.random().toString(36).slice(2,8)}.json`);
      await fs.writeFile(outPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
      if (this.isDebugEnhanced && this.debugEventBus) {
        this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_payload_saved', timestamp: Date.now(), type: 'start', position: 'middle', data: { path: outPath, model: (payloadObj as any).model, hasTools: Array.isArray((payloadObj as any).tools) } });
      }
    } catch { /* noop: optional debug payload save */ void 0; }

    const timeoutMs = Number(process.env.GLM_HTTP_TIMEOUT_MS || process.env.RCC_UPSTREAM_TIMEOUT_MS || 300000);
    const controller = new AbortController();
    const t = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, Math.max(1, timeoutMs));

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'RouteCodex/GLMHTTPProvider'
        },
        body: JSON.stringify(payloadObj),
        signal: (controller as any).signal
      } as any);
    } catch (e: any) {
      clearTimeout(t);
      const isAbort = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted');
      if (isAbort) {
        const err: any = new Error(`GLM upstream timeout after ${timeoutMs}ms`);
        err.type = 'timeout';
        err.statusCode = 504;
        err.details = { upstream: { timeoutMs }, provider: { vendor: 'glm', baseUrl: this.getBaseUrl(), moduleType: this.type } };
        err.retryable = false;
        if (this.isDebugEnhanced && this.debugEventBus) {
          this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_timeout', timestamp: Date.now(), type: 'error', position: 'middle', data: { timeoutMs } });
        }
        throw err;
      }

      const socketCode = String(e?.code || '').toUpperCase();
      const msg = String(e?.message || '').toLowerCase();
      const isSocketError = socketCode === 'UND_ERR_SOCKET' || socketCode === 'ECONNREFUSED' || socketCode === 'ENOTFOUND' || msg.includes('fetch failed');

      if (isSocketError) {
        const err: any = new Error('GLM provider network request failed: outbound sandbox access required');
        err.code = 'SANDBOX_NETWORK_BLOCKED';
        err.type = 'sandbox';
        err.statusCode = 503;
        err.retryable = false;
        err.details = {
          upstream: { code: e?.code, message: e?.message },
          provider: { vendor: 'glm', baseUrl: this.getBaseUrl(), moduleType: this.type },
          hint: 'Grant outbound network access or disable sandbox restrictions to reach https://open.bigmodel.cn'
        };

        if (this.isDebugEnhanced && this.debugEventBus) {
          this.debugEventBus.publish({
            sessionId: 'system',
            moduleId: this.id,
            operationId: 'glm_http_request_network_error',
            timestamp: Date.now(),
            type: 'error',
            position: 'middle',
            data: { code: e?.code, message: e?.message }
          });
        }

        throw err;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }

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

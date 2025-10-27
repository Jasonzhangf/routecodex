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
    const requestId = (() => {
      try {
        const raw: any = request as any;
        const fromMeta = raw?._metadata && typeof raw._metadata === 'object' ? raw._metadata.requestId : undefined;
        const fromTop = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata.requestId : undefined;
        const picked = typeof fromMeta === 'string' ? fromMeta : (typeof fromTop === 'string' ? fromTop : undefined);
        return picked && picked.startsWith('req_') ? picked : `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
    })();
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

    // Persist final payload snapshot (categorized path)
    try {
      const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
      const effectiveId = requestId;
      const entry = (request as any)?.metadata?.entryEndpoint || '';
      const entryFolder = /\/v1\/responses/i.test(String(entry))
        ? 'openai-responses'
        : (/\/v1\/messages/i.test(String(entry)) ? 'anthropic-messages' : 'openai-chat');
      const entryDir = path.join(baseDir, entryFolder);
      await fs.mkdir(entryDir, { recursive: true });
      const directReqPath = path.join(entryDir, `${effectiveId}_provider-request.json`);
      await fs.writeFile(directReqPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
      const wrapped = {
        requestId: effectiveId,
        timestamp: Date.now(),
        model: (payloadObj as any)?.model,
        toolsCount: Array.isArray((payloadObj as any)?.tools) ? (payloadObj as any).tools.length : 0,
        messagesCount: Array.isArray((payloadObj as any)?.messages) ? (payloadObj as any).messages.length : 0,
        request: payloadObj
      };
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-in.json`), JSON.stringify(wrapped, null, 2), 'utf-8');
      if (this.isDebugEnhanced && this.debugEventBus) {
        this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_payload_saved', timestamp: Date.now(), type: 'start', position: 'middle', data: { path: directReqPath, model: (payloadObj as any).model, hasTools: Array.isArray((payloadObj as any).tools) } });
      }
    } catch { /* noop */ void 0; }

    const wantsStream = Boolean((payloadObj as any)?.stream === true);
    const timeoutMs = Number(process.env.GLM_HTTP_TIMEOUT_MS || process.env.RCC_UPSTREAM_TIMEOUT_MS || 300000);
    const controller = new AbortController();
    // For streaming, avoid premature abort; use a generous timeout if configured
    const t = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, Math.max(1, wantsStream ? (timeoutMs || 300000) : timeoutMs));

    let res: Response;
    try {
      // Strip internal metadata before sending upstream
      const wirePayload = (() => { const p = { ...(payloadObj as any) } as Record<string, unknown>; delete (p as any)._metadata; delete (p as any).metadata; return p; })();
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'RouteCodex/GLMHTTPProvider'
        },
        body: JSON.stringify(wirePayload),
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

    // Always treat upstream as non-stream JSON; local streaming (if any) is synthesized later.

    // Non-stream JSON response
    const data = await res.json();
    // Persist response snapshot (categorized under entrypoint)
    try {
      const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
      const effectiveId = requestId;
      const entry = (request as any)?.metadata?.entryEndpoint || '';
      const entryFolder = /\/v1\/responses/i.test(String(entry))
        ? 'openai-responses'
        : (/\/v1\/messages/i.test(String(entry)) ? 'anthropic-messages' : 'openai-chat');
      const entryDir = path.join(baseDir, entryFolder);
      await fs.mkdir(entryDir, { recursive: true });
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-response.json`), JSON.stringify(data, null, 2), 'utf-8');
      const pair = {
        type: 'glm-provider-pair',
        requestId: effectiveId,
        timestamp: Date.now(),
        meta: { provider: 'glm', baseURL: this.getBaseUrl() },
        request: (request as any),
        response: data
      };
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-pair.json`), JSON.stringify(pair, null, 2), 'utf-8');
    } catch { /* ignore */ }
    if (this.isDebugEnhanced && this.debugEventBus) {
      this.debugEventBus.publish({ sessionId: 'system', moduleId: this.id, operationId: 'glm_http_request_success', timestamp: Date.now(), type: 'end', position: 'middle', data: { status: res.status, elapsed, streaming: false } });
    }

    return {
      data,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      metadata: { requestId, processingTime: elapsed, model: (request as any)?.model }
    };
  }
}

export default GLMHTTPProvider;

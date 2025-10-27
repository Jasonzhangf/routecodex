/**
 * Generic OpenAI-compatible HTTP Provider
 *
 * Sends OpenAI Chat Completions payloads to a configurable baseUrl that claims
 * OpenAI compatibility. Supports streaming passthrough and JSON responses.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { buildAuthHeaders } from './shared/provider-helpers.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export class GenericOpenAIProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'generic-openai-provider';
  readonly providerType = 'openai';
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
      }
    } catch {
      this.debugEventBus = null;
      this.isDebugEnhanced = false;
    }
  }

  async initialize(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;
    const auth = providerConfig.auth as any;
    if (auth && (auth.type === 'apikey' || auth.type === 'bearer') && (auth.apiKey || auth.token)) {
      const token = String(auth.apiKey || auth.token).trim();
      this.authContext = { type: auth.type === 'bearer' ? 'bearer' : 'apikey', token } as AuthContext;
    } else {
      this.authContext = null; // allow no-auth endpoints
    }
    this.isInitialized = true;
  }

  async checkHealth(): Promise<boolean> {
    // Best-effort: verify baseUrl is reachable by HEAD/GET /models when available
    try {
      const providerConfig = this.config.config as ProviderConfig;
      const baseUrl = String(providerConfig.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl) return false;
      const url = `${baseUrl}/models`;
      const headers = buildAuthHeaders(this.authContext || { type: 'none' } as any, { 'Content-Type': 'application/json' });
      const res = await fetch(url, { method: 'GET', headers } as any);
      return res.ok || res.status === 404; // some vendors may not expose /models
    } catch {
      return false;
    }
  }

  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    return this.sendRequest(request);
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> { return response; }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.authContext = null;
  }

  getStatus(): { id: string; type: string; providerType: string; isInitialized: boolean; hasAuth: boolean } {
    return { id: this.id, type: this.type, providerType: this.providerType, isInitialized: this.isInitialized, hasAuth: !!this.authContext };
  }

  private getBaseUrl(): string {
    const providerConfig = this.config.config as ProviderConfig;
    return String(providerConfig.baseUrl || '').replace(/\/+$/, '');
  }

  async sendRequest(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) throw new Error('GenericOpenAIProvider is not initialized');
    const start = Date.now();
    const endpoint = `${this.getBaseUrl()}/chat/completions`;
    const payload: Record<string, unknown> = { ...(request as any) };
    const requestId = (() => {
      try {
        const raw: any = payload as any;
        const fromMeta = raw?._metadata && typeof raw._metadata === 'object' ? raw._metadata.requestId : undefined;
        const fromTop = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata.requestId : undefined;
        const picked = typeof fromMeta === 'string' ? fromMeta : (typeof fromTop === 'string' ? fromTop : undefined);
        return picked && picked.startsWith('req_') ? picked : `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
    })();
    const wantsStream = Boolean((payload as any)?.stream === true);

    // Persist outgoing payload for debugging (categorized path)
    try {
      const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
      const effectiveId = requestId;
      const entry = (request as any)?.metadata?.entryEndpoint || '';
      const entryFolder = /\/v1\/responses/i.test(String(entry))
        ? 'openai-responses'
        : (/\/v1\/messages/i.test(String(entry)) ? 'anthropic-messages' : 'openai-chat');
      const entryDir = path.join(baseDir, entryFolder);
      await fs.mkdir(entryDir, { recursive: true });
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-request.json`), JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* ignore */ }

    const headers = buildAuthHeaders(this.authContext || { type: 'none' } as any, { 'Content-Type': 'application/json', 'User-Agent': 'RouteCodex/GenericOpenAIProvider' });
    const timeoutMs = Number(process.env.OPENAI_GENERIC_TIMEOUT_MS || process.env.RCC_UPSTREAM_TIMEOUT_MS || 300000);
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch {} }, Math.max(1, timeoutMs));

    let res: Response;
    try {
      // Strip internal metadata fields before sending upstream
      const wirePayload = (() => { const p = { ...(payload as any) } as Record<string, unknown>; delete (p as any)._metadata; delete (p as any).metadata; return p; })();
      res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(wirePayload), signal: (controller as any).signal } as any);
    } finally {
      clearTimeout(t);
    }

    const elapsed = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`OpenAI-compatible API error: ${res.status} ${res.statusText} - ${text}`);
      err.status = res.status;
      err.details = { upstream: text ? { text } : undefined, provider: { vendor: 'openai-compatible', baseUrl: this.getBaseUrl(), moduleType: this.type } };
      throw err;
    }

    if (wantsStream && res.body) {
      try {
        const { Readable } = await import('stream');
        const nodeStream = (Readable as any).fromWeb ? (Readable as any).fromWeb(res.body as any) : (res as any).body;
        return { data: nodeStream, status: res.status, headers: Object.fromEntries(res.headers.entries()), metadata: { requestId, processingTime: elapsed, model: (request as any)?.model } };
      } catch {
        // fallthrough to buffered json
      }
    }

    const data = await res.json();
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
    } catch { /* ignore */ }
    return { data, status: res.status, headers: Object.fromEntries(res.headers.entries()), metadata: { requestId, processingTime: elapsed, model: (request as any)?.model } };
  }
}

export default GenericOpenAIProvider;

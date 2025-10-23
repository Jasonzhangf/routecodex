import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { ProviderResponse } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import fetch from 'node-fetch';

export class GenericResponsesProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'generic-responses';
  readonly providerType = 'generic-responses';
  readonly config: ModuleConfig;
  private isInitialized = false;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, deps: ModuleDependencies) {
    this.id = `provider-generic-resp-${Date.now()}`;
    this.config = config;
    this.logger = deps.logger as any;
  }

  async initialize(): Promise<void> { this.isInitialized = true; }

  async processIncoming(request: SharedPipelineRequest): Promise<unknown> {
    if (!this.isInitialized) await this.initialize();
    const cfg = (this.config.config || {}) as any;
    const baseUrl = String(cfg.baseUrl || cfg.baseURL || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('generic-responses: baseUrl required');
    const apiKey = String((cfg.auth && (cfg.auth.apiKey || cfg.auth.token)) || '').trim();
    const url = `${baseUrl}/responses`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'application/json',
      'OpenAI-Beta': process.env.RCC_OPENAI_RESPONSES_BETA || 'responses-2024-12-17',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const payload = request.data as any;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err: ProviderResponse = {
        data: { error: data?.error || data || { message: `HTTP ${res.status}` } },
        status: res.status,
        metadata: {
          requestId: (request.route?.requestId as string) || 'unknown',
          processingTime: 0,
          model: (payload?.model as string) || 'responses'
        } as any
      } as any;
      return this.processResponse(err);
    }
    const out: ProviderResponse = {
      data,
      status: res.status,
      metadata: {
        requestId: (request.route?.requestId as string) || 'unknown',
        processingTime: 0,
        model: (payload?.model as string) || 'responses'
      } as any
    } as any;
    return this.processResponse(out);
  }

  async processOutgoing(response: unknown): Promise<unknown> { return response; }

  private processResponse(resp: ProviderResponse): unknown {
    return resp.data;
  }

  async sendRequest(request: SharedPipelineRequest | any): Promise<unknown> { return this.processIncoming(request); }
  async checkHealth(): Promise<boolean> { return true; }
  async cleanup(): Promise<void> { this.isInitialized = false; }
  getStatus(): any { return { id: this.id, type: this.type, initialized: this.isInitialized, timestamp: Date.now() }; }
  async getMetrics(): Promise<any> { return { requestCount: 0, successCount: 0, errorCount: 0, averageResponseTime: 0, timestamp: Date.now() }; }
}

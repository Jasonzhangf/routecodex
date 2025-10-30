/**
 * OpenAI Normalizer LLM Switch (sharedmodule wrapper)
 * Logic copied from root module; types relaxed to avoid root coupling.
 */

export class OpenAINormalizerLLMSwitch {
  readonly id: string;
  readonly type = 'llmswitch-openai-openai';
  readonly protocol = 'openai';
  readonly config: any;
  private isInitialized = false;

  constructor(config: any, _dependencies: any) {
    this.id = `llmswitch-openai-openai-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;
  }

  async processIncoming(requestParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();
    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as any) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as any);

    const normalized = await this.normalizeOpenAIRequest(payload);

    const outDto = isDto
      ? { ...dto!, data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } } }
      : {
          data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } },
          route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() },
          metadata: {},
          debug: { enabled: false, stages: {} }
        };
    return outDto;
  }

  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  async transformResponse(response: any): Promise<any> {
    return response;
  }

  private async normalizeOpenAIRequest(request: any): Promise<any> {
    if (!request || typeof request !== 'object') return request;
    try {
      // Use unified OpenAI normalization (includes tool->assistant embedding, shell arg fixups, MCP hints)
      const { normalizeChatRequest } = await import('../conversion/shared/openai-normalize.js');
      return normalizeChatRequest(request);
    } catch {
      // Fallback to minimal tooling stage if shared normalize is unavailable
      try {
        const { applyOpenAIToolingStage } = await import('../conversion/shared/openai-tooling-stage.js');
        return applyOpenAIToolingStage({ ...(request as any) } as any) as any;
      } catch { return request; }
    }
  }

  // Legacy local normalizers removed; rely on shared normalizeChatRequest/Response

  async dispose(): Promise<void> { this.isInitialized = false; }
  async cleanup(): Promise<void> { await this.dispose(); }
  getStats(): any { return { type: this.type, initialized: this.isInitialized, timestamp: Date.now() }; }
}
import { augmentOpenAITools } from '../guidance/index.js';

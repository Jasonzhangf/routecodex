import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces';
import type { SharedPipelineRequest } from '../../shared/shared-dtos';
import { OpenAINormalizerLLMSwitch } from './openai-normalizer';
import { AnthropicOpenAIConverter } from './llmswitch-anthropic-openai';

export interface UnifiedLLMSwitchConfig {
  protocolDetection: 'endpoint-based' | 'content-based' | 'header-based';
  defaultProtocol: 'anthropic' | 'openai';
  endpointMapping?: { anthropic: string[]; openai: string[] };
}

export class UnifiedLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-unified';
  readonly protocol = 'unified';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private openaiSwitch: OpenAINormalizerLLMSwitch;
  private anthropicSwitch: AnthropicOpenAIConverter;
  private switchConfig: UnifiedLLMSwitchConfig;
  private protocolByRequestId: Map<string, 'anthropic' | 'openai'> = new Map();

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `llmswitch-unified-${Date.now()}`;
    this.config = config;
    const defaults: UnifiedLLMSwitchConfig = {
      protocolDetection: 'endpoint-based',
      defaultProtocol: 'openai',
      endpointMapping: { anthropic: ['/v1/anthropic/messages', '/v1/messages'], openai: ['/v1/chat/completions', '/v1/completions'] }
    };
    this.switchConfig = { ...defaults, ...(config.config as UnifiedLLMSwitchConfig || {}) };
    this.openaiSwitch = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} }, dependencies);
    this.anthropicSwitch = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, dependencies);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.openaiSwitch.initialize();
    await this.anthropicSwitch.initialize();
    this.isInitialized = true;
  }

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) await this.initialize();
    const protocol = this.detectProtocol(request);
    try { const reqId = request?.route?.requestId; if (reqId) this.protocolByRequestId.set(reqId, protocol); } catch {}
    const selected = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;
    return await selected.processIncoming(request);
  }

  async transformRequest(request: any): Promise<unknown> {
    if (!this.isInitialized) await this.initialize();
    const selected = (this.detectProtocol(request) === 'anthropic') ? this.anthropicSwitch : this.openaiSwitch;
    return await selected.transformRequest(request);
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) await this.initialize();
    let protocol: 'anthropic' | 'openai' = this.switchConfig.defaultProtocol;
    try {
      const reqId = (response && typeof response === 'object' && 'metadata' in response) ? (response as { metadata?: { requestId?: string } }).metadata?.requestId : undefined;
      if (reqId && this.protocolByRequestId.has(reqId)) {
        protocol = this.protocolByRequestId.get(reqId)!;
        this.protocolByRequestId.delete(reqId);
      } else {
        protocol = this.detectProtocol(response);
      }
    } catch { protocol = this.detectProtocol(response); }
    const selected = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;
    return await selected.processOutgoing(response);
  }

  async transformResponse(response: any): Promise<unknown> {
    if (!this.isInitialized) await this.initialize();
    const selected = (this.detectProtocol(response) === 'anthropic') ? this.anthropicSwitch : this.openaiSwitch;
    return await selected.transformResponse(response);
  }

  async cleanup(): Promise<void> { await this.openaiSwitch.cleanup(); await this.anthropicSwitch.cleanup(); this.isInitialized = false; }

  private detectProtocol(request: any): 'anthropic' | 'openai' {
    const detectionMethod = this.switchConfig.protocolDetection;
    switch (detectionMethod) {
      case 'endpoint-based': return this.detectProtocolByEndpoint(request);
      case 'content-based': return this.detectProtocolByContent(request);
      case 'header-based': return this.detectProtocolByHeaders(request);
      default: return this.switchConfig.defaultProtocol;
    }
  }

  private detectProtocolByEndpoint(request: any): 'anthropic' | 'openai' {
    const explicit = (request?._metadata?.targetProtocol || request?.metadata?.targetProtocol) as string | undefined;
    if (explicit && (explicit === 'anthropic' || explicit === 'openai')) return explicit as any;
    const endpoint = request._metadata?.endpoint || request.endpoint || request.metadata?.endpoint || request.metadata?.url || request.url || '';
    const mapping = this.switchConfig.endpointMapping;
    if (!mapping) return this.switchConfig.defaultProtocol;
    if (mapping.anthropic.some(ep => String(endpoint).includes(ep))) return 'anthropic';
    if (mapping.openai.some(ep => String(endpoint).includes(ep))) return 'openai';
    return this.switchConfig.defaultProtocol;
  }

  private detectProtocolByContent(request: any): 'anthropic' | 'openai' {
    if (request.messages && Array.isArray(request.messages)) return 'openai';
    if (request.max_tokens !== undefined && request.model !== undefined) return 'anthropic';
    return this.switchConfig.defaultProtocol;
  }

  private detectProtocolByHeaders(request: any): 'anthropic' | 'openai' {
    const headers = request._metadata?.headers || request.headers || {};
    if (headers['anthropic-version']) return 'anthropic';
    if (headers['content-type'] === 'application/json' && (headers['authorization'] || '').startsWith('Bearer ')) return 'openai';
    return this.switchConfig.defaultProtocol;
  }
}


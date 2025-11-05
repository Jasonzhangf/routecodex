import type { ModuleConfig, ModuleDependencies, PipelineModule } from '../interfaces/pipeline-interfaces.js';

// v2 conversion codecs
import { OpenAIOpenAIConversionCodec } from 'rcc-llmswitch-core/v2/conversion/codecs/openai-openai-codec';
import { AnthropicOpenAIConversionCodec } from 'rcc-llmswitch-core/v2/conversion/codecs/anthropic-openai-codec';
import { ResponsesOpenAIConversionCodec } from 'rcc-llmswitch-core/v2/conversion/codecs/responses-openai-codec';

type Ctx = {
  requestId?: string;
  endpoint?: string;
  entryEndpoint?: string;
  metadata?: Record<string, unknown>;
};

abstract class BaseV2Adapter implements PipelineModule {
  public readonly id: string;
  public readonly type: string;
  public readonly config: ModuleConfig;
  protected initialized = false;

  constructor(type: string, config: ModuleConfig) {
    this.type = type;
    this.config = config;
    this.id = `${type}-v2`;
  }

  async initialize(): Promise<void> { this.initialized = true; }
  async cleanup(): Promise<void> { /* no-op */ }

  protected buildContext(requestOrResponse: any): Ctx {
    try {
      const req = requestOrResponse;
      const route = (req && typeof req === 'object') ? (req.route || {}) : {};
      const meta = (req && typeof req === 'object') ? (req.metadata || {}) : {};
      return {
        requestId: String(route.requestId || meta.requestId || `req_${Date.now()}`),
        endpoint: String(meta.endpoint || meta.entryEndpoint || ''),
        entryEndpoint: String(meta.entryEndpoint || ''),
        metadata: meta,
      };
    } catch { return {}; }
  }

  abstract processIncoming(request: any): Promise<unknown>;
  abstract processOutgoing(response: any): Promise<unknown>;
}

export class OpenAIOpenAIAdapter extends BaseV2Adapter {
  private codec: OpenAIOpenAIConversionCodec;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-openai-openai', config);
    this.codec = new OpenAIOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertResponse(response.data ?? response, profile, ctx as any);
  }
}

export class AnthropicOpenAIAdapter extends BaseV2Adapter {
  private codec: AnthropicOpenAIConversionCodec;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-anthropic-openai', config);
    this.codec = new AnthropicOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertResponse(response.data ?? response, profile, ctx as any);
  }
}

export class ResponsesToChatAdapter extends BaseV2Adapter {
  private codec: ResponsesOpenAIConversionCodec;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-response-chat', config);
    this.codec = new ResponsesOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertResponse(response.data ?? response, profile, ctx as any);
  }
}

export class ResponsesPassthroughAdapter extends BaseV2Adapter {
  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-responses-passthrough', config);
  }
  async processIncoming(request: any): Promise<unknown> { return request; }
  async processOutgoing(response: any): Promise<unknown> { return response; }
}

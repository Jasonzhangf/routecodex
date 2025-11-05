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
      const rootEntry = (req && typeof req === 'object' && typeof (req as any).entryEndpoint === 'string') ? (req as any).entryEndpoint : '';
      const dataMeta = (req && typeof req === 'object' && req.data && typeof (req as any).data === 'object') ? ((req as any).data.metadata || {}) : {};
      const dataEntry = (req && typeof req === 'object' && req.data && typeof (req as any).data === 'object' && typeof (req as any).data.entryEndpoint === 'string') ? (req as any).data.entryEndpoint : '';
      return {
        requestId: String(route.requestId || (meta as any).requestId || `req_${Date.now()}`),
        endpoint: String((meta as any).endpoint || (meta as any).entryEndpoint || (dataMeta as any).entryEndpoint || dataEntry || rootEntry || ''),
        entryEndpoint: String((meta as any).entryEndpoint || (dataMeta as any).entryEndpoint || dataEntry || rootEntry || ''),
        metadata: meta,
      };
    } catch { return {}; }
  }

  abstract processIncoming(request: any): Promise<unknown>;
  abstract processOutgoing(response: any): Promise<unknown>;
}

// Dynamic router: choose proper codec by entryEndpoint
export class ConversionRouterAdapter extends BaseV2Adapter {
  private openaiCodec: OpenAIOpenAIConversionCodec;
  private anthropicCodec: AnthropicOpenAIConversionCodec;
  private responsesCodec: ResponsesOpenAIConversionCodec;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-conversion-router', config);
    this.openaiCodec = new OpenAIOpenAIConversionCodec({});
    this.anthropicCodec = new AnthropicOpenAIConversionCodec({});
    this.responsesCodec = new ResponsesOpenAIConversionCodec({});
  }

  private pickProtocol(ctx: Ctx): 'openai-chat' | 'openai-responses' | 'anthropic-messages' {
    const ep = String(ctx.entryEndpoint || ctx.endpoint || '').toLowerCase();
    try { console.log('[LLMSWITCH.pick] ctx=', ctx); } catch { /* ignore */ }
    if (ep === '/v1/messages') return 'anthropic-messages';
    if (ep === '/v1/responses') return 'openai-responses';
    if (ep === '/v1/chat/completions' || ep === '/v1/completions') return 'openai-chat';
    // Unknown endpoint: mark for 404 by throwing a structured error
    const err: any = new Error(`Unsupported endpoint for conversion router: ${ep}`);
    err.status = 404; err.code = 'not_found';
    throw err;
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const body = request?.data ?? request;
    let proto: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    try {
      proto = this.pickProtocol(ctx);
    } catch (err) {
      // If endpoint missing but body clearly matches OpenAI Chat (has messages), treat as openai-chat
      if (body && typeof body === 'object' && Array.isArray((body as any).messages)) {
        proto = 'openai-chat';
      } else {
        throw err;
      }
    }
    let converted: any;
    switch (proto) {
      case 'anthropic-messages':
        converted = await this.anthropicCodec.convertRequest(body, { outgoingProtocol: 'openai-chat' } as any, ctx as any);
        break;
      case 'openai-responses':
        converted = await this.responsesCodec.convertRequest(body, { outgoingProtocol: 'openai-chat' } as any, ctx as any);
        break;
      default:
        converted = await this.openaiCodec.convertRequest(body, { outgoingProtocol: 'openai-chat' } as any, ctx as any);
        break;
    }
    // 返回时携带元数据，供响应阶段严格识别协议（不做兜底）
    const meta = (request && request.metadata && typeof request.metadata === 'object') ? { ...(request.metadata) } : {};
    (meta as any).entryEndpoint = ctx.entryEndpoint;
    (meta as any).protocol = proto;
    return { data: converted, metadata: meta } as any;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const meta = (response && (response as any).metadata && typeof (response as any).metadata === 'object') ? (response as any).metadata : {};
    const protoMeta = typeof (meta as any).protocol === 'string' ? (meta as any).protocol : '';
    const body = response?.data ?? response;
    const proto: 'openai-chat' | 'openai-responses' | 'anthropic-messages' = (protoMeta === 'anthropic-messages' || protoMeta === 'openai-responses' || protoMeta === 'openai-chat')
      ? (protoMeta as any)
      : (() => { try { return this.pickProtocol(ctx); } catch { return (body && typeof body === 'object' && Array.isArray((body as any).messages)) ? 'openai-chat' : this.pickProtocol(ctx); } })();
    switch (proto) {
      case 'anthropic-messages':
        // Convert OpenAI Chat response → Anthropic Messages
        return await this.anthropicCodec.convertResponse(body, { outgoingProtocol: 'anthropic-messages' } as any, ctx as any);
      case 'openai-responses':
        // Convert OpenAI Chat response → OpenAI Responses
        return await this.responsesCodec.convertResponse(body, { outgoingProtocol: 'openai-responses' } as any, ctx as any);
      default:
        // Keep OpenAI Chat
        return await this.openaiCodec.convertResponse(body, { outgoingProtocol: 'openai-chat' } as any, ctx as any);
    }
  }
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

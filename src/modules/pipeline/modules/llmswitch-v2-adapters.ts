import type { ModuleConfig, ModuleDependencies, PipelineModule } from '../interfaces/pipeline-interfaces.js';
import path from 'path';
// Orchestration moved into llmswitch-core; adapters delegate to core bridge
import { fileURLToPath } from 'url';

// Runtime resolver: import from installed package only（严格，无兜底）
async function importCore(subpath: string): Promise<any> {
  const clean = subpath.replace(/\.js$/i, '');
  const spec = `rcc-llmswitch-core/${clean}`;
  try {
    // 动态 ESM 按包导入，依赖包内 exports 映射（独立模块负责暴露路径）
    return await import(spec);
  } catch (e) {
    const msg = (e as any)?.message || String(e);
    throw new Error(`[llmswitch] import failed: ${spec}: ${msg}`);
  }
}

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
        // 合并顶层与 data.metadata，确保 stream/entryEndpoint 等旗标传入 codec
        metadata: { ...(meta as any), ...(dataMeta as any) },
      };
    } catch { return {}; }
  }

  abstract processIncoming(request: any): Promise<unknown>;
  abstract processOutgoing(response: any): Promise<unknown>;
}

// Dynamic router: choose proper codec by entryEndpoint
export class ConversionRouterAdapter extends BaseV2Adapter {
  private orchestrator: any;
  private readonly deps: ModuleDependencies;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-conversion-router', config);
    this.orchestrator = null;
    this.deps = _dependencies;
  }

  // Chat 工具治理链在 llmswitch-core 内部的各 codec 中执行；此适配器不再触发

  private async ensureOrchestrator(): Promise<void> {
    if (this.orchestrator) return;
    const mod = await importCore('v2/conversion/switch-orchestrator');
    const { SwitchOrchestrator } = mod as any;
    const __filename = fileURLToPath(import.meta.url);
    const pkgRoot = path.resolve(path.dirname(__filename), '../../../..');
    this.orchestrator = new SwitchOrchestrator({}, {
      baseDir: pkgRoot,
      profilesPath: 'config/conversion/llmswitch-profiles.json'
    });
    // 在回退后的 core 版本中，CodecRegistry 默认不包含任何工厂；
    // 需要由宿主（routecodex）显式注册核心 codec 工厂，确保 profile 中的 codec 可解析。
    // 与 profiles 中的 "codec" 值严格对齐：
    //  - "openai-openai" → OpenAIOpenAIConversionCodec
    //  - "anthropic-openai" → AnthropicOpenAIConversionCodec
    //  - "responses-openai" → ResponsesOpenAIConversionCodec
    try {
      const factories: Record<string, () => Promise<any>> = {};
      const openaiCodecMod = await importCore('v2/conversion/codecs/openai-openai-codec');
      factories['openai-openai'] = async () => new (openaiCodecMod as any).OpenAIOpenAIConversionCodec({});

      const anthCodecMod = await importCore('v2/conversion/codecs/anthropic-openai-codec');
      factories['anthropic-openai'] = async () => new (anthCodecMod as any).AnthropicOpenAIConversionCodec({});

      const respCodecMod = await importCore('v2/conversion/codecs/responses-openai-codec');
      factories['responses-openai'] = async () => new (respCodecMod as any).ResponsesOpenAIConversionCodec({});

      this.orchestrator.registerFactories(factories);
    } catch (e) {
      const msg = (e as any)?.message || String(e);
      throw new Error(`[llmswitch] failed to register codec factories: ${msg}`);
    }
    await this.orchestrator.initialize();
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
    const __filename = fileURLToPath(import.meta.url);
    const pkgRoot = path.resolve(path.dirname(__filename), '../../../..');
    const bridge = await importCore('v2/bridge/routecodex-adapter');
    const result = await (bridge as any).processIncoming(request, { baseDir: pkgRoot, profilesPath: 'config/conversion/llmswitch-profiles.json' });
    // Normalize: some core bridge versions may return an envelope like
    // { payload, pipelineId, ... }. Downstream expects plain Chat JSON
    // (BasePipeline will wrap it into DTO). Keep DTO if already returned.
    try {
      if (result && typeof result === 'object') {
        const obj: any = result as any;
        const looksDto = ('data' in obj) && ('metadata' in obj);
        if (looksDto) return result;
        if ('payload' in obj && obj.payload && typeof obj.payload === 'object') {
          return obj.payload;
        }
      }
    } catch { /* ignore */ }
    return result;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const __filename = fileURLToPath(import.meta.url);
    const pkgRoot = path.resolve(path.dirname(__filename), '../../../..');
    const bridge = await importCore('v2/bridge/routecodex-adapter');
    const invokeSecondRound = async (dto: any, _ctx: any) => {
      try {
        // Build a SharedPipelineRequest and re-enter pipeline (non-streaming second round)
        const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        const sharedReq: any = {
          data: dto?.body,
          route: { providerId: 'unknown', modelId: String(dto?.body?.model || 'unknown'), requestId: reqId, timestamp: Date.now(), pipelineId: (response as any)?.route?.pipelineId || (response as any)?.route?.pipelineId },
          metadata: { entryEndpoint: dto?.entryEndpoint, endpoint: dto?.entryEndpoint, stream: false },
          debug: { enabled: false, stages: {} },
          entryEndpoint: dto?.entryEndpoint
        };
        // We don't have direct manager here; rely on hosting pipeline to provide a dependency callback if available
        const runner = (this.deps as any)?.invokeSecondRound;
        if (typeof runner === 'function') {
          const out = await runner(sharedReq);
          return out && out.data ? out : { data: out };
        }
        // Fallback: return original dto (no-op)
        return { data: dto?.body };
      } catch (e) {
        return { data: dto?.body };
      }
    };
    return await (bridge as any).processOutgoing(response, { baseDir: pkgRoot, profilesPath: 'config/conversion/llmswitch-profiles.json', invokeSecondRound });
  }
}

export class OpenAIOpenAIAdapter extends BaseV2Adapter {
  private codec: any;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-openai-openai', config);
    this.codec = null;
  }

  private async ensureCodec(): Promise<void> {
    if (this.codec) return;
    const mod = await importCore('v2/conversion/codecs/openai-openai-codec');
    this.codec = new (mod as any).OpenAIOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    const converted = await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
    const obj = converted as any;
    if (obj && typeof obj === 'object' && 'payload' in obj && obj.payload && typeof obj.payload === 'object') {
      return obj.payload;
    }
    return converted;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
    const ctx = this.buildContext(response);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertResponse(response.data ?? response, profile, ctx as any);
  }
}

export class AnthropicOpenAIAdapter extends BaseV2Adapter {
  private codec: any;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-anthropic-openai', config);
    this.codec = null;
  }

  private async ensureCodec(): Promise<void> {
    if (this.codec) return;
    const mod = await importCore('v2/conversion/codecs/anthropic-openai-codec');
    this.codec = new (mod as any).AnthropicOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    const converted = await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
    const obj = converted as any;
    if (obj && typeof obj === 'object' && 'payload' in obj && obj.payload && typeof obj.payload === 'object') {
      return obj.payload;
    }
    return converted;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
    const ctx = this.buildContext(response);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    return await this.codec.convertResponse(response.data ?? response, profile, ctx as any);
  }
}

export class ResponsesToChatAdapter extends BaseV2Adapter {
  private codec: any;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-response-chat', config);
    this.codec = null;
  }

  private async ensureCodec(): Promise<void> {
    if (this.codec) return;
    const mod = await importCore('v2/conversion/codecs/responses-openai-codec');
    this.codec = new (mod as any).ResponsesOpenAIConversionCodec({});
  }

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
    const ctx = this.buildContext(request);
    const profile = { outgoingProtocol: 'openai-chat' } as any;
    const converted = await this.codec.convertRequest(request.data ?? request, profile, ctx as any);
    const obj = converted as any;
    if (obj && typeof obj === 'object' && 'payload' in obj && obj.payload && typeof obj.payload === 'object') {
      return obj.payload;
    }
    return converted;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    await this.ensureCodec();
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

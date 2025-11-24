import type { ModuleConfig, ModuleDependencies, PipelineModule } from '../interfaces/pipeline-interfaces.js';
import {
  bridgeProcessIncoming,
  bridgeProcessInboundResponse,
  bridgeProcessOutboundRequest,
  bridgeProcessOutboundResponse
} from '../../llmswitch/bridge.js';
import { llmswitchPipelineRegistry, type PipelineResolution } from '../../llmswitch/pipeline-registry.js';

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
    // V3：编解码器注册和 Orchestrator 初始化交由 llmswitch-core 内部处理；
    // 此处仅保留占位，避免破坏现有调用路径。
    this.orchestrator = null;
  }

  // For unified behavior: default Responses → Chat bridge unless explicit passthrough module is used
  // No per-adapter codec instantiation here; delegate strictly to core bridge

  async processIncoming(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const descriptor = this.resolveDescriptor('inbound', 'request', ctx, request);
    this.applyDescriptorMetadata(ctx, descriptor);
    const result = await bridgeProcessIncoming(request, {
      processMode: descriptor.processMode,
      providerProtocol: descriptor.providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json',
      entryEndpoint: ctx.entryEndpoint || descriptor.entryEndpoint
    });
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

  private normalizeRequestDto(original: any, transformed: any): any {
    try {
      if (transformed && typeof transformed === 'object') {
        const obj: any = transformed as any;
        if ('data' in obj && 'metadata' in obj) {
          return { ...(original as any), ...(obj as any), route: (original as any)?.route };
        }
      }
    } catch { /* ignore */ }
    return {
      ...original,
      data: transformed
    };
  }

  private normalizeResponseDto(original: any, transformed: any): any {
    try {
      if (transformed && typeof transformed === 'object') {
        const obj: any = transformed as any;
        if ('data' in obj && 'metadata' in obj) {
          return obj;
        }
      }
    } catch { /* ignore */ }
    return {
      ...original,
      data: transformed
    };
  }

  async transformRequest(request: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(request);
    const descriptor = this.resolveDescriptor('outbound', 'request', ctx, request);
    this.applyDescriptorMetadata(ctx, descriptor);
    const result = await bridgeProcessOutboundRequest(request, {
      processMode: descriptor.processMode,
      providerProtocol: descriptor.providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json',
      entryEndpoint: ctx.entryEndpoint || descriptor.entryEndpoint
    });
    return this.normalizeRequestDto(request, result);
  }

  async transformResponse(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const descriptor = this.resolveDescriptor('inbound', 'response', ctx, response);
    this.applyDescriptorMetadata(ctx, descriptor);
    const result = await bridgeProcessInboundResponse(response, {
      processMode: descriptor.processMode,
      providerProtocol: descriptor.providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json',
      entryEndpoint: ctx.entryEndpoint || descriptor.entryEndpoint
    });
    return this.normalizeResponseDto(response, result);
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    const descriptor = this.resolveDescriptor('outbound', 'response', ctx, response);
    this.applyDescriptorMetadata(ctx, descriptor);
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
    return await bridgeProcessOutboundResponse(response, {
      processMode: descriptor.processMode,
      providerProtocol: descriptor.providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json',
      invokeSecondRound,
      entryEndpoint: ctx.entryEndpoint || descriptor.entryEndpoint
    });
  }

  private getModuleConfig(): Record<string, unknown> {
    return ((this.config as any)?.config || {}) as Record<string, unknown>;
  }

  private resolveDescriptor(stage: 'inbound' | 'outbound', phase: 'request' | 'response', ctx: Ctx, envelope?: any): PipelineResolution {
    const cfg = this.getModuleConfig();
    const entryEndpoint = ctx.entryEndpoint || ctx.endpoint;
    if (!entryEndpoint || !String(entryEndpoint).trim()) {
      throw new Error('[LLMSWITCH] 请求缺少 entryEndpoint，无法匹配流水线');
    }
    const processPreference = this.readProcessPreference(cfg, phase);
    const providerHint = this.readProviderProtocolHint(cfg, ctx, envelope);
    const descriptor = llmswitchPipelineRegistry.resolve(entryEndpoint, {
      stage,
      providerProtocol: providerHint,
      processMode: processPreference
    });
    if (!descriptor) {
      throw new Error(`[LLMSWITCH] 未在 pipeline-config 中找到 ${entryEndpoint} (stage=${stage}, phase=${phase}) 的流水线`);
    }
    if (!descriptor.providerProtocol) {
      const fallback = this.normalizeProtocol(providerHint);
      if (!fallback) {
        throw new Error(`[LLMSWITCH] 流水线 ${descriptor.id} 缺少 providerProtocol，且配置未提供 fallback`);
      }
      descriptor.providerProtocol = fallback;
    }
    return descriptor;
  }

  private applyDescriptorMetadata(ctx: Ctx, descriptor: PipelineResolution): void {
    if (!ctx.entryEndpoint) {
      ctx.entryEndpoint = descriptor.entryEndpoint;
    }
    const meta = ctx.metadata && typeof ctx.metadata === 'object' ? ctx.metadata : {};
    meta.providerProtocol = descriptor.providerProtocol;
    meta.pipelineId = descriptor.id;
    if (descriptor.streaming === 'always') {
      meta.stream = true;
    } else if (descriptor.streaming === 'never') {
      meta.stream = false;
    }
    ctx.metadata = meta;
  }

  private readProcessPreference(cfg: Record<string, unknown>, phase: 'request' | 'response'): string | undefined {
    const key = phase === 'request' ? 'requestProcess' : 'responseProcess';
    const raw = typeof cfg[key] === 'string' && (cfg[key] as string).trim() ? String(cfg[key]).trim() : undefined;
    if (raw) return raw;
    const fallback = typeof cfg.process === 'string' && cfg.process.trim() ? cfg.process.trim() : undefined;
    return fallback;
  }

  private readProviderProtocolHint(cfg: Record<string, unknown>, ctx: Ctx, envelope?: any): string | undefined {
    if (typeof cfg.providerProtocol === 'string' && cfg.providerProtocol.trim()) {
      return cfg.providerProtocol.trim();
    }
    const meta = ctx.metadata || {};
    if (typeof (meta as any).providerProtocol === 'string' && (meta as any).providerProtocol.trim()) {
      return (meta as any).providerProtocol.trim();
    }
    if (envelope && typeof envelope === 'object') {
      const envMeta = (envelope as any).metadata;
      if (envMeta && typeof envMeta === 'object' && typeof envMeta.providerProtocol === 'string' && envMeta.providerProtocol.trim()) {
        return envMeta.providerProtocol.trim();
      }
      const route = (envelope as any).route;
      if (route && typeof route === 'object' && typeof route.providerProtocol === 'string' && route.providerProtocol.trim()) {
        return route.providerProtocol.trim();
      }
    }
    return undefined;
  }

  private normalizeProtocol(value?: string): string | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const trimmed = value.trim().toLowerCase();
    return trimmed || undefined;
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
    const mod = await import('../../llmswitch/bridge.js');
    // 保持现有路径不变：OpenAI→OpenAI codec 由 core 内部管理，此处仅占位以兼容旧路径。
    this.codec = (mod as any).openaiCodec ?? null;
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
    const mod = await import('../../llmswitch/bridge.js');
    this.codec = (mod as any).anthropicCodec ?? null;
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

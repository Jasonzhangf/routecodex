import type { ModuleConfig, ModuleDependencies, PipelineModule } from '../interfaces/pipeline-interfaces.js';
import path from 'path';
// Orchestration moved into llmswitch-core; adapters delegate to bridge module
import { fileURLToPath } from 'url';
import { bridgeProcessIncoming, bridgeProcessOutgoing } from '../../llmswitch/bridge.js';

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

function resolveProcessMode(rawMode: unknown, typeLower: string): 'chat' | 'passthrough' {
  const v = typeof rawMode === 'string' ? rawMode.toLowerCase() : '';
  if (v === 'passthrough') return 'passthrough';
  if (v === 'chat') return 'chat';
  // 兼容旧配置：responses 直通模块默认采用 passthrough
  if (typeLower === 'llmswitch-responses-passthrough') return 'passthrough';
  // 默认按 chat 处理（完整 Anth↔Chat/Responses↔Chat 编解码链）
  return 'chat';
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
    // V3：编解码器注册和 Orchestrator 初始化交由 llmswitch-core 内部处理；
    // 此处仅保留占位，避免破坏现有调用路径。
    this.orchestrator = null;
  }

  // For unified behavior: default Responses → Chat bridge unless explicit passthrough module is used
  // No per-adapter codec instantiation here; delegate strictly to core bridge

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
    const typeLower = String(this.config.type || '').toLowerCase();
    const cfg: any = (this.config as any)?.config || {};
    // 请求侧优先使用 requestProcess，其次回退到通用 process
    const rawModeIn = (typeof cfg.requestProcess === 'string' ? cfg.requestProcess : cfg.process) as string | undefined;
    const processMode = resolveProcessMode(rawModeIn, typeLower);
    // providerProtocol 优先来自配置（由 config-core / assembler 注入），缺失时按入口端点推断
    let providerProtocol = String(cfg.providerProtocol || '').toLowerCase();
    if (!providerProtocol) {
      providerProtocol = this.pickProtocol(ctx);
    }
    const result = await bridgeProcessIncoming(request, {
      processMode,
      providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json'
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

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    const ctx = this.buildContext(response);
    // entryEndpoint is required; no inference here
    const typeLower = String(this.config.type || '').toLowerCase();
    const cfg: any = (this.config as any)?.config || {};
    // 响应侧优先使用 responseProcess，其次回退到通用 process
    const rawModeOut = (typeof cfg.responseProcess === 'string' ? cfg.responseProcess : cfg.process) as string | undefined;
    const processMode = resolveProcessMode(rawModeOut, typeLower);
    // 响应侧同样需要 providerProtocol，用于确定 Chat→Anth/Chat→Responses 的出口编码
    let providerProtocol = String(cfg.providerProtocol || '').toLowerCase();
    if (!providerProtocol) {
      providerProtocol = this.pickProtocol(ctx);
    }
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
    return await bridgeProcessOutgoing(response, {
      processMode,
      providerProtocol,
      profilesPath: 'config/conversion/llmswitch-profiles.json',
      invokeSecondRound
    });
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

export class ResponsesToChatAdapter extends BaseV2Adapter {
  private codec: any;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    super('llmswitch-response-chat', config);
    this.codec = null;
  }

  private async ensureCodec(): Promise<void> {
    if (this.codec) return;
    const mod = await import('../../llmswitch/bridge.js');
    this.codec = (mod as any).responsesCodec ?? null;
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

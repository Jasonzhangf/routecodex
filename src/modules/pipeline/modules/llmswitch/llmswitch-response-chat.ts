import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { PipelineDebugLogger } from '../../interfaces/pipeline-interfaces.js';
import {
  buildChatRequestFromResponses,
  buildResponsesPayloadFromChat,
  captureResponsesContext,
  extractRequestIdFromResponse,
  normalizeTools,
  type ResponsesRequestContext
} from 'rcc-llmswitch-core/conversion';
import { extractToolText } from '../../utils/tool-result-text.js';

export class ResponsesToChatLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-response-chat';
  readonly protocol = 'openai-responses';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private requestContext: Map<string, ResponsesRequestContext> = new Map();
  // Thin adapter: no runtime schema validation here (conversion path validates by orchestrator when needed)

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-response-chat-${Date.now()}`;
    this.logger = dependencies.logger;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;

    // no-op: validation handled by orchestrator conversion schemas when configured
  }

  async processIncoming(requestParam: SharedPipelineRequest | any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as Record<string, unknown>) : (requestParam as Record<string, unknown>);

    const context = captureResponsesContext(payload, dto ?? undefined);
    const { request: chatRequest, toolsNormalized } = buildChatRequestFromResponses(payload, context);
    // Normalize tool message content to text (align with Anthropic→OpenAI)
    try {
      const msgs = Array.isArray((chatRequest as any).messages) ? ((chatRequest as any).messages as any[]) : [];
      const push = (arr: string[], s?: string) => { if (typeof s === 'string') { const t = s.trim(); if (t) arr.push(t); } };
      const flattenParts = (v: any): string[] => {
        const texts: string[] = [];
        if (Array.isArray(v)) {
          for (const p of v) {
            if (!p) continue;
            if (typeof p === 'string') { push(texts, p); continue; }
            if (typeof p === 'object') {
              if (typeof (p as any).text === 'string') { push(texts, (p as any).text); continue; }
              if (typeof (p as any).content === 'string') { push(texts, (p as any).content); continue; }
              if (Array.isArray((p as any).content)) { texts.push(...flattenParts((p as any).content)); continue; }
            }
          }
        }
        return texts;
      };
      for (const m of msgs) {
        if (m && m.role === 'tool' && m.content !== undefined) {
          if (typeof m.content !== 'string') {
            m.content = extractToolText(m.content);
          }
        }
      }
      (chatRequest as any).messages = msgs;
    } catch { /* ignore content normalization errors */ }
    // Align tools declaration: normalize + strict=true
    try {
      if (Array.isArray((chatRequest as any).tools)) {
        const nt = normalizeTools((chatRequest as any).tools as any[]);
        (chatRequest as any).tools = (nt as any[]).map((t: any) => {
          if (t && t.type === 'function' && t.function && typeof t.function === 'object') {
            return { ...t, function: { ...t.function, strict: true } };
          }
          return t;
        });
      }
    } catch { /* ignore normalize errors */ }
    if (toolsNormalized) {
      context.toolsNormalized = toolsNormalized;
    }
    if (context.requestId) {
      this.requestContext.set(context.requestId, context);
    }

    // No runtime validation here; orchestrator can validate canonical schemas if configured

    const stamped = {
      ...chatRequest,
      _metadata: {
        ...(chatRequest as any)._metadata || {},
        switchType: this.type,
        timestamp: Date.now(),
        entryProtocol: 'responses',
        targetProtocol: 'openai'
      }
    } as Record<string, unknown>;

    this.logger.logTransformation(this.id, 'responses-to-chat-request', payload, stamped);

    if (isDto) {
      return {
        ...dto!,
        data: stamped,
        metadata: {
          ...(dto!.metadata || {}),
          rccResponsesContext: context
        }
      };
    }

    return {
      data: stamped,
      route: {
        providerId: 'unknown',
        modelId: 'unknown',
        requestId: context.requestId || `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: { rccResponsesContext: context },
      debug: { enabled: false, stages: {} }
    } satisfies SharedPipelineRequest;
  }

  async processOutgoing(responseParam: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    const payload = isDto ? (responseParam as SharedPipelineResponse).data : responseParam;

    const requestId = extractRequestIdFromResponse(responseParam);
    const context = requestId ? this.requestContext.get(requestId) : undefined;
    if (requestId && context) {
      this.requestContext.delete(requestId);
    }

    let converted = payload;
    if (context && context.isResponsesPayload) {
      converted = buildResponsesPayloadFromChat(payload, context);
      // No runtime validation here
    }

    this.logger.logTransformation(this.id, 'chat-to-responses', payload, converted);

    if (isDto) {
      const baseMeta = { ...((responseParam as SharedPipelineResponse).metadata || {}) } as Record<string, unknown>;
      if (context && context.isResponsesPayload) {
        (baseMeta as any).responsesStatus = (converted as any)?.status || 'completed';
      }
      return { ...(responseParam as SharedPipelineResponse), data: converted, metadata: baseMeta as any };
    }

    return converted;
  }

  async transformRequest(request: unknown): Promise<unknown> {
    const dto = await this.processIncoming(request as any);
    return dto.data;
  }

  async transformResponse(response: unknown): Promise<unknown> {
    return buildResponsesPayloadFromChat(response, undefined);
  }

  async cleanup(): Promise<void> {
    this.requestContext.clear();
    this.isInitialized = false;
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  getStats(): Record<string, unknown> {
    return {
      type: this.type,
      initialized: this.isInitialized,
      trackedRequests: this.requestContext.size,
      timestamp: Date.now()
    };
  }
}

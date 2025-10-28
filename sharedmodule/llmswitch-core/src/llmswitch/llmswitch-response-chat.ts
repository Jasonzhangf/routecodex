/**
 * Responses <-> Chat wrapper (sharedmodule)
 * Copied logic with types relaxed and internalized imports.
 */

import {
  buildChatRequestFromResponses,
  buildResponsesPayloadFromChat,
  captureResponsesContext,
  extractRequestIdFromResponse,
  normalizeTools,
  type ResponsesRequestContext
} from '../conversion/index.js';

export class ResponsesToChatLLMSwitch {
  readonly id: string;
  readonly type = 'llmswitch-response-chat';
  readonly protocol = 'openai-responses';
  readonly config: any;

  private isInitialized = false;
  private logger: any;
  private requestContext: Map<string, ResponsesRequestContext> = new Map();

  constructor(config: any, dependencies: any) {
    this.config = config;
    this.id = `llmswitch-response-chat-${Date.now()}`;
    this.logger = dependencies?.logger;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;
  }

  async processIncoming(requestParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as any) : null;
    const payload = isDto ? (dto!.data as Record<string, unknown>) : (requestParam as Record<string, unknown>);

    const context = captureResponsesContext(payload, dto ?? undefined);
    const { request: chatRequest, toolsNormalized } = buildChatRequestFromResponses(payload, context);

    try {
      const msgs = Array.isArray((chatRequest as any).messages) ? ((chatRequest as any).messages as any[]) : [];
      for (const m of msgs) {
        if (m && m.role === 'tool' && m.content !== undefined) {
          if (typeof m.content !== 'string') {
            try { m.content = JSON.stringify(m.content); } catch { m.content = String(m.content); }
          }
        }
      }
      (chatRequest as any).messages = msgs;
    } catch { /* ignore */ }

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
    } catch { /* ignore */ }
    if (toolsNormalized) { (context as any).toolsNormalized = toolsNormalized; }
    if ((context as any).requestId) { this.requestContext.set((context as any).requestId!, context); }

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

    this.logger?.logTransformation?.(this.id, 'responses-to-chat-request', payload, stamped);

    if (isDto) {
      return {
        ...dto!,
        data: stamped,
        metadata: {
          ...(dto as any)?.metadata || {},
          rccResponsesContext: context
        }
      };
    }

    return {
      data: stamped,
      route: { providerId: 'unknown', modelId: 'unknown', requestId: (context as any).requestId || `req_${Date.now()}`, timestamp: Date.now() },
      metadata: { rccResponsesContext: context },
      debug: { enabled: false, stages: {} }
    };
  }

  async processOutgoing(responseParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();

    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    const payload = isDto ? (responseParam as any).data : responseParam;

    const requestId = extractRequestIdFromResponse(responseParam);
    const context = requestId ? this.requestContext.get(requestId) : undefined;
    if (requestId && context) { this.requestContext.delete(requestId); }

    let converted = payload;
    if (context && (context as any).isResponsesPayload) {
      converted = buildResponsesPayloadFromChat(payload, context);
    }

    this.logger?.logTransformation?.(this.id, 'chat-to-responses', payload, converted);

    if (isDto) {
      const baseMeta = { ...((responseParam as any).metadata || {}) } as Record<string, unknown>;
      if (context && (context as any).isResponsesPayload) {
        (baseMeta as any).responsesStatus = (converted as any)?.status || 'completed';
      }
      return { ...(responseParam as any), data: converted, metadata: baseMeta as any };
    }
    return converted;
  }

  async transformRequest(request: unknown): Promise<unknown> {
    const dto = await this.processIncoming(request as any);
    return (dto as any).data;
  }

  async transformResponse(response: unknown): Promise<unknown> {
    return buildResponsesPayloadFromChat(response, undefined);
  }

  async cleanup(): Promise<void> { this.requestContext.clear(); this.isInitialized = false; }
  async dispose(): Promise<void> { await this.cleanup(); }
  getStats(): Record<string, unknown> { return { type: this.type, initialized: this.isInitialized, trackedRequests: this.requestContext.size, timestamp: Date.now() }; }
}


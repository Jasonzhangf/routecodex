/**
 * Responses passthrough wrapper (sharedmodule)
 * Types relaxed; behavior identical to root wrapper.
 */

export class ResponsesPassthroughLLMSwitch {
  readonly id: string;
  readonly type = 'llmswitch-responses-passthrough';
  readonly protocol = 'openai-responses';
  readonly config: any;
  private isInitialized = false;
  private logger: any;

  constructor(config: any, dependencies: any) {
    this.config = config;
    this.id = `llmswitch-responses-passthrough-${Date.now()}`;
    this.logger = dependencies?.logger;
  }

  async initialize(): Promise<void> { if (!this.isInitialized) this.isInitialized = true; }

  async processIncoming(requestParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();
    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as any) : null;
    const payload = isDto ? (dto!.data as Record<string, unknown>) : (requestParam as Record<string, unknown>);

    if (!payload || typeof payload !== 'object') {
      const e: any = new Error('Responses payload must be an object');
      (e as any).status = 400; throw e;
    }

    const stamped = {
      ...payload,
      _metadata: {
        ...(payload as any)?._metadata || {},
        switchType: this.type,
        timestamp: Date.now(),
        entryProtocol: 'responses',
        targetProtocol: 'responses'
      }
    } as Record<string, unknown>;

    this.logger?.logTransformation?.(this.id, 'responses-passthrough-request', payload, stamped);

    return isDto
      ? { ...(dto as any), data: stamped }
      : ({ data: stamped, route: { providerId: 'unknown', modelId: 'responses', requestId: `req_${Date.now()}`, timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as any);
  }

  async processOutgoing(responseParam: any): Promise<any> {
    if (!this.isInitialized) await this.initialize();
    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    const payload = isDto ? (responseParam as any).data : responseParam;
    this.logger?.logTransformation?.(this.id, 'responses-passthrough-response', payload, payload);
    return responseParam;
  }

  async transformRequest(request: unknown): Promise<unknown> { return request; }
  async transformResponse(response: unknown): Promise<unknown> { return response; }
  async cleanup(): Promise<void> { this.isInitialized = false; }
  async dispose(): Promise<void> { await this.cleanup(); }
  getStats(): Record<string, unknown> { return { type: this.type, initialized: this.isInitialized, timestamp: Date.now() }; }
}


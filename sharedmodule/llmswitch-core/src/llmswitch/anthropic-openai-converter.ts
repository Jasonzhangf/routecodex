// Minimal stub matching root behavior; kept for build compatibility

export class AnthropicOpenAIConverter {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai';
  readonly config: any;
  constructor(config?: any, _deps?: any) {
    this.id = `llmswitch-anthropic-openai-stub-${Date.now()}`;
    this.config = config || { type: 'llmswitch-anthropic-openai', config: {} };
  }
  async initialize(): Promise<void> { /* no-op */ }
  async processIncoming(request: any): Promise<any> { return request; }
  async processOutgoing(response: any): Promise<any> { return response; }
  async cleanup(): Promise<void> { /* no-op */ }
  convertOpenAIRequestToAnthropic(request: unknown): unknown { return request; }
  convertAnthropicRequestToOpenAI(request: unknown): unknown { return request; }
}


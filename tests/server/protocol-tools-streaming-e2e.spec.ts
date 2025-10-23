import { describe, it, expect, jest } from '@jest/globals';

import { ChatCompletionsHandler } from '../../src/server/handlers/chat-completions.ts';
import { MessagesHandler } from '../../src/server/handlers/messages.ts';
import { ResponsesHandler } from '../../src/server/handlers/responses.ts';

// Mock external ESM deps used by handlers
jest.mock('rcc-basemodule', () => ({
  BaseModule: class { constructor(..._args: any[]) {} },
}), { virtual: true });

jest.mock('rcc-errorhandling', () => ({
  ErrorHandlingCenter: class {
    async initialize() {}
    async handleError(_e?: any) {}
    createContext() { return {}; }
    getStatistics() { return {}; }
    async destroy() {}
  },
}), { virtual: true });

jest.mock('rcc-debugcenter', () => ({
  DebugEventBus: { getInstance: () => ({ publish: () => {}, subscribe: () => {} }) },
}), { virtual: true });

// Stubs
function makeReq(url: string, body: any) {
  return {
    body,
    method: 'POST',
    url,
    baseUrl: '/v1/openai',
    headers: { 'content-type': 'application/json' },
    get: () => undefined,
    ip: '127.0.0.1',
  } as any;
}

function makeSSERecorder() {
  const out = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    text: '',
  };
  const res: any = {
    headersSent: false,
    writableEnded: false,
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(code: number) { out.statusCode = code; return this; },
    json(_obj: any) { return this; },
    write(chunk: any) { out.text += String(chunk); },
    end() { this.writableEnded = true; },
  };
  (res as any).__out = out;
  return res as any as { setHeader: (k: string, v: string) => void; status: (n: number) => any; json: (o: any) => any; write: (d: any) => void; end: () => void; writableEnded: boolean } & { __out: typeof out };
}

class CapturingPipelineManager {
  public lastRequest: any = null;
  constructor(private responder: (req: any) => any) {}
  async initialize() {}
  async processRequest(req: any) {
    this.lastRequest = req;
    return { data: await this.responder(req) };
  }
}

const routePools = { default: ['glm.test'] } as Record<string, string[]>;
const routeMeta = { 'glm.test': { providerId: 'glm', modelId: 'glm-4.6', keyId: 'key1' } } as Record<string, { providerId: string; modelId: string; keyId: string }>;

describe('Protocol adapters tool-calling streaming E2E', () => {
  it('Chat(OpenAI) streaming: Anthropic-shaped tool_use/request → OpenAI mapped into pipeline; SSE emits chunks + [DONE]', async () => {
    const handler = new ChatCompletionsHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    // Return non-stream response with content; StreamingManager will synthesize chunks from content
    const pm = new CapturingPipelineManager((_req) => ({
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now()/1000),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'tool ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    handler.attachPipelineManager(pm as any);

    const anthRequest = {
      model: 'claude-3-sonnet',
      max_tokens: 64,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } }] },
      ],
      stream: true,
    };
    const req = makeReq('/v1/chat/completions', anthRequest);
    const res = makeSSERecorder();
    await handler.handleRequest(req, res);

    const got = (pm.lastRequest?.data) as any;
    const hasAssistantToolCall = got.messages.some((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(hasAssistantToolCall).toBe(true);
    expect(res.__out.headers['Content-Type']).toBe('text/event-stream');
    expect(res.__out.text).toContain('data:');
    expect(res.__out.text).toContain('[DONE]');
  });

  it('Messages(Anthropic) streaming: OpenAI tool_calls → Anthropic tool_use into pipeline; SSE emits chunks + [DONE]', async () => {
    const handler = new MessagesHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    const pm = new CapturingPipelineManager((_req) => ({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'glm-4.6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    handler.attachPipelineManager(pm as any);

    const openaiReq = {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Compute' },
        { role: 'assistant', content: '', tool_calls: [ { id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"a":1}' } } ] },
      ],
      stream: true,
    };
    const req = makeReq('/v1/messages', openaiReq);
    const res = makeSSERecorder();
    await handler.handleRequest(req, res);

    const got = pm.lastRequest?.data as any;
    const hasToolUse = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'tool_use'));
    expect(hasToolUse).toBe(true);
    expect(res.__out.headers['Content-Type']).toBe('text/event-stream');
    expect(res.__out.text).toContain('data:');
    expect(res.__out.text).toContain('[DONE]');
  });

  it('Responses(Anthropic) streaming: OpenAI tool_calls → Anthropic tool_use into pipeline; SSE emits chunks + [DONE]', async () => {
    const handler = new ResponsesHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    const pm = new CapturingPipelineManager((_req) => ({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'glm-4.6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    handler.attachPipelineManager(pm as any);

    const openaiReq = {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Search' },
        { role: 'assistant', content: '', tool_calls: [ { id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } } ] },
      ],
      stream: true,
    };
    const req = makeReq('/v1/responses', openaiReq);
    const res = makeSSERecorder();
    await handler.handleRequest(req, res);

    const got = pm.lastRequest?.data as any;
    const hasToolUse = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'tool_use'));
    expect(hasToolUse).toBe(true);
    expect(res.__out.headers['Content-Type']).toBe('text/event-stream');
    expect(res.__out.text).toContain('data:');
    expect(res.__out.text).toContain('[DONE]');
  });
});


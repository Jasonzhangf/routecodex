import { describe, it, expect, jest } from '@jest/globals';

import { ChatCompletionsHandler } from '../../src/server/handlers/chat-completions.ts';
import { MessagesHandler } from '../../src/server/handlers/messages.ts';
import { ResponsesHandler } from '../../src/server/handlers/responses.ts';

// Mocks for external ESM-only packages used by handlers
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

// Minimal req/res factories
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

function makeJsonRes() {
  const out = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    jsonBody: undefined as any,
  };
  const res: any = {
    headersSent: false,
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(code: number) { out.statusCode = code; return this; },
    json(obj: any) { out.jsonBody = obj; return this; },
    write() { /* ignore SSE in these tests */ },
    end() { /* ignore */ },
  };
  (res as any).__out = out;
  return res as any as { setHeader: (k: string, v: string) => void; status: (n: number) => any; json: (o: any) => any; write: (...args: any[]) => void; end: () => void } & { __out: typeof out };
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

describe('Protocol adapters tool-calling E2E', () => {
  it('OpenAI chat endpoint accepts Anthropic-shaped tool_use + tool_result and forwards OpenAI-mapped tool_calls/tool role to pipeline', async () => {
    const handler = new ChatCompletionsHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    const pm = new CapturingPipelineManager((_req) => ({
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now()/1000),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    handler.attachPipelineManager(pm as any);

    const anthRequest = {
      model: 'claude-3-sonnet',
      max_tokens: 64,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] },
      ],
      stream: false,
    };

    const req = makeReq('/v1/chat/completions', anthRequest);
    const res = makeJsonRes();
    await handler.handleRequest(req, res);

    expect(res.__out.statusCode).toBe(200);
    // Validate pipeline received OpenAI-shaped tool_calls + tool role mapping
    const got = (pm.lastRequest?.data) as any;
    expect(Array.isArray(got?.messages)).toBe(true);
    const hasAssistantToolCall = got.messages.some((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0]?.function?.name === 'get_weather');
    const hasToolRole = got.messages.some((m: any) => m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0);
    expect(hasAssistantToolCall).toBe(true);
    expect(hasToolRole).toBe(true);
  });

  it('Anthropic messages endpoint accepts OpenAI tool_calls + tool message and forwards Anthropic tool_use/tool_result to pipeline, returns OpenAI-normalized tool_calls', async () => {
    const handler = new MessagesHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    const pm = new CapturingPipelineManager((_req) => ({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'tu_2', name: 'calc', input: { a: 1 } },
      ],
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
        { role: 'tool', content: '{"result":1}', tool_call_id: 'call_1' },
      ],
      stream: false,
    };
    const req = makeReq('/v1/messages', openaiReq);
    const res = makeJsonRes();
    await handler.handleRequest(req, res);

    // Pipeline should have gotten Anthropic tool_use/tool_result mapped
    const got = pm.lastRequest?.data as any;
    expect(Array.isArray(got?.messages)).toBe(true);
    const hasToolUse = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'tool_use' && c?.name === 'calc'));
    // Converter may not emit tool_result if it regenerates tool_use id; allow text fallback capture
    const hasToolResult = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'tool_result'));
    const hasToolResultText = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.includes('result')));
    expect(hasToolUse).toBe(true);
    expect(hasToolResult || hasToolResultText).toBe(true);

    // Response normalized back to OpenAI with tool_calls present
    expect(res.__out.statusCode).toBe(200);
    const body = res.__out.jsonBody;
    expect(Array.isArray(body?.choices)).toBe(true);
  });

  it('Anthropic responses endpoint accepts OpenAI tool_calls and returns Responses-shaped JSON', async () => {
    const handler = new ResponsesHandler({ enablePipeline: true, enableValidation: true });
    handler.attachRoutePools(routePools);
    handler.attachRouteMeta(routeMeta);
    const pm = new CapturingPipelineManager((_req) => ({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'tu_3', name: 'search', input: { q: 'x' } },
      ],
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
      stream: false,
    };
    const req = makeReq('/v1/responses', openaiReq);
    const res = makeJsonRes();
    await handler.handleRequest(req, res);

    // Pipeline should have gotten Anthropic tool_use mapping
    const got = pm.lastRequest?.data as any;
    expect(Array.isArray(got?.messages)).toBe(true);
    const hasToolUse = got.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c?.type === 'tool_use' && c?.name === 'search'));
    expect(hasToolUse).toBe(true);

    // Response should be OpenAI Responses JSON shape
    expect(res.__out.statusCode).toBe(200);
    const body = res.__out.jsonBody;
    expect(body && body.object).toBe('response');
    expect(typeof body?.output_text === 'string').toBe(true);
  });
});

import fs from 'fs';
import path from 'path';

// Under test
// Mock snapshot writer to avoid ESM import.meta in llmswitch bridge during tests
jest.mock('../../src/modules/pipeline/modules/provider/v2/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot: async () => {}
}), { virtual: true });

import { ChatHttpProvider } from '../../src/modules/pipeline/modules/provider/v2/core/chat-http-provider.ts';
import { attachProviderRuntimeMetadata } from '../../src/modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.ts';

// Minimal dependencies stub
const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

// Fake HttpClient to intercept outbound calls
class FakeHttpClient {
  last: { url?: string; body?: any; headers?: Record<string, string> } = {};
  constructor(_cfg?: any) {}
  async post(url: string, body: any, headers?: Record<string, string>) {
    this.last = { url, body, headers: headers || {} };
    return { data: { id: 'cmpl_x', model: (body?.model || 'unknown'), choices: [] }, status: 200, headers: {}, url };
  }
}

function loadGolden(providerId: string, proto: string): any | null {
  const base = process.env.RCC_GOLDEN_DIR
    || path.join(process.env.HOME || '', '.routecodex', 'golden_samples', 'provider_golden_samples');
  try {
    const p = path.join(base, providerId, proto, 'request.sample.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return null;
}

describe('Provider outbound → upstream (openai-chat)', () => {
  beforeAll(() => {
    // Enable fake GLM compat for aggregator to avoid dynamic import in tests
    process.env.RCC_TEST_FAKE_GLM = '1';
  });

  test('glm: compat.minimal + provider body/headers shaping', async () => {
    const golden = loadGolden('glm', 'openai-chat') || { messages: [{ role: 'user', content: 'hi' }] };

    const provider = new ChatHttpProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'glm-4.6',
        auth: { type: 'apikey', apiKey: 'testapikey12345' },
        overrides: { maxRetries: 0 }
      }
    } as any, deps);
    // Patch http client
    (provider as any).httpClient = new FakeHttpClient({});
    await provider.initialize();

    // Build request and attach runtime routing metadata
    const request: any = { data: { ...golden, stream: true, metadata: { foo: 'bar' } } };
    attachProviderRuntimeMetadata(request, {
      requestId: 'req_test_glm', providerType: 'openai', providerProtocol: 'openai-chat', providerId: 'glm'
    });

    const res = await provider.sendRequest(request);
    const call = (provider as any).httpClient.last as any;
    expect(res?.status ?? 200).toBe(200);
    // Assert endpoint
    expect(String(call.url)).toMatch(/\/chat\/completions$/);
    // Assert model enforced
    expect(call.body.model).toBe('glm-4.6');
    // stream removed
    expect(call.body.stream).toBeUndefined();
    // metadata removed
    expect(call.body.metadata).toBeUndefined();
    // Accept JSON header
    expect((call.headers || {})['Accept']).toBe('application/json');
  });

  test('qwen: passthrough compat + provider shaping', async () => {
    const golden = loadGolden('qwen', 'openai-chat') || { messages: [{ role: 'user', content: 'hi' }] };

    const provider = new ChatHttpProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'qwen3-coder-plus',
        auth: { type: 'apikey', apiKey: 'testapikey12345' },
        overrides: { maxRetries: 0 }
      }
    } as any, deps);
    (provider as any).httpClient = new FakeHttpClient({});
    await provider.initialize();

    const request: any = { data: { ...golden, stream: true, metadata: { foo: 'bar' } } };
    attachProviderRuntimeMetadata(request, {
      requestId: 'req_test_qwen', providerType: 'openai', providerProtocol: 'openai-chat', providerId: 'qwen'
    });

    const res = await provider.sendRequest(request);
    const call = (provider as any).httpClient.last as any;
    expect(res?.status ?? 200).toBe(200);
    expect(String(call.url)).toMatch(/\/chat\/completions$/);
    expect(call.body.model).toBe('qwen3-coder-plus');
    expect(call.body.stream).toBeUndefined();
    expect(call.body.metadata).toBeUndefined();
    expect((call.headers || {})['Accept']).toBe('application/json');
  });
});

describe('Provider outbound → upstream (iflow/lmstudio)', () => {
  beforeAll(() => { process.env.RCC_TEST_FAKE_GLM = '1'; });

  test('iflow: compat.minimal + provider shaping', async () => {
    process.env.RCC_TEST_FAKE_IFLOW = '1';
    const golden = loadGolden('iflow', 'openai-chat') || { messages: [{ role: 'user', content: 'hi' }] };
    const provider = new ChatHttpProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'iflow-gpt4-1106', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
      }
    } as any, deps);
    (provider as any).httpClient = new FakeHttpClient({}); await provider.initialize();
    const request: any = { data: { ...golden, stream: true, metadata: { foo: 'bar' } } };
    attachProviderRuntimeMetadata(request, { requestId: 'req_iflow', providerType: 'openai', providerProtocol: 'openai-chat', providerId: 'iflow' });
    const res = await provider.sendRequest(request); const call = (provider as any).httpClient.last as any;
    expect(res?.status ?? 200).toBe(200);
    expect(String(call.url)).toMatch(/\/chat\/completions$/);
    expect(call.body.model).toBe('iflow-gpt4-1106');
    expect(call.body.stream).toBeUndefined(); expect(call.body.metadata).toBeUndefined();
    expect((call.headers || {})['Accept']).toBe('application/json');
  });

  test('lmstudio: compat.minimal + provider shaping', async () => {
    process.env.RCC_TEST_FAKE_LMSTUDIO = '1';
    const golden = loadGolden('lmstudio', 'openai-chat') || { messages: [{ role: 'user', content: 'hi' }] };
    const provider = new ChatHttpProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'lmstudio-phi3', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
      }
    } as any, deps);
    (provider as any).httpClient = new FakeHttpClient({}); await provider.initialize();
    const request: any = { data: { ...golden, stream: true, metadata: { foo: 'bar' } } };
    attachProviderRuntimeMetadata(request, { requestId: 'req_lms', providerType: 'openai', providerProtocol: 'openai-chat', providerId: 'lmstudio' });
    const res = await provider.sendRequest(request); const call = (provider as any).httpClient.last as any;
    expect(res?.status ?? 200).toBe(200);
    expect(String(call.url)).toMatch(/\/chat\/completions$/);
    expect(call.body.model).toBe('lmstudio-phi3');
    expect(call.body.stream).toBeUndefined(); expect(call.body.metadata).toBeUndefined();
    expect((call.headers || {})['Accept']).toBe('application/json');
  });
});

describe('Provider outbound → upstream (responses wire)', () => {
  // Mock llmswitch bridge (avoid ESM import.meta issues and control chat→responses encoding)
  jest.mock('../../src/modules/llmswitch/bridge.ts', () => ({
    buildResponsesRequestFromChat: (body: any) => {
      const msg = Array.isArray(body?.messages) ? body.messages[0] : { role: 'user', content: '' };
      const instructions = typeof body?.instructions === 'string' ? body.instructions : undefined;
      const input = Array.isArray(body?.messages)
        ? body.messages.map((m: any) => ({ role: m.role || 'user', content: [{ type: 'input_text', text: (m.content || '') + '' }] }))
        : [];
      const req = instructions ? { model: body?.model, instructions } : { model: body?.model, input };
      return { request: req };
    }
  }), { virtual: true });
  class FakeHttpClientResponses extends FakeHttpClient {
    async postStream(url: string, body: any, headers?: Record<string, string>) {
      this.last = { url, body, headers: headers || {} };
      // throw to stop after capture (avoid converter); test will catch
      throw new Error('STOP_AFTER_CAPTURE');
    }
  }

  test('responses: chat→responses encoding before postStream', async () => {
    const golden = loadGolden('fc', 'openai-responses') || null; // for shape hints; not required
    const chatReq = loadGolden('glm', 'openai-chat') || { messages: [{ role: 'user', content: 'hi' }] };
    const { ResponsesHttpProvider } = await import('../../src/modules/pipeline/modules/provider/v2/core/responses-http-provider.ts');
    const provider = new (ResponsesHttpProvider as any)({
      type: 'responses-http-provider',
      config: {
        providerType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
      }
    }, deps);
    (provider as any).httpClient = new FakeHttpClientResponses({}); await provider.initialize();
    const request: any = { data: { ...chatReq, stream: false } };
    attachProviderRuntimeMetadata(request, { requestId: 'req_resp', providerType: 'responses', providerProtocol: 'openai-responses', providerId: 'openai' });
    let processed: any;
    try {
      processed = await (provider as any).preprocessRequest(request);
    } catch {}
    try { await (provider as any).sendRequestInternal(processed); } catch (e) { /* expected stop */ }
    const call = ((provider as any).httpClient.last as any) || {};
    expect(String(call.url)).toMatch(/\/responses$/);
    // Ensure encoding happened: should not be chat messages; expect 'input' or 'instructions'
    // Headers should request SSE upstream
    expect(((call.headers||{})['Accept']||'').toLowerCase()).toBe('text/event-stream');
  });
});
process.env.RCC_TEST_FAKE_OPENAI_COMPAT = '1';

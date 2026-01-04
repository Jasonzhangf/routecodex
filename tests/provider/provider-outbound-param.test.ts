import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// Stubs and mocks
jest.mock('../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot: async () => {}
}), { virtual: true });

// bridge mock for responses encoding (avoid ESM import.meta and control shape)
jest.mock('../../src/modules/llmswitch/bridge.ts', () => ({
  buildResponsesRequestFromChat: (body: any) => {
    const input = Array.isArray(body?.messages)
      ? body.messages.map((m: any) => ({ role: m.role || 'user', content: [{ type: 'input_text', text: (m.content || '') + '' }] }))
      : [];
    return { request: { model: body?.model || 'gpt-4o-mini', input } };
  }
}), { virtual: true });

import { ChatHttpProvider } from '../../src/providers/core/runtime/chat-http-provider.ts';
import { AnthropicHttpProvider } from '../../src/providers/core/runtime/anthropic-http-provider.ts';
import { attachProviderRuntimeMetadata } from '../../src/providers/core/runtime/provider-runtime-metadata.ts';

// Lazy import for Responses to allow mock above
const importResponsesProvider = async () => (await import('../../src/providers/core/runtime/responses-http-provider.ts')).ResponsesHttpProvider as any;

const deps: any = { logger: { logModule: () => {}, logProviderRequest: () => {} }, errorHandlingCenter: { handleError: async () => {} } };

class FakeHttpClient {
  last: { url?: string; body?: any; headers?: Record<string, string> } = {};
  constructor(_cfg?: any) {}
  async post(url: string, body: any, headers?: Record<string, string>) {
    this.last = { url, body, headers: headers || {} };
    return { data: { ok: true }, status: 200, headers: {}, url };
  }
}
class FakeHttpClientResponses extends FakeHttpClient {
  async postStream(url: string, body: any, headers?: Record<string, string>) {
    this.last = { url, body, headers: headers || {} };
    throw new Error('STOP_AFTER_CAPTURE');
  }
}

function listChatAggregates(limit = 3): string[] {
  const base = path.join(process.env.HOME || '', '.routecodex', 'codex-samples', 'openai-chat');
  if (!fs.existsSync(base)) return [];
  const files = fs.readdirSync(base).filter(f => f.endsWith('_pipeline.aggregate.json'));
  return files.slice(0, limit).map(f => path.join(base, f));
}

function extractChatMessagesFromAggregate(file: string): any[] {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Prefer inputData.choices[0].message or reconstruct a user message from previous http-request
    const outChoices = doc?.outputData?.choices; // often assistant output
    const inChoices = doc?.inputData?.choices; // chat completion inbound
    const pick = Array.isArray(inChoices) && inChoices.length ? inChoices : (Array.isArray(outChoices) ? outChoices : []);
    const msg = pick[0]?.message;
    if (msg && typeof msg === 'object') {
      if (typeof msg.content === 'string') return [{ role: 'user', content: msg.content }];
      if (Array.isArray(msg.content)) return [{ role: 'user', content: JSON.stringify(msg.content) }];
    }
  } catch {}
  return [{ role: 'user', content: 'hi' }];
}

describe('Param: chat → all providers (openai/responses/anthropic)', () => {
  const aggregates = listChatAggregates(3);
  if (aggregates.length === 0) {
    test.skip('no codex-samples found; skipping', () => {});
    return;
  }

  for (const agg of aggregates) {
    const name = path.basename(agg);
    describe(name, () => {
      const messages = extractChatMessagesFromAggregate(agg);

      test('openai-standard outbound', async () => {
        const provider = new ChatHttpProvider({
          type: 'openai-standard',
          config: {
            providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
          }
        } as any, deps);
        (provider as any).httpClient = new FakeHttpClient({}); await provider.initialize();
        const request: any = { data: { messages, model: 'gpt-4o-mini', stream: true, metadata: { debug: true } } };
        attachProviderRuntimeMetadata(request, { requestId: 'req_param_openai', providerType: 'openai', providerProtocol: 'openai-chat', providerId: 'openai' });
        // Bypass response composite shape check (outbound test only cares about request shaping)
        (provider as any).postprocessResponse = async (r: any) => r;
        const res = await provider.sendRequest(request);
        const call = (provider as any).httpClient.last as any;
        expect(res?.status ?? 200).toBe(200);
        expect(String(call.url)).toMatch(/\/chat\/completions$/);
        expect(call.body.model).toBe('gpt-4o-mini');
        expect(call.body.stream).toBeUndefined(); expect(call.body.metadata).toBeUndefined();
        expect(((call.headers||{})['Accept']||'').toLowerCase()).toBe('application/json');
      });

      test('responses outbound', async () => {
        const ResponsesHttpProvider = await importResponsesProvider();
        const provider = new ResponsesHttpProvider({
          type: 'responses-http-provider',
          config: {
            providerType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
          }
        }, deps);
        (provider as any).httpClient = new FakeHttpClientResponses({}); await provider.initialize();
        const request: any = { data: { messages, stream: false } };
        attachProviderRuntimeMetadata(request, { requestId: 'req_param_responses', providerType: 'responses', providerProtocol: 'openai-responses', providerId: 'openai' });
        let processed: any; try { processed = await (provider as any).preprocessRequest(request); } catch {}
        try { await (provider as any).sendRequestInternal(processed); } catch {}
        const call = (provider as any).httpClient.last as any;
        expect(String(call.url)).toMatch(/\/responses$/);
        expect(((call.headers||{})['Accept']||'').toLowerCase()).toBe('text/event-stream');
      });

      test('anthropic outbound', async () => {
        const provider = new AnthropicHttpProvider({
          type: 'anthropic-http-provider',
          config: {
            providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet', auth: { type: 'apikey', apiKey: 'testapikey12345' }, overrides: { maxRetries: 0 }
          }
        } as any, deps);
        (provider as any).httpClient = new FakeHttpClient({}); await provider.initialize();
        const request: any = { data: { messages, model: 'claude-3-5-sonnet', stream: true, metadata: { debug: true } } };
        attachProviderRuntimeMetadata(request, { requestId: 'req_param_anthropic', providerType: 'anthropic', providerProtocol: 'anthropic-messages', providerId: 'anthropic' });
        (provider as any).postprocessResponse = async (r: any) => r;
        const res = await provider.sendRequest(request);
        const call = (provider as any).httpClient.last as any;
        expect(res?.status ?? 200).toBe(200);
        expect(String(call.url)).toMatch(/\/v1\/messages$/);
        expect(((call.headers||{})['Accept']||'').toLowerCase()).toBe('application/json');
      });
    });
  }
});
process.env.RCC_TEST_FAKE_OPENAI_COMPAT = '1';

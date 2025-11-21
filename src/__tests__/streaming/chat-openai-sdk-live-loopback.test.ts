import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { aggregateOpenAIChatSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-chat-sse.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readGLMConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const j = JSON.parse(raw);
    const baseURL = j?.virtualrouter?.providers?.glm?.baseURL || j?.virtualrouter?.providers?.glm?.baseUrl;
    const apiKey = j?.virtualrouter?.providers?.glm?.auth?.apiKey || (Array.isArray(j?.virtualrouter?.providers?.glm?.apiKey) ? j.virtualrouter.providers.glm.apiKey[0] : undefined);
    const model = 'glm-4.6';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch {
    return null;
  }
}

async function linesFromSDKStream(stream: any): Promise<string[]> {
  const lines: string[] = [];
  for await (const chunk of stream) {
    lines.push('data: ' + JSON.stringify(chunk) + '\n\n');
  }
  lines.push('data: [DONE]\n\n');
  return lines;
}

function readableFromLines(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l); r.push(null); });
  return r;
}

describe('OpenAI SDK live loopback via GLM endpoint', () => {
  const cfg = readGLMConfig();
  if (!cfg) {
    test('skip: missing GLM config', () => expect(true).toBe(true));
    return;
  }
  jest.setTimeout(60000);

  test('text streaming roundtrip', async () => {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    const messages = [{ role: 'user' as const, content: '请用简体中文打个招呼' }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, stream: true });
    const originLines = await linesFromSDKStream(stream);
    const aggregated = await aggregateOpenAIChatSSEToJSON(readableFromLines(originLines));
    const ourSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: 'glm_text_rt' });
    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(ourSSE as unknown as Readable)
    );
    if (!eq.equal) {
      throw new Error('tool roundtrip mismatch: ' + JSON.stringify(eq));
    }
    expect(eq.equal).toBe(true);
  });

  test('tool streaming roundtrip', async () => {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    const messages = [{ role: 'user' as const, content: '请调用 search 工具查询 hello' }];
    const tools = [{ type: 'function' as const, function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, tools, stream: true });
    const originLines = await linesFromSDKStream(stream);
    const aggregated = await aggregateOpenAIChatSSEToJSON(readableFromLines(originLines));
    const ourSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: 'glm_tool_rt' });
    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(ourSSE as unknown as Readable)
    );
    expect(eq.equal).toBe(true);
  });
});

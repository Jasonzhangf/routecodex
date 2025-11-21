import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { Readable, PassThrough } from 'stream';
import OpenAI from 'openai';
import { aggregateOpenAIChatSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-chat-sse.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readGLMConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const j = JSON.parse(raw);
    const baseURL = j?.virtualrouter?.providers?.glm?.baseURL || j?.virtualrouter?.providers?.glm?.baseUrl || 'http://127.0.0.1:0/api/coding/paas/v4';
    const apiKey = j?.virtualrouter?.providers?.glm?.auth?.apiKey || (Array.isArray(j?.virtualrouter?.providers?.glm?.apiKey) ? j.virtualrouter.providers.glm.apiKey[0] : 'test-key');
    return { baseURL, apiKey };
  } catch {
    return { baseURL: 'http://127.0.0.1:0/api/coding/paas/v4', apiKey: 'test-key' };
  }
}

function buildSSEWriter(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  return (obj: any) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
}

function randomId(prefix: string) { return `${prefix}_${Math.random().toString(36).slice(2,10)}`; }

function createOriginServer(expectedKey: string, basePath: string): Promise<{ server: http.Server; port: number } > {
  const app = express();
  app.use(bodyParser.json({ limit: '1mb' }));
  const route = path.posix.join('/', basePath.replace(/^https?:\/\/[^/]+\//, ''), 'chat/completions');
  app.post(route, (req, res) => {
    try {
      const auth = String(req.headers['authorization'] || '');
      if (!auth.endsWith(expectedKey)) { return res.status(401).json({ error: { message: 'invalid key' } }); }
      const body = req.body || {};
      const wantsSSE = body.stream === true;
      if (!wantsSSE) return res.status(200).json({ id: randomId('chatcmpl_json'), object: 'chat.completion', model: body.model || 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'JSON path' }, finish_reason: 'stop' }] });
      const write = buildSSEWriter(res);
      const id = randomId('chatcmpl_ORG');
      const created = Math.floor(Date.now()/1000);
      const model = body.model || 'gpt-4o-mini';
      // First role
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      if (Array.isArray(body.tools) && body.tools.length) {
        // Tool path: emit name then arguments in two chunks
        const callId = randomId('call');
        write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: body.tools?.[0]?.function?.name || 'search' } }] }, finish_reason: null }] });
        write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { arguments: '{"q":"hel' } }] }, finish_reason: null }] });
        write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { arguments: 'lo"}' } }] }, finish_reason: null }] });
        write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // Text path
      const content = '你好，这是流式测试';
      for (const ch of content.match(/.{1,6}/g) || []) {
        write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
      }
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      res.status(500).json({ error: { message: String(e?.message || e) } });
    }
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function createSinkServer(expectedKey: string, basePath: string, sseReadable: Readable): Promise<{ server: http.Server; port: number } > {
  const app = express();
  app.use(bodyParser.json({ limit: '1mb' }));
  const route = path.posix.join('/', basePath.replace(/^https?:\/\/[^/]+\//, ''), 'chat/completions');
  app.post(route, (_req, res) => {
    const passthrough = new PassThrough();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    sseReadable.pipe(passthrough).pipe(res);
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function linesFromSDKStream(stream: any): Promise<string[]> {
  return new Promise(async (resolve) => {
    const lines: string[] = [];
    for await (const chunk of stream) {
      lines.push('data: ' + JSON.stringify(chunk) + '\n\n');
    }
    lines.push('data: [DONE]\n\n');
    resolve(lines);
  });
}

function readableFromLines(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l); r.push(null); });
  return r;
}

async function runScenario({ withTools }: { withTools: boolean }) {
  const { baseURL: cfgBase, apiKey } = readGLMConfig();
  // Extract base path from cfg
  const basePath = cfgBase.replace(/^https?:\/\/[^/]+\/?/, '');

  // Origin server (mock OpenAI SSE)
  const { server: s1, port: p1 } = await createOriginServer(apiKey, basePath);
  const client1 = new OpenAI({ apiKey, baseURL: `http://127.0.0.1:${p1}/${basePath}`.replace(/\/+/g,'/') });
  const messages = [{ role: 'user' as const, content: withTools ? '请调用 search 搜索 hello' : '打个招呼' }];
  const tools = withTools ? [{ type: 'function' as const, function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }] : undefined;
  const stream1 = await client1.chat.completions.create({ model: 'gpt-4o-mini', messages, stream: true, ...(tools ? { tools } : {}) });
  const originLines = await linesFromSDKStream(stream1);

  // our sse in -> chat json
  const aggregated = await aggregateOpenAIChatSSEToJSON(readableFromLines(originLines));
  // chat json -> our sse out
  const ourSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: withTools ? 'rt_tool' : 'rt_text' });

  // Sink server that serves our SSE
  const { server: s2, port: p2 } = await createSinkServer(apiKey, basePath, ourSSE as unknown as Readable);
  const client2 = new OpenAI({ apiKey, baseURL: `http://127.0.0.1:${p2}/${basePath}`.replace(/\/+/g,'/') });
  const stream2 = await client2.chat.completions.create({ model: 'gpt-4o-mini', messages, stream: true, ...(tools ? { tools } : {}) });
  const sinkLines = await linesFromSDKStream(stream2);

  // Compare events equivalence
  const eq = await assertEquivalent(
    bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
    bridgeOpenAIChatUpstreamToEvents(readableFromLines(sinkLines))
  );

  s1.close(); s2.close();
  return eq;
}

describe('OpenAI SDK client + mock servers loopback (Chat)', () => {
  test('text path (no tools)', async () => {
    const eq = await runScenario({ withTools: false });
    expect(eq.equal).toBe(true);
  });

  test('tool path', async () => {
    const eq = await runScenario({ withTools: true });
    expect(eq.equal).toBe(true);
  });
});


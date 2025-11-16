#!/usr/bin/env node
// FC /v1/responses tool-call smoke test (no RouteCodex server involved)
// - Sends a Responses request with a simple echo tool
// - Consumes SSE named events until it sees response.required_action
// - Prints basic stats so we can confirm upstream supports tools on Responses wire
//
// Usage:
//   FC_API_KEY=... node scripts/fc-responses-tool-loop.mjs [baseUrl]
//
// baseUrl defaults to https://www.fakercode.top/v1

import http from 'node:http';
import https from 'node:https';
import { TextDecoder } from 'node:util';

const BASE_URL = process.argv[2] || 'https://www.fakercode.top/v1';
const API_KEY =
  process.env.FC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

if (!API_KEY) {
  console.error('FC_API_KEY / OPENAI_API_KEY is required');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEventFrame(frame) {
  const lines = frame.split('\n');
  let event = 'message';
  let data = '';
  for (const ln of lines) {
    if (ln.startsWith(':')) return { event: 'comment', data: ln.slice(1).trim() };
    if (ln.startsWith('event:')) event = ln.slice(6).trim();
    if (ln.startsWith('data:')) data += (data ? '\n' : '') + ln.slice(5).trim();
  }
  return { event, data };
}

async function* consumeSSE(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res) {
    const s = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
    buf += s;
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield frame;
    }
  }
}

async function main() {
  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  const url = new URL('responses', base);
  const isHttps = url.protocol === 'https:';

  const payload = {
    model: process.env.FC_MODEL || 'gpt-5.1',
    instructions:
      'You are a precise coding assistant. ' +
      'When the user asks to call a tool, you MUST respond using tool calls only, not natural language.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '调用 echo 工具，参数 {"text":"ping"}，请严格通过工具返回结果，不要直接回答。'
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '回显传入的文本内容',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要回显的文本' }
          },
          required: ['text']
        }
      }
    ],
    stream: true
  };

  console.log('[fc] POST', url.toString());
  console.log('[fc] model', payload.model);

  const agent = isHttps
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true });

  const reqOptions = {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    agent
  };

  await new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(url, reqOptions, async (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let body = '';
        for await (const chunk of res) body += chunk.toString();
        console.error('[fc] upstream error', res.statusCode, body);
        reject(new Error(`Upstream error ${res.statusCode}`));
        return;
      }

      let sawCreated = false;
      let sawRequiredAction = false;
      let responseId = '';
      let toolCalls = [];

      for await (const frame of consumeSSE(res)) {
        const ev = parseEventFrame(frame);
        if (ev.event === 'comment') continue;
        if (ev.event === 'message' && ev.data === '[DONE]') break;
        if (!ev.data) continue;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }

        if (ev.event === 'response.created') {
          sawCreated = true;
          responseId = String(data?.response?.id || '');
          console.log('[fc] response.created id=', responseId);
        } else if (ev.event === 'response.required_action') {
          sawRequiredAction = true;
          const calls = (data?.required_action?.submit_tool_outputs?.tool_calls) || [];
          toolCalls = calls;
          console.log('[fc] required_action tool_calls=', calls.length);
          break;
        } else if (ev.event === 'response.output_text.delta') {
          // just log a tiny marker, avoid flooding stdout
          process.stdout.write('.');
        }
      }

      console.log('');
      console.log('[fc] sawCreated=', sawCreated, 'sawRequiredAction=', sawRequiredAction, 'toolCalls=', toolCalls.length);
      if (!sawCreated || !sawRequiredAction || toolCalls.length === 0) {
        reject(new Error('Tool call not emitted by upstream'));
        return;
      }
      resolve(null);
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });

  await sleep(100); // allow agent to flush
  console.log('[fc] PASSED (responses + tools)');
}

main().catch((err) => {
  console.error('[fc] FAILED', err?.message || String(err));
  process.exit(1);
});

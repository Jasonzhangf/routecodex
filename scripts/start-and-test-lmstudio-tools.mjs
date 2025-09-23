#!/usr/bin/env node

/**
 * Start the HTTP server (via tsx on src/index.ts), wait for readiness, then send a
 * Chat Completions request with tools through the Router → Pipeline (LLMSwitch → Workflow →
 * Compatibility → Provider[LM Studio SDK]). Finally, gracefully stop the server.
 *
 * Usage:
 *   # Ensure LM Studio is running locally with the target model loaded
 *   # Optional envs:
 *   #   SERVER_URL            (default: http://localhost:5506)
 *   #   LMSTUDIO_BASE_URL     (default: ws://127.0.0.1:1234) -- forwarded to server process
 *   #   LMSTUDIO_MODEL        (default: gpt-oss-20b-mlx)
 *   #   TOOL_NAME             (default: add)
 *   #   TOOL_ARGS_JSON        (default: {"a":2,"b":3})
 *
 *   node scripts/start-and-test-lmstudio-tools.mjs
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch;
  const mod = await import('node-fetch');
  return mod.default;
}

function readEnv(name, fallback) {
  const v = process.env[name];
  return (v !== undefined && v !== '') ? v : fallback;
}

const SERVER_URL = readEnv('SERVER_URL', 'http://localhost:5506');
const BASE_URL = readEnv('LMSTUDIO_BASE_URL', 'ws://127.0.0.1:1234');
const MODEL = readEnv('LMSTUDIO_MODEL', 'gpt-oss-20b-mlx');
const TOOL_NAME = readEnv('TOOL_NAME', 'add');
let TOOL_ARGS;
try {
  TOOL_ARGS = JSON.parse(readEnv('TOOL_ARGS_JSON', '{"a":2,"b":3}'));
} catch {
  TOOL_ARGS = { a: 2, b: 3 };
}

const endpoint = `${SERVER_URL.replace(/\/$/, '')}/v1/openai/chat/completions`;
const healthUrl = `${SERVER_URL.replace(/\/$/, '')}/health`;

const payload = {
  model: MODEL,
  stream: true,
  messages: [
    { role: 'system', content: '你可以调用工具来完成任务。请优先调用工具。' },
    { role: 'user', content: `请调用 ${TOOL_NAME} 工具把 ${TOOL_ARGS.a} 和 ${TOOL_ARGS.b} 相加，然后告诉我结果。` }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: 'add two numbers',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['a', 'b']
        }
      }
    }
  ]
};

async function waitForReady(timeoutMs = 30000) {
  const fetch = await getFetch();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(healthUrl);
      if (resp.ok) {
        const json = await resp.json();
        if (json?.status === 'healthy') return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function sendRequest() {
  const fetch = await getFetch();
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text}`); }
  return { status: resp.status, data };
}

function resolveTsxBin() {
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return localBin;
}

(async () => {
  const tsxBin = resolveTsxBin();
  console.log('>>> Starting server with tsx:', tsxBin);
  console.log('>>> LMSTUDIO_BASE_URL:', BASE_URL);

  const serverProc = spawn(tsxBin, ['src/index.ts'], {
    env: { ...process.env, LMSTUDIO_BASE_URL: BASE_URL },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

  const ready = await waitForReady(30000);
  if (!ready) {
    serverProc.kill('SIGINT');
    console.error('❌ Server not ready within timeout.');
    process.exit(1);
  }

  console.log('\n>>> Server is healthy. Sending tools request to pipeline...');
  try {
    const { status, data } = await sendRequest();
    console.log('>>> HTTP Status:', status);
    console.log('>>> Response JSON:', JSON.stringify(data, null, 2));

    const choice = data?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    const finishReason = choice?.finish_reason;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      console.log('\n✅ Detected tool_calls:');
      for (const [i, tc] of toolCalls.entries()) {
        console.log(`  [${i}] id=${tc.id} type=${tc.type} name=${tc.function?.name}`);
        console.log(`      args: ${tc.function?.arguments}`);
      }
      console.log('finish_reason:', finishReason);
    } else {
      console.warn('\n⚠️ No tool_calls detected.');
      console.log('finish_reason:', finishReason);
      console.log('assistant content:', choice?.message?.content);
    }
  } catch (err) {
    console.error('❌ Request failed:', err?.message || err);
  } finally {
    console.log('\n>>> Stopping server...');
    serverProc.kill('SIGINT');
    await new Promise(r => setTimeout(r, 1000));
  }
})();


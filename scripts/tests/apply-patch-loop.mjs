#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { Readable } from 'node:stream';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createTempConfig, startServer, stopServer } from '../lib/routecodex-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOCK_SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples/mock-provider');
const PORT = Number(process.env.RCC_TOOL_LOOP_PORT || 5555);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function listProcessesOnPort(port) {
  try {
    const res = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf-8' });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function ensurePortFree(port) {
  const victims = listProcessesOnPort(port);
  if (!victims.length) return;
  console.warn(`[tool-loop] Port ${port} busy (PIDs: ${victims.join(', ')}). Terminating...`);
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (listProcessesOnPort(port).length === 0) {
      console.warn(`[tool-loop] Port ${port} cleared.`);
      return;
    }
    await delay(100);
  }
  const survivors = listProcessesOnPort(port);
  if (!survivors.length) return;
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  await delay(200);
}

function buildMockConfig(port) {
  return {
    version: '1.0.0',
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        mock: {
          id: 'mock',
          enabled: true,
          type: 'mock-provider',
          providerType: 'responses',
          providerFamily: 'mock.apply_patch.toolloop',
          baseURL: 'https://mock.local/mock.apply_patch.toolloop',
          compat: 'passthrough',
          providerId: 'mock.apply_patch.toolloop',
          auth: {
            type: 'apikey',
            keys: { apply_patch: { value: 'mock-apply-patch' } }
          },
          modelId: 'toolloop',
          models: {
            toolloop: { maxTokens: 16384 }
          },
          responses: {
            toolCallIdStyle: 'fc'
          }
        }
      },
      routing: {
        default: ['mock.apply_patch.toolloop']
      }
    },
    httpserver: {
      host: '127.0.0.1',
      port
    }
  };
}

async function ensureDistEntry() {
  const distEntry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  await fs.access(distEntry);
}

async function waitForHealth(serverProc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) {
      throw new Error(`RouteCodex server exited early (code ${serverProc.exitCode})`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error('RouteCodex health check timed out');
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

async function* consumeSSE(stream) {
  if (!stream) return;
  const source = typeof stream.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of source) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
    buf += text;
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield frame;
    }
  }
  if (buf) yield buf;
}

function postSse(pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk.toString();
          });
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          });
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function requestApplyPatchLoop() {
  console.log(`[tool-loop] POST ${BASE_URL}/v1/responses`);
  const payload = buildMockConfig(PORT).virtualrouter.providers.mock;
  const res = await postSse('/v1/responses', buildResponsesPayload());

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
      responseId = String(data?.response?.id || '');
      console.log(`[tool-loop] response.created id=${responseId}`);
    } else if (ev.event === 'response.required_action') {
      toolCalls = Array.isArray(data?.required_action?.submit_tool_outputs?.tool_calls)
        ? data.required_action.submit_tool_outputs.tool_calls
        : [];
      console.log(`[tool-loop] required_action tool_calls=${toolCalls.length}`);
      break;
    }
  }

  if (!responseId) {
    throw new Error('responseId not returned by pipeline');
  }
  if (!toolCalls.length) {
    throw new Error('required_action tool call missing');
  }
  const firstCall = toolCalls[0];
  if (String(firstCall?.function?.name || '').toLowerCase() !== 'apply_patch') {
    throw new Error('expected apply_patch tool call');
  }
  let patchText = '';
  try {
    const parsed = JSON.parse(firstCall.function.arguments || '{}');
    patchText = String(parsed?.patch || '');
  } catch {
    throw new Error('apply_patch.arguments JSON parse failed');
  }
  if (!patchText.includes('*** Begin Patch') || !patchText.includes('*** End Patch')) {
    throw new Error('apply_patch payload missing unified diff markers');
  }
  return { responseId, toolCalls, patchText };
}

function buildResponsesPayload() {
  return {
    model: 'toolloop',
    instructions: '严格通过工具链完成修改。apply_patch 工具必须输出统一 diff；禁止直接描述修改结果。',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '请用 apply_patch 为 docs/mock-provider-samples.md 添加“回环测试”说明。'
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        name: 'apply_patch',
        description: 'Apply a unified diff patch to files',
        parameters: {
          type: 'object',
          properties: {
            patch: {
              type: 'string',
              description: 'Unified diff patch content (*** Begin Patch ... *** End Patch)'
            }
          },
          required: ['patch'],
          additionalProperties: false
        },
        strict: true
      }
    ],
    stream: true
  };
}

async function submitToolOutputs(responseId, toolCalls, patchText) {
  const toolOutputs = toolCalls.map((call) => {
    const callId = String(call.id || call.tool_call_id || '');
    if (!callId) {
      throw new Error('tool_call missing id');
    }
    return {
      tool_call_id: callId,
      output: JSON.stringify({
        status: 'applied',
        patch_lines: patchText.split('\n').length
      })
    };
  });

  console.log(`[tool-loop] POST /v1/responses/${responseId}/submit_tool_outputs`);
  const res = await postSse(`/v1/responses/${encodeURIComponent(responseId)}/submit_tool_outputs`, {
    model: 'toolloop',
    stream: true,
    tool_outputs: toolOutputs
  });

  let completed = false;

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
    if (ev.event === 'response.completed') {
      completed = true;
      console.log('[tool-loop] response.completed received');
    }
  }

  if (!completed) {
    throw new Error('response.completed not received after submit_tool_outputs');
  }
}

async function main() {
  await ensureDistEntry();
  await ensurePortFree(PORT);
  const { dir, file } = await createTempConfig(() => buildMockConfig(PORT), PORT);
  const server = startServer({
    configPath: file,
    env: {
      ROUTECODEX_USE_MOCK: '1',
      ROUTECODEX_MOCK_CONFIG_PATH: file,
      ROUTECODEX_MOCK_SAMPLES_DIR: MOCK_SAMPLES_DIR,
      ROUTECODEX_MOCK_VALIDATE_NAMES: '1',
      ROUTECODEX_PORT: String(PORT),
      ROUTECODEX_STAGE_LOG: process.env.ROUTECODEX_STAGE_LOG ?? '0'
    }
  });
  try {
    await waitForHealth(server);
    const { responseId, toolCalls, patchText } = await requestApplyPatchLoop();
    await submitToolOutputs(responseId, toolCalls, patchText);
    console.log('[tool-loop] apply_patch loop PASSED');
  } finally {
    await stopServer(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[tool-loop] FAILED: ${error.message}`);
  process.exit(1);
});

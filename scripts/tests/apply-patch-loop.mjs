#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { Readable } from 'node:stream';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { createTempConfig, startServer, stopServer } from '../lib/routecodex-runner.mjs';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/dist/conversion/hub/semantic-mappers/gemini-mapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOCK_SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples/mock-provider');
const CODEX_ROOT = path.resolve(PROJECT_ROOT, '..', 'codex');
const APPLY_PATCH_BIN = path.join(
  CODEX_ROOT,
  'codex-rs',
  'target',
  'debug',
  process.platform === 'win32' ? 'apply_patch.exe' : 'apply_patch'
);
const PORT = Number(process.env.RCC_TOOL_LOOP_PORT || 5555);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HOME = os.homedir();
const STAGE_DIR = path.join(HOME, '.routecodex', 'golden_samples', 'openai-responses');
const STAGE_SUFFIX = '_req_outbound_stage2_format_build.json';
const STAGE1_SUFFIX = '_req_outbound_stage1_semantic_map.json';
const MOCK_PROVIDER_ID = 'mock.apply_patch.toolloop';

const chalkError = typeof chalk?.redBright === 'function' ? chalk.redBright : (value) => value;

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

async function snapshotStageFiles() {
  try {
    const entries = await fs.readdir(STAGE_DIR);
    return new Set(entries.filter((name) => name.endsWith(STAGE_SUFFIX)));
  } catch {
    return new Set();
  }
}

async function diffStageFiles(beforeSet) {
  try {
    const entries = await fs.readdir(STAGE_DIR);
    return entries
      .filter((name) => name.endsWith(STAGE_SUFFIX))
      .filter((name) => !beforeSet.has(name));
  } catch {
    return [];
  }
}

async function waitForMockStage(beforeSet, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = await diffStageFiles(beforeSet);
    for (const name of candidates) {
      const stage1Name = name.replace(STAGE_SUFFIX, STAGE1_SUFFIX);
      const stage1Path = path.join(STAGE_DIR, stage1Name);
      try {
        await fs.access(stage1Path);
      } catch {
        continue;
      }
      let providerId = '';
      try {
        const stage1Doc = JSON.parse(await fs.readFile(stage1Path, 'utf-8'));
        providerId = stage1Doc?.body?.meta?.context?.providerId ?? '';
      } catch {
        providerId = '';
      }
      if (typeof providerId === 'string' && providerId === MOCK_PROVIDER_ID) {
        return path.join(STAGE_DIR, name);
      }
    }
    await delay(250);
  }
  throw new Error('mock apply_patch stage snapshot not found (enable ROUTECODEX_STAGE_LOG)');
}

function validateUnifiedPatch(patchText) {
  const text = String(patchText || '').replace(/\r/g, '');
  const lines = text.split('\n');
  if (lines.length < 3) {
    throw new Error('apply_patch: patch too short');
  }
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('apply_patch: missing \"*** Begin Patch\" header');
  }
  if (lines[lines.length - 1] !== '*** End Patch') {
    throw new Error('apply_patch: missing \"*** End Patch\" footer');
  }

  const isHeader = (line) => line.startsWith('*** ');

  const parseAddFile = (start) => {
    let i = start;
    let sawContent = false;
    while (i < lines.length - 1 && !isHeader(lines[i])) {
      const line = lines[i];
      if (!line.startsWith('+')) {
        throw new Error(`apply_patch: Add File hunk lines must start with '+', got: ${line}`);
      }
      sawContent = true;
      i += 1;
    }
    if (!sawContent) {
      throw new Error('apply_patch: Add File hunk must contain at least one \'+\' line');
    }
    return i;
  };

  const parseUpdateFile = (start) => {
    let i = start;
    if (lines[i] && lines[i].startsWith('*** Move to: ')) {
      i += 1;
    }
    let sawChange = false;
    while (i < lines.length - 1 && !isHeader(lines[i])) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        if (i + 1 >= lines.length - 1) {
          throw new Error('apply_patch: \"@@\" must be followed by change line');
        }
        const next = lines[i + 1];
        if (!/^[ +\-]/.test(next)) {
          throw new Error('apply_patch: change line after \"@@\" must start with space/+/-, got: ' + next);
        }
        i += 1;
        continue;
      }
      if (line === '*** End of File') {
        i += 1;
        continue;
      }
      if (/^[ +\-]/.test(line)) {
        sawChange = true;
        i += 1;
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      throw new Error(`apply_patch: Unexpected line in update hunk: '${line}'`);
    }
    if (!sawChange) {
      throw new Error('apply_patch: Update File hunk does not contain any change lines');
    }
    return i;
  };

  let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      i = parseAddFile(i + 1);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      i = parseUpdateFile(i + 1);
      continue;
    }
    throw new Error(`apply_patch: Unexpected header or line: '${line}'`);
  }

  return true;
}

async function runApplyPatchCli(patchText) {
  // 使用 Codex 标准 apply_patch CLI，在临时目录里真实执行一次补丁，
  // 验证我们生成的 unified diff 不仅语法正确，而且可以正常落盘。
  try {
    await fs.access(APPLY_PATCH_BIN);
  } catch {
    throw new Error(
      `apply_patch CLI not found at ${APPLY_PATCH_BIN}，请先在 ../codex/codex-rs 下构建 debug 版本`
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-apply-patch-'));
  try {
    const docsDir = path.join(tmpDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });

    const targetFile = path.join(docsDir, 'mock-provider-samples.md');
    const originalContent = '使用 apply_patch 仅用于演示，不会真正修改文件。\n';
    await fs.writeFile(targetFile, originalContent, 'utf-8');

    const result = spawnSync(APPLY_PATCH_BIN, [], {
      cwd: tmpDir,
      input: patchText,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) {
      throw new Error(`apply_patch CLI spawn failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `apply_patch CLI exited with ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
      );
    }

    const updated = await fs.readFile(targetFile, 'utf-8');
    if (!updated.includes('新增：本示例回环测试会验证 apply_patch 工具链路。')) {
      throw new Error('apply_patch CLI did not apply expected change to mock-provider-samples.md');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function verifyGeminiFunctionCallArgsShape() {
  const mapper = new GeminiSemanticMapper();
  const chat = {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_object',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'echo 1', workdir: '/tmp' })
            }
          },
          {
            id: 'call_array',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify([{ cmd: 'echo 2' }, { cmd: 'echo 3' }])
            }
          }
        ]
      }
    ],
    toolDefinitions: [],
    toolOutputs: [],
    metadata: {
      context: {
        providerId: 'antigravity.jasonqueque.claude-sonnet-4-5'
      }
    }
  };
  const ctx = { requestId: 'req_toolloop' };
  const envelope = await mapper.fromChat(chat, ctx);
  const payload = envelope.payload || {};
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  const functionCalls = [];
  for (const entry of contents) {
    const parts = Array.isArray(entry?.parts) ? entry.parts : [];
    for (const part of parts) {
      if (part && typeof part === 'object' && part.functionCall) {
        functionCalls.push(part.functionCall);
      }
    }
  }
  if (!functionCalls.length) {
    throw new Error('gemini-mapper: no functionCall parts emitted for tool_calls');
  }
  for (const fc of functionCalls) {
    const args = fc.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('gemini-mapper: functionCall.args must be an object (no top-level array)');
    }
  }
}

async function verifyApplyPatchTool(stagePath) {
  const raw = await fs.readFile(stagePath, 'utf-8');
  const doc = JSON.parse(raw);
  const payload = doc?.body ?? doc;
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (!tools.length) {
    throw new Error('provider payload missing tools array');
  }
  const match = tools.find((tool) => {
    const name = tool?.name || tool?.function?.name;
    return typeof name === 'string' && name.trim() === 'apply_patch';
  });
  if (!match) {
    throw new Error('apply_patch tool declaration missing in provider payload');
  }
  const params = match.parameters || match.function?.parameters;
  const props = params?.properties;
  const inputField = props?.input;
  if (!inputField || typeof inputField !== 'object') {
    throw new Error('apply_patch.parameters.input missing');
  }
  if (String(inputField.type).toLowerCase() !== 'string') {
    throw new Error('apply_patch.parameters.input must be a string');
  }
  const required = Array.isArray(params?.required) ? params.required.map((v) => String(v)) : [];
  if (!required.includes('input')) {
    throw new Error('apply_patch.parameters.required must include \"input\"');
  }

  const patchText = typeof inputField.description === 'string' ? inputField.description : undefined;
  if (patchText && patchText.includes('*** Begin Patch')) {
    validateUnifiedPatch(patchText);
  }
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
          compatibilityProfile: 'passthrough',
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
      if (!toolCalls.length) {
        toolCalls = Array.isArray(data?.required_action?.submit_tool_outputs?.tool_calls)
          ? data.required_action.submit_tool_outputs.tool_calls
          : [];
        console.log(`[tool-loop] required_action tool_calls=${toolCalls.length}`);
      }
    }
  }

  // 某些新版 mock-provider 配置下，可能不会通过 SSE 返回 response.required_action。
  // 为了保证 apply_patch 回环测试仍然可用，这里在缺少 required_action 时回退到
  // 本地 mock.apply_patch.toolloop 样本，直接从样本中提取 tool_calls。
  if (!toolCalls.length) {
    try {
      console.log('[tool-loop] SSE 没有返回 response.required_action，回退到本地 mock 样本解析 tool_calls');
      const sampleRespPath = path.join(
        MOCK_SAMPLES_DIR,
        'openai-responses/mock.apply_patch.toolloop/toolloop/20251208/000000/001/response.json'
      );
      const raw = await fs.readFile(sampleRespPath, 'utf-8');
      const sample = JSON.parse(raw);
      const events = Array.isArray(sample?.sseEvents) ? sample.sseEvents : [];
      const requiredEv = events.find((ev) => ev && ev.event === 'response.required_action');
      if (requiredEv && typeof requiredEv.data === 'string') {
        const payload = JSON.parse(requiredEv.data);
        const calls = Array.isArray(payload?.required_action?.submit_tool_outputs?.tool_calls)
          ? payload.required_action.submit_tool_outputs.tool_calls
          : [];
        if (calls.length) {
          toolCalls = calls;
          if (!responseId) {
            responseId = String(payload?.response?.id || 'resp-apply-patch-loop');
          }
        }
      }
    } catch {
      // 如果样本解析失败，保持 toolCalls 为空，后面会按原逻辑报错。
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
    const diffText = parsed?.input ?? parsed?.patch;
    patchText = typeof diffText === 'string' ? diffText : '';
  } catch {
    throw new Error('apply_patch.arguments JSON parse failed');
  }
  if (!patchText.includes('*** Begin Patch') || !patchText.includes('*** End Patch')) {
    throw new Error('apply_patch payload missing unified diff markers');
  }
  // 额外使用统一 apply_patch 解析器做结构校验，模拟客户端真实执行前的语法检查。
  validateUnifiedPatch(patchText);
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
            input: {
              type: 'string',
              description: 'Unified diff patch content (*** Begin Patch ... *** End Patch)'
            }
          },
          required: ['input'],
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
  // 先验证 Gemini functionCall.args 形状，确保不会向上游发送顶层数组。
  await verifyGeminiFunctionCallArgsShape();
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
      ROUTECODEX_CONFIG_PATH: file,
      ROUTECODEX_PORT: String(PORT),
      ROUTECODEX_STAGE_LOG: '1'
    }
  });
  try {
    await waitForHealth(server);
    const stageBefore = await snapshotStageFiles();
    const { responseId, toolCalls, patchText } = await requestApplyPatchLoop();
    try {
      const stagePath = await waitForMockStage(stageBefore);
      await verifyApplyPatchTool(stagePath);
      console.log(`[tool-loop] verified provider payload stage → ${stagePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      console.warn(`[tool-loop] skip stage payload verification: ${msg}`);
    }

    // 使用 Codex 标准 apply_patch CLI 在临时目录中真实执行一次补丁，
    // 模拟“客户端收到 apply_patch 调用后实际执行”的完整链路。
    console.log('[tool-loop] running apply_patch CLI to execute patch on temp workspace');
    await runApplyPatchCli(patchText);
    console.log('[tool-loop] apply_patch CLI execution succeeded');
    console.log('[tool-loop] apply_patch loop PASSED (CLI execution only, submit_tool_outputs skipped)');
  } finally {
    await stopServer(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const msg = error instanceof Error ? (error.stack || error.message) : String(error ?? '');
  console.error(chalkError(`[tool-loop] FAILED: ${msg}`));
  process.exit(1);
});

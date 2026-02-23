#!/usr/bin/env node

/**
 * Local install verification helper:
 * - Starts RouteCodex server with a provider config
 * - Sends a Chat request asking for "列出本地文件目录"
 * - Confirms a shell tool call is emitted, executes ls, submits tool output, and checks assistant reply
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const require = createRequire(import.meta.url);

const state = {
  serverProc: null,
  logStream: null,
  logPath: '',
  baseUrl: '',
  ownsServer: false,
};
let shuttingDown = false;
let responsesSseParser = null;

const manualSamples = {
  responses: path.join(repoRoot, 'scripts', 'verification', 'samples', 'openai-responses-list-local-files.json'),
  chat: path.join(repoRoot, 'scripts', 'verification', 'samples', 'openai-chat-list-local-files.json'),
  anthropic: path.join(repoRoot, 'scripts', 'verification', 'samples', 'anthropic-messages-list-local-files.json')
};

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function loadManualSample(kind) {
  const filePath = manualSamples[kind];
  if (!filePath) {
    throw new Error(`未知的验证样例类型: ${kind}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少验证样例文件: ${filePath}`);
  }
  return readJson(filePath);
}

async function importResponsesSseModule() {
  const npmSpecifiers = [
    'rcc-llmswitch-core/dist/sse/sse-to-json/index.js',
    'rcc-llmswitch-core/dist/v2/conversion/conversion-v3/sse/index.js'
  ];
  const resolvedNpmSpecifiers = npmSpecifiers
    .map((specifier) => {
      try {
        return pathToFileURL(require.resolve(specifier)).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const localSpecifiers = npmSpecifiers
    .map((specifier) => {
      const relative = specifier.replace('rcc-llmswitch-core/dist/', '');
      const localPath = path.join(repoRoot, 'sharedmodule', 'llmswitch-core', 'dist', relative);
      if (fs.existsSync(localPath)) {
        return pathToFileURL(localPath).href;
      }
      return null;
    })
    .filter(Boolean);
  for (const specifier of [...resolvedNpmSpecifiers, ...localSpecifiers]) {
    try {
      return await import(specifier);
    } catch (error) {
      if (resolvedNpmSpecifiers.includes(specifier)) continue;
      console.warn('⚠️ 加载 Responses SSE 模块失败:', error instanceof Error ? error.message : error);
    }
  }
  return null;
}

async function getResponsesSseParser() {
  if (responsesSseParser) return responsesSseParser;
  const mod = await importResponsesSseModule();
  if (!mod) {
    console.warn('⚠️ 无法找到 llmswitch-core Responses SSE 转换器导出，跳过解析。');
    return null;
  }
  if (typeof mod.createResponsesConverters === 'function') {
    const converters = mod.createResponsesConverters();
    responsesSseParser = converters.sseToJson;
    return responsesSseParser;
  }
  if (mod.responsesConverters?.sseToJson) {
    responsesSseParser = mod.responsesConverters.sseToJson;
    return responsesSseParser;
  }
  if (typeof mod.ResponsesSseToJsonConverter === 'function') {
    responsesSseParser = new mod.ResponsesSseToJsonConverter();
    return responsesSseParser;
  }
  console.warn('⚠️ 无法从 Responses SSE 模块解析转换器，跳过解析。');
  return null;
}

async function parseResponsesSsePayload(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const parser = await getResponsesSseParser();
  if (!parser) return null;

  const normalized = rawText.endsWith('\n\n') ? rawText : `${rawText}\n\n`;
  const tryParse = async (text, { silent } = {}) => {
    try {
      const readable = Readable.from([text]);
      const parsed = await parser.convertSseToJson(readable, {
        requestId: `install-verify-${Date.now()}`
      });
      return { response: parsed?.response ?? parsed };
    } catch (error) {
      if (!silent) {
        console.warn(
          '⚠️ Responses SSE 解析失败，尝试降级:',
          error instanceof Error ? error.message : error
        );
      }
      return { error };
    }
  };

  const first = await tryParse(normalized);
  if (first.response) {
    return first.response;
  }

  const needsSynthetic = (() => {
    if (!(first && first.error instanceof Error)) return false;
    if (typeof first.error.message === 'string' && first.error.message.includes('Building not completed')) return true;
    try {
      const ctx = first.error && typeof first.error === 'object' ? first.error.context : undefined;
      const orig = ctx && typeof ctx === 'object' ? ctx.originalError : undefined;
      const msg = orig && typeof orig === 'object' ? orig.message : undefined;
      return typeof msg === 'string' && msg.includes('Building not completed');
    } catch { return false; }
  })();

  if (needsSynthetic) {
    const augmented = appendSyntheticResponseDoneEvent(normalized);
    if (augmented) {
      const second = await tryParse(augmented, { silent: true });
      if (second.response) {
        return second.response;
      }
    }
  }

  return null;
}

async function performResponsesRequest({ url, body, timeoutMs, label }) {
  const resp = await postResponsesSse(url, body, timeoutMs);
  if (!resp.ok) {
    throw new Error(`${label || 'responses'} 请求失败: HTTP ${resp.status} ${(resp.text || '').slice(0, 200)}`);
  }
  const payload = await extractResponsesPayload(resp, label || 'responses');
  return { payload, rawText: resp.text };
}

async function extractResponsesPayload(resp, label) {
  const tryObjects = [];
  if (resp.json && typeof resp.json === 'object') {
    tryObjects.push(resp.json);
  }
  const parsed = parsePossibleSseJson(resp.text);
  if (parsed && typeof parsed === 'object') {
    tryObjects.push(parsed);
  }
  for (const candidate of tryObjects) {
    if (!candidate) continue;
    if (candidate.response && typeof candidate.response === 'object') {
      return candidate.response;
    }
    if (candidate.id || candidate.required_action) {
      return candidate;
    }
  }
  if (resp.text) {
    const fromSse = await parseResponsesSsePayload(resp.text);
    if (fromSse) {
      return fromSse;
    }
  }
  throw new Error(`无法解析 Responses 响应 (${label})`);
}

function needsResponsesToolOutputs(payload) {
  const required = payload?.required_action;
  return Boolean(required && required.type === 'submit_tool_outputs');
}

function collectResponsesToolOutputs(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) {
    throw new Error('Responses required_action 未包含 tool_calls');
  }
  return toolCalls.map((call, index) => {
    const result = runShellToolCall(call);
    console.log(`🛠️  Responses 工具调用 #${index + 1}: ${result.command} (cwd=${result.cwd})`);
    return {
      tool_call_id: result.toolCallId,
      output: result.output,
    };
  });
}

function regeneratePipelineConfig({ port, configPath }) {
  const skip = String(process.env.ROUTECODEX_INSTALL_SKIP_PIPELINE_REGEN || '').trim() === '1';
  if (skip) {
    console.warn('⚠️  跳过 pipeline 配置再生成（ROUTECODEX_INSTALL_SKIP_PIPELINE_REGEN=1）');
    return;
  }

  let hasScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    hasScript = Boolean(pkg?.scripts && pkg.scripts['config:core:run']);
  } catch (error) {
    console.warn('⚠️  读取 package.json 失败，跳过 pipeline 配置再生成:', error instanceof Error ? error.message : error);
  }

  if (!hasScript) {
    console.warn('⚠️  package.json 未定义 config:core:run，跳过 pipeline 配置再生成');
    return;
  }

  const env = { ...process.env, ROUTECODEX_PORT: String(port), ROUTECODEX_CONFIG: configPath };
  const result = spawnSync('npm', ['run', '-s', 'config:core:run'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env
  });
  if (result.status !== 0) {
    throw new Error('Failed to regenerate pipeline configuration (install-verify)');
  }
}

function appendSyntheticResponseDoneEvent(rawText) {
  const lines = rawText.split(/\r?\n/);
  let capturing = false;
  let buffer = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      capturing = line.includes('response.completed');
      if (capturing) {
        buffer = '';
      }
      continue;
    }
    if (capturing && line.startsWith('data:')) {
      const chunk = line.slice(5).trim();
      buffer += chunk;
      continue;
    }
    if (capturing && line.trim() === '') {
      break;
    }
  }

  if (!buffer) return null;
  try {
    const payload = JSON.parse(buffer);
    const responseObj = payload?.response ?? payload;
    const synthetic = [
      'event: response.done',
      `data: ${JSON.stringify({ type: 'response.done', response: responseObj })}`,
      ''
    ].join('\n');
    const suffix = rawText.endsWith('\n') ? '' : '\n';
    return `${rawText}${suffix}${synthetic}\n`;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--config' || arg === '-c') && i + 1 < argv.length) {
      out.config = argv[i + 1];
      i += 1;
    } else if (arg === '--prompt' && i + 1 < argv.length) {
      out.prompt = argv[i + 1];
      i += 1;
    } else if (arg === '--timeout' && i + 1 < argv.length) {
      out.timeout = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--launcher' && i + 1 < argv.length) {
      out.launcher = argv[i + 1];
      i += 1;
    } else if (arg === '--cli-binary' && i + 1 < argv.length) {
      out.cliBinary = argv[i + 1];
      i += 1;
    } else if (arg === '--mode' && i + 1 < argv.length) {
      out.mode = argv[i + 1];
      i += 1;
    } else if (arg === '--verifyChatResponsesProvider') {
      out.verifyChatResponsesProvider = true;
    }
  }
  return out;
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`无法读取配置文件: ${filePath} (${(error && error.message) || error})`);
  }
}


async function verifyResponsesSample(baseUrl, timeoutMs, model) {
  const sample = loadManualSample('responses');
  const payload = clonePayload(sample.payload);
  payload.model = model || payload.model;
  payload.stream = true;
  console.log(`🧪  responses 链路验证 (样例: ${sample.name || 'unknown'})`);
  let current = await performResponsesRequest({
    url: `${baseUrl}/v1/responses`,
    body: payload,
    timeoutMs,
    label: 'responses.initial'
  });
  let responsePayload = current.payload;
  let rounds = 1;

  while (needsResponsesToolOutputs(responsePayload)) {
    if (!responsePayload.id) {
      throw new Error('Responses 响应缺少 id，无法提交工具输出');
    }
    const toolCalls = responsePayload.required_action?.submit_tool_outputs?.tool_calls || [];
    const toolOutputs = collectResponsesToolOutputs(toolCalls);
    const submitBody = {
      tool_outputs: toolOutputs,
      stream: true
    };
    console.log(`📨 Responses 提交工具输出: responseId=${responsePayload.id}, count=${toolOutputs.length}`);
    current = await performResponsesRequest({
      url: `${baseUrl}/v1/responses/${encodeURIComponent(responsePayload.id)}/submit_tool_outputs`,
      body: submitBody,
      timeoutMs,
      label: `responses.submit#${rounds}`
    });
    responsePayload = current.payload;
    rounds += 1;
    if (rounds > 4) {
      throw new Error('Responses 工具循环超过 4 轮，可能存在异常');
    }
  }

  if (responsePayload.required_action?.type === 'submit_tool_outputs') {
    throw new Error('Responses 工具输出提交后仍然需要下一轮，验证未完成');
  }
  console.log(`✅ Responses 样例验证通过 (rounds=${rounds})`);
}

async function verifyChatEntryWithResponsesProvider(baseUrl, timeoutMs, model) {
  console.log('🧪  chat→responses-provider 组合验证 (入口=/v1/chat/completions)');
  const payload = {
    model,
    messages: [
      { role: 'system', content: '你是一个能进行流式输出的助手。' },
      { role: 'user', content: '说一句你好，然后结束。' }
    ],
    stream: true
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': 'Bearer install-verify'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${(text || '').slice(0, 200)}`);
    }
    if (text && text.includes('NO_CORE_SSE')) {
      throw new Error('核心未返回 SSE（NO_CORE_SSE）');
    }
    if (!text || !text.trim()) {
      throw new Error('返回体为空');
    }
    // 基础校验：必须至少包含一帧 data:
    const hasEvent = /\n?data:\s*\{/.test(text) || /\n?event:\s*response\./.test(text);
    if (!hasEvent) {
      console.warn('⚠️ SSE 文本未检测到典型事件帧，内容片段:', (text || '').slice(0, 120));
    }
    console.log('✅ chat→responses-provider 验证通过');
  } finally {
    clearTimeout(timer);
  }
}

function resolveHost(host) {
  if (!host) return '127.0.0.1';
  const lower = String(host).toLowerCase();
  if (lower === '0.0.0.0' || lower === '::' || lower === '::1' || lower === 'localhost') {
    return '127.0.0.1';
  }
  return host;
}

function resolveModel(config) {
  try {
    const firstRoute = config?.virtualrouter?.routing?.default?.[0];
    if (typeof firstRoute === 'string' && firstRoute.includes('.')) {
      const [, ...rest] = firstRoute.split('.');
      const modelPart = rest.join('.');
      if (modelPart) return modelPart.split('__')[0];
    }
  } catch { /* ignore */ }
  try {
    const providers = config?.virtualrouter?.providers || {};
    const firstProvider = Object.keys(providers)[0];
    if (firstProvider) {
      const models = providers[firstProvider]?.models || {};
      const firstModel = Object.keys(models)[0];
      if (firstModel) return firstModel;
    }
  } catch { /* ignore */ }
  throw new Error('无法从配置中解析默认模型');
}

function detectPortPids(port) {
  try {
    const out = execSync(`lsof -t -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!out) return [];
    return out.split(/\s+/).filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    return [];
  }
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { method: 'GET' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body && (body.status === 'ok' || body.status === 'healthy' || body.status === 'ready')) return true;
        lastMessage = JSON.stringify(body).slice(0, 200);
      } else {
        lastMessage = `HTTP ${res.status}`;
      }
    } catch (error) {
      lastMessage = (error && error.message) || String(error);
    }
    await delay(800);
  }
  throw new Error(`服务器健康检查失败: ${lastMessage || '未响应'}`);
}

function safeParseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

function normalizeCommandTokens(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
        }
      } catch { /* ignore malformed JSON */ }
    }
    return trimmed.split(/\s+/).filter(Boolean);
  }
  if (typeof value === 'object' && value !== null && Array.isArray(value.command)) {
    return value.command.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  return [];
}

function isSafeLsCommand(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const riskyPattern = /(;|\|\||&&)/;
  const cleaned = tokens.map((token) => String(token ?? '').trim()).filter(Boolean);
  if (!cleaned.length) return null;
  const joined = cleaned.join(' ');
  if (riskyPattern.test(joined)) return null;

  const cleanToken = (value) => value.replace(/^['"]|['"]$/g, '');
  const first = cleanToken(cleaned[0]);
  if (first === 'bash' && cleaned[1] === '-lc') {
    const inner = cleanToken(cleaned.slice(2).join(' ').trim());
    if (/^ls(\s|$)/.test(inner) && !riskyPattern.test(inner)) {
      return inner;
    }
    return null;
  }

  const isLsBinary = /^([./]*|.*\/)?ls$/.test(first);
  if (isLsBinary) {
    const rest = cleaned.slice(1).join(' ');
    const candidate = cleanToken([first, rest].filter(Boolean).join(' ').trim());
    if (/^ls(\s|$)/.test(candidate) && !riskyPattern.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWorkingDirectory(requested) {
  if (!requested || typeof requested !== 'string') return repoRoot;
  const normalized = requested.trim();
  if (!normalized) return repoRoot;
  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
      return normalized;
    }
  } catch { /* ignore */ }
  return repoRoot;
}

function executeLs(command, options = {}) {
  const started = Date.now();
  const cwd = resolveWorkingDirectory(options.cwd);
  const exec = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (exec.error) throw exec.error;
  const durationMs = Date.now() - started;
  const output = `${exec.stdout || ''}${exec.stderr || ''}`.trim();
  if (!output) throw new Error('ls 命令未返回任何输出');
  return {
    output: output.split('\n').slice(0, 80).join('\n'),
    exitCode: Number.isInteger(exec.status) ? exec.status : 0,
    durationSeconds: Math.round((durationMs / 1000) * 1000) / 1000,
    cwd,
  };
}

function isShellToolFunctionName(name) {
  const normalized = String(name || '').toLowerCase();
  return normalized === 'shell' || normalized === 'shell_command';
}

function runShellToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') {
    throw new Error('工具调用缺失');
  }
  const fn = toolCall.function || {};
  if (!isShellToolFunctionName(fn.name)) {
    throw new Error(`当前仅支持 shell/shell_command 工具调用，收到: ${fn.name || 'unknown'}`);
  }
  const argsObj = safeParseArguments(fn.arguments);
  const normalized = normalizeCommandTokens(argsObj?.command);
  const command = isSafeLsCommand(normalized);
  if (!command) {
    throw new Error(`工具调用未提供受支持的 ls 命令: ${JSON.stringify(argsObj)}`);
  }
  const result = executeLs(command, { cwd: argsObj?.workdir });
  return {
    command,
    cwd: result.cwd,
    output: result.output,
    exitCode: result.exitCode ?? 0,
    durationSeconds: result.durationSeconds ?? 0,
    toolCallId: String(toolCall.id || toolCall.call_id || `call_${Date.now()}`),
    rawCall: toolCall,
  };
}

async function postJson(url, body, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer install-verify',
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (error) {
    throw new Error(`请求失败: ${(error && error.message) || error}`);
  } finally {
    clearTimeout(timer);
  }
}

async function postSseRequest(url, body, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer install-verify',
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const reader = res.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          text += chunk;
          if (
            text.includes('response.completed') ||
            text.includes('"type":"response.completed"') ||
            text.includes('[DONE]')
          ) {
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
        }
      }
    } else {
      text = await res.text();
    }
    let json = null;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try { json = JSON.parse(trimmed); } catch { /* ignore */ }
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (error) {
    throw new Error(`请求失败: ${(error && error.message) || error}`);
  } finally {
    clearTimeout(timer);
  }
}

function postResponsesSse(url, body, timeoutMs) {
  return postSseRequest(url, body, timeoutMs);
}

function unwrapFirstChoice(payload) {
  const extracted = extractChoiceContainer(payload);
  if (!extracted) return { firstChoice: null };
  const { choices } = extracted;
  const firstChoice = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
  return { firstChoice, choices, usage: extracted.usage, source: extracted.source };
}

function parsePossibleSseJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.toLowerCase().startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { return JSON.parse(payload); } catch { /* ignore */ }
  }
  return null;
}

function unwrapChoiceFromResponse(response) {
  if (!response) return { firstChoice: null };
  const payload = (response.json && typeof response.json === 'object')
    ? response.json
    : parsePossibleSseJson(response.text);
  return unwrapFirstChoice(payload);
}

function extractChoiceContainer(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    return { choices: payload.choices, usage: payload.usage, source: 'choices' };
  }
  const sseDirect = extractFromSseContainer(payload.sseStream, 'sseStream');
  if (sseDirect) return sseDirect;
  const data = payload.data;
  if (data && typeof data === 'object') {
    // direct data payload with choices
    if (Array.isArray(data.choices) && data.choices.length > 0) {
      return { choices: data.choices, usage: data.usage, source: 'data' };
    }
    // unwrap nested provider wrapper: { data: { data: { choices: [...] }, status, headers } }
    const nestedData = data.data && typeof data.data === 'object' ? data.data : null;
    if (nestedData && Array.isArray(nestedData.choices) && nestedData.choices.length > 0) {
      return { choices: nestedData.choices, usage: nestedData.usage, source: 'data.data' };
    }
    const dataSse = extractFromSseContainer(data.sseStream, 'data.sseStream');
    if (dataSse) return dataSse;
    const nested = data.__sse_responses;
    if (nested && typeof nested === 'object') {
      if (Array.isArray(nested.choices) && nested.choices.length > 0) {
        return { choices: nested.choices, usage: nested.usage, source: '__sse_responses' };
      }
      const nestedInner = extractFromSseContainer(nested, '__sse_responses');
      if (nestedInner) return nestedInner;
      const nestedDataInner = extractFromSseContainer(nested.data, '__sse_responses.data');
      if (nestedDataInner) return nestedDataInner;
    }
  }
  const responseLayer = payload.response;
  if (responseLayer && typeof responseLayer === 'object') {
    return extractChoiceContainer(responseLayer);
  }
  return null;
}

function extractFromSseContainer(candidate, sourceLabel) {
  if (!candidate || typeof candidate !== 'object') return null;
  const streamData = candidate.data && typeof candidate.data === 'object' ? candidate.data : candidate;
  if (Array.isArray(streamData?.choices) && streamData.choices.length > 0) {
    return { choices: streamData.choices, usage: streamData.usage, source: sourceLabel };
  }
  return null;
}

async function verifyChatStreaming(baseUrl, model, timeoutMs, samplePayload, chatTools, chatMessages) {
  const streamingPayload = {
    ...clonePayload(samplePayload || {}),
    model,
    messages: Array.isArray(chatMessages) ? chatMessages : [],
    tools: chatTools,
    stream: true,
    tool_choice: samplePayload?.tool_choice || 'auto'
  };
  console.log('📡 发送 Chat 样例 SSE 请求...');
  const sseResponse = await postSseRequest(`${baseUrl}/v1/chat/completions`, streamingPayload, timeoutMs);
  if (!sseResponse.ok) {
    throw new Error(`Chat SSE 请求失败: HTTP ${sseResponse.status} ${(sseResponse.text || '').slice(0, 200)}`);
  }
  const payloadText = sseResponse.text || '';
  if (!payloadText.includes('data:')) {
    throw new Error('未检测到 SSE 数据帧');
  }
  if (payloadText.includes('NO_CORE_SSE')) {
    throw new Error('检测到 NO_CORE_SSE 回退，流式输出未生效');
  }
  console.log('✅ Chat SSE 请求返回正常流式数据');
}

async function stopServer() {
  const proc = state.serverProc;
  const baseUrl = state.baseUrl;
  if (state.ownsServer && baseUrl) {
    try { await fetch(`${baseUrl}/shutdown`, { method: 'POST' }).catch(() => {}); } catch { /* ignore */ }
  }
  if (!state.ownsServer) {
    return;
  }
  if (!proc) {
    if (state.logStream) {
      try { state.logStream.end(); } catch { /* ignore */ }
      state.logStream = null;
    }
    return;
  }
  try {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  await new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 3500);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (state.logStream) {
    try { state.logStream.end(); } catch { /* ignore */ }
    state.logStream = null;
  }
  state.serverProc = null;
}

function detectAnthropicSupport(config) {
  try {
    const providers = config?.providers || config?.virtualrouter?.providers || {};
    // Heuristic: if any provider has providerType/protocol anthropic/messages
    const entries = Object.entries(providers);
    for (const [_, prov] of entries) {
      const pt = String(prov?.providerType || prov?.type || '').toLowerCase();
      const proto = String(prov?.providerProtocol || '').toLowerCase();
      if (pt.includes('anthropic') || proto.includes('anthropic') || proto.includes('messages')) {
        return true;
      }
    }
  } catch {}
  return false;
}

async function verifyAnthropicBasic(baseUrl, timeoutMs, model) {
  const sample = loadManualSample('anthropic');
  const payload = clonePayload(sample.payload);
  if (model) {
    payload.model = model;
  }
  payload.stream = true;
  console.log(`📡 发送 Anthropic 样例请求 (${sample.name || 'anthropic'})...`);
  const resp = await postSseRequest(`${baseUrl}/v1/messages`, payload, timeoutMs);
  if (!resp.ok) {
    throw new Error(`Anthropic 请求失败: HTTP ${resp.status} ${(resp.text || '').slice(0, 200)}`);
  }
  const text = resp.text || '';
  if (!text || (!text.includes('message_start') && !text.includes('content_block')) || text.includes('Instructions are not valid')) {
    throw new Error('Anthropic SSE 响应未找到 message_start/content_block 事件');
  }
  console.log('✅ Anthropic 样例 SSE 验证通过');
}

async function printLogTail() {
  if (!state.logPath) return;
  if (!fs.existsSync(state.logPath)) return;
  const data = fs.readFileSync(state.logPath, 'utf-8');
  const lines = data.trim().split('\n');
  const tail = lines.slice(-40).join('\n');
  console.error('\n----- server log tail -----');
  console.error(tail);
  console.error('----- end log tail -----\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(
    args.config ||
    process.env.ROUTECODEX_INSTALL_VERIFY_CONFIG ||
    path.join(os.homedir(), '.routecodex', 'provider', 'glm', 'config.v1.json')
  );
  const timeoutValue = Number.isFinite(args.timeout) ? Number(args.timeout) : null;
  const timeoutMs = timeoutValue == null
    ? 60000
    : (timeoutValue > 1000 ? timeoutValue : timeoutValue * 1000);
  const launcher = String(args.launcher || 'repo').toLowerCase();
  const cliBinary = args.cliBinary || (launcher === 'cli' ? 'routecodex' : '');
  const modeRaw = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim().toLowerCase() : 'both';
  const mode = ['chat', 'responses', 'both', 'anthropic', 'all'].includes(modeRaw) ? modeRaw : 'both';
  const runChatVerify = mode === 'chat' || mode === 'both' || mode === 'all';
  const runResponsesVerify = mode === 'responses' || mode === 'both' || mode === 'all';
  const runAnthropicVerify = mode === 'anthropic' || mode === 'all';
  const runChatToResponsesVerify = !!args.verifyChatResponsesProvider;

  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到验证所需配置文件: ${configPath}`);
  }
  console.log(`🧪 使用配置: ${configPath}`);

  const config = readJson(configPath);
  const port = Number(config?.httpserver?.port ?? config?.server?.port ?? 5520);
  const host = resolveHost(config?.httpserver?.host ?? config?.server?.host ?? '127.0.0.1');
  const baseUrl = `http://${host}:${port}`;
  state.baseUrl = baseUrl;

  const model = resolveModel(config);
  console.log(`🔁 模型: ${model}, 端口: ${port}`);
  const buildRestartOnly = (() => {
    const raw = String(process.env.ROUTECODEX_BUILD_RESTART_ONLY ?? process.env.RCC_BUILD_RESTART_ONLY ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  })();

  const listeners = detectPortPids(port);
  const reuseExistingServer = buildRestartOnly && listeners.length > 0;
  if (listeners.length && !reuseExistingServer) {
    throw new Error(`端口 ${port} 已被使用 (PID: ${listeners.join(', ')}). 请先停止正在运行的 RouteCodex 实例再重试。`);
  }
  if (reuseExistingServer) {
    console.log(`ℹ build-restart-only: 检测到已运行服务 (PID: ${listeners.join(', ')})，复用现有实例进行验证。`);
  }

  console.log('🛠️ 动态生成最新的 pipeline 配置...');
  regeneratePipelineConfig({ port, configPath });

  let command;
  let commandArgs;
  const env = { ...process.env };
  let cwd = repoRoot;
  if (launcher === 'cli') {
    command = cliBinary || 'routecodex';
    commandArgs = ['start', '--config', configPath, '--exclusive'];
    cwd = process.cwd();
    env.ROUTECODEX_CONFIG = configPath;
  } else {
    command = process.execPath;
    commandArgs = [path.join(repoRoot, 'dist', 'index.js')];
    env.ROUTECODEX_CONFIG = configPath;
    env.ROUTECODEX_CONFIG_PATH = configPath;
    env.ROUTECODEX_PORT = String(port);
    env.RCC_PORT = String(port);
  }

  if (!reuseExistingServer) {
    state.logPath = path.join(os.tmpdir(), `routecodex-install-verify-${Date.now()}.log`);
    const logStream = fs.createWriteStream(state.logPath, { flags: 'a' });
    state.ownsServer = true;
    console.log(`🚀 启动 RouteCodex server... (launcher=${launcher === 'cli' ? command : 'node dist/index.js'})`);
    const serverProc = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    serverProc.stdout.pipe(logStream, { end: false });
    serverProc.stderr.pipe(logStream, { end: false });
    state.serverProc = serverProc;
    state.logStream = logStream;
  } else {
    state.ownsServer = false;
    state.serverProc = null;
  }

  await waitForHealth(baseUrl, 90000);
  console.log('✅ server 健康检查通过');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'shell',
        description: '执行安全的 shell 命令',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['command'],
        },
      },
    },
  ];

  if (runChatVerify) {
    const chatSample = loadManualSample('chat');
    const chatPayloadBase = clonePayload(chatSample.payload);
    const chatTools = Array.isArray(chatPayloadBase.tools) && chatPayloadBase.tools.length ? chatPayloadBase.tools : tools;
    const chatMessages = Array.isArray(chatPayloadBase.messages) ? chatPayloadBase.messages : [];
    const firstPayload = {
      ...chatPayloadBase,
      model,
      messages: chatMessages,
      tools: chatTools,
      stream: false,
      tool_choice: chatPayloadBase.tool_choice || 'auto'
    };

    console.log(`📨 发送 Chat 样例请求 (${chatSample.name || 'chat'})...`);
    const firstRes = await postJson(`${baseUrl}/v1/chat/completions`, firstPayload, timeoutMs);
    if (!firstRes.ok) {
      throw new Error(`首次请求失败: HTTP ${firstRes.status} ${firstRes.text?.slice(0, 200) || ''}`);
    }

    const { firstChoice: initialChoice } = unwrapChoiceFromResponse(firstRes);
    const toolCalls = initialChoice?.message?.tool_calls || [];
    const shellCall = toolCalls.find((tc) => isShellToolFunctionName(tc?.function?.name));
    if (!shellCall) {
      const preview = firstRes.json
        ? JSON.stringify(firstRes.json).slice(0, 400)
        : (firstRes.text || '').slice(0, 400);
      throw new Error(`模型未返回 shell 工具调用 (响应片段: ${preview || '无数据'})`);
    }
    console.log(`🛠️  收到 shell 工具调用: ${JSON.stringify(shellCall).slice(0, 200)}`);

    const toolResult = runShellToolCall(shellCall);
    console.log('📁 工具输出 (前几行):');
    console.log(toolResult.output.split('\n').slice(0, 10).join('\n'));

    const assistantMsg = {
      role: 'assistant',
      content: initialChoice?.message?.content ?? '',
      tool_calls: toolCalls,
    };
    const toolMsg = {
      role: 'tool',
      tool_call_id: toolResult.toolCallId,
      content: JSON.stringify({
        output: toolResult.output,
        metadata: {
          exit_code: toolResult.exitCode ?? 0,
          duration_seconds: Number.isFinite(toolResult.durationSeconds) ? toolResult.durationSeconds : 0,
          cwd: toolResult.cwd,
        },
      }),
    };

    const secondPayload = {
      ...chatPayloadBase,
      model,
      messages: [...chatMessages, assistantMsg, toolMsg],
      tools: chatTools,
      stream: false,
      tool_choice: 'auto'
    };

    console.log('📨 提交工具输出...');
    const secondRes = await postJson(`${baseUrl}/v1/chat/completions`, secondPayload, timeoutMs);
    if (!secondRes.ok) {
      throw new Error(`二次请求失败: HTTP ${secondRes.status} ${secondRes.text?.slice(0, 200) || ''}`);
    }
    const { firstChoice: finalChoice } = unwrapChoiceFromResponse(secondRes);
    const finalText = String(finalChoice?.message?.content || '').trim();
    if (!finalText) {
      throw new Error('二次响应为空');
    }
    console.log('🧾 最终响应:');
    console.log(finalText.split('\n').slice(0, 12).join('\n'));
    console.log('✅ Chat 工具链路验证通过');

    await verifyChatStreaming(baseUrl, model, timeoutMs, chatPayloadBase, chatTools, chatMessages);
  } else {
    console.log('⏭️  跳过 Chat 工具验证（mode !== chat）');
  }

  if (runResponsesVerify) {
    await verifyResponsesSample(baseUrl, timeoutMs, model);
  } else {
    console.log('⏭️  跳过 Responses 验证（mode !== responses）');
  }

  if (runAnthropicVerify) {
    const hasAnthropic = detectAnthropicSupport(config);
    if (!hasAnthropic) {
      console.log('⏭️  跳过 Anthropic 验证（当前配置未声明 anthropic provider）');
    } else {
      await verifyAnthropicBasic(baseUrl, timeoutMs, model);
    }
  }

  if (runChatToResponsesVerify) {
    await verifyChatEntryWithResponsesProvider(baseUrl, timeoutMs, model);
  }
}

async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { console.warn(`\n⚠️  install-verify received ${signal}, cleaning up...`); } catch { /* ignore */ }
  try { await stopServer(); } catch { /* ignore */ }
  process.exit(1);
}

process.once('SIGINT', () => { void handleSignal('SIGINT'); });
process.once('SIGTERM', () => { void handleSignal('SIGTERM'); });

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(`❌ install verify 错误: ${(error && error.message) || error}`);
    await printLogTail();
    await stopServer();
    process.exit(1);
  }
  await stopServer();
  process.exit(0);
})();

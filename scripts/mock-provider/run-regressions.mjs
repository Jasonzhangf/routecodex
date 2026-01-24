#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOCK_SAMPLES_DIR = resolveSamplesDir();
const REGISTRY_PATH = path.join(MOCK_SAMPLES_DIR, '_registry', 'index.json');
const NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const ENTRY_FILTER = parseEntryFilter();
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function resolveSamplesDir() {
  const override = String(process.env.ROUTECODEX_MOCK_SAMPLES_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(PROJECT_ROOT, override);
  }
  return path.join(PROJECT_ROOT, 'samples/mock-provider');
}

function parseEntryFilter() {
  const raw = String(process.env.ROUTECODEX_MOCK_ENTRY_FILTER || 'openai-chat,openai-responses').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return null;
  }
  const parts = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

async function ensureCliAvailable() {
  const cliPath = path.join(PROJECT_ROOT, 'dist', 'cli.js');
  const serverPath = path.join(PROJECT_ROOT, 'dist', 'index.js');
  if ((await fileExists(cliPath)) && (await fileExists(serverPath))) {
    return;
  }
  console.warn('[mock:regressions] dist artifacts missing (cli.js/index.js), running "npm run build:min" automatically...');
  await runBuildForMockRegressions();
  if (!(await fileExists(cliPath)) || !(await fileExists(serverPath))) {
    throw new Error('dist artifacts missing after automatic build. Please run "npm run build:dev" manually.');
  }
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runBuildForMockRegressions() {
  await new Promise((resolve, reject) => {
    const child = spawn(NPM_CMD, ['run', 'build:min'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ROUTECODEX_VERIFY_SKIP: '1'
      },
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm run build:min exited with code ${code}`));
      }
    });
    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function loadRegistry() {
  const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw);
  if (!registry || !Array.isArray(registry.samples)) {
    throw new Error('Mock registry missing samples array');
  }
  return registry.samples.filter((sample) => {
    if (!ENTRY_FILTER) {
      return true;
    }
    return sample.entry && ENTRY_FILTER.has(sample.entry);
  });
}

async function loadSampleDocument(sample, options = {}) {
  const fileName = options.fileName || 'request.json';
  const sampleDir = path.join(MOCK_SAMPLES_DIR, sample.path);
  const requestPath = path.join(sampleDir, fileName);
  try {
    const raw = await fs.readFile(requestPath, 'utf-8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !doc.body) {
      throw new Error(`Sample ${sample.reqId} missing request body (${fileName})`);
    }
    return doc;
  } catch (error) {
    if (options.optional) {
      return null;
    }
    throw error;
  }
}

function parseProviderKey(providerKey) {
  const parts = providerKey.split('.');
  if (parts.length < 3) {
    throw new Error(`Invalid providerId "${providerKey}" in registry (expected provider.alias.model)`);
  }
  return {
    providerId: parts[0],
    alias: parts[1],
    model: parts.slice(2).join('.')
  };
}

function resolveToolCallIdStyle(sample) {
  const tags = Array.isArray(sample.tags) ? sample.tags : [];
  if (tags.includes('missing_tool_call_id') || tags.includes('preserve_tool_call_id')) {
    return 'preserve';
  }
  return 'fc';
}

function buildConfig(sample, port) {
  const { providerId, alias, model } = parseProviderKey(sample.providerId);
  const toolCallIdStyle = resolveToolCallIdStyle(sample);
  return {
    version: '1.0.0',
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        [providerId]: {
          id: providerId,
          enabled: true,
          type: 'mock-provider',
          providerType: 'responses',
          baseURL: `https://mock.local/${providerId}`,
          compatibilityProfile: 'compat:passthrough',
          providerId: sample.providerId,
          auth: {
            type: 'apikey',
            keys: {
              [alias]: {
                value: `mock-${alias}-token-1234567890`
              }
            }
          },
          modelId: model,
          models: {
            [model]: {
              maxTokens: 32768
            }
          },
          responses: {
            toolCallIdStyle
          }
        }
      },
      routing: {
        default: [`${providerId}.${alias}.${model}`]
      }
    },
    httpserver: {
      host: '127.0.0.1',
      port
    }
  };
}

async function writeTempConfig(sample, port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-mock-'));
  const file = path.join(dir, 'config.json');
  const config = buildConfig(sample, port);
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8');
  return { dir, file };
}

async function createServer(configPath, port, snapshotRoot) {
  const env = {
    ...process.env,
    ROUTECODEX_USE_MOCK: '1',
    ROUTECODEX_MOCK_CONFIG_PATH: configPath,
    ROUTECODEX_MOCK_SAMPLES_DIR: MOCK_SAMPLES_DIR,
    ROUTECODEX_MOCK_VALIDATE_NAMES: '1',
    ROUTECODEX_STAGE_LOG: process.env.ROUTECODEX_STAGE_LOG ?? '0',
    ROUTECODEX_PORT: String(port),
    ROUTECODEX_CONFIG_PATH: configPath,
    // 将快照写入临时目录，避免污染全局 ~/.routecodex/codex-samples 样本
    ...(snapshotRoot
      ? {
          ROUTECODEX_SNAPSHOT_DIR: snapshotRoot,
          RCC_SNAPSHOT_DIR: snapshotRoot
        }
      : {})
  };
  const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  // Defensive: build scripts or other verification steps may clean dist between checks.
  // Ensure the server entry exists right before spawning.
  // (Avoids confusing "Cannot find module dist/index.js" regressions.)
  if (!(await fileExists(entry))) {
    console.warn('[mock:regressions] dist/index.js missing at spawn time, rebuilding via "npm run build:min"...');
    await runBuildForMockRegressions();
    if (!(await fileExists(entry))) {
      throw new Error(`dist/index.js still missing after rebuild: ${entry}`);
    }
  }
  const child = spawn(process.execPath, [entry], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 4000) {
      stdout = stdout.slice(-4000);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });
  return {
    process: child,
    logs: () => ({ stdout, stderr })
  };
}

async function waitForHealth(port, serverProc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) {
      throw new Error(`RouteCodex server exited early (code ${serverProc.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET' });
      if (res.ok) {
        // /health becomes reachable before runtime is fully initialized (server starts listening first
        // to support token portal). Mock regressions must wait until hub pipeline is ready.
        try {
          const data = await res.json();
          const ready = data && (data.ready === true || data.pipelineReady === true || data.status === 'ok');
          if (ready) {
            return;
          }
        } catch {
          // ignore JSON errors, retry
        }
      }
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error('RouteCodex health check timed out');
}

async function stopServer(child, forceTimeout = 5000) {
  if (!child || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  const deadline = Date.now() + forceTimeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return;
    }
    await delay(100);
  }
  child.kill('SIGKILL');
}

async function createLocalUpstreamServer(handler) {
  return await new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to obtain listen address for upstream server'));
        return;
      }
      resolve({
        server,
        port: address.port
      });
    });
  });
}

function buildIflowUaProbeConfig(port, upstreamPort) {
  return {
    version: '1.0.0',
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        iflow: {
          id: 'iflow',
          enabled: true,
          type: 'iflow',
          baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
          compatibilityProfile: 'chat:iflow',
          auth: {
            type: 'apikey',
            apiKey: 'test-upstream-token'
          },
          models: {
            'glm-4.7': { supportsStreaming: false }
          }
        }
      },
      routing: {
        default: ['iflow.glm-4.7']
      }
    },
    httpserver: {
      host: '127.0.0.1',
      port
    }
  };
}

async function runIflowUserAgentRegression() {
  const seen = {
    path: '',
    headers: {},
    body: ''
  };

  const { server: upstream, port: upstreamPort } = await createLocalUpstreamServer(async (req, res) => {
    try {
      seen.path = String(req.url || '');
      seen.headers = req.headers || {};
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      await new Promise((resolve) => req.on('end', resolve));
      seen.body = raw;
    } catch {
      // ignore
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_mock_iflow_ua',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'glm-4.7',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });

  const port = 5750;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-iflow-ua-'));
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(buildIflowUaProbeConfig(port, upstreamPort), null, 2), 'utf-8');

  const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ROUTECODEX_PORT: String(port),
      ROUTECODEX_CONFIG_PATH: configPath,
      RCC_PORT: String(port),
      RCC_CONFIG_PATH: configPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForHealth(port, child);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // If UA precedence is wrong, this inbound UA will leak to upstream and break iFlow glm-4.7.
        'User-Agent': 'curl/8.7.1'
      },
      body: JSON.stringify({
        model: 'iflow.glm-4.7',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: false
      })
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ua probe request failed: HTTP ${res.status}: ${text}`);
    }

    const upstreamUa = typeof seen.headers['user-agent'] === 'string' ? seen.headers['user-agent'] : '';
    if (upstreamUa !== 'iFlow-Cli') {
      throw new Error(
        `iflow UA regression: expected upstream user-agent="iFlow-Cli", got ${JSON.stringify(upstreamUa)} (path=${seen.path})`
      );
    }
  } finally {
    await stopServer(child);
    await fs.rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => upstream.close(() => resolve()));
  }
}

function collectInvalidNames(payload) {
  const failures = [];
  const check = (value, location) => {
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
    if (!NAME_REGEX.test(value)) {
      failures.push({ location, value });
    }
  };

  const visitArray = (value, base) => {
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      check(entry.name, `${base}[${index}].name`);
      if (entry.function && typeof entry.function === 'object') {
        check(entry.function.name, `${base}[${index}].function.name`);
      }
    });
  };

  if (payload && typeof payload === 'object') {
    const record = payload;
    visitArray(record.input, 'input');
    visitArray(record.tools, 'tools');
    const requiredAction = record.required_action;
    if (requiredAction && typeof requiredAction === 'object') {
      const submit = requiredAction.submit_tool_outputs;
      if (submit && typeof submit === 'object') {
        visitArray(submit.tool_calls, 'required_action.tool_calls');
      }
    }
  }

  return failures;
}

function validateToolCallIds(payload, sample, tagSet) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return errors;
  }
  const enforceCallIdFormat = tagSet.has('require_fc_call_ids');
  const isValidCallId = (value) =>
    /^call_[A-Za-z0-9]+$/.test(value) || /^fc[_-][A-Za-z0-9-]+$/.test(value);

  const allToolCallIds = new Set();
  if (Array.isArray(payload.output)) {
    payload.output.forEach((entry, oi) => {
      if (!entry || typeof entry !== 'object') return;
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      toolCalls.forEach((tc, ti) => {
        if (!tc || typeof tc !== 'object') return;
        const rawId = typeof tc.id === 'string' ? tc.id.trim() : '';
        if (!rawId) {
          errors.push(`output[${oi}].tool_calls[${ti}].id missing`);
          return;
        }
        allToolCallIds.add(rawId);
        if (enforceCallIdFormat && !isValidCallId(rawId)) {
          errors.push(`output[${oi}].tool_calls[${ti}].id has invalid format: ${rawId}`);
        }
      });
    });
  }

  const requiredAction = payload.required_action;
  const submit = requiredAction && typeof requiredAction === 'object'
    ? requiredAction.submit_tool_outputs
    : undefined;
  const submitCalls = submit && typeof submit === 'object'
    ? submit.tool_calls
    : undefined;
  if (Array.isArray(submitCalls)) {
    submitCalls.forEach((tc, i) => {
      if (!tc || typeof tc !== 'object') return;
      const rawId = typeof tc.tool_call_id === 'string'
        ? tc.tool_call_id.trim()
        : typeof tc.id === 'string'
          ? tc.id.trim()
          : '';
      if (!rawId) {
        errors.push(`required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id missing`);
        return;
      }
      if (enforceCallIdFormat && !isValidCallId(rawId)) {
        errors.push(
          `required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id has invalid format: ${rawId}`
        );
      }
      if (allToolCallIds.size > 0 && !allToolCallIds.has(rawId)) {
        errors.push(
          `required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id=${rawId} has no matching output.tool_calls entry`
        );
      }
    });
  }

  return errors;
}

function extractRequestBody(doc) {
  const body = doc && typeof doc === 'object' ? doc.body : undefined;
  if (!body || typeof body !== 'object') {
    return {};
  }
  if (body.body && typeof body.body === 'object') {
    return body.body;
  }
  if (body.payload && typeof body.payload === 'object') {
    return body.payload;
  }
  return body;
}

function resolveRequestUrl(sample, requestDoc, port) {
  const rawCandidate =
    requestDoc.endpoint ||
    (requestDoc.meta && typeof requestDoc.meta.entryEndpoint === 'string' ? requestDoc.meta.entryEndpoint : undefined) ||
    requestDoc.url ||
    sample.entry ||
    '/v1/responses';
  if (typeof rawCandidate === 'string' && /^https?:\/\//i.test(rawCandidate.trim())) {
    return rawCandidate.trim();
  }
  const normalizedPath = typeof rawCandidate === 'string' && rawCandidate.trim().length
    ? rawCandidate.trim()
    : '/v1/responses';
  const pathWithSlash = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  return `http://127.0.0.1:${port}${pathWithSlash}`;
}

async function sendRequest(sample, requestDoc, port) {
  const url = resolveRequestUrl(sample, requestDoc, port);
  const payload = extractRequestBody(requestDoc);
  if (payload && typeof payload === 'object') {
    const meta = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    payload.metadata = { ...meta, mockSampleReqId: sample.reqId };
  }
  const headers = { 'content-type': 'application/json' };
  const wantsStream =
    payload?.stream === true ||
    (requestDoc.body && typeof requestDoc.body === 'object' && requestDoc.body.stream === true) ||
    (requestDoc.meta && requestDoc.meta.stream === true);
  if (wantsStream) {
    headers.accept = 'text/event-stream';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000).unref?.();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return text;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function looksLikeSseErrorStream(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  // 简单判定：包含 SSE error 事件头和 JSON error 负载。
  if (trimmed.includes('event: error') && trimmed.includes('data:')) {
    return true;
  }
  if (trimmed.includes('"type":"error"') || trimmed.includes('"status":502')) {
    return true;
  }
  return false;
}

async function runSample(sample, index) {
  const clientDoc = await loadSampleDocument(sample, { fileName: 'client-request.json', optional: true });
  const requestDoc = clientDoc || (await loadSampleDocument(sample));
  const responseDoc = await loadSampleDocument(sample, { fileName: 'response.json', optional: true });
  const port = 5800 + index;
  const { dir, file } = await writeTempConfig(sample, port);
  // 为当前样本创建独立的临时快照根目录，并在完成后整体删除
  const snapshotRoot = path.join(dir, 'codex-samples');
  const server = await createServer(file, port, snapshotRoot);
  const tags = new Set(Array.isArray(sample.tags) ? sample.tags : []);
  const expectSseTerminationError = tags.has('responses_sse_terminated');
  const allowSampleError =
    responseDoc && typeof responseDoc.status === 'number' && responseDoc.status >= 400;
  try {
    await waitForHealth(port, server.process);
    let responseText;
    try {
      responseText = await sendRequest(sample, requestDoc, port);
      if (expectSseTerminationError) {
        if (!looksLikeSseErrorStream(responseText)) {
          throw new Error(
            'expected SSE termination to surface as HTTP error or SSE error event, but got successful non-error payload'
          );
        }
        // 对于 SSE 终止样本，只要以 SSE error 事件形式返回即可视为通过。
        return;
      }
    } catch (sendError) {
      if (expectSseTerminationError || allowSampleError) {
        const msg = sendError instanceof Error ? sendError.message : String(sendError);
        if (!/HTTP\s+4\d\d|HTTP\s+5\d\d/i.test(msg)) {
          throw new Error(
            `expected HTTP 4xx/5xx error, but got: ${msg}`
          );
        }
        // 对于错误类样本，只要成功以 HTTP 错误形式透出即可。
        return;
      }
      throw sendError;
    }
    const body = (() => {
      try {
        return JSON.parse(responseText);
      } catch {
        return undefined;
      }
    })();
    if (body && Array.isArray(body.output)) {
      const invalid = collectInvalidNames(body);
      if (invalid.length) {
        throw new Error(
          `[${sample.reqId}] provider response still contains invalid names:\n${invalid
            .map((item) => ` - ${item.location}: ${item.value}`)
            .join('\n')}`
        );
      }
      const idErrors = validateToolCallIds(body, sample, tags);
      if (idErrors.length) {
        throw new Error(
          `[${sample.reqId}] tool_call_id invariants failed:\n${idErrors
            .map((msg) => ` - ${msg}`)
            .join('\n')}`
        );
      }
    }
  } catch (error) {
    const logs = server.logs();
    throw new Error(
      `[${sample.reqId}] regression failed: ${error instanceof Error ? error.message : String(error)}\n` +
        `--- RouteCodex stdout ---\n${logs.stdout}\n--- RouteCodex stderr ---\n${logs.stderr}`
    );
  } finally {
    await stopServer(server.process);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  await ensureCliAvailable();
  await runIflowUserAgentRegression();
  const samples = await loadRegistry();
  const watchedTags = new Set(['invalid_name', 'missing_output', 'missing_tool_call_id', 'require_fc_call_ids', 'regression']);
  const regressionSamples = samples.filter(
    (sample) => Array.isArray(sample.tags) && sample.tags.some((tag) => watchedTags.has(tag))
  );
  if (!regressionSamples.length) {
    console.warn('[mock:regressions] No regression-tagged samples matched current filters; skipping mock replay.');
    return;
  }

  const coverageByEntry = Object.create(null);
  const coverageByProvider = Object.create(null);

  const tagCounter = Object.create(null);
  const incrementTag = (tag) => {
    if (!watchedTags.has(tag)) {
      return;
    }
    tagCounter[tag] = (tagCounter[tag] || 0) + 1;
  };
  regressionSamples.forEach((sample) => {
    const matched = new Set();
    const entry = typeof sample.entry === 'string' && sample.entry.trim().length ? sample.entry.trim() : 'unknown';
    const providerId =
      typeof sample.providerId === 'string' && sample.providerId.trim().length ? sample.providerId.trim() : 'unknown';
    coverageByEntry[entry] = (coverageByEntry[entry] || 0) + 1;
    coverageByProvider[providerId] = (coverageByProvider[providerId] || 0) + 1;

    (sample.tags || []).forEach((tag) => {
      if (watchedTags.has(tag) && !matched.has(tag)) {
        incrementTag(tag);
        matched.add(tag);
      }
    });
  });
  for (let idx = 0; idx < regressionSamples.length; idx += 1) {
    const sample = regressionSamples[idx];
    await runSample(sample, idx);
  }
  const summary = Array.from(watchedTags)
    .map((tag) => `${tag}=${tagCounter[tag] || 0}`)
    .join(', ');
  console.log(`✅ mock provider regressions passed (${regressionSamples.length} samples · ${summary})`);
  const byEntry = Object.entries(coverageByEntry)
    .map(([entry, count]) => `${entry}=${count}`)
    .join(', ');
  const byProvider = Object.entries(coverageByProvider)
    .map(([pid, count]) => `${pid}=${count}`)
    .join(', ');
  console.log(`[mock:regressions] coverage by entry: ${byEntry}`);
  console.log(`[mock:regressions] coverage by providerId: ${byProvider}`);
}

main().catch((error) => {
  console.error(`[mock:regressions] Failed: ${error.message}`);
  process.exitCode = 1;
});

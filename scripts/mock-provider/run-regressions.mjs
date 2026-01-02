#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'node:timers/promises';

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
  if (await fileExists(cliPath)) {
    return;
  }
  console.warn('[mock:regressions] dist/cli.js missing, running "npm run build:min" automatically...');
  await runBuildForMockRegressions();
  if (!(await fileExists(cliPath))) {
    throw new Error('dist/cli.js missing after automatic build. Please run "npm run build:dev" manually.');
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

function createServer(configPath, port) {
  const env = {
    ...process.env,
    ROUTECODEX_USE_MOCK: '1',
    ROUTECODEX_MOCK_CONFIG_PATH: configPath,
    ROUTECODEX_MOCK_SAMPLES_DIR: MOCK_SAMPLES_DIR,
    ROUTECODEX_MOCK_VALIDATE_NAMES: '1',
    ROUTECODEX_STAGE_LOG: process.env.ROUTECODEX_STAGE_LOG ?? '0',
    ROUTECODEX_PORT: String(port),
    ROUTECODEX_CONFIG_PATH: configPath
  };
  const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
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
        return;
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

async function runSample(sample, index) {
  const clientDoc = await loadSampleDocument(sample, { fileName: 'client-request.json', optional: true });
  const requestDoc = clientDoc || (await loadSampleDocument(sample));
  const port = 5800 + index;
  const { dir, file } = await writeTempConfig(sample, port);
  const server = createServer(file, port);
  try {
    await waitForHealth(port, server.process);
    const responseText = await sendRequest(sample, requestDoc, port);
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
  const samples = await loadRegistry();
  const watchedTags = new Set(['invalid_name', 'missing_output', 'missing_tool_call_id', 'require_fc_call_ids', 'regression']);
  const regressionSamples = samples.filter(
    (sample) => Array.isArray(sample.tags) && sample.tags.some((tag) => watchedTags.has(tag))
  );
  if (!regressionSamples.length) {
    console.warn('[mock:regressions] No regression-tagged samples matched current filters; skipping mock replay.');
    return;
  }
  const tagCounter = Object.create(null);
  const incrementTag = (tag) => {
    if (!watchedTags.has(tag)) {
      return;
    }
    tagCounter[tag] = (tagCounter[tag] || 0) + 1;
  };
  regressionSamples.forEach((sample) => {
    const matched = new Set();
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
}

main().catch((error) => {
  console.error(`[mock:regressions] Failed: ${error.message}`);
  process.exitCode = 1;
});

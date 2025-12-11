#!/usr/bin/env node

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const HOME = os.homedir();
const PROVIDER_ROOT = path.join(HOME, '.routecodex', 'provider');
const GOLDEN_ROOT = path.join(HOME, '.routecodex', 'golden_samples');
const CUSTOM_SAMPLE_ROOT = path.join(GOLDEN_ROOT, 'new');
const MOCK_SAMPLES_ROOT = path.join(PROJECT_ROOT, 'samples', 'mock-provider');
const REGISTRY_PATH = path.join(MOCK_SAMPLES_ROOT, '_registry', 'index.json');

function usage() {
  console.log(
    'Usage: node scripts/mock-provider/capture-from-configs.mjs [options]\n' +
      '\nOptions:\n' +
      '  --filter <providerIds>   Comma separated provider ids to capture (default: all)\n' +
      '  --help                   Show this message\n'
  );
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { providerFilter: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--filter') {
      const next = args[i + 1];
      if (!next) {
        console.error('--filter requires a comma separated provider list');
        process.exit(1);
      }
      i += 1;
      const list = next
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      options.providerFilter = new Set(list);
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  return options;
}

const ENTRY_ENDPOINTS = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages'
};

const ENTRY_HEADERS = {
  'openai-responses': { 'OpenAI-Beta': 'responses-2024-12-17' }
};

function ensureDir(dir) {
  fssync.mkdirSync(dir, { recursive: true });
}

function listProviderConfigs() {
  const entries = [];
  if (!fssync.existsSync(PROVIDER_ROOT)) {
    throw new Error(`provider directory missing: ${PROVIDER_ROOT}`);
  }
  for (const dir of fssync.readdirSync(PROVIDER_ROOT)) {
    const absDir = path.join(PROVIDER_ROOT, dir);
    if (!fssync.statSync(absDir).isDirectory()) continue;
    for (const file of fssync.readdirSync(absDir)) {
      if (!file.startsWith('config') || !file.endsWith('.json')) continue;
      const absFile = path.join(absDir, file);
      let doc;
      try {
        doc = JSON.parse(fssync.readFileSync(absFile, 'utf-8'));
      } catch (error) {
        console.warn(`[mock-capture] skip malformed config ${absFile}: ${error.message}`);
        continue;
      }
      const providers = doc?.virtualrouter?.providers;
      if (!providers || typeof providers !== 'object') continue;
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        entries.push({
          configFile: absFile,
          providerId,
          providerConfig,
          doc
        });
      }
    }
  }
  return entries;
}

function detectEntryType(providerConfig) {
  const type = String(providerConfig?.type || providerConfig?.providerType || '').toLowerCase();
  if (type.includes('anthropic')) return 'anthropic-messages';
  if (type.includes('responses')) return 'openai-responses';
  if (type.includes('gemini')) return 'openai-chat';
  if (type.includes('iflow')) return 'openai-chat';
  return 'openai-chat';
}

function loadGoldenRequest(entryType, providerId) {
  const dir = path.join(CUSTOM_SAMPLE_ROOT, entryType, providerId);
  const samplePath = path.join(dir, 'request.sample.json');
  if (!fssync.existsSync(samplePath)) {
    return null;
  }
  const body = JSON.parse(fssync.readFileSync(samplePath, 'utf-8'));
  return { body };
}

function pickModel(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    return 'unknown-model';
  }
  if (typeof requestBody.model === 'string' && requestBody.model.trim()) {
    return requestBody.model.trim();
  }
  if (Array.isArray(requestBody.messages)) {
    const meta = requestBody.messages.find((msg) => msg?.metadata?.model);
    if (meta?.metadata?.model) return String(meta.metadata.model);
  }
  return 'unknown-model';
}

function sanitizePathSegment(value) {
  return value.replace(/[\\/]/g, '_');
}

function buildSamplePath(entry, providerKey, model, timestamp) {
  const date = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
  const time = timestamp.toISOString().slice(11, 19).replace(/:/g, '');
  const safeProvider = sanitizePathSegment(providerKey);
  const safeModel = sanitizePathSegment(model);
  return path.join(entry, safeProvider, safeModel, date, time, '001');
}

function waitForHealth(port, proc, timeoutMs = 25000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (proc.exitCode !== null) {
        reject(new Error('RouteCodex exited before health check'));
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('health check timeout'));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // retry
      }
      setTimeout(check, 500);
    };
    check();
  });
}

async function sendRequest(port, entryType, body) {
  const endpoint = ENTRY_ENDPOINTS[entryType];
  if (!endpoint) throw new Error(`unknown entry type: ${entryType}`);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer mock-sample',
    ...ENTRY_HEADERS[entryType]
  };
  if (body?.stream === true) {
    headers.Accept = 'text/event-stream';
  } else {
    headers.Accept = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return res;
}

async function captureResponsePayload(res) {
  const contentType = String(res.headers.get('content-type') || '');
  if (contentType.includes('text/event-stream')) {
    const events = [];
    const decoder = new TextDecoder();
    let buffer = '';
    if (!res.body) {
      return { status: res.status, kind: 'sse', events };
    }
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim()) continue;
        let eventName;
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5));
          }
        }
        if (dataLines.length) {
          events.push({
            ...(eventName ? { event: eventName } : {}),
            data: dataLines.join('\n')
          });
        }
      }
    }
    return { status: res.status, kind: 'sse', events };
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, kind: 'json', body: payload };
}

function formatReqId(entry, providerKey, model, timestamp, seq = '001') {
  const date = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
  const time = timestamp.toISOString().slice(11, 19).replace(/:/g, '');
  return `${entry}-${providerKey}-${model}-${date}T${time}-${seq}`;
}

async function updateRegistry(entries) {
  const registryRaw = await fs.readFile(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(registryRaw);
  registry.updated = new Date().toISOString();
  registry.samples.push(...entries);
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

async function main() {
  const options = parseArgs();
  const providerEntries = listProviderConfigs();
  const capturedSamples = [];
  let portBase = 6020;
  for (const entry of providerEntries) {
    if (options.providerFilter && !options.providerFilter.has(entry.providerId)) {
      continue;
    }
    const entryType = detectEntryType(entry.providerConfig);
    const requestSample = loadGoldenRequest(entryType, entry.providerId);
    if (!requestSample) {
      console.warn(`[mock-capture] skip ${entry.providerId} (${entryType}): golden request missing`);
      continue;
    }
    const model = pickModel(requestSample.body);
    const providerKey = `${entry.providerId}.default.${model}`;
    const port = portBase++;
    const env = {
      ...process.env,
      ROUTECODEX_VERIFY_SKIP: '1',
      ROUTECODEX_PORT: String(port)
    };
    const server = spawn('routecodex', ['start', '--config', entry.configFile], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    server.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
    });
    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    try {
      await waitForHealth(port, server);
      const res = await sendRequest(port, entryType, requestSample.body);
      const payload = await captureResponsePayload(res);
      const timestamp = new Date();
      const reqId = formatReqId(entryType, providerKey, model, timestamp);
      const relPath = buildSamplePath(entryType, providerKey, model, timestamp);
      const absDir = path.join(MOCK_SAMPLES_ROOT, relPath);
      ensureDir(absDir);
      const requestDoc = {
        reqId,
        entry: entryType,
        endpoint: ENTRY_ENDPOINTS[entryType],
        providerId: providerKey,
        model,
        timestamp: timestamp.toISOString(),
        body: requestSample.body
      };
      const responseDoc = {
        reqId,
        entry: entryType,
        endpoint: ENTRY_ENDPOINTS[entryType],
        providerId: providerKey,
        model,
        timestamp: timestamp.toISOString(),
        status: payload.status
      };
      if (payload.kind === 'sse') {
        responseDoc.sseEvents = payload.events;
      } else {
        responseDoc.body = payload.body;
      }
      await fs.writeFile(path.join(absDir, 'request.json'), JSON.stringify(requestDoc, null, 2));
      await fs.writeFile(path.join(absDir, 'response.json'), JSON.stringify(responseDoc, null, 2));
      capturedSamples.push({
        reqId,
        entry: entryType,
        providerId: providerKey,
        model,
        timestamp: timestamp.toISOString(),
        path: relPath.replace(/\\/g, '/'),
        tags: ['regression']
      });
      console.log(`[mock-capture] captured ${reqId}`);
    } catch (error) {
      console.error(`[mock-capture] failed for ${entry.providerId} (${entryType}): ${error.message}`);
      console.error(stdout);
      console.error(stderr);
    } finally {
      server.kill('SIGINT');
    }
  }
  if (capturedSamples.length) {
    await updateRegistry(capturedSamples);
    console.log(`[mock-capture] registry updated with ${capturedSamples.length} sample(s).`);
  } else {
    console.warn('[mock-capture] no samples captured.');
  }
}

main().catch((error) => {
  console.error('[mock-capture] fatal:', error);
  process.exit(1);
});

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const HOME = os.homedir();
const PROVIDER_ROOT = path.join(HOME, '.routecodex', 'provider');
const SNAPSHOT_ROOT = path.join(HOME, '.routecodex', 'golden_samples');
const PROVIDER_GOLDEN_ROOT = path.join(SNAPSHOT_ROOT, 'provider_golden_samples');
const CUSTOM_SAMPLE_ROOT = path.join(SNAPSHOT_ROOT, 'new');
const TEMP_ROOT = path.join(process.cwd(), 'tmp', 'provider-captures');
const STAGE_DIRS = {
  'openai-chat': path.join(SNAPSHOT_ROOT, 'openai-chat'),
  'openai-responses': path.join(SNAPSHOT_ROOT, 'openai-responses'),
  'anthropic-messages': path.join(SNAPSHOT_ROOT, 'anthropic-messages')
};
const ENTRY_STAGE_MATRIX = {
  'openai-chat': {
    request: [
      'req_inbound_stage2_semantic_map',
      'req_process_tool_filters_request_pre',
      'req_process_tool_filters_request_post',
      'req_outbound_stage1_semantic_map'
    ],
    response: [
      'resp_inbound_stage3_semantic_map',
      'resp_process_tool_filters_response_pre',
      'resp_process_tool_filters_response_post',
      'resp_outbound_stage1_client_remap'
    ]
  },
  'openai-responses': {
    request: [
      'req_inbound_stage2_semantic_map',
      'req_process_stage1_tool_governance',
      'req_process_stage2_route_select',
      'req_outbound_stage1_semantic_map'
    ],
    response: [
      'resp_inbound_stage3_semantic_map',
      'resp_process_stage1_tool_governance',
      'resp_process_stage2_finalize',
      'resp_outbound_stage1_client_remap'
    ]
  },
  'anthropic-messages': {
    request: [
      'req_inbound_stage2_semantic_map',
      'req_process_stage1_tool_governance',
      'req_process_stage2_route_select',
      'req_outbound_stage1_semantic_map'
    ],
    response: [
      'resp_inbound_stage3_semantic_map',
      'resp_process_stage1_tool_governance',
      'resp_process_stage2_finalize',
      'resp_outbound_stage1_client_remap'
    ]
  }
};
const AUX_STAGE_NAMES = [
  'req_inbound_stage1_format_parse',
  'resp_inbound_stage2_format_parse'
];
const TRACKED_STAGE_NAMES = Array.from(new Set([...Object.values(ENTRY_STAGE_MATRIX).flatMap((group) => [...group.request, ...group.response]), ...AUX_STAGE_NAMES]));

function usage() {
  console.log(`Usage: node scripts/tools/capture-provider-goldens.mjs [options]\n\n` +
    '  --update-golden   Overwrite provider_golden_samples when diffs are detected\n' +
    '  --custom-only     Only use ~/.routecodex/golden_samples/new samples (skip live capture)\n');
  process.exit(0);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { updateGolden: false, customOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-golden') opts.updateGolden = true;
    else if (arg === '--custom-only') opts.customOnly = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }
  return opts;
}

const ENTRY_DEFS = {
  'openai-chat': {
    stageDir: 'openai-chat',
    endpoint: '/v1/chat/completions',
    samplePath: path.join(
      ROOT,
      'samples',
      'chat-blackbox',
      'openai',
      'request-basic.json'
    ),
    extraHeaders: {}
  },
  'openai-responses': {
    stageDir: 'openai-responses',
    endpoint: '/v1/responses',
    samplePath: path.join(
      ROOT,
      'samples',
      'chat-blackbox',
      'responses',
      'request-basic.json'
    ),
    extraHeaders: { 'OpenAI-Beta': 'responses-2024-12-17' }
  },
  'anthropic-messages': {
    stageDir: 'anthropic-messages',
    endpoint: '/v1/messages',
    samplePath: path.join(
      ROOT,
      'samples',
      'chat-blackbox',
      'anthropic',
      'request-basic.json'
    ),
    extraHeaders: {}
  }
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function listProviderConfigs() {
  const entries = [];
  if (!fs.existsSync(PROVIDER_ROOT)) {
    throw new Error(`Provider directory missing: ${PROVIDER_ROOT}`);
  }
  for (const dir of fs.readdirSync(PROVIDER_ROOT)) {
    const absDir = path.join(PROVIDER_ROOT, dir);
    if (!fs.statSync(absDir).isDirectory()) continue;
    const files = fs.readdirSync(absDir).filter((f) => f.startsWith('config') && f.endsWith('.json'));
    for (const file of files) {
      const absFile = path.join(absDir, file);
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(absFile, 'utf-8'));
      } catch (error) {
        console.warn(`[capture] skip malformed config ${absFile}: ${error.message}`);
        continue;
      }
      const providers = doc?.virtualrouter?.providers;
      if (!providers || typeof providers !== 'object') continue;
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        entries.push({
          dir,
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
  const type = String(providerConfig?.type || '').toLowerCase();
  if (type.includes('anthropic')) return 'anthropic-messages';
  if (type.includes('responses')) return 'openai-responses';
  return 'openai-chat';
}

function pickModel(providerConfig) {
  const models = providerConfig?.models;
  if (!models || typeof models !== 'object') return null;
  const keys = Object.keys(models);
  if (!keys.length) return null;
  const preferred = keys.find((key) => !/embedding|imagen|veo|live|lyria/i.test(key));
  return preferred || keys[0];
}

function sanitizeProviderId(providerId) {
  if (typeof providerId !== 'string' || !providerId.trim()) {
    return 'provider';
  }
  return providerId.replace(/[^a-z0-9_-]/gi, '_');
}

function normalizeProviderIdentifiers(body, providerId, sanitizedId) {
  if (!body || typeof body !== 'object' || providerId === sanitizedId) {
    return body;
  }
  const json = JSON.stringify(body);
  if (!json.includes(sanitizedId)) {
    return body;
  }
  return JSON.parse(json.split(sanitizedId).join(providerId));
}

function buildDerivedConfig(baseDoc, providerId, providerConfig, portOverride, overrideProviderId) {
  const clone = JSON.parse(JSON.stringify(baseDoc));
  const providerKey = overrideProviderId ?? providerId;
  const providerClone = JSON.parse(JSON.stringify(providerConfig));
  providerClone.id = providerKey;
  clone.virtualrouter.providers = { [providerKey]: providerClone };
  const model = pickModel(providerConfig);
  if (!model) throw new Error(`Provider ${providerId} missing models list`);
  clone.virtualrouter.routing = { default: [`${providerKey}.${model}`] };
  clone.httpserver = clone.httpserver || {};
  clone.httpserver.host = '127.0.0.1';
  clone.httpserver.port = portOverride;
  return clone;
}

async function waitForHealth(port, timeoutMs = 20000) {
  const url = `http://127.0.0.1:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await delay(500);
  }
  throw new Error(`Health check timed out on port ${port}`);
}

async function consumeResponse(res) {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.body) {
    await res.text();
    return;
  }
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function snapshotStageFiles(stageDir, suffix) {
  if (!fs.existsSync(stageDir)) return new Set();
  const files = fs.readdirSync(stageDir).filter((name) => name.endsWith(suffix));
  return new Set(files);
}

function diffStageFiles(stageDir, suffix, beforeSet) {
  if (!fs.existsSync(stageDir)) return [];
  const files = fs.readdirSync(stageDir).filter((name) => name.endsWith(suffix));
  return files.filter((name) => !beforeSet.has(name));
}

function describeType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function diffJson(expected, actual, prefix = '<root>') {
  const diffs = [];
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    diffs.push(`${prefix}: type mismatch (${describeType(expected)} vs ${describeType(actual)})`);
    return diffs;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      diffs.push(`${prefix}: length mismatch (${expected.length} vs ${actual.length})`);
    }
    const len = Math.min(expected.length, actual.length);
    for (let i = 0; i < len && diffs.length <= 32; i += 1) {
      diffs.push(...diffJson(expected[i], actual[i], `${prefix}[${i}]`));
    }
    return diffs;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const nextPath = prefix === '<root>' ? key : `${prefix}.${key}`;
      if (!(key in expected)) {
        diffs.push(`${nextPath}: missing in golden`);
      } else if (!(key in actual)) {
        diffs.push(`${nextPath}: missing in captured payload`);
      } else {
        diffs.push(...diffJson(expected[key], actual[key], nextPath));
      }
      if (diffs.length > 32) break;
    }
    return diffs;
  }
  if (!Object.is(expected, actual)) {
    diffs.push(`${prefix}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`);
  }
  return diffs;
}

function loadCustomSample(providerId, entryType) {
  const dir = path.join(CUSTOM_SAMPLE_ROOT, entryType, providerId);
  const samplePath = path.join(dir, 'request.sample.json');
  if (!fs.existsSync(samplePath)) return null;
  let stageFile;
  const metaPath = path.join(dir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      stageFile = meta?.stageFile;
    } catch (error) {
      console.warn(`[capture] custom meta parse failed for ${providerId}/${entryType}: ${error.message}`);
    }
  }
  return {
    body: JSON.parse(fs.readFileSync(samplePath, 'utf-8')),
    stageFile,
    dir
  };
}

function saveProviderSample(providerId, entryType, sourceStagePath, providedBody, updateGolden) {
  const targetDir = path.join(PROVIDER_GOLDEN_ROOT, providerId, entryType);
  ensureDir(targetDir);
  let body = providedBody;
  if (!body) {
    if (!sourceStagePath || !fs.existsSync(sourceStagePath)) {
      throw new Error(`missing stage payload for ${providerId} (${entryType})`);
    }
    const raw = JSON.parse(fs.readFileSync(sourceStagePath, 'utf-8'));
    body = raw?.body ?? raw;
  }
  const targetFile = path.join(targetDir, 'request.sample.json');
  if (fs.existsSync(targetFile)) {
    const previous = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    const diffs = diffJson(previous, body);
    if (diffs.length) {
      if (!updateGolden) {
        throw new Error(`golden mismatch for ${providerId} (${entryType}): ${diffs.slice(0, 8).join('; ')}`);
      }
    } else if (!updateGolden) {
      return;
    }
  }
  fs.writeFileSync(targetFile, JSON.stringify(body, null, 2));
  const meta = {
    providerId,
    entryType,
    capturedAt: new Date().toISOString(),
    stageFile: sourceStagePath || null
  };
  fs.writeFileSync(path.join(targetDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function replaySample(baseUrl, entryDef, headersOverride = {}) {
  const body = JSON.parse(fs.readFileSync(entryDef.samplePath, 'utf-8'));
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer provider-golden',
    Accept: body?.stream === true ? 'text/event-stream' : 'application/json',
    ...entryDef.extraHeaders,
    ...headersOverride
  };
  const res = await fetch(`${baseUrl}${entryDef.endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  await consumeResponse(res);
}

function spawnServer(configPath, port) {
  const env = {
    ...process.env,
    ROUTECODEX_HUB_SNAPSHOTS: '1',
    ROUTECODEX_VERIFY_SKIP: '1',
    ROUTECODEX_PORT: String(port)
  };
  return spawn(
    'routecodex',
    ['start', '--config', configPath],
    { env, stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

async function captureProvider(providerEntry, entryType, port, options, sanitizedProviderId) {
  const stageDir = path.join(SNAPSHOT_ROOT, ENTRY_DEFS[entryType].stageDir);
  const suffix = '_req_outbound_stage2_format_build.json';
  const before = snapshotStageFiles(stageDir, suffix);
  const baseUrl = `http://127.0.0.1:${port}`;
  await replaySample(baseUrl, ENTRY_DEFS[entryType]);
  await delay(2000);
  const candidates = diffStageFiles(stageDir, suffix, before);
  if (!candidates.length) {
    throw new Error(`No new stage snapshots detected for ${entryType}`);
  }
  const latest = candidates
    .map((name) => ({ name, mtime: fs.statSync(path.join(stageDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  const stagePath = path.join(stageDir, latest.name);
  let processedBody;
  try {
    const stagePayload = JSON.parse(fs.readFileSync(stagePath, 'utf-8'));
    const capturedBody = stagePayload?.body ?? stagePayload;
    processedBody = normalizeProviderIdentifiers(
      capturedBody,
      providerEntry.providerId,
      sanitizedProviderId
    );
  } catch {
    processedBody = null;
  }
  saveProviderSample(providerEntry.providerId, entryType, stagePath, processedBody, options.updateGolden);
  return { stagePath, mode: 'recorded' };
}

async function main() {
  const options = parseArgs();
  ensureDir(TEMP_ROOT);
  const providers = listProviderConfigs();
  const captured = new Set();
  const results = [];
  let portBase = 5800;

  for (const entry of providers) {
    const entryType = detectEntryType(entry.providerConfig);
    const entryDef = ENTRY_DEFS[entryType];
    if (!entryDef) continue;
    const captureKey = `${entry.providerId}:${entryType}`;
    if (captured.has(captureKey)) {
      continue;
    }
    const sampleExists = fs.existsSync(entryDef.samplePath);
    if (!sampleExists) {
      results.push({ provider: entry.providerId, entryType, status: 'skipped', reason: 'sample missing' });
      continue;
    }
    const custom = loadCustomSample(entry.providerId, entryType);
    if (custom) {
      console.log(`[capture] using custom sample for ${entry.providerId} (${entryType}) from ${custom.dir}`);
      saveProviderSample(entry.providerId, entryType, custom.stageFile, custom.body, options.updateGolden);
      captured.add(captureKey);
      results.push({
        provider: entry.providerId,
        entryType,
        status: 'ok',
        stagePath: custom.stageFile || '<custom>',
        mode: 'custom'
      });
      continue;
    }
    if (options.customOnly) {
      results.push({
        provider: entry.providerId,
        entryType,
        status: 'skipped',
        reason: 'custom sample missing'
      });
      continue;
    }

    const port = portBase++;
    const sanitizedProviderId = sanitizeProviderId(entry.providerId);
    const derived = buildDerivedConfig(
      entry.doc,
      entry.providerId,
      entry.providerConfig,
      port,
      sanitizedProviderId
    );
    const tmpConfig = path.join(
      TEMP_ROOT,
      `${entry.providerId}.${entryType.replace(/[^a-z0-9-]/gi, '_')}.${port}.json`
    );
    fs.writeFileSync(tmpConfig, JSON.stringify(derived, null, 2));
    const server = spawnServer(tmpConfig, port);
    let captureInfo;
    try {
      await waitForHealth(port);
      captureInfo = await captureProvider(entry, entryType, port, options, sanitizedProviderId);
      captured.add(captureKey);
      results.push({ provider: entry.providerId, entryType, status: 'ok', stagePath: captureInfo.stagePath, mode: captureInfo.mode });
    } catch (error) {
      results.push({ provider: entry.providerId, entryType, status: 'error', reason: error.message });
    } finally {
      server.kill('SIGINT');
      await delay(1000);
    }
  }

  console.log('\\n[capture] summary');
  for (const row of results) {
    if (row.status === 'ok') {
      const sourceLabel = row.mode === 'custom' ? 'custom' : 'capture';
      console.log(`  ✓ ${row.provider} (${row.entryType}) [${sourceLabel}] → ${row.stagePath || '<body>'}`);
    } else {
      console.log(`  ✗ ${row.provider} (${row.entryType}) → ${row.reason}`);
    }
  }
}

main().catch((error) => {
  console.error('[capture] failed:', error);
  process.exit(1);
});

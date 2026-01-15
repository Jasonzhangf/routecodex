#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const CODEX_SAMPLES_DIR = resolveCodexSamplesDir();
const MOCK_SAMPLES_DIR = resolveMockSamplesDir();
const REGISTRY_PATH = path.join(MOCK_SAMPLES_DIR, '_registry/index.json');

function resolveCodexSamplesDir() {
  const override = String(process.env.ROUTECODEX_SAMPLES_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
  }
  return path.join(os.homedir(), '.routecodex', 'codex-samples');
}

function resolveMockSamplesDir() {
  const override = String(process.env.ROUTECODEX_MOCK_SAMPLES_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
  }
  return path.join(projectRoot, 'samples/mock-provider');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.samples)) {
      return parsed;
    }
  } catch {
    // fallthrough
  }
  return { version: 1, updated: new Date().toISOString(), samples: [] };
}

async function saveRegistry(registry) {
  registry.updated = new Date().toISOString();
  await ensureDir(path.dirname(REGISTRY_PATH));
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function sanitizeComponent(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
}

function timestampToToken(timestamp) {
  const t = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp)
    : new Date();
  const yyyy = String(t.getFullYear()).padStart(4, '0');
  const mm = String(t.getMonth() + 1).padStart(2, '0');
  const dd = String(t.getDate()).padStart(2, '0');
  const hh = String(t.getHours()).padStart(2, '0');
  const mi = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}

function findProviderId(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const queue = [node];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string' && key.toLowerCase() === 'providerid') {
        return value;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }
  return null;
}

async function detectProviderId(entryDir, prefix, request) {
  const semanticPath = prefix ? path.join(entryDir, `${prefix}_semantic_map_from_chat.json`) : null;
  if (semanticPath && (await fileExists(semanticPath))) {
    try {
      const semantic = JSON.parse(await fs.readFile(semanticPath, 'utf-8'));
      const detected = findProviderId(semantic);
      if (detected) {
        return sanitizeComponent(detected, 'unknown');
      }
    } catch {
      // ignore semantic parse errors
    }
  }
  const fallback =
    request?.providerId ||
    request?.meta?.providerId ||
    request?.body?.providerId ||
    request?.body?.meta?.providerId ||
    'unknown';
  return sanitizeComponent(fallback, 'unknown');
}

function buildTags(response) {
  const tags = [];
  const body = response?.body || response?.data?.body;
  if (body?.__sse_responses || body?.mode === 'sse') {
    tags.push('sse');
  }
  const toolCalls = body?.tool_calls || body?.output?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    tags.push('tool-call');
  }
  return tags;
}

function parseRequestTimestamp(requestId, request) {
  if (typeof request?.timestamp === 'number' && Number.isFinite(request.timestamp)) {
    return request.timestamp;
  }
  const buildTime = request?.meta?.buildTime;
  if (typeof buildTime === 'string') {
    const parsed = Date.parse(buildTime);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const match = String(requestId || '').match(/(\d{8})T(\d{6})(\d{3})?/);
  if (match) {
    const ymd = match[1];
    const hms = match[2];
    const ms = match[3] || '000';
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(4, 6));
    const day = Number(ymd.slice(6, 8));
    const hour = Number(hms.slice(0, 2));
    const min = Number(hms.slice(2, 4));
    const sec = Number(hms.slice(4, 6));
    const msNum = Number(ms);
    if ([year, month, day, hour, min, sec, msNum].every((v) => Number.isFinite(v))) {
      return new Date(year, month - 1, day, hour, min, sec, msNum).getTime();
    }
  }
  return Date.now();
}

function extractModelFromProviderRequest(request) {
  const body = request?.body || request?.data?.body;
  const raw =
    body?.model ||
    body?.data?.model ||
    request?.model ||
    request?.data?.model ||
    undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'unknown';
}

async function detectProviderIdFromRequestDir(requestDir, request) {
  try {
    const files = await fs.readdir(requestDir);
    const semanticCandidates = files
      .filter((name) => name.toLowerCase().endsWith('.json') && name.toLowerCase().includes('semantic_map'))
      .slice(0, 10);
    for (const file of semanticCandidates) {
      try {
        const semantic = JSON.parse(await fs.readFile(path.join(requestDir, file), 'utf-8'));
        const detected = findProviderId(semantic);
        if (detected) {
          return sanitizeComponent(detected, 'unknown');
        }
      } catch {
        // ignore semantic parse errors
      }
    }
  } catch {
    // ignore dir read errors
  }
  return await detectProviderId(requestDir, null, request);
}

function pickLatestStageFile(files, prefix) {
  const candidates = files
    .filter((name) => name.toLowerCase().endsWith('.json') && name.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (!candidates.length) {
    return null;
  }
  return candidates[candidates.length - 1];
}

async function extractPair(entryName, entryDir, file, registry, seqMap, filters = {}) {
  const prefix = file.replace('_provider-request.json', '');
  const requestPath = path.join(entryDir, file);
  const responsePath = path.join(entryDir, `${prefix}_provider-response.json`);
  if (!(await fileExists(responsePath))) {
    console.warn(`⚠️  Missing provider-response for ${prefix}, skipped.`);
    return;
  }

  const request = JSON.parse(await fs.readFile(requestPath, 'utf-8'));
  const response = JSON.parse(await fs.readFile(responsePath, 'utf-8'));
  const providerId = await detectProviderId(entryDir, prefix, request);
  if (filters.provider && providerId !== sanitizeComponent(filters.provider, filters.provider)) {
    return;
  }
  const model = sanitizeComponent(extractModelFromProviderRequest(request), 'unknown');
  const tsToken = timestampToToken(parseRequestTimestamp(prefix, request));
  const seqKey = `${entryName}|${providerId}|${model}|${tsToken}`;
  const seq = (seqMap.get(seqKey) || 0) + 1;
  seqMap.set(seqKey, seq);
  const seqStr = String(seq).padStart(3, '0');
  const reqId = `${entryName}-${providerId}-${model}-${tsToken}-${seqStr}`;

  const daySegment = tsToken.slice(0, 8);
  const timeSegment = tsToken.slice(9);
  const targetDir = path.join(MOCK_SAMPLES_DIR, entryName, providerId, model, daySegment, timeSegment, seqStr);
  await ensureDir(targetDir);

  const enrichedRequest = { ...request, reqId, entryEndpoint: request?.endpoint };
  const enrichedResponse = { ...response, reqId, entryEndpoint: response?.endpoint };
  await fs.writeFile(path.join(targetDir, 'request.json'), JSON.stringify(enrichedRequest, null, 2));
  await fs.writeFile(path.join(targetDir, 'response.json'), JSON.stringify(enrichedResponse, null, 2));

   // 可选：如果存在入口层的 client-request 快照，一并抽取，便于端到端重放。
   const clientSnapshotPath = path.join(entryDir, `${prefix}_client-request.json`);
   if (await fileExists(clientSnapshotPath)) {
     try {
       const client = JSON.parse(await fs.readFile(clientSnapshotPath, 'utf-8'));
       const enrichedClient = { ...client, reqId, entryEndpoint: client?.endpoint };
       await fs.writeFile(
         path.join(targetDir, 'client-request.json'),
         JSON.stringify(enrichedClient, null, 2)
       );
     } catch {
       // client-request 仅用于重放，解析失败不阻断样本注册。
     }
   }

  registry.samples = registry.samples.filter((sample) => sample.reqId !== reqId);
  registry.samples.push({
    reqId,
    entry: entryName,
    providerId,
    model,
    timestamp: new Date(request?.timestamp || Date.now()).toISOString(),
    path: path.relative(MOCK_SAMPLES_DIR, targetDir),
    tags: buildTags(response)
  });
  console.log(`✅ ${reqId}`);
}

async function extractPairFromRequestDir(entryName, requestDir, registry, seqMap, filters = {}) {
  const files = await fs.readdir(requestDir);
  const providerRequestFile = pickLatestStageFile(files, 'provider-request');
  const providerResponseFile = pickLatestStageFile(files, 'provider-response');
  if (!providerRequestFile || !providerResponseFile) {
    return;
  }

  const requestPath = path.join(requestDir, providerRequestFile);
  const responsePath = path.join(requestDir, providerResponseFile);
  const request = JSON.parse(await fs.readFile(requestPath, 'utf-8'));
  const response = JSON.parse(await fs.readFile(responsePath, 'utf-8'));

  const requestId = path.basename(requestDir);
  const providerId = await detectProviderIdFromRequestDir(requestDir, request);
  if (filters.provider && providerId !== sanitizeComponent(filters.provider, filters.provider)) {
    return;
  }
  const model = sanitizeComponent(extractModelFromProviderRequest(request), 'unknown');
  const tsToken = timestampToToken(parseRequestTimestamp(requestId, request));
  const seqKey = `${entryName}|${providerId}|${model}|${tsToken}`;
  const seq = (seqMap.get(seqKey) || 0) + 1;
  seqMap.set(seqKey, seq);
  const seqStr = String(seq).padStart(3, '0');
  const reqId = `${entryName}-${providerId}-${model}-${tsToken}-${seqStr}`;

  const daySegment = tsToken.slice(0, 8);
  const timeSegment = tsToken.slice(9);
  const targetDir = path.join(MOCK_SAMPLES_DIR, entryName, providerId, model, daySegment, timeSegment, seqStr);
  await ensureDir(targetDir);

  const enrichedRequest = { ...request, reqId, entryEndpoint: request?.endpoint };
  const enrichedResponse = { ...response, reqId, entryEndpoint: response?.endpoint };
  await fs.writeFile(path.join(targetDir, 'request.json'), JSON.stringify(enrichedRequest, null, 2));
  await fs.writeFile(path.join(targetDir, 'response.json'), JSON.stringify(enrichedResponse, null, 2));

  const clientRequestFile = pickLatestStageFile(files, 'client-request');
  if (clientRequestFile) {
    try {
      const client = JSON.parse(await fs.readFile(path.join(requestDir, clientRequestFile), 'utf-8'));
      const enrichedClient = { ...client, reqId, entryEndpoint: client?.endpoint };
      await fs.writeFile(path.join(targetDir, 'client-request.json'), JSON.stringify(enrichedClient, null, 2));
    } catch {
      // ignore client-request parse errors
    }
  }

  registry.samples = registry.samples.filter((sample) => sample.reqId !== reqId);
  registry.samples.push({
    reqId,
    entry: entryName,
    providerId,
    model,
    timestamp: new Date(parseRequestTimestamp(requestId, request)).toISOString(),
    path: path.relative(MOCK_SAMPLES_DIR, targetDir),
    tags: buildTags(response)
  });
  console.log(`✅ ${reqId}`);
}

async function extractAll(options = {}) {
  console.log('[mock:extract] Preparing directories...');
  await ensureDir(MOCK_SAMPLES_DIR);
  await ensureDir(path.join(MOCK_SAMPLES_DIR, '_registry'));

  const registry = await loadRegistry();
  const seqMap = buildSeqMapFromRegistry(registry);
  const providerFilter = options.provider ? sanitizeComponent(options.provider, options.provider) : undefined;

  const dirEntries = await fs.readdir(CODEX_SAMPLES_DIR, { withFileTypes: true });
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    if (options.entry && dirEntry.name !== options.entry) {
      continue;
    }
    const entryDir = path.join(CODEX_SAMPLES_DIR, dirEntry.name);
    const entries = await fs.readdir(entryDir, { withFileTypes: true });

    // Newer layout: entry/<provider>/<requestId>/... (all stages in one directory)
    // Previous layout: entry/<requestId>/... (single-level request directory)
    for (const sub of entries) {
      if (!sub.isDirectory()) continue;
      const maybeProviderOrRequestDir = path.join(entryDir, sub.name);
      let nested = [];
      try {
        nested = await fs.readdir(maybeProviderOrRequestDir, { withFileTypes: true });
      } catch {
        nested = [];
      }
      const hasJsonFiles = nested.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'));
      if (hasJsonFiles) {
        try {
          await extractPairFromRequestDir(dirEntry.name, maybeProviderOrRequestDir, registry, seqMap, { provider: providerFilter });
        } catch (error) {
          console.warn(`⚠️  Skipped ${sub.name}: ${error.message}`);
        }
        continue;
      }
      const requestDirs = nested.filter((e) => e.isDirectory());
      for (const reqSub of requestDirs) {
        const requestDir = path.join(maybeProviderOrRequestDir, reqSub.name);
        try {
          await extractPairFromRequestDir(dirEntry.name, requestDir, registry, seqMap, { provider: providerFilter });
        } catch (error) {
          console.warn(`⚠️  Skipped ${sub.name}/${reqSub.name}: ${error.message}`);
        }
      }
    }

    // Legacy layout: entry/*_provider-request.json
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const requests = files.filter((name) => name.endsWith('_provider-request.json'));
    for (const file of requests) {
      try {
        await extractPair(dirEntry.name, entryDir, file, registry, seqMap, { provider: providerFilter });
      } catch (error) {
        console.warn(`⚠️  Skipped ${file}: ${error.message}`);
      }
    }
  }

  await saveRegistry(registry);
  console.log('[mock:extract] Done.');
}

async function extractSingle(reqId) {
  await ensureDir(MOCK_SAMPLES_DIR);
  await ensureDir(path.join(MOCK_SAMPLES_DIR, '_registry'));
  const registry = await loadRegistry();
  const seqMap = buildSeqMapFromRegistry(registry);

  const inferredEntry = inferEntryFolder(reqId);
  const entryDir = path.join(CODEX_SAMPLES_DIR, inferredEntry);
  const requestDir = path.join(entryDir, sanitizeRequestDirName(reqId));
  try {
    const stat = await fs.stat(requestDir);
    if (stat.isDirectory()) {
      await extractPairFromRequestDir(inferredEntry, requestDir, registry, seqMap);
      await saveRegistry(registry);
      return;
    }
  } catch {
    // fall through
  }

  // Newer layout: entry/<provider>/<requestId>/...
  try {
    const providerDirs = await fs.readdir(entryDir, { withFileTypes: true });
    for (const providerDir of providerDirs) {
      if (!providerDir.isDirectory()) continue;
      const candidate = path.join(entryDir, providerDir.name, sanitizeRequestDirName(reqId));
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          await extractPairFromRequestDir(inferredEntry, candidate, registry, seqMap);
          await saveRegistry(registry);
          return;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore entryDir scan errors
  }

  const files = await fs.readdir(entryDir);
  const target = files.find((file) => file.includes(reqId) && file.endsWith('_provider-request.json'));
  if (!target) {
    throw new Error(`Request ${reqId} not found under ${inferredEntry}`);
  }
  await extractPair(inferredEntry, entryDir, target, registry, seqMap);
  await saveRegistry(registry);
}

function sanitizeRequestDirName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return `req_${Date.now()}`;
  }
  return value.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
}

function inferEntryFolder(reqId) {
  const lower = String(reqId || '').toLowerCase();
  if (lower.includes('openai-responses') || lower.includes('responses')) {
    return 'openai-responses';
  }
  if (lower.includes('anthropic')) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function parseArguments(argv) {
  const opts = { mode: 'all', reqId: undefined, provider: undefined, entry: undefined };
  for (const arg of argv) {
    if (arg === '--all') {
      opts.mode = 'all';
      continue;
    }
    if (arg.startsWith('--req=')) {
      opts.mode = 'req';
      opts.reqId = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--provider=')) {
      opts.provider = arg.split('=')[1];
      continue;
    }
    if (arg.startsWith('--entry=')) {
      opts.entry = arg.split('=')[1];
      continue;
    }
    if (arg === '--help') {
      console.log('Usage: npm run mock:extract -- [--all] [--req=<requestId>] [--provider=<providerId>] [--entry=<entryName>]');
      process.exit(0);
    }
  }
  return opts;
}

async function main(argv) {
  const opts = parseArguments(argv);
  if (opts.mode === 'req' && opts.reqId) {
    await extractSingle(opts.reqId);
  } else {
    await extractAll({ entry: opts.entry, provider: opts.provider });
  }
}

function buildSeqMapFromRegistry(registry) {
  const seqMap = new Map();
  for (const sample of registry.samples) {
    if (!sample?.reqId || typeof sample.reqId !== 'string') continue;
    if (!sample.entry || !sample.providerId || !sample.model) continue;
    const match = sample.reqId.match(/-([0-9]{8}T[0-9]{6})-([0-9]{3})$/);
    if (!match) continue;
    const tsToken = match[1];
    const seq = Number(match[2]);
    if (Number.isNaN(seq)) continue;
    const key = `${sample.entry}|${sample.providerId}|${sample.model}|${tsToken}`;
    seqMap.set(key, Math.max(seqMap.get(key) || 0, seq));
  }
  return seqMap;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[mock:extract] Failed: ${error.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const suffix = '_req_process_tool_filters_request_pre.json';
const DEFAULT_SAMPLE_ROOT = path.join(os.homedir(), '.routecodex', 'codex-samples');
const DEFAULT_LIMIT = 400;
const args = process.argv.slice(2);
let sampleRoot = DEFAULT_SAMPLE_ROOT;
let limit = DEFAULT_LIMIT;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg) continue;
  if (arg === '--limit' && i + 1 < args.length) {
    limit = Number(args[i + 1]) || DEFAULT_LIMIT;
    i += 1;
  } else if (arg.startsWith('--')) {
    continue;
  } else if (sampleRoot === DEFAULT_SAMPLE_ROOT) {
    sampleRoot = path.resolve(arg);
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const ENDPOINT_MAP = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages'
};

async function loadClassifierModules() {
  const featuresPath = path.join(ROOT, 'sharedmodule', 'llmswitch-core', 'dist', 'router', 'virtual-router', 'features.js');
  const classifierPath = path.join(ROOT, 'sharedmodule', 'llmswitch-core', 'dist', 'router', 'virtual-router', 'classifier.js');
  const { buildRoutingFeatures } = await import('file://' + featuresPath);
  const { RoutingClassifier } = await import('file://' + classifierPath);
  return { buildRoutingFeatures, RoutingClassifier };
}

async function loadClassifierConfig() {
  const modulesPath = path.join(ROOT, 'config', 'modules.json');
  const raw = await fs.readFile(modulesPath, 'utf8');
  const json = JSON.parse(raw);
  const cfg =
    json?.virtualrouter?.config?.classificationConfig ||
    json?.modules?.virtualrouter?.config?.classificationConfig ||
    {};
  return cfg || {};
}

async function listCandidateFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listCandidateFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(full);
    }
  }
  return files;
}

function requestKey(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^(req_\d+_[^_]+)/);
  return match ? match[1] : base;
}

function inferEndpoint(filePath) {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (ENDPOINT_MAP[part]) return ENDPOINT_MAP[part];
  }
  return '/v1/responses';
}

function buildMetadata(reqId, endpoint) {
  return {
    requestId: reqId,
    entryEndpoint: endpoint,
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

async function main() {
  const { buildRoutingFeatures, RoutingClassifier } = await loadClassifierModules();
  const classifierConfig = await loadClassifierConfig();
  const classifier = new RoutingClassifier(classifierConfig);

  const protocols = await fs.readdir(sampleRoot, { withFileTypes: true });
  const files = [];
  for (const proto of protocols) {
    if (!proto.isDirectory()) continue;
    const dir = path.join(sampleRoot, proto.name);
    files.push(...(await listCandidateFiles(dir)));
  }
  files.sort((a, b) => a.localeCompare(b));

  let processedFiles = files;
  if (limit && files.length > limit) {
    processedFiles = files.slice(-limit);
  }

  const seen = new Set();
  const stats = new Map();
  const diagnostics = [];

  for (const filePath of processedFiles) {
    const key = requestKey(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    let payload;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch (err) {
      diagnostics.push({ file: filePath, error: err.message || String(err) });
      continue;
    }
    if (!payload || typeof payload !== 'object') continue;
    const endpoint = inferEndpoint(filePath);
    const metadata = buildMetadata(key, endpoint);
    let features;
    try {
      features = buildRoutingFeatures(payload, metadata);
    } catch (err) {
      diagnostics.push({ file: filePath, error: err.message || String(err), stage: 'features' });
      continue;
    }
    let classification;
    try {
      classification = classifier.classify(features);
    } catch (err) {
      diagnostics.push({ file: filePath, error: err.message || String(err), stage: 'classify' });
      continue;
    }
    const route = classification?.routeName || 'unknown';
    stats.set(route, (stats.get(route) || 0) + 1);
  }

  const total = Array.from(stats.values()).reduce((sum, count) => sum + count, 0);
  const summary = Array.from(stats.entries())
    .map(([route, count]) => ({ route, count, ratio: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);

  console.log(
    JSON.stringify(
      { sampleRoot, configuredLimit: limit, evaluatedSamples: processedFiles.length, totalSamples: total, summary, diagnostics },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('Failed to analyze routing classifier:', err);
  process.exit(1);
});

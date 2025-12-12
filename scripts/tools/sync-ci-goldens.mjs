#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TARGET_ROOT = path.join(PROJECT_ROOT, 'samples', 'ci-goldens');
const SOURCE_ROOT = path.join(os.homedir(), '.routecodex', 'golden_samples', 'new');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeIfChanged(target, content) {
  const next = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf-8');
    if (prev === next) {
      return false;
    }
  }
  fs.writeFileSync(target, next);
  return true;
}

function syncProvider(entryType, providerId) {
  const sourceDir = path.join(SOURCE_ROOT, entryType, providerId);
  const requestPath = path.join(sourceDir, 'request.sample.json');
  if (!fs.existsSync(requestPath)) {
    console.warn(`[sync-ci-goldens] skip ${entryType}/${providerId}: request.sample.json missing`);
    return { status: 'skipped' };
  }
  const targetDir = path.join(TARGET_ROOT, entryType, providerId);
  ensureDir(targetDir);
  const targetRequest = path.join(targetDir, 'request.sample.json');
  const changedRequest = writeIfChanged(targetRequest, fs.readFileSync(requestPath, 'utf-8'));
  const sourceMetaPath = path.join(sourceDir, 'meta.json');
  const targetMeta = path.join(targetDir, 'meta.json');
  if (fs.existsSync(sourceMetaPath)) {
    const meta = readJson(sourceMetaPath);
    meta.source = 'ci-goldens';
    writeIfChanged(targetMeta, meta);
  } else if (!fs.existsSync(targetMeta)) {
    const meta = {
      providerId,
      entryType,
      capturedAt: new Date().toISOString(),
      source: 'ci-goldens',
      stageFile: null
    };
    writeIfChanged(targetMeta, meta);
  }
  return { status: changedRequest ? 'updated' : 'unchanged', targetDir };
}

function listEntries() {
  if (!fs.existsSync(SOURCE_ROOT)) {
    throw new Error(`Source golden samples missing: ${SOURCE_ROOT}`);
  }
  const entries = [];
  for (const entryType of fs.readdirSync(SOURCE_ROOT)) {
    const entryDir = path.join(SOURCE_ROOT, entryType);
    if (!fs.statSync(entryDir).isDirectory()) continue;
    for (const providerId of fs.readdirSync(entryDir)) {
      const providerDir = path.join(entryDir, providerId);
      if (!fs.statSync(providerDir).isDirectory()) continue;
      entries.push({ entryType, providerId });
    }
  }
  return entries;
}

function usage() {
  console.log('Usage: node scripts/tools/sync-ci-goldens.mjs [--entry <type>] [--provider <id>]');
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const filters = { entry: null, provider: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--entry') {
      filters.entry = args[++i] || null;
    } else if (arg === '--provider') {
      filters.provider = args[++i] || null;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  return filters;
}

function main() {
  const filters = parseArgs();
  const entries = listEntries().filter((item) => {
    if (filters.entry && filters.entry !== item.entryType) return false;
    if (filters.provider && filters.provider !== item.providerId) return false;
    return true;
  });
  if (!entries.length) {
    console.warn('[sync-ci-goldens] no matching samples found');
    return;
  }
  let updated = 0;
  let unchanged = 0;
  for (const item of entries) {
    const result = syncProvider(item.entryType, item.providerId);
    if (result.status === 'updated') updated += 1;
    else if (result.status === 'unchanged') unchanged += 1;
  }
  console.log(`[sync-ci-goldens] synced ${entries.length} provider samples (${updated} updated, ${unchanged} unchanged).`);
}

try {
  main();
} catch (error) {
  console.error('[sync-ci-goldens] failed:', error.message || error);
  process.exit(1);
}

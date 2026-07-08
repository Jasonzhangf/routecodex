#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SRC_PREFIX = 'sharedmodule/llmswitch-core/src/';
const MANIFEST_PATH = path.join(ROOT, 'docs/loops/rustification/minimal-ts-surface.json');
const ZERO_TARGETS = [
  'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
  'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts',
  'sharedmodule/llmswitch-core/src/runtime/user-data-paths.ts',
  'sharedmodule/llmswitch-core/src/telemetry/stats-center.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/types/json.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.ts',
  'sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts',
  'sharedmodule/llmswitch-core/src/servertool/types.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts',
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-policy.ts',
];

function readGitTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'));
}

function isHandAuthoredProdTs(rel) {
  if (!rel.startsWith(SRC_PREFIX)) return false;
  if (!rel.endsWith('.ts')) return false;
  if (rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return false;
  if (rel.includes('/tests/') || rel.includes('/test/') || rel.includes('/archive/')) return false;
  return fs.existsSync(path.join(ROOT, rel));
}

function isNativeLinked(content) {
  return [
    /native-router-hotpath/,
    /WithNative/,
    /loadNativeRouterHotpathBinding/,
    /router_hotpath_napi/,
  ].some((pattern) => pattern.test(content));
}

function readManifestEntries() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`missing manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

function readRustificationAudit() {
  const raw = execFileSync(process.execPath, ['scripts/ci/llmswitch-rustification-audit.mjs', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function main() {
  const errors = [];
  const tracked = new Set(readGitTrackedFiles());
  const manifestEntries = readManifestEntries();
  const manifestPaths = new Set(manifestEntries.map((entry) => entry?.path).filter((p) => typeof p === 'string'));

  for (const target of ZERO_TARGETS) {
    if (tracked.has(target) && isHandAuthoredProdTs(target)) {
      errors.push(`zero-TS target still exists as hand-authored production TS: ${target}`);
    }
    if (manifestPaths.has(target)) {
      errors.push(`zero-TS target still listed in minimal surface manifest: ${target}`);
    }
  }

  if (manifestEntries.length !== 0) {
    errors.push(`minimal TS surface manifest entries must be zero; current=${manifestEntries.length}`);
  }

  const currentNonNativeProdTs = readGitTrackedFiles()
    .filter(isHandAuthoredProdTs)
    .filter((rel) => !isNativeLinked(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  if (currentNonNativeProdTs.length !== 0) {
    errors.push(`sharedmodule llmswitch-core non-native production TS files must be zero; current=${currentNonNativeProdTs.length}`);
    for (const rel of currentNonNativeProdTs) errors.push(`remaining non-native production TS: ${rel}`);
  }

  const audit = readRustificationAudit();
  const metrics = audit.metrics ?? {};
  if (metrics.nonNativeFileCount !== 0) {
    errors.push(`rustification audit nonNativeFileCount must be zero; current=${metrics.nonNativeFileCount}`);
  }
  if (metrics.nonNativeLocTotal !== 0) {
    errors.push(`rustification audit nonNativeLocTotal must be zero; current=${metrics.nonNativeLocTotal}`);
  }

  if (errors.length > 0) {
    console.error('[verify-llmswitch-zero-ts-closeout] FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(2);
  }

  console.log('[verify-llmswitch-zero-ts-closeout] ok');
  console.log('- entries: 0');
  console.log('- non-native production TS files: 0');
  console.log('- nonNativeFileCount: 0');
  console.log('- nonNativeLocTotal: 0');
}

main();

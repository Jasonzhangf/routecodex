#!/usr/bin/env node

/**
 * Scan apply_patch tool call shapes in:
 * 1) repo samples: samples/ci-goldens/** (including _regressions/apply_patch)
 * 2) user samples: ~/.routecodex/codex-samples/**
 *
 * Goal: identify remaining non-context shape failures (invalid_json/missing_changes/etc.)
 * and optionally capture failures into repo ci-goldens regressions.
 *
 * Usage:
 *   node scripts/scan-apply-patch-samples.mjs
 *   node scripts/scan-apply-patch-samples.mjs --user-all
 *   ROUTECODEX_APPLY_PATCH_REGRESSION_TO_REPO=1 node scripts/scan-apply-patch-samples.mjs --user-all
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const coreLoaderPath = path.join(repoRoot, 'dist', 'modules', 'llmswitch', 'core-loader.js');
const coreLoaderUrl = pathToFileURL(coreLoaderPath).href;

const HOME = os.homedir();
const USER_CODEX_ROOT = path.join(HOME, '.routecodex', 'codex-samples');
const USER_CODEX_ROOT_ALT = path.join(HOME, '.routecodex', 'codex samples');
const USER_CODEX_PENDING = path.join(USER_CODEX_ROOT, 'openai-chat', '__pending__');
const REPO_GOLDENS_ROOT = path.join(repoRoot, 'samples', 'ci-goldens');
const ERROR_SAMPLES_ROOT = path.join(HOME, '.routecodex', 'errorsamples', 'apply_patch');

const DEFAULT_CAPTURE_TOTAL_LIMIT = 5000;
const DEFAULT_CAPTURE_PER_REASON_LIMIT = 250;

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function* walkJsonFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        yield full;
      }
    }
  }
}

function extractApplyPatchArgs(doc, { allowRegressionOriginalArgs } = { allowRegressionOriginalArgs: false }) {
  const out = [];

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;

    const any = node;

    // OpenAI chat tool_calls: { function: { name, arguments } }
    if (any.function && typeof any.function === 'object') {
      const fn = any.function;
      if (fn && fn.name === 'apply_patch') {
        const args = fn.arguments;
        if (typeof args === 'string' && args.trim()) {
          out.push(args);
        }
      }
    }

    // Responses output: { type:"function_call", name:"apply_patch", arguments:"..." }
    if (any.type === 'function_call' && any.name === 'apply_patch') {
      const args = any.arguments;
      if (typeof args === 'string' && args.trim()) {
        out.push(args);
      }
    }

    // Regression sample shape: { originalArgs: "...", errorType: "..." }
    if (allowRegressionOriginalArgs) {
      if (
        typeof any.originalArgs === 'string' &&
        any.originalArgs.trim() &&
        typeof any.errorType === 'string' &&
        any.errorType.trim()
      ) {
        out.push(any.originalArgs);
      }
    }

    for (const value of Object.values(any)) visit(value);
  }

  visit(doc);
  return out;
}

function isContextMismatchReason(reason) {
  // We only capture/repair shape issues; context mismatches are not actionable here.
  // Keep this conservative: if a new reason is introduced, we still capture it unless
  // it clearly indicates a context mismatch.
  if (!reason) return false;
  const r = String(reason);
  return (
    r.includes('context') ||
    r.includes('expected') ||
    r.includes('hunk') ||
    r.includes('no_match') ||
    r.includes('not_found')
  );
}

function stableHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

async function captureFailure({
  destRoot,
  label,
  sourceFile,
  reason,
  originalArgs,
  validationResult,
  captureState,
}) {
  if (isContextMismatchReason(reason)) return;
  if (captureState?.reasonAllowList && !captureState.reasonAllowList.has(reason)) return;
  if (!destRoot) return;

  const totalLimit = captureState.totalLimit ?? DEFAULT_CAPTURE_TOTAL_LIMIT;
  const perReasonLimit = captureState.perReasonLimit ?? DEFAULT_CAPTURE_PER_REASON_LIMIT;
  if (captureState.totalCaptured >= totalLimit) return;

  const currentReasonCount = captureState.byReason.get(reason) ?? 0;
  if (currentReasonCount >= perReasonLimit) return;

  const key = `${label}\n${reason}\n${sourceFile}\n${originalArgs}`;
  const filename = `sample_${stableHash(key)}.json`;
  const folder = path.join(destRoot, reason);
  const outPath = path.join(folder, filename);

  try {
    await fs.access(outPath);
    return;
  } catch {
    // continue
  }

  await fs.mkdir(folder, { recursive: true });
  const payload = {
    tool: 'apply_patch',
    label,
    reason,
    capturedAt: new Date().toISOString(),
    sourceFile,
    argsSha256: crypto.createHash('sha256').update(originalArgs).digest('hex'),
    originalArgs,
    validationResult,
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');

  captureState.totalCaptured += 1;
  captureState.byReason.set(reason, currentReasonCount + 1);
}

async function loadValidator() {
  if (!(await fileExists(coreLoaderPath))) {
    throw new Error(`core-loader missing at ${coreLoaderPath} (run npm run build:dev first)`);
  }
  const { importCoreModule } = await import(coreLoaderUrl);
  const { validateToolCall } = await importCoreModule('tools/tool-registry');
  if (typeof validateToolCall !== 'function') {
    throw new Error('validateToolCall not found in llmswitch-core tools/tool-registry');
  }
  return { validateToolCall };
}

async function scanRoot(label, rootDir, validateToolCall, capture) {
  if (!(await fileExists(rootDir))) {
    return { label, rootDir, files: 0, calls: 0, ok: 0, byReason: new Map(), examples: [] };
  }

  const byReason = new Map();
  const examples = [];
  let files = 0;
  let calls = 0;
  let ok = 0;

  for await (const filePath of walkJsonFiles(rootDir)) {
    files += 1;
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    // Fast prefilter: skip JSON that doesn't even mention apply_patch.
    if (!raw.includes('apply_patch')) continue;

    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }

    const isRegressionFile = filePath.includes(`${path.sep}_regressions${path.sep}`);
    const argsList = extractApplyPatchArgs(doc, { allowRegressionOriginalArgs: isRegressionFile });
    if (!argsList.length) continue;

    const dedup = Array.from(new Set(argsList));
    for (const args of dedup) {
      calls += 1;
      const res = validateToolCall('apply_patch', args);
      if (res && res.ok) {
        ok += 1;
        continue;
      }
      const reason = (res && res.reason) || 'unknown';
      const cur = byReason.get(reason) || { count: 0 };
      cur.count += 1;
      byReason.set(reason, cur);
      if (capture?.enabled) {
        await captureFailure({
          destRoot: capture.destRoot,
          label,
          sourceFile: filePath,
          reason,
          originalArgs: args,
          validationResult: res,
          captureState: capture.state,
        });
      }
      if (examples.length < 12) {
        examples.push({ file: filePath, reason });
      }
    }
  }

  return { label, rootDir, files, calls, ok, byReason, examples };
}

function printReport(report) {
  const failures = report.calls - report.ok;
  console.log(`\n[scan] ${report.label}`);
  console.log(`root: ${report.rootDir}`);
  console.log(`files: ${report.files}  apply_patch_calls: ${report.calls}  ok: ${report.ok}  fail: ${failures}`);
  const entries = Array.from(report.byReason.entries()).sort((a, b) => b[1].count - a[1].count);
  if (entries.length) {
    console.log('failures_by_reason:');
    for (const [reason, v] of entries.slice(0, 20)) {
      console.log(`  - ${reason}: ${v.count}`);
    }
  }
  if (report.examples.length) {
    console.log('examples:');
    for (const ex of report.examples) {
      console.log(`  - ${path.relative(repoRoot, ex.file)}  reason=${ex.reason}`);
    }
  }
}

async function main() {
  const { validateToolCall } = await loadValidator();

  const captureEnabled = process.argv.slice(2).includes('--capture') || process.env.ROUTECODEX_SCAN_CAPTURE === '1';
  const captureRepo = process.argv.slice(2).includes('--capture-repo') || process.env.ROUTECODEX_SCAN_CAPTURE_REPO === '1';
  const captureRoot = process.env.ROUTECODEX_ERRORSAMPLES_DIR || ERROR_SAMPLES_ROOT;
  const totalLimit = Number.parseInt(process.env.ROUTECODEX_CAPTURE_TOTAL_LIMIT || '', 10);
  const perReasonLimit = Number.parseInt(process.env.ROUTECODEX_CAPTURE_PER_REASON_LIMIT || '', 10);
  const reasonsArg = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--capture-reasons='))
    ?.split('=')[1];
  const reasonsEnv = process.env.ROUTECODEX_CAPTURE_REASONS;
  const reasonAllowListRaw = (reasonsArg || reasonsEnv || '').trim();
  const reasonAllowList = reasonAllowListRaw
    ? new Set(
        reasonAllowListRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;
  const captureState = {
    totalCaptured: 0,
    totalLimit: Number.isFinite(totalLimit) ? totalLimit : DEFAULT_CAPTURE_TOTAL_LIMIT,
    perReasonLimit: Number.isFinite(perReasonLimit) ? perReasonLimit : DEFAULT_CAPTURE_PER_REASON_LIMIT,
    byReason: new Map(),
    reasonAllowList,
  };

  const repo = await scanRoot('repo samples/ci-goldens', REPO_GOLDENS_ROOT, validateToolCall, {
    enabled: captureEnabled && captureRepo,
    destRoot: captureRoot,
    state: captureState,
  });
  printReport(repo);

  const userAll = process.argv.slice(2).includes('--user-all');
  const userRoots = [];
  if (userAll) {
    if (await fileExists(USER_CODEX_ROOT)) userRoots.push({ label: 'user ~/.routecodex/codex-samples (all)', root: USER_CODEX_ROOT });
    if (await fileExists(USER_CODEX_ROOT_ALT))
      userRoots.push({ label: 'user ~/.routecodex/codex samples (all)', root: USER_CODEX_ROOT_ALT });
  } else {
    const pending = (await fileExists(USER_CODEX_PENDING)) ? USER_CODEX_PENDING : null;
    if (pending) userRoots.push({ label: 'user ~/.routecodex/codex-samples/openai-chat/__pending__', root: pending });
    else if (await fileExists(USER_CODEX_ROOT)) userRoots.push({ label: 'user ~/.routecodex/codex-samples', root: USER_CODEX_ROOT });
    else if (await fileExists(USER_CODEX_ROOT_ALT)) userRoots.push({ label: 'user ~/.routecodex/codex samples', root: USER_CODEX_ROOT_ALT });
    else userRoots.push({ label: 'user ~/.routecodex/codex-samples', root: USER_CODEX_ROOT });
  }

  const userReports = [];
  for (const entry of userRoots) {
    const report = await scanRoot(entry.label, entry.root, validateToolCall, {
      enabled: captureEnabled,
      destRoot: captureRoot,
      state: captureState,
    });
    userReports.push(report);
    printReport(report);
  }

  const totalCalls = repo.calls + userReports.reduce((sum, r) => sum + r.calls, 0);
  const totalOk = repo.ok + userReports.reduce((sum, r) => sum + r.ok, 0);
  console.log(`\n[scan] TOTAL apply_patch_calls=${totalCalls} ok=${totalOk} fail=${totalCalls - totalOk}`);
  if (captureEnabled) {
    console.log(
      `[scan] captured_failures=${captureState.totalCaptured} dest=${captureRoot} (per_reason<=${captureState.perReasonLimit}, total<=${captureState.totalLimit})`
    );
  }

  process.exitCode = totalCalls - totalOk > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[scan-apply-patch-samples] failed:', error?.stack || error?.message || String(error ?? 'unknown'));
  process.exit(2);
});

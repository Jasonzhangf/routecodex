#!/usr/bin/env node

/**
 * Scan exec_command tool call shapes in:
 * 1) repo samples: samples/ci-goldens/**
 * 2) user samples: ~/.routecodex/codex-samples/** and ~/.routecodex/codex samples/**
 *
 * Goal: identify remaining shape failures and (via llmswitch-core) capture failures into:
 *   ~/.routecodex/errorsamples/exec_command/<error-type>/
 *
 * Usage:
 *   node scripts/scan-exec-command-samples.mjs
 *   node scripts/scan-exec-command-samples.mjs --user-all
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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

function extractExecCommandArgs(doc, { allowRegressionOriginalArgs } = { allowRegressionOriginalArgs: false }) {
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
      if (fn && fn.name === 'exec_command') {
        const args = fn.arguments;
        if (typeof args === 'string' && args.trim()) {
          out.push(args);
        }
      }
    }

    // Responses output: { type:"function_call", name:"exec_command", arguments:"..." }
    if (any.type === 'function_call' && any.name === 'exec_command') {
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

async function scanRoot(label, rootDir, validateToolCall) {
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
    // Fast prefilter: skip JSON that doesn't even mention exec_command.
    if (!raw.includes('exec_command')) continue;

    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }

    const isRegressionFile = filePath.includes(`${path.sep}_regressions${path.sep}`);
    const argsList = extractExecCommandArgs(doc, { allowRegressionOriginalArgs: isRegressionFile });
    if (!argsList.length) continue;

    const dedup = Array.from(new Set(argsList));
    for (const args of dedup) {
      calls += 1;
      const res = validateToolCall('exec_command', args);
      if (res && res.ok) {
        ok += 1;
        continue;
      }
      const reason = (res && res.reason) || 'unknown';
      const cur = byReason.get(reason) || { count: 0 };
      cur.count += 1;
      byReason.set(reason, cur);
      if (examples.length < 12) {
        examples.push({ file: filePath, reason });
      }
    }
  }

  return { label, rootDir, files, calls, ok, byReason, examples };
}

function mergeReports(a, b) {
  const byReason = new Map(a.byReason);
  for (const [reason, v] of b.byReason.entries()) {
    const cur = byReason.get(reason) || { count: 0 };
    cur.count += v.count;
    byReason.set(reason, cur);
  }
  const examples = [...a.examples, ...b.examples].slice(0, 12);
  return {
    label: `${a.label} + ${b.label}`,
    rootDir: `${a.rootDir} | ${b.rootDir}`,
    files: a.files + b.files,
    calls: a.calls + b.calls,
    ok: a.ok + b.ok,
    byReason,
    examples
  };
}

function printReport(report) {
  const failures = report.calls - report.ok;
  console.log(`\n[scan] ${report.label}`);
  console.log(`root: ${report.rootDir}`);
  console.log(`files: ${report.files}  exec_command_calls: ${report.calls}  ok: ${report.ok}  fail: ${failures}`);
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

  const repo = await scanRoot('repo samples/ci-goldens', REPO_GOLDENS_ROOT, validateToolCall);
  printReport(repo);

  const userAll = process.argv.slice(2).includes('--user-all');
  if (!userAll) {
    const userRoot = (await fileExists(USER_CODEX_PENDING)) ? USER_CODEX_PENDING : USER_CODEX_ROOT;
    const user = await scanRoot('user ~/.routecodex/codex-samples/openai-chat/__pending__', userRoot, validateToolCall);
    printReport(user);
    const totalCalls = repo.calls + user.calls;
    const totalOk = repo.ok + user.ok;
    console.log(`\n[scan] TOTAL exec_command_calls=${totalCalls} ok=${totalOk} fail=${totalCalls - totalOk}`);
    process.exitCode = totalCalls - totalOk > 0 ? 1 : 0;
    return;
  }

  const roots = [];
  if (await fileExists(USER_CODEX_ROOT)) roots.push({ label: 'user ~/.routecodex/codex-samples (all)', dir: USER_CODEX_ROOT });
  if (await fileExists(USER_CODEX_ROOT_ALT)) roots.push({ label: 'user ~/.routecodex/codex samples (all)', dir: USER_CODEX_ROOT_ALT });
  if (!roots.length) {
    const user = await scanRoot('user ~/.routecodex/codex-samples (all)', USER_CODEX_ROOT, validateToolCall);
    printReport(user);
    const totalCalls = repo.calls + user.calls;
    const totalOk = repo.ok + user.ok;
    console.log(`\n[scan] TOTAL exec_command_calls=${totalCalls} ok=${totalOk} fail=${totalCalls - totalOk}`);
    process.exitCode = totalCalls - totalOk > 0 ? 1 : 0;
    return;
  }

  let merged = null;
  for (const root of roots) {
    const report = await scanRoot(root.label, root.dir, validateToolCall);
    printReport(report);
    merged = merged ? mergeReports(merged, report) : report;
  }

  const user = merged;
  const totalCalls = repo.calls + user.calls;
  const totalOk = repo.ok + user.ok;
  console.log(`\n[scan] TOTAL exec_command_calls=${totalCalls} ok=${totalOk} fail=${totalCalls - totalOk}`);

  process.exitCode = totalCalls - totalOk > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[scan-exec-command-samples] failed:', error?.stack || error?.message || String(error ?? 'unknown'));
  process.exit(2);
});


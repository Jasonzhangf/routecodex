#!/usr/bin/env node

/**
 * Scan tool-call argument shapes in:
 * 1) repo samples: samples/ci-goldens/**
 * 2) user samples: ~/.routecodex/codex-samples/** (or ~/.routecodex/codex samples/**)
 *
 * Tools covered:
 * - apply_patch
 * - exec_command
 *
 * Notes:
 * - This script validates "shape/type/format" only. Context mismatch is not handled here.
 * - For apply_patch, validateToolCall() may capture regressions automatically into:
 *     ~/.routecodex/golden_samples/ci-regression/apply_patch
 *   Use --to-repo to write into repo CI goldens (_regressions/apply_patch).
 *
 * Usage:
 *   node scripts/scan-tool-shape-samples.mjs
 *   node scripts/scan-tool-shape-samples.mjs --user-all
 *   node scripts/scan-tool-shape-samples.mjs --to-repo --user-all
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
const USER_CODEX_ROOT_SPACE = path.join(HOME, '.routecodex', 'codex samples');
const USER_CODEX_PENDING = path.join(USER_CODEX_ROOT, 'openai-chat', '__pending__');
const USER_CODEX_PENDING_SPACE = path.join(USER_CODEX_ROOT_SPACE, 'openai-chat', '__pending__');
const REPO_GOLDENS_ROOT = path.join(repoRoot, 'samples', 'ci-goldens');

const TOOL_NAMES = ['apply_patch', 'exec_command'];

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

function extractToolArgs(doc, toolNames, { allowRegressionOriginalArgs } = { allowRegressionOriginalArgs: false }) {
  const out = [];
  const wanted = new Set(toolNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean));

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
      const name = typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
      if (wanted.has(name)) {
        const args = fn.arguments;
        if (typeof args === 'string' && args.trim()) {
          out.push({ name, args });
        }
      }
    }

    // Responses output: { type:"function_call", name:"...", arguments:"..." }
    if (any.type === 'function_call') {
      const name = typeof any.name === 'string' ? any.name.trim().toLowerCase() : '';
      if (wanted.has(name)) {
        const args = any.arguments;
        if (typeof args === 'string' && args.trim()) {
          out.push({ name, args });
        }
      }
    }

    // Regression sample shape: { originalArgs: "...", errorType: "..." }
    if (allowRegressionOriginalArgs) {
      const name = typeof any.tool === 'string' ? any.tool.trim().toLowerCase() : '';
      if (wanted.has(name) && typeof any.originalArgs === 'string' && any.originalArgs.trim()) {
        out.push({ name, args: any.originalArgs });
      }
      // Historical apply_patch regression capture doesn't include tool name; default to apply_patch.
      if (
        typeof any.originalArgs === 'string' &&
        any.originalArgs.trim() &&
        typeof any.errorType === 'string' &&
        any.errorType.trim() &&
        !name
      ) {
        out.push({ name: 'apply_patch', args: any.originalArgs });
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
    return { label, rootDir, files: 0, calls: 0, ok: 0, byReason: new Map(), byTool: new Map(), examples: [] };
  }

  const byReason = new Map();
  const byTool = new Map();
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
    // Fast prefilter: skip JSON that doesn't even mention our tool names.
    if (!TOOL_NAMES.some((n) => raw.includes(n))) continue;

    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }

    const isRegressionFile = filePath.includes(`${path.sep}_regressions${path.sep}`);
    const argsList = extractToolArgs(doc, TOOL_NAMES, { allowRegressionOriginalArgs: isRegressionFile });
    if (!argsList.length) continue;

    const dedupKey = (x) => `${x.name}:${x.args}`;
    const dedup = Array.from(new Map(argsList.map((x) => [dedupKey(x), x])).values());

    for (const entry of dedup) {
      calls += 1;
      const toolName = entry.name;
      const toolCount = byTool.get(toolName) || { calls: 0, ok: 0 };
      toolCount.calls += 1;
      byTool.set(toolName, toolCount);

      const res = validateToolCall(toolName, entry.args);
      if (res && res.ok) {
        ok += 1;
        toolCount.ok += 1;
        continue;
      }
      const reason = (res && res.reason) || 'unknown';
      const cur = byReason.get(reason) || { count: 0 };
      cur.count += 1;
      byReason.set(reason, cur);
      if (examples.length < 12) {
        examples.push({ file: filePath, reason, tool: toolName });
      }
    }
  }

  return { label, rootDir, files, calls, ok, byReason, byTool, examples };
}

function printReport(report) {
  const failures = report.calls - report.ok;
  console.log(`\n[scan] ${report.label}`);
  console.log(`root: ${report.rootDir}`);
  console.log(`files: ${report.files}  tool_calls: ${report.calls}  ok: ${report.ok}  fail: ${failures}`);

  const toolEntries = Array.from(report.byTool.entries()).sort((a, b) => b[1].calls - a[1].calls);
  if (toolEntries.length) {
    console.log('by_tool:');
    for (const [tool, v] of toolEntries) {
      console.log(`  - ${tool}: calls=${v.calls} ok=${v.ok} fail=${v.calls - v.ok}`);
    }
  }

  const entries = Array.from(report.byReason.entries()).sort((a, b) => b[1].count - a[1].count);
  if (entries.length) {
    console.log('failures_by_reason:');
    for (const [reason, v] of entries.slice(0, 30)) {
      console.log(`  - ${reason}: ${v.count}`);
    }
  }
  if (report.examples.length) {
    console.log('examples:');
    for (const ex of report.examples) {
      console.log(`  - ${path.relative(repoRoot, ex.file)}  tool=${ex.tool} reason=${ex.reason}`);
    }
  }
}

function resolveUserRoot({ userAll }) {
  const candidates = [];
  if (userAll) {
    candidates.push(USER_CODEX_ROOT);
    candidates.push(USER_CODEX_ROOT_SPACE);
  } else {
    candidates.push(USER_CODEX_PENDING);
    candidates.push(USER_CODEX_PENDING_SPACE);
    candidates.push(USER_CODEX_ROOT);
    candidates.push(USER_CODEX_ROOT_SPACE);
  }
  return candidates;
}

async function main() {
  const args = process.argv.slice(2);
  const userAll = args.includes('--user-all');
  const toRepo = args.includes('--to-repo');
  if (toRepo) {
    process.env.ROUTECODEX_APPLY_PATCH_REGRESSION_TO_REPO = '1';
  }

  const { validateToolCall } = await loadValidator();

  const repo = await scanRoot('repo samples/ci-goldens', REPO_GOLDENS_ROOT, validateToolCall);
  printReport(repo);

  let userRoot = null;
  for (const p of resolveUserRoot({ userAll })) {
    if (await fileExists(p)) {
      userRoot = p;
      break;
    }
  }
  const userLabel = userAll
    ? '~/.routecodex/(codex-samples|codex samples) (all)'
    : '~/.routecodex/(codex-samples|codex samples)/openai-chat/__pending__';
  const user = await scanRoot(`user ${userLabel}`, userRoot || USER_CODEX_ROOT, validateToolCall);
  printReport(user);

  const totalCalls = repo.calls + user.calls;
  const totalOk = repo.ok + user.ok;
  console.log(`\n[scan] TOTAL tool_calls=${totalCalls} ok=${totalOk} fail=${totalCalls - totalOk}`);

  process.exitCode = totalCalls - totalOk > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[scan-tool-shape-samples] failed:', error?.stack || error?.message || String(error ?? 'unknown'));
  process.exit(2);
});


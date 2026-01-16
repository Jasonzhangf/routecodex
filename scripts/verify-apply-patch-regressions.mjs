#!/usr/bin/env node

/**
 * Verify that captured apply_patch regressions in repo stay parseable and correctly classified.
 *
 * Policy:
 * - If a sample now validates OK, it's considered "fixed" (pass).
 * - If it still fails, the failure reason must match sample.errorType (pass).
 * - Any mismatch, missing fields, or crashes are failures.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const REG_ROOT = path.join(repoRoot, 'samples', 'ci-goldens', '_regressions', 'apply_patch');
const coreLoaderPath = path.join(repoRoot, 'dist', 'modules', 'llmswitch', 'core-loader.js');
const coreLoaderUrl = pathToFileURL(coreLoaderPath).href;

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
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) yield full;
    }
  }
}

async function loadValidator() {
  if (!(await fileExists(coreLoaderPath))) {
    throw new Error(`core-loader missing at ${coreLoaderPath} (run npm run build:dev first)`);
  }
  const { importCoreModule } = await import(coreLoaderUrl);
  const { validateToolCall } = await importCoreModule('tools/tool-registry');
  return { validateToolCall };
}

async function main() {
  if (!(await fileExists(REG_ROOT))) {
    console.log(`[verify:apply-patch-regressions] skip (missing: ${REG_ROOT})`);
    return;
  }

  const { validateToolCall } = await loadValidator();

  let total = 0;
  let fixed = 0;
  let stillFailing = 0;
  const mismatches = [];

  for await (const filePath of walkJsonFiles(REG_ROOT)) {
    total += 1;
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {
      mismatches.push({ filePath, reason: 'unparseable_json' });
      continue;
    }

    const expected = typeof doc?.errorType === 'string' ? doc.errorType.trim() : '';
    const args = typeof doc?.originalArgs === 'string' ? doc.originalArgs : '';
    if (!expected || !args) {
      mismatches.push({ filePath, reason: 'missing_errorType_or_originalArgs' });
      continue;
    }

    const res = validateToolCall('apply_patch', args);
    if (res?.ok) {
      fixed += 1;
      continue;
    }
    stillFailing += 1;
    const actual = (res && res.reason) || 'unknown';
    if (actual !== expected) {
      mismatches.push({ filePath, reason: `reason_mismatch expected=${expected} actual=${actual}` });
    }
  }

  console.log(
    `[verify:apply-patch-regressions] total=${total} fixed=${fixed} stillFailing=${stillFailing} mismatches=${mismatches.length}`
  );
  if (mismatches.length) {
    console.error('[verify:apply-patch-regressions] ❌ mismatches:');
    for (const m of mismatches.slice(0, 20)) {
      console.error(` - ${path.relative(repoRoot, m.filePath)} :: ${m.reason}`);
    }
    process.exitCode = 1;
  } else {
    console.log('[verify:apply-patch-regressions] ✅ ok');
  }
}

main().catch((error) => {
  console.error('[verify:apply-patch-regressions] failed:', error?.stack || error?.message || String(error ?? 'unknown'));
  process.exit(2);
});


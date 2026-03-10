#!/usr/bin/env node
/**
 * Minimal "module must have tests" gate.
 *
 * Definition:
 * - A module is a first-level folder under src/ (e.g. conversion, router, servertool, filters, tools, guidance, sse, ...).
 * - Each module must have at least one test under tests/<bucket>/<module>/...
 *
 * Buckets: unit, integration, regression, golden.
 *
 * This is intentionally conservative and can be refined as the repo structure stabilizes.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function listDirs(p) {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function hasAnyFileUnder(p) {
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isFile()) return true;
      if (e.isDirectory() && hasAnyFileUnder(full)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function main() {
  const srcRoot = path.join(root, 'src');
  const modules = listDirs(srcRoot).filter((name) => !name.startsWith('.') && name !== 'test' && name !== 'tests');
  if (!modules.length) {
    console.log('[verify-test-coverage-map] no src modules found; skip');
    return;
  }

  const testRoot = path.join(root, 'tests');
  const buckets = ['unit', 'integration', 'regression', 'golden'];
  const missing = [];
  for (const m of modules) {
    const ok = buckets.some((b) => hasAnyFileUnder(path.join(testRoot, b, m)));
    if (!ok) {
      missing.push(m);
    }
  }

  if (missing.length) {
    console.error(`[verify-test-coverage-map] missing module tests: ${missing.join(', ')}`);
    console.error('[verify-test-coverage-map] expected at least one test under tests/{unit,integration,regression,golden}/<module>/...');
    process.exit(1);
  }
  console.log(`[verify-test-coverage-map] ok: ${modules.length} modules have tests`);
}

main();


#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadRustMigrationManifest } from './lib/rust-migration-manifest.mjs';

function readArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) {
    return String(process.argv[idx + 1]).trim();
  }
  return fallback;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function toMetric(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const linesTotal = Number(entry.lines?.total ?? 0);
  const linesCovered = Number(entry.lines?.covered ?? 0);
  const branchesTotal = Number(entry.branches?.total ?? 0);
  const branchesCovered = Number(entry.branches?.covered ?? 0);
  if (!Number.isFinite(linesTotal) || !Number.isFinite(linesCovered)) return null;
  if (!Number.isFinite(branchesTotal) || !Number.isFinite(branchesCovered)) return null;
  return { linesTotal, linesCovered, branchesTotal, branchesCovered };
}

function pct(covered, total) {
  if (!total) return 0;
  return (covered / total) * 100;
}

function globToRegExp(glob) {
  const escaped = glob
    .split('\\')
    .join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*\\\*\\/g, '(?:.*\\/)?')
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function pathMatcher(pattern) {
  const normalized = toPosixPath(pattern);
  if (normalized.includes('*')) {
    const re = globToRegExp(normalized);
    return (file) => re.test(file);
  }
  return (file) => file === normalized || file.endsWith(`/${normalized}`);
}

function aggregateModule(summary, moduleConfig) {
  const matchers = (Array.isArray(moduleConfig.paths) ? moduleConfig.paths : [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((pattern) => pathMatcher(pattern));
  if (!matchers.length) {
    return { files: 0, linesTotal: 0, linesCovered: 0, branchesTotal: 0, branchesCovered: 0 };
  }
  let files = 0;
  let linesTotal = 0;
  let linesCovered = 0;
  let branchesTotal = 0;
  let branchesCovered = 0;
  for (const [filePath, node] of Object.entries(summary)) {
    if (filePath === 'total') continue;
    const normalized = toPosixPath(filePath);
    if (!matchers.some((fn) => fn(normalized))) {
      continue;
    }
    const metric = toMetric(node);
    if (!metric) {
      continue;
    }
    files += 1;
    linesTotal += metric.linesTotal;
    linesCovered += metric.linesCovered;
    branchesTotal += metric.branchesTotal;
    branchesCovered += metric.branchesCovered;
  }
  return { files, linesTotal, linesCovered, branchesTotal, branchesCovered };
}

function main() {
  const summaryPath = path.resolve(
    process.cwd(),
    readArg('--summary', path.join('coverage', 'coverage-summary.json'))
  );
  const manifestPath = path.resolve(
    process.cwd(),
    readArg('--manifest', path.join('config', 'rust-migration-modules.json'))
  );
  const onlyModule = readArg('--module', '');
  const includeUnprepared = readArg('--include-unprepared', '') === '1';

  if (!fs.existsSync(summaryPath)) {
    console.error(`[shadow-gate] coverage summary not found: ${summaryPath}`);
    process.exit(1);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const { modules: allModules } = loadRustMigrationManifest(manifestPath);
  let modules = allModules;
  if (onlyModule) {
    modules = allModules.filter((item) => item.id === onlyModule);
    if (!modules.length) {
      console.error(`[shadow-gate] module not found in manifest: ${onlyModule}`);
      process.exit(1);
    }
  } else if (!includeUnprepared) {
    modules = allModules.filter((item) => item.preparedForShadow);
  }

  if (!modules.length) {
    console.error('[shadow-gate] no modules selected for coverage gate');
    process.exit(1);
  }

  let failed = false;
  for (const item of modules) {
    const agg = aggregateModule(summary, item);
    const linePct = pct(agg.linesCovered, agg.linesTotal);
    const branchPct = pct(agg.branchesCovered, agg.branchesTotal);
    console.log(
      `[shadow-gate] module=${item.id} prepared=${item.preparedForShadow} files=${agg.files} lines=${linePct.toFixed(
        2
      )}% branches=${branchPct.toFixed(2)}%`
    );
    if (agg.files === 0) {
      failed = true;
      console.error(`[shadow-gate] FAIL module=${item.id} no coverage entries matched configured paths`);
      continue;
    }
    if (linePct < item.lineThreshold || branchPct < item.branchThreshold) {
      failed = true;
      console.error(
        `[shadow-gate] FAIL module=${item.id} required(line>=${item.lineThreshold}, branch>=${item.branchThreshold})`
      );
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log('[shadow-gate] PASS');
}

main();

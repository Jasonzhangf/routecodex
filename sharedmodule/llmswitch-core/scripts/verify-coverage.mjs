#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRel(p) {
  return p.split(path.sep).join('/');
}

function globToRegExp(glob) {
  const escaped = glob
    .split('\\').join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*\\\*\\/g, '(?:.*\\/)?')
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function pct(entry) {
  return entry && typeof entry.pct === 'number' ? entry.pct : 0;
}

function sumMetric(a, b) {
  const total = Number(a?.total ?? 0) + Number(b?.total ?? 0);
  const covered = Number(a?.covered ?? 0) + Number(b?.covered ?? 0);
  const skipped = Number(a?.skipped ?? 0) + Number(b?.skipped ?? 0);
  const pctVal = total ? (covered / total) * 100 : 100;
  return { total, covered, skipped, pct: Number(pctVal.toFixed(2)) };
}

function parseArgs(argv) {
  const out = {
    threshold: Number(process.env.LLMSWITCH_COVERAGE_MIN ?? '90'),
    summary: 'coverage/coverage-summary.json',
    allowlist: 'config/coverage-exclude-glue.json'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--threshold') out.threshold = Number(argv[++i] ?? out.threshold);
    else if (arg === '--summary') out.summary = String(argv[++i] ?? out.summary);
    else if (arg === '--allowlist') out.allowlist = String(argv[++i] ?? out.allowlist);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const threshold = Number.isFinite(args.threshold) ? args.threshold : 90;
  const projectRoot = process.cwd();
  const summaryPath = path.resolve(projectRoot, args.summary);
  if (!fs.existsSync(summaryPath)) {
    console.error(`[verify-coverage] missing coverage summary: ${summaryPath}`);
    process.exit(2);
  }

  const allowlistPath = path.resolve(projectRoot, args.allowlist);
  const allowlist = fs.existsSync(allowlistPath) ? readJson(allowlistPath) : { glueAllowlist: [] };
  const allowPatterns = Array.isArray(allowlist?.glueAllowlist) ? allowlist.glueAllowlist : [];
  const allowRegexes = allowPatterns.map((r) => ({
    pattern: String(r.pattern || ''),
    reason: String(r.reason || ''),
    re: globToRegExp(String(r.pattern || ''))
  }));

  // Fail fast if allowlist explodes (should remain "small and auditable").
  if (allowRegexes.length > 20) {
    console.error(`[verify-coverage] glue allowlist too large (${allowRegexes.length} > 20): ${allowlistPath}`);
    process.exit(1);
  }

  const summary = readJson(summaryPath);
  const totals = { lines: null, branches: null, functions: null, statements: null };

  const keys = Object.keys(summary).filter((k) => k !== 'total');
  for (const key of keys) {
    const entry = summary[key];
    if (!entry || typeof entry !== 'object') continue;

    const abs = path.isAbsolute(key) ? key : path.resolve(projectRoot, key);
    const rel = normalizeRel(path.relative(projectRoot, abs));

    // Only gate coverage for llmswitch-core source (src/**).
    if (!rel.startsWith('src/')) continue;

    // Exclude explicit glue allowlist.
    if (allowRegexes.some((x) => x.re.test(rel))) continue;

    totals.lines = sumMetric(totals.lines, entry.lines);
    totals.branches = sumMetric(totals.branches, entry.branches);
    totals.functions = sumMetric(totals.functions, entry.functions);
    totals.statements = sumMetric(totals.statements, entry.statements);
  }

  const metrics = {
    lines: pct(totals.lines),
    branches: pct(totals.branches),
    functions: pct(totals.functions),
    statements: pct(totals.statements)
  };

  const failures = Object.entries(metrics)
    .filter(([, v]) => typeof v === 'number' && v < threshold)
    .map(([k, v]) => `${k}=${v}% (<${threshold}%)`);

  if (failures.length) {
    console.error(`[verify-coverage] failed (src/**, glue allowlist applied): ${failures.join(', ')}`);
    console.error(`[verify-coverage] summary: ${summaryPath}`);
    console.error(`[verify-coverage] allowlist: ${allowlistPath}`);
    process.exit(1);
  }

  console.log(
    `[verify-coverage] ok (src/**): lines=${metrics.lines} branches=${metrics.branches} functions=${metrics.functions} statements=${metrics.statements} (>=${threshold}%)`
  );
}

main();

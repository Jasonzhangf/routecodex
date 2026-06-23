#!/usr/bin/env node
/**
 * Report Unified Hub policy violations/enforcement rewrites.
 * Delegates read logic to src/debug/policy/violations.ts (debug.unified_surface).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePolicyViolationsRoot, collectPolicyViolations } from '../src/debug/policy/violations.js';

function usage() {
  console.log(`Usage:
  node scripts/policy-violations-report.mjs [options]

Options:
  --root <dir>          default: ~/.routecodex/codex-samples/__policy_violations__
  --since-hours <n>     only include files modified in last N hours
  --limit <n>           limit printed rows per section (default: 30)
  --fail                exit 1 if any records found
  --help                show help
`);
}

function parseArgs(argv) {
  const out = {
    root: undefined,
    sinceHours: undefined,
    limit: 30,
    fail: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' && i + 1 < argv.length) out.root = argv[++i];
    else if (a === '--since-hours' && i + 1 < argv.length) out.sinceHours = Number(argv[++i]);
    else if (a === '--limit' && i + 1 < argv.length) out.limit = Number(argv[++i]);
    else if (a === '--fail') out.fail = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      out.help = true;
    }
  }
  return out;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function inferStageFromFilename(filePath) {
  const base = path.basename(filePath, '.json');
  return base.replace(/_[0-9]+$/, '');
}

function fmtRow(cols, widths) {
  return cols
    .map((c, i) => {
      const w = widths[i] || 20;
      const s = String(c ?? '');
      return s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w, ' ');
    })
    .join('  ');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const root = resolvePolicyViolationsRoot(args.root);
  const rootExists = await fileExists(root);
  if (!rootExists) {
    console.log(`[policy-report] no folder: ${root}`);
    process.exit(0);
  }

  const sinceMs =
    typeof args.sinceHours === 'number' && Number.isFinite(args.sinceHours) && args.sinceHours > 0
      ? Date.now() - args.sinceHours * 60 * 60 * 1000
      : null;

  const records = await collectPolicyViolations({ rootDir: root, sinceHours: args.sinceHours, limit: args.limit ? args.limit * 2 : undefined });
  const rows = records.map((rec) => {
    const file = rec.file;
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    return {
      file,
      rel,
      endpointFolder: parts[0] || '',
      providerKey: parts[1] || '',
      requestId: parts[2] || '',
      stage: inferStageFromFilename(file),
      protocol: '',
      kind: rec.violations.length > 0 ? 'observe' : rec.removedTopLevelKeys.length > 0 ? 'enforce' : 'unknown',
      obj: rec,
    };
  });

  console.log(`[policy-report] root=${root}`);
  if (sinceMs !== null) {
    console.log(`[policy-report] sinceHours=${args.sinceHours}`);
  }
  console.log(`[policy-report] records=${rows.length}`);
  if (!rows.length) {
    process.exit(0);
  }

  const byStage = new Map();
  const byProtocol = new Map();
  const violationPathCounts = new Map();
  const wrapperCounts = new Map();
  const removedKeyCounts = new Map();

  for (const r of rows) {
    inc(byStage, r.stage);
    if (r.protocol) inc(byProtocol, r.protocol);

    if (r.kind === 'observe' && Array.isArray(r.obj?.violations)) {
      for (const v of r.obj.violations) {
        const p = safeString(v?.path) || '(unknown)';
        inc(violationPathCounts, p);
      }
    }
    if (r.kind === 'enforce') {
      const flattened = Array.isArray(r.obj?.flattenedWrappers) ? r.obj.flattenedWrappers : [];
      for (const w of flattened) inc(wrapperCounts, String(w));
      const removed = Array.isArray(r.obj?.removedTopLevelKeys) ? r.obj.removedTopLevelKeys : [];
      for (const k of removed) inc(removedKeyCounts, String(k));
    }
  }

  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 30;

  console.log('\n[policy-report] top stages:');
  for (const [k, v] of topN(byStage, limit)) {
    console.log(`- ${k}: ${v}`);
  }

  console.log('\n[policy-report] top protocols:');
  for (const [k, v] of topN(byProtocol, limit)) {
    console.log(`- ${k}: ${v}`);
  }

  if (violationPathCounts.size) {
    console.log('\n[policy-report] top violation paths:');
    for (const [k, v] of topN(violationPathCounts, limit)) {
      console.log(`- ${k}: ${v}`);
    }
  }

  if (wrapperCounts.size) {
    console.log('\n[policy-report] top flattened wrappers (enforce):');
    for (const [k, v] of topN(wrapperCounts, limit)) {
      console.log(`- ${k}: ${v}`);
    }
  }

  if (removedKeyCounts.size) {
    console.log('\n[policy-report] top removed keys (enforce):');
    for (const [k, v] of topN(removedKeyCounts, limit)) {
      console.log(`- ${k}: ${v}`);
    }
  }

  console.log('\n[policy-report] newest records:');
  const newest = rows
    .slice()
    .sort((a, b) => (a.file < b.file ? 1 : -1))
    .slice(0, Math.min(limit, rows.length));
  console.log(fmtRow(['endpoint', 'providerKey', 'stage', 'protocol', 'requestId'], [16, 28, 40, 18, 24]));
  for (const r of newest) {
    console.log(fmtRow([r.endpointFolder, r.providerKey, r.stage, r.protocol || '-', r.requestId], [16, 28, 40, 18, 24]));
  }

  if (args.fail) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[policy-report] failed:', err);
  process.exit(2);
});

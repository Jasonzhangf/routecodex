#!/usr/bin/env node
/**
 * Report Unified Hub policy violations/enforcement rewrites captured under:
 *   ~/.routecodex/codex-samples/__policy_violations__/
 *
 * This is intended for day-to-day monitoring when policy is enabled by default.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    root: path.join(os.homedir(), '.routecodex', 'errorsamples', 'policy'),
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

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.endsWith('.json')) out.push(p);
    }
  }
  return out;
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function readJson(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function classifyRecord(obj) {
  if (!obj || typeof obj !== 'object') return { kind: 'unknown' };
  const o = obj;
  if (Array.isArray(o.violations) || (o.summary && typeof o.summary === 'object')) return { kind: 'observe' };
  if (Array.isArray(o.removedTopLevelKeys) || Array.isArray(o.flattenedWrappers)) return { kind: 'enforce' };
  return { kind: 'unknown' };
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
  let root = path.resolve(args.root);
  if (!(await fileExists(root))) {
    const fallback = path.join(os.homedir(), '.routecodex', 'codex-samples', '__policy_violations__');
    if (await fileExists(fallback)) {
      root = fallback;
    } else {
      console.log(`[policy-report] no folder: ${root}`);
      process.exit(0);
    }
  }

  const sinceMs =
    typeof args.sinceHours === 'number' && Number.isFinite(args.sinceHours) && args.sinceHours > 0
      ? Date.now() - args.sinceHours * 60 * 60 * 1000
      : null;

  const files = await walk(root);
  const rows = [];
  for (const file of files) {
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      continue;
    }
    if (sinceMs !== null && st.mtimeMs < sinceMs) continue;
    const obj = await readJson(file);
    if (!obj) continue;
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    const endpointFolder = parts[0] || '';
    const providerKey = parts[1] || '';
    const requestId = parts[2] || '';
    rows.push({
      file,
      rel,
      endpointFolder,
      providerKey,
      requestId,
      stage: safeString(obj?.stage) || safeString(obj?.meta?.stage) || inferStageFromFilename(file),
      protocol: safeString(obj?.providerProtocol) || safeString(obj?.protocol),
      kind: classifyRecord(obj).kind,
      obj
    });
  }

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

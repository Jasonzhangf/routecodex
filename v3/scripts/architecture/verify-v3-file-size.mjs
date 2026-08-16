#!/usr/bin/env node
// verify:v3-file-size — ratchet gate for v3.module_decomposition.
// Rules:
//   1. Every production .rs file under v3/crates (excluding /target/ and /tests/)
//      must be <= limit (1500) unless whitelisted.
//   2. Whitelisted files must never exceed their snapshot (ratchet: shrink-only).
//   3. A whitelisted file that drops to <= limit must be removed from the
//      whitelist (the gate fails until the entry is deleted, so the ratchet
//      cannot silently loosen).
// Policy truth: config/v3-file-size-policy.json
// SOP: docs/architecture/wiki/v3-module-decomposition-sop.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const policyPath = process.env.ROUTECODEX_V3_FILE_SIZE_POLICY_PATH
  ? path.resolve(root, process.env.ROUTECODEX_V3_FILE_SIZE_POLICY_PATH)
  : path.join(root, 'config', 'v3-file-size-policy.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const limit = Number(policy.limit);
const scope = String(policy.scope);
const excludeSegments = Array.isArray(policy.exclude_path_segments) ? policy.exclude_path_segments : [];
const whitelist = policy.ratchet_whitelist ?? {};
const failures = [];

if (!Number.isInteger(limit) || limit <= 0) failures.push('policy limit must be a positive integer');

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (excludeSegments.some((seg) => `/${rel}/`.includes(seg))) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collect(full, out);
    else if (rel.endsWith('.rs')) out.push(rel);
  }
  return out;
}

const files = collect(path.join(root, scope));
const seen = new Set();
for (const rel of files) {
  // Count like `wc -l` (number of newline characters) so snapshots taken with
  // wc stay comparable.
  const content = fs.readFileSync(path.join(root, rel), 'utf8');
  const lines = (content.match(/\n/g) ?? []).length;
  const snapshot = whitelist[rel];
  if (snapshot !== undefined) {
    seen.add(rel);
    if (!Number.isInteger(snapshot) || snapshot <= limit) {
      failures.push(`${rel}: whitelist snapshot ${snapshot} is not above limit ${limit}; remove the entry`);
      continue;
    }
    if (lines > snapshot) {
      failures.push(`${rel}: ${lines} lines exceeds ratchet snapshot ${snapshot} (shrink-only)`);
    } else if (lines <= limit) {
      failures.push(`${rel}: now ${lines} lines (<= ${limit}); remove its ratchet_whitelist entry in v3/config/v3-file-size-policy.json`);
    }
    continue;
  }
  if (lines > limit) {
    failures.push(`${rel}: ${lines} lines exceeds limit ${limit}; split per docs/architecture/wiki/v3-module-decomposition-sop.md`);
  }
}
for (const rel of Object.keys(whitelist)) {
  if (!seen.has(rel)) failures.push(`stale ratchet_whitelist entry (file missing): ${rel}`);
}

if (failures.length) {
  console.error('[verify:v3-file-size] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[verify:v3-file-size] ok (limit=${limit}, files=${files.length}, ratchet entries=${Object.keys(whitelist).length})`);

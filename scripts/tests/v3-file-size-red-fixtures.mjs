#!/usr/bin/env node
// Red fixtures for verify:v3-file-size — proves the ratchet gate actually
// rejects each forbidden state (guard: paired positive/negative tests).
// Positive path is covered by running the real gate against the repo.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const gate = path.join(root, 'scripts', 'architecture', 'verify-v3-file-size.mjs');
const failures = [];

function runGate(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-file-size-red-'));
  const policyFile = path.join(dir, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  try {
    execFileSync('node', [gate], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROUTECODEX_V3_FILE_SIZE_POLICY_PATH: policyFile },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const realPolicy = JSON.parse(fs.readFileSync(path.join(root, 'config', 'v3-file-size-policy.json'), 'utf8'));
const whitelisted = Object.keys(realPolicy.ratchet_whitelist)[0];
const currentLines = (fs.readFileSync(path.join(root, whitelisted), 'utf8').match(/\n/g) ?? []).length;

// RED 1: un-whitelisted oversize file must fail (drop every whitelist entry).
const red1 = runGate({ ...realPolicy, ratchet_whitelist: {} });
if (red1.ok) failures.push('red1: gate passed with oversize files and empty whitelist');
else if (!red1.output.includes('exceeds limit')) failures.push('red1: wrong failure reason');

// RED 2: whitelisted file above its ratchet snapshot must fail (shrink-only).
const red2 = runGate({
  ...realPolicy,
  ratchet_whitelist: { ...realPolicy.ratchet_whitelist, [whitelisted]: currentLines - 1 },
});
if (red2.ok) failures.push('red2: gate passed when file exceeds its ratchet snapshot');
else if (!red2.output.includes('exceeds ratchet snapshot')) failures.push('red2: wrong failure reason');

// RED 3: whitelist entry at/below limit must fail (entry must be removed, not kept).
const red3 = runGate({
  ...realPolicy,
  ratchet_whitelist: { ...realPolicy.ratchet_whitelist, 'v3/crates/routecodex-v3-runtime/src/nodes.rs': realPolicy.limit },
});
if (red3.ok) failures.push('red3: gate passed with a whitelist snapshot not above limit');
else if (!red3.output.includes('remove the entry')) failures.push('red3: wrong failure reason');

// RED 4: stale whitelist entry for a missing file must fail.
const red4 = runGate({
  ...realPolicy,
  ratchet_whitelist: { ...realPolicy.ratchet_whitelist, 'v3/crates/routecodex-v3-runtime/src/does_not_exist.rs': 9999 },
});
if (red4.ok) failures.push('red4: gate passed with a stale whitelist entry');
else if (!red4.output.includes('stale ratchet_whitelist entry')) failures.push('red4: wrong failure reason');

// GREEN: the real policy must pass against the real tree.
const green = runGate(realPolicy);
if (!green.ok) failures.push(`green: real policy failed: ${green.output}`);

if (failures.length) {
  console.error('[test:v3-file-size-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[test:v3-file-size-red-fixtures] ok (4 red + 1 green)');

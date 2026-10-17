#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml';
const verifier = path.join(repo, 'v3/scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs');
const files = [manifest, ...['v3-function-map.yml', 'v3-mainline-call-map.yml', 'v3-verification-map.yml', 'v3-resource-operation-map.yml'].map((file) => `docs/architecture/${file}`)];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tool-parity-data-'));
function run() {
  const result = spawnSync(process.execPath, [verifier], { cwd: repo, env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: tmp }, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
try {
  for (const file of files) {
    const target = path.join(tmp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, file), target);
  }
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.output);
  const target = path.join(tmp, manifest);
  const doc = YAML.parse(fs.readFileSync(target, 'utf8'));
  doc.owner_feature_id = 'v3.hub_relay_runtime_closeout';
  fs.writeFileSync(target, YAML.stringify(doc));
  const result = run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /owner_feature_id mismatch/);
  console.log('[test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures] GREEN baseline + owner drift rejected');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

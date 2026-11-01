#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = path.join(repo, 'v3/scripts/architecture/verify-v3-normalization-payload-logic-boundary.mjs');
const file = 'docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml';
const input = YAML.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-normalization-data-'));
const target = path.join(root, file);
fs.mkdirSync(path.dirname(target), { recursive: true });
function run(doc) {
  fs.writeFileSync(target, YAML.stringify(doc));
  const result = spawnSync(process.execPath, [verifier], {
    cwd: repo,
    env: { ...process.env, ROUTECODEX_V3_FIXTURE_ROOT: root },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
try {
  const baseline = run(input);
  assert.equal(baseline.status, 0, baseline.output);
  for (const id of ['ProviderReqCompat06ProviderCompat', 'ProviderRespCompat02ProviderCompat']) {
    const doc = structuredClone(input);
    doc.nodes.find((node) => node.node_id === id).tool_governance = 'allowed';
    const result = run(doc);
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(`${id}: tool governance must remain forbidden`), result.output);
  }
  console.log('[test:v3-normalization-payload-logic-boundary-red-fixtures] GREEN baseline + 2 Compat data mutations rejected');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

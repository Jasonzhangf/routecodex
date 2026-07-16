#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-anthropic-relay-local-continuation.mjs');
const files = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
  'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/manifests/v3.anthropic_relay.local_continuation.mainline.yml',
  'docs/architecture/wiki/v3-anthropic-relay-local-continuation.md',
  'docs/architecture/wiki/v3-anthropic-relay-local-continuation.html',
  'docs/goals/v3-anthropic-relay-local-continuation-test-design.md',
];
const runtime = files[0];
const codec = files[1];
const store = files[2];
const manifest = files[10];
const cases = [
  ['remove Resp04 store', runtime, '        commit_or_release_local_continuation(', '        removed_local_continuation(', /Resp04 commit calls/],
  ['move restore after Req05', runtime, '        merge_restored_local_context_at_req04(', '        delayed_context_merge(', /merge_restored_local_context_at_req04|missing or reordered/],
  ['add fallback', runtime, '    let mut restored_context = None;', '    let fallback = true;\n    let mut restored_context = None;', /fallback/],
  ['add required_action inference', runtime, '    let mut restored_context = None;', '    let required_action = true;\n    let mut restored_context = None;', /required_action/],
  ['add codec owner leak', codec, 'fn encode_messages(', 'const STORE_KEY: &str = "store_key";\nfn encode_messages(', /store_key/],
  ['remove Anthropic scope type', store, 'V3LocalContinuationEntryProtocol::Anthropic', 'V3LocalContinuationEntryProtocol::Responses', /V3LocalContinuationEntryProtocol::Anthropic/],
  ['drift immutable edge', manifest, 'step_id: v3-localcont-02', 'step_id: v3-localcont-02x', /edge v3-localcont-02 mismatch/],
];
const failures = [];
for (const [name, target, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-anthropic-local-red-'));
  try {
    for (const file of files) {
      const destination = resolve(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, file), destination);
    }
    const path = resolve(root, target);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(path, source.split(from).join(to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-anthropic-relay-local-continuation-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-anthropic-relay-local-continuation-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);

#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-openai-chat-relay-runtime-integration.mjs');
const runtime = 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs';
const cases = [
  ['missing Req06', '    trace.push("V3HubReqTarget06Resolved");', '', /V3HubReqTarget06Resolved/],
  ['transport skipped', 'transport.send(transport_request).await', 'Ok::<_, V3ProviderError>(unreachable!())', /transport\.send/],
  ['fallback added', 'let mut trace = Vec::with_capacity(17);', 'let fallback = true; let mut trace = Vec::with_capacity(17);', /fallback/],
  ['Responses Direct re-entry', 'let mut trace = Vec::with_capacity(17);', 'let _ = "ResponsesDirect11Policy"; let mut trace = Vec::with_capacity(17);', /ResponsesDirect/],
  ['dynamic hooks', 'compile_v3_hub_v1_static_registry()', 'std::fs::read_dir(".").unwrap(); compile_v3_hub_v1_static_registry()', /read_dir|dynamic/],
  ['raw SSE materialization', 'routecodex_v3_sse::SseIncrementalDecoder::new(', 'let sse_frames = Vec::new(); routecodex_v3_sse::SseIncrementalDecoder::new(', /sse_frames/],
  ['internal metadata leak', 'use std::collections::{BTreeMap, BTreeSet, VecDeque};', 'const INTERNAL: &str = "metadata_center";\nuse std::collections::{BTreeMap, BTreeSet, VecDeque};', /metadata_center/],
];
const copied = [
  runtime,
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'docs/goals/v3-openai-chat-relay-runtime-integration-test-design.md',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/tests/openai_chat_relay_controlled.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.openai_chat_relay.controlled_runtime.mainline.yml',
  'docs/architecture/wiki/v3-openai-chat-relay-controlled-runtime.md',
  'docs/architecture/wiki/html/v3-openai-chat-relay-controlled-runtime.html',
];
const failures = [];
for (const [name, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-openai-chat-relay-red-'));
  try {
    for (const path of copied) cpSync(resolve(repo, path), resolve(root, path), { recursive: true });
    const target = resolve(root, runtime);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(name + ': mutation source missing');
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.status === 0) failures.push(name + ': verifier unexpectedly passed');
    else if (!diagnostic.test(output)) failures.push(name + ': wrong diagnostic: ' + output.slice(-500));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-openai-chat-relay-runtime-integration-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[test:v3-openai-chat-relay-runtime-integration-red-fixtures] ok (' + cases.length + ' forbidden mutations rejected)');

#!/usr/bin/env node
/**
 * verify:v3-client-sse-head-commit
 *
 * The Server may commit the client SSE response channel and transport
 * keepalives, but no provider payload byte may be projected before the Runtime's
 * full-attempt outcome, an exec replacement must give in-flight client responses
 * a bounded drain before it closes their transports, and the committed channel
 * carries the projected successful payload by SSE transport framing.
 *
 * The behaviour lives in the controlled black-box test through the public
 * /v1/chat/completions entry, so this gate locks only the ownership bindings:
 * the Server owns the client channel commit and the drain, the committed payload
 * is framed only through the SSE transport codec, and neither path may reach
 * into Runtime or provider transport code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(v3Root, '..');
const failures = [];

function read(rel) {
  const candidates = [
    path.join(root, rel),
    path.join(v3Root, rel),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  return fs.readFileSync(file, 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(root, rel)) || fs.existsSync(path.join(v3Root, rel));
}

const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlineMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const verificationMapPath = 'docs/architecture/v3-verification-map.yml';
const manifestPath = 'docs/architecture/manifests/v3.client_sse_head_commit.mainline.yml';
const functionMapSource = 'v3/crates/routecodex-v3-server/src/client_sse_transport.rs';
const headCommitSymbol = 'accept_v3_client_sse_transport';
const mainlineStepId = 'v3-client-sse-head-commit-01';

for (const rel of [
  functionMapPath,
  mainlineMapPath,
  verificationMapPath,
  manifestPath,
  functionMapSource,
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/restart_handoff.rs',
  'v3/crates/routecodex-v3-server/tests/client_transport_boundary_controlled.rs',
]) {
  if (!exists(rel)) failures.push(`missing ${rel}`);
}

// Every canonical doc the manifest binds must exist on disk; a binding to an
// absent page would let an incomplete architecture record pass the map gates.
const manifestLines = read(manifestPath).split('\n');
const canonicalDocsStart = manifestLines.findIndex((line) => line.startsWith('canonical_docs:'));
if (canonicalDocsStart < 0) {
  failures.push(`${manifestPath}: missing canonical_docs`);
} else {
  for (let index = canonicalDocsStart + 1; index < manifestLines.length; index += 1) {
    const line = manifestLines[index];
    if (!line.startsWith('  - ')) break;
    const doc = line.slice('  - '.length).trim();
    if (!exists(doc)) failures.push(`${manifestPath}: canonical doc missing on disk: ${doc}`);
  }
}

const functionMap = read(functionMapPath);
const mainlineMap = read(mainlineMapPath);
const verificationMap = read(verificationMapPath);
const featureBlock = functionMap.split('\n- feature_id: v3.client_sse_head_commit\n')?.[1] ?? '';
const block = featureBlock.split('\n- feature_id: ')[0] ?? '';
for (const required of [
  'owner_crate: routecodex-v3-server',
  `  - ${functionMapSource}`,
  `  - ${headCommitSymbol}`,
  '  - v3.front.request_activity_gate',
  `  - ${mainlineStepId}`,
  '  - v3/crates/routecodex-v3-server/tests/client_transport_boundary_controlled.rs',
  '  - npm run test:v3-client-sse-head-commit',
  '  - npm run test:v3-client-transport-boundary',
  '  - npm run verify:v3-client-sse-head-commit',
]) {
  if (!block.includes(required)) failures.push(`function map feature missing ${required}`);
}
if (!block.includes('forbidden_paths:')) failures.push('function map feature missing forbidden_paths');
for (const forbidden of [
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src',
]) {
  if (!block.includes(`  - ${forbidden}`)) failures.push(`function map feature must forbid ${forbidden}`);
}

const verificationBlock = verificationMap.split('\n- feature_id: v3.client_sse_head_commit\n')?.[1] ?? '';
const verificationSection = verificationBlock.split('\n- feature_id: ')[0] ?? '';
for (const required of [
  'owner_kind: rust_v3_server_http_transport_boundary',
  'source_controlled: true',
  'global_install_restart: false',
  '  - npm run test:v3-client-sse-head-commit',
  '  - npm run test:v3-client-transport-boundary',
  '  - npm run verify:v3-client-sse-head-commit',
]) {
  if (!verificationSection.includes(required)) {
    failures.push(`verification map feature missing ${required}`);
  }
}

if (!mainlineMap.includes(`step_id: ${mainlineStepId}`)) {
  failures.push(`mainline call map missing ${mainlineStepId}`);
}
if (!mainlineMap.includes(`owner_feature_id: v3.client_sse_head_commit`)) {
  failures.push('mainline call map missing the client SSE head commit owner');
}

const lib = read('v3/crates/routecodex-v3-server/src/lib.rs');
if (!lib.includes(headCommitSymbol)) {
  failures.push(`Server entry must call ${headCommitSymbol}`);
}
if (!lib.includes('V3_EXEC_INFLIGHT_DRAIN')) {
  failures.push('Server entry must bound the exec in-flight drain');
}
if (!read('v3/crates/routecodex-v3-server/src/restart_handoff.rs').includes('V3_FRONT_CLOSE_FLUSH')) {
  failures.push('Front write worker must bound the close flush');
}

// The client SSE transport is an independent module. It must implement the
// declared client-accept channel and the projected-client-frame edge, it must
// frame the committed payload through the SSE transport codec, and it must keep
// exactly one keepalive owner at a time.
const transportSource = read(functionMapSource);
for (const required of [
  'V3DirectSseAccept01ClientChannel',
  'V3DirectSseAccept03ProjectedClientFrame',
  'build_v3_sse_transport_out_04_keepalive_comment',
  'build_v3_sse_transport_in_02_from_fields',
  'MissedTickBehavior::Delay',
  'V3ClientSseChannelDisposition::FrameCommittedPayload',
]) {
  if (!transportSource.includes(required)) {
    failures.push(`${functionMapSource}: client SSE transport missing ${required}`);
  }
}
if (!/V3ClientSseChannelState::Drain\(stream\)[\s\S]{0,900}?poll_next\(cx\)/.test(transportSource)) {
  failures.push(`${functionMapSource}: the drained outcome body must own the keepalive`);
}

// The head commit is a transport-boundary owner. It must not reach into Runtime
// or provider transport code, so it cannot become a second provider-payload
// projection path. It also must not parse the payload: the committed payload is
// carried by transport framing only.
for (const line of transportSource.split('\n')) {
  if (/^\s*use\s+(routecodex_v3_runtime|routecodex_v3_provider)/.test(line)) {
    failures.push(`${functionMapSource}: transport head commit must not import provider or Runtime code: ${line.trim()}`);
  }
  if (/^\s*use\s+(serde_json|regex)/.test(line)) {
    failures.push(`${functionMapSource}: transport head commit must not parse the payload: ${line.trim()}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-client-sse-head-commit] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-client-sse-head-commit] ok');

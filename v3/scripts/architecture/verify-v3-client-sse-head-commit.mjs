#!/usr/bin/env node
// Declared ownership and import isolation for the client transport boundary.
// Head commit, keepalive, drain and framing behavior use the existing public
// client_transport_boundary_controlled Rust consumer, not source expressions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const sourcePath = 'v3/crates/routecodex-v3-server/src/client_sse_transport.rs';
const featureId = 'v3.client_sse_head_commit';
const stepId = 'v3-client-sse-head-commit-01';
const frontResourceBinding = 'v3.front.client_closeout_frame';
const explicitRoot = String(process.env.ROUTECODEX_V3_SOURCE_ROOT ?? '').trim();
const root = explicitRoot
  ? path.resolve(explicitRoot)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const functionMap = YAML.parse(read('docs/architecture/v3-function-map.yml'));
const resourceMap = YAML.parse(read('docs/architecture/v3-resource-operation-map.yml'));
const mainlineMap = YAML.parse(read('docs/architecture/v3-mainline-call-map.yml'));
const manifest = YAML.parse(
  read('docs/architecture/manifests/v3.client_sse_head_commit.mainline.yml'),
);
const feature = functionMap.features?.find((entry) => entry.feature_id === featureId);
if (feature?.owner_crate !== 'routecodex-v3-server') {
  failures.push('client SSE transport must be owned by routecodex-v3-server');
}
if (!feature?.allowed_paths?.includes(sourcePath)) {
  failures.push('client SSE transport source must belong to the declared owner');
}
if (!feature?.resource_bindings?.includes(frontResourceBinding)) {
  failures.push('client SSE transport must bind the Front closeout/flush resource');
}
if (!feature?.mainline_bindings?.includes(stepId)) {
  failures.push('client SSE transport must bind its mainline edge');
}
for (const requiredStep of [
  'v3-client-body-eof-front-held',
  'v3-client-front-flush-completed',
]) {
  if (!feature?.mainline_bindings?.includes(requiredStep)) {
    failures.push(`client SSE transport must bind ${requiredStep}`);
  }
}
for (const requiredSymbol of [
  'V3FrontHttpIo::poll_flush',
  'V3StableFrontSocket::close_for_exec_replacement',
  'write_front_command',
  'V3_FRONT_CLOSE_FLUSH',
]) {
  if (!feature?.entry_symbols?.includes(requiredSymbol)) {
    failures.push(`client SSE transport must retain ${requiredSymbol}`);
  }
}
if (feature?.entry_symbols?.includes('V3StableFrontSocket::hold_activity_until_flush')) {
  failures.push('client SSE transport must not retain the retired activity permit caller');
}
for (const forbidden of [
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src',
]) {
  if (!feature?.forbidden_paths?.includes(forbidden)) {
    failures.push(`client SSE transport owner must exclude ${forbidden}`);
  }
}
const edgeFor = (id) => mainlineMap.chains?.flatMap((chain) => chain.edges ?? [])
  .find((entry) => entry.step_id === id);
const headEdge = edgeFor(stepId);
const heldEdge = edgeFor('v3-client-body-eof-front-held');
const flushEdge = edgeFor('v3-client-front-flush-completed');
if (headEdge?.owner_feature_id !== featureId) {
  failures.push('client SSE transport mainline edge has no matching owner');
}
for (const [name, edge, callerSymbol, calleeSymbol] of [
  ['body EOF handoff', heldEdge, 'V3FrontHttpIo::poll_flush', 'V3FrontWriteCommand::Flush'],
  ['Front flush completion', flushEdge, 'V3StableFrontSocket::spawn', 'write_front_command'],
]) {
  if (
    edge?.owner_feature_id !== featureId ||
    edge?.caller_symbol !== callerSymbol ||
    edge?.callee_symbol !== calleeSymbol
  ) {
    failures.push(`${name} must use its real Front owner`);
  }
}
if (!manifest?.resource_reads?.some((entry) => entry.resource_id === frontResourceBinding)) {
  failures.push('client SSE manifest must read the real Front closeout/flush resource');
}
const frontResource = resourceMap.resources?.find((entry) => entry.resource_id === frontResourceBinding);
if (
  frontResource?.owner_crate !== 'routecodex-v3-server' ||
  frontResource?.owner_node !== 'V3StableFrontSocket' ||
  !frontResource?.allowed_writers?.includes('V3FrontTransportCloseoutState::close_for_exec_replacement') ||
  !frontResource?.allowed_readers?.includes('V3StableFrontSocket::close_for_exec_replacement')
) {
  failures.push('Front closeout/flush resource must retain its declared owner');
}
for (const line of read(sourcePath).split('\n')) {
  if (/^\s*use\s+(routecodex_v3_runtime|routecodex_v3_provider)/.test(line)) {
    failures.push(`client SSE transport must not import provider or Runtime code: ${line.trim()}`);
  }
  if (/^\s*use\s+(serde_json|regex)/.test(line)) {
    failures.push(`client SSE transport must not parse the payload: ${line.trim()}`);
  }
}
if (failures.length) {
  console.error('[verify:v3-client-sse-head-commit] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-client-sse-head-commit] ok');

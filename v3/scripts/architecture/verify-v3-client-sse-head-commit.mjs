#!/usr/bin/env node
// Declared ownership and import isolation for the client transport boundary.
// Head commit, keepalive, drain and framing behavior use the existing public
// client_transport_boundary_controlled Rust consumer, not source expressions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourcePath = 'v3/crates/routecodex-v3-server/src/client_sse_transport.rs';
const featureId = 'v3.client_sse_head_commit';
const stepId = 'v3-client-sse-head-commit-01';
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const functionMap = YAML.parse(read('docs/architecture/v3-function-map.yml'));
const mainlineMap = YAML.parse(read('docs/architecture/v3-mainline-call-map.yml'));
const feature = functionMap.features?.find((entry) => entry.feature_id === featureId);
if (feature?.owner_crate !== 'routecodex-v3-server') {
  failures.push('client SSE transport must be owned by routecodex-v3-server');
}
if (!feature?.allowed_paths?.includes(sourcePath)) {
  failures.push('client SSE transport source must belong to the declared owner');
}
if (!feature?.resource_bindings?.includes('v3.front.request_activity_gate')) {
  failures.push('client SSE transport must bind its request activity resource');
}
if (!feature?.mainline_bindings?.includes(stepId)) {
  failures.push('client SSE transport must bind its mainline edge');
}
for (const forbidden of [
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src',
]) {
  if (!feature?.forbidden_paths?.includes(forbidden)) {
    failures.push(`client SSE transport owner must exclude ${forbidden}`);
  }
}
const edge = mainlineMap.chains?.flatMap((chain) => chain.edges ?? [])
  .find((entry) => entry.step_id === stepId);
if (edge?.owner_feature_id !== featureId) {
  failures.push('client SSE transport mainline edge has no matching owner');
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

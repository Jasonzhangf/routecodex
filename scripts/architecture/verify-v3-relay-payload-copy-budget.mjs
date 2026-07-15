#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const paths = {
  response: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  request: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  hooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
  probes: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs',
  design: 'docs/goals/v3-hub-relay-payload-copy-runtime-probes-test-design.md',
};
const text = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
);
const runtime = [text.response, text.request, text.hooks].join('\n');
const failures = [];

function fail(message) {
  failures.push(message);
}

function requireAll(source, owner, phrases) {
  for (const phrase of phrases) {
    if (!source.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbid(source, owner, pattern, label) {
  if (pattern.test(source)) fail(`${owner}: forbidden ${label}`);
}

requireAll(text.response, paths.response, [
  'struct V3HubResponsePayload(Arc<Value>);',
  'Arc::ptr_eq(&context.payload, &self.previous.previous.previous.payload.0)',
  'payload: Arc::clone(&input.previous.previous.payload.0)',
  'V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse',
]);
requireAll(text.request, paths.request, [
  'canonical_context: Arc<Value>',
  'restore_local_context_at_req04',
  'Ok(Some(Arc::clone(&local.canonical_context)))',
  'V3HubRelayRequestHookEvent::Req04LocalContextRestored',
]);
requireAll(text.hooks, paths.hooks, [
  "pub struct V3HubCurrentNodeBorrowedView<'node, T>",
  "value: &'node T",
  'borrow_v3_hub_current_node',
]);
requireAll(text.probes, paths.probes, [
  'relay_json_moves_one_business_payload_through_req04',
  'relay_sse_keeps_one_canonical_payload_without_materializing_stream',
  'local_context_is_retained_until_req04_outcome_release',
  'servertool_roundtrip_uses_one_resp04_context_and_restores_before_req04_hook',
  'canonical_context_shares_finalized_payload',
  'drop(lookup)',
  'drop(outcome)',
]);
requireAll(text.design, paths.design, [
  'unbounded `deep_clone`',
  '`serde_json::to_string`/`from_str`',
  'SSE `collect`',
  'Debug/snapshot payloads',
  'hook planning',
  'does not prove live Relay',
]);

forbid(runtime, 'Relay runtime source', /\b(?:deep_clone|deepClone)\s*\(/, 'unbounded deep copy');
forbid(
  runtime,
  'Relay runtime source',
  /serde_json::(?:to_string|to_vec|to_value)[\s\S]{0,240}serde_json::(?:from_str|from_slice|from_value)/,
  'JSON serialization round-trip clone',
);
forbid(
  runtime,
  'Relay runtime source',
  /(?:sse|stream)[^\n]{0,100}(?:collect\s*::<\s*Vec|collect\s*\(|body_text|full_buffer|materiali[sz]e)/i,
  'full SSE materialization',
);
forbid(
  runtime,
  'Relay runtime source',
  /(?:continuation|request|response|business)[^\n]{0,100}(?:truth|payload)[^\n]{0,100}(?:debug_snapshot|snapshot_payload)|(?:debug_snapshot|snapshot_payload)[^\n]{0,100}(?:truth|payload)/i,
  'Debug/snapshot truth substitution',
);
forbid(
  text.hooks,
  paths.hooks,
  /(?:HookPlan|HookPlanning|hook_plan)[\s\S]{0,240}(?:retained_payload|owned_payload|payload\s*:\s*(?:Value|Arc\s*<\s*Value)|\.clone\s*\(\))/,
  'hook planning payload retention or clone',
);
forbid(
  text.request,
  paths.request,
  /(?:payload|canonical_context)\s*\.clone\s*\(\)/,
  'full request/context clone',
);
forbid(
  text.response,
  paths.response,
  /(?:payload|canonical_context)\s*\.clone\s*\(\)/,
  'full response/context clone',
);

const maps = [
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
for (const path of maps) {
  requireAll(readFileSync(resolve(root, path), 'utf8'), path, [
    'v3.hub_relay_payload_copy_runtime_probes',
    'v3-hub-relay-copy-probe-01',
    'v3-hub-relay-copy-probe-02',
    'v3-hub-relay-copy-probe-03',
    'v3-hub-relay-copy-probe-04',
  ]);
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const script of [
  'test:v3-relay-payload-copy-runtime-probes',
  'verify:v3-relay-payload-copy-budget',
  'test:v3-relay-payload-copy-budget-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) fail(`package.json: missing script ${script}`);
}

if (failures.length > 0) {
  console.error('[verify:v3-relay-payload-copy-budget] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-relay-payload-copy-budget] ok');

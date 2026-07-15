#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const typesPath = 'v3/crates/routecodex-v3-config/src/types.rs';
const validatePath = 'v3/crates/routecodex-v3-config/src/validate.rs';
const hookPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs';
const types = readFileSync(typesPath, 'utf8');
const validate = readFileSync(validatePath, 'utf8');
const hooks = readFileSync(hookPath, 'utf8');
const failures = [];

const nodeCount = (types.match(/Self::V3(?:Hub|Provider|Server)[A-Za-z0-9]+/g) ?? [])
  .filter((value, index, all) => all.indexOf(value) === index)
  .length;
if (nodeCount !== 15) failures.push(`V3HubFixedNode::ALL must own exactly 15 fixed nodes, found ${nodeCount}`);
if (!hooks.includes('V3_HUB_V1_NODE_HOOK_COUNT: usize = V3HubFixedNode::ALL.len() * 2')) {
  failures.push('entry/exit hook count must derive from the closed fixed-node set');
}
if (!hooks.includes("published: &'manifest V3Config05ManifestPublished")) {
  failures.push('Runtime hook registry must consume V3Config05ManifestPublished');
}
if (!hooks.includes("resources: &'manifest BTreeMap<String, V3HubResourceManifest>")) {
  failures.push('Runtime hook resources must borrow the published Manifest registry');
}
const borrowedView = hooks.match(/pub struct V3HubCurrentNodeBorrowedView<'node, T> \{[\s\S]*?\}/)?.[0] ?? '';
if (!borrowedView.includes("value: &'node T") || !hooks.includes('borrow_v3_hub_current_node')) {
  failures.push('large hook payload access must be a current-node scoped borrowed view');
}
if (!validate.includes('may_enter_provider_body: false') || !validate.includes('may_enter_client_body: false')) {
  failures.push('compiled hook resources must be side-channel isolated from provider/client normal payload');
}

const authoringStart = types.indexOf('pub struct V3HubHookAuthoringConfig');
const authoringEnd = types.indexOf('\n}', authoringStart);
const authoring = types.slice(authoringStart, authoringEnd);
for (const field of ['requirement', 'allowed_resources', 'forbidden_resources', 'priority', 'order']) {
  if (!authoring.includes(`pub ${field}:`)) failures.push(`hook authoring must explicitly declare ${field}`);
}
if (/serde\(default\)[\s\S]{0,80}pub (?:allowed_resources|forbidden_resources):/.test(authoring)) {
  failures.push('allowed_resources and forbidden_resources must be explicit authoring declarations');
}

for (const scope of ['Server', 'Listener', 'RoutingGroup', 'Session', 'Request', 'Provider', 'Hook', 'Debug']) {
  if (!types.includes(`    ${scope},`)) failures.push(`missing runtime resource scope ${scope}`);
}
for (const kind of ['Control', 'Continuation', 'Debug', 'Error', 'Snapshot', 'ProviderHealth']) {
  if (!types.includes(`    ${kind},`)) failures.push(`missing side-channel resource kind ${kind}`);
}
if (!hooks.includes('V3HubHookProfile::Servertool')
  || !hooks.includes('V3HubFixedNode::V3HubReqChatProcess04Governed')
  || !hooks.includes('V3HubFixedNode::V3HubRespChatProcess03Governed')) {
  failures.push('servertool profile placement must be closed to ReqChatProcess04/RespChatProcess03');
}
if (!hooks.includes('V3HubHookImplementation::DisabledNoop')) {
  failures.push('optional disabled hooks must project a typed no-op');
}

const forbiddenRuntime = [
  [/std::fs|File::open|read_to_string/, 'Runtime hook registry must not read config files or directories'],
  [/libloading|discover.*hook|dynamic.*hook/i, 'dynamic hook discovery/loading is forbidden'],
  [/serde_json::(?:to_value|from_value|to_string|from_str)/, 'JSON round-trip cloning is forbidden in hook/resource runtime'],
  [/materialize.*sse|collect::<Vec<.*Value/i, 'full SSE/body materialization is forbidden in hook/resource runtime'],
  [/snapshot.*(?:truth|payload).*clone|debug.*(?:truth|payload).*clone/i, 'debug/snapshot copies cannot become live truth'],
];
for (const [pattern, message] of forbiddenRuntime) if (pattern.test(hooks)) failures.push(message);
for (const line of hooks.split('\n')) {
  if (line.includes('.clone(') && !line.includes('hook_id.clone(')) {
    failures.push(`unbounded clone in hook/resource runtime: ${line.trim()}`);
  }
}
if (/serde_json::Value|Arc<Value>|Vec<Value>/.test(hooks)) {
  failures.push('hook/resource declaration registry must not own business payload values');
}

if (failures.length) {
  console.error('[verify:v3-relay-hook-resources] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-relay-hook-resources] ok');

#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';

const rootPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const hookPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs';
const skeletonPaths = [
  rootPath,
  'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_compat_shared.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_01_client_raw.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_inbound_01_raw.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
  hookPath,
];
const hookText = readFileSync(hookPath, 'utf8');
const production = skeletonPaths
  .map((path) => readFileSync(path, 'utf8').replace(/#\[cfg\(test\)\][\s\S]*/, ''))
  .join('\n');
const failures = [];
function rustFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const file = `${dir}/${entry}`;
    if (statSync(file).isDirectory()) {
      if (entry !== 'target') rustFiles(file, output);
    } else if (file.endsWith('.rs')) output.push(file);
  }
  return output;
}

const nodeOwners = {
  V3HubReqInbound01ClientRaw: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_01_client_raw.rs',
  V3HubReqInbound02Normalized: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  V3HubReqContinuation03Classified: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs',
  V3HubReqChatProcess04Governed: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs',
  V3HubReqExecution05Planned: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs',
  V3HubReqTarget06Resolved: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs',
  V3HubReqOutbound07ProviderSemantic: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs',
  ProviderReqCompat06ProviderCompat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  V3ProviderReqOutbound08WirePayload: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs',
  V3ProviderReqOutbound09TransportRequest: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs',
  V3ProviderRespInbound01Raw: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_inbound_01_raw.rs',
  ProviderRespCompat02ProviderCompat: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs',
  V3HubRespInbound02Normalized: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs',
  V3HubRespChatProcess03Governed: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  V3HubRespContinuation04Committed: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  V3HubRespOutbound05ClientSemantic: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  V3ServerRespOutbound06ClientFrame: 'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
};
const nodes = Object.keys(nodeOwners);
const allRust = rustFiles('v3/crates');
for (const node of nodes) {
  if (!production.includes(`pub struct ${node}`)) failures.push(`missing opaque node ${node}`);
  const owners = allRust.filter((file) => new RegExp(`pub\\s+struct\\s+${node}\\b`).test(readFileSync(file, 'utf8')));
  if (owners.length !== 1 || owners[0] !== nodeOwners[node]) {
    failures.push(`opaque node ${node} owner count/path invalid: ${owners.join(',')}`);
  }
}

const builders = [
  'build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01',
  'build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01',
  'build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02',
  'build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03',
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04',
  'build_v3_hub_req_target_06_from_v3_hub_req_execution_05',
  'build_v3_hub_req_outbound_07_from_v3_hub_req_target_06',
  'build_provider_req_compat_06_from_v3_hub_req_outbound_07',
  'build_v3_provider_req_outbound_08_from_provider_req_compat_06',
  'build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08',
  'build_provider_resp_compat_02_from_v3_provider_resp_inbound_01',
  'build_v3_hub_resp_inbound_02_from_provider_resp_compat_02',
  'build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02',
  'build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  'build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
];
for (const builder of builders) {
  const count = (production.match(new RegExp(`pub fn ${builder}\\b`, 'g')) ?? []).length;
  if (count !== 1) failures.push(`adjacent builder ${builder} count=${count}, expected 1`);
}
const conversionBuilders = [...production.matchAll(/pub fn (build_(?:v3_)?[a-z0-9_]+_from_(?:v3_)?[a-z0-9_]+)\b/g)].map((match) => match[1]);
for (const builder of conversionBuilders) if (!builders.includes(builder)) failures.push(`non-adjacent or duplicate builder ${builder}`);

const axes = ['V3HubEntryProtocol', 'V3HubContinuationOwnership', 'V3HubExecutionMode', 'V3HubProviderWireProtocol'];
for (const axis of axes) if (!production.includes(`pub enum ${axis}`)) failures.push(`missing independent axis ${axis}`);
if (/entry_protocol[\s\S]{0,120}(?:Direct|RemoteProviderOwned)|provider_protocol[\s\S]{0,120}RemoteProviderOwned|same_protocol/i.test(production)) {
  failures.push('protocol fact is used to infer execution or continuation ownership');
}
if (/provider_family|model_prefix|starts_with\(/i.test(production)) failures.push('Hub v1 contains provider-specific branch vocabulary');

for (const node of nodes) {
  for (const phase of ['Entry', 'Exit']) {
    const pattern = new RegExp(`static_hook\\s*\\(\\s*V3HubFixedNode::${node}\\s*,\\s*V3HubHookPhase::${phase}\\s*,?\\s*\\)`);
    if (!pattern.test(hookText)) failures.push(`missing static ${phase.toLowerCase()} hook for ${node}`);
  }
}
if (!hookText.includes('static V3_HUB_V1_STATIC_NODE_HOOKS: [V3HubStaticHookSpec; V3_HUB_V1_NODE_HOOK_COUNT]')) failures.push('closed static entry/exit hook table missing');
if (!hookText.includes('V3Config05ManifestPublished')) failures.push('Runtime static hook registry must consume V3Config05ManifestPublished');
if (/read_to_string|std::fs|File::open|config\.v3\.toml/.test(hookText)) failures.push('Runtime hook registry must not read config files');
if (!production.includes('V3HubHookImplementation::NotImplemented')) failures.push('explicit not_implemented implementation missing');
if (!production.includes('V3HubHookImplementation::DisabledNoop')) failures.push('typed optional disabled hook no-op missing');
if (!production.includes('validate_v3_hub_v1_hook_manifest')) failures.push('deterministic startup validation missing');
for (const variant of ['MissingHook', 'DuplicateHook', 'UnknownHook', 'IncompatibleHook']) {
  if (!production.includes(variant)) failures.push(`startup validation missing ${variant}`);
}
if (/std::fs|libloading|discover.*hook|dynamic.*hook/i.test(production)) failures.push('dynamic hook loading/discovery is forbidden');
if (/fallback|default_hook|unwrap_or.*hook/i.test(production)) failures.push('missing-hook fallback is forbidden');
if (/routecodex_v3_provider_responses|reqwest|ResponsesTransport|\.send\(/.test(production)) failures.push('H1 Hub v1 skeleton must not connect Provider network');
if (/pub\s+(?:struct|type)\s+[^\n]*(?:Value|Record)|pub\s+[^\n]*serde_json::Value/.test(production)) failures.push('Hub v1 critical node payload cannot expose bare generic Value/Record DTOs');
if (/SemanticEnvelope|CanonicalPayload|SharedNodeDto/.test(production)) failures.push('Hub v1 cannot collapse distinct nodes into a synonymous shared DTO');
if ((production.match(/V3ServerRespOutbound06ClientFrame/g) ?? []).length < 2) failures.push('sole response exit node missing');
if (/V3ServerRespOutbound0[7-9]|SecondaryResponse|AlternateResponse/.test(production)) failures.push('second response exit is forbidden');
for (const invariant of ['allowed_resources', 'forbidden_resources', 'V3HubHookRequirement', 'V3HubHookProfile::Servertool', 'may_enter_provider_body', 'may_enter_client_body', 'borrow_v3_hub_current_node']) {
  if (!production.includes(invariant)) failures.push(`missing hook/resource invariant ${invariant}`);
}
if (/serde_json::(?:to_value|from_value|to_string|from_str)|materialize.*sse|snapshot.*live/i.test(hookText)) {
  failures.push('resource/hook registry contains forbidden JSON round-trip, SSE materialization, or snapshot live-truth pattern');
}

if (failures.length) {
  console.error('[verify:v3-static-hook-registry] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-static-hook-registry] ok');

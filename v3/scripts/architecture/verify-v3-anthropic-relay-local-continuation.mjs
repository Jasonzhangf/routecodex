#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const paths = {
  runtime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  codec: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  store: 'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
  tests: 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_local_continuation_integration.rs',
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  kernel: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  callMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  manifest: 'docs/architecture/manifests/v3.anthropic_relay.local_continuation.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-anthropic-relay-local-continuation.md',
  html: 'docs/architecture/wiki/v3-anthropic-relay-local-continuation.html',
  design: 'docs/goals/v3-anthropic-relay-local-continuation-test-design.md',
};
const text = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
const manifest = YAML.parse(text.manifest);
const failures = [];
const feature = 'v3.anthropic_relay_local_continuation_integration';
const nodes = [
  'V3LocalContResp01ChatProcessGoverned',
  'V3LocalContResp02ImmutableSaved',
  'V3LocalContReq03ExactScopeLoaded',
  'V3LocalContReq04RestoredGoverned',
];

if (manifest.lifecycle_id !== 'v3.anthropic_relay.local_continuation') failures.push('manifest lifecycle_id mismatch');
if (manifest.owner_feature_id !== feature) failures.push('manifest owner_feature_id mismatch');
if (JSON.stringify(manifest.node_ids) !== JSON.stringify(nodes)) failures.push('manifest node order mismatch');
if (!Array.isArray(manifest.edges) || manifest.edges.length !== 3) failures.push('manifest must have three adjacent edges');
for (let index = 0; index < 3; index += 1) {
  const edge = manifest.edges?.[index] ?? {};
  const step = `v3-localcont-0${index + 1}`;
  if (edge.step_id !== step || edge.from_node !== nodes[index] || edge.to_node !== nodes[index + 1] || edge.status !== 'anchored') failures.push(`manifest edge ${step} mismatch`);
}
for (const owner of ['functionMap', 'callMap', 'verificationMap']) requireText(owner, feature);
for (const step of ['v3-localcont-01', 'v3-localcont-02', 'v3-localcont-03']) requireText('callMap', step);
for (const phrase of [
  'resource_id: v3.continuation.local_context_truth',
  'commit_or_release_local_continuation',
  'execute_v3_anthropic_relay_runtime_with_local_continuation',
  'binding_status: anchored',
]) requireText('resourceMap', phrase);

for (const phrase of [
  'find_anthropic_tool_result_ids(&input.payload)?',
  'with_local_context_from_req04_store(',
  'run_from_normalized(',
  'hooks.commit(resp03)?',
  'commit_or_release_local_continuation(',
  'V3LocalContinuationTerminalOutcome::NonTerminal',
  'store.release_in_scope(&local.scope.local_key(), context_id)',
]) requireText('runtime', phrase);
const resp04CommitBindingCount = text.runtime.match(/commit_or_release_local_continuation\(/g)?.length ?? 0;
if (resp04CommitBindingCount !== 2) failures.push(`runtime expected one Resp04 commit call plus one owner definition, found ${resp04CommitBindingCount}`);
requireOrder('runtime', [
  'with_local_context_from_req04_store(',
  'run_from_normalized(',
  'build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(',
]);
for (const phrase of [
  'V3LocalContinuationEntryProtocol::Anthropic',
  'V3LocalContinuationSaveBoundary::Resp04',
  'V3LocalContinuationRestoreOwner::RouteCodexLocal',
  'AlreadyCommitted',
  'ScopeMismatch',
  'Expired',
]) requireText('store', phrase);
for (const phrase of [
  'json_two_turn_save_restore_order_and_terminal_release',
  'sse_first_turn_and_json_second_turn_share_the_same_immutable_lifecycle',
  'scope_mismatch_fails_before_provider_send_and_preserves_saved_truth',
  'provider_error_after_restore_does_not_release_or_project_success',
  'multiple_pending_tool_calls_restore_one_canonical_context_and_release_all_aliases',
]) requireText('tests', phrase);
for (const node of nodes) requireText('wiki', node);
for (const node of nodes) requireText('html', node);
for (const phrase of ['CONTROLLED JSON/SSE VERIFIED', 'implementation plan', 'test design', 'machine manifest']) requireText('html', phrase);

forbid('runtime', [/fallback/i, /required_action/i, /restore_at_req04\s*\(/, /history[_ -]?repair|context[_ -]?rebuild/i]);
forbid('codec', [/metadata_center|debug_snapshot|continuation_owner|store_key/i, /unwrap_or_default\s*\(/]);
forbid('server', [/V3AnthropicRelayLocalContinuationState|commit_or_release_local_continuation|restore_at_req04/]);
forbid('kernel', [/V3AnthropicRelayLocalContinuationState|commit_or_release_local_continuation/]);

if (failures.length) {
  console.error('[verify:v3-anthropic-relay-local-continuation] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-anthropic-relay-local-continuation] ok');

function requireText(owner, phrase) {
  if (!text[owner].includes(phrase)) failures.push(`${paths[owner]}: missing ${phrase}`);
}
function requireOrder(owner, phrases) {
  let cursor = 0;
  for (const phrase of phrases) {
    const index = text[owner].indexOf(phrase, cursor);
    if (index < 0) { failures.push(`${paths[owner]}: missing or reordered ${phrase}`); return; }
    cursor = index + phrase.length;
  }
}
function forbid(owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text[owner])) failures.push(`${paths[owner]}: forbidden ${pattern}`);
}

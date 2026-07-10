import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const directPath = path.join(root, 'src/server/runtime/http-server/direct-passthrough-payload.ts');
const providerPath = path.join(root, 'src/providers/core/runtime/responses-provider.ts');
const bridgePath = path.join(root, 'src/modules/llmswitch/bridge/native-exports.ts');
const retiredNativeTsPath = path.join(root, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-policy-semantics.ts');
const rustPath = path.join(root, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');

for (const abs of [directPath, providerPath, bridgePath, rustPath]) {
  if (!fs.existsSync(abs)) {
    failures.push(`missing required file: ${path.relative(root, abs)}`);
  }
}
if (fs.existsSync(retiredNativeTsPath)) {
  failures.push(`retired production native TS bridge must stay deleted: ${path.relative(root, retiredNativeTsPath)}`);
}

const directSource = fs.readFileSync(directPath, 'utf8');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const nativeTsSource = '';
const rustSource = fs.readFileSync(rustPath, 'utf8');

for (const forbidden of [
  'validateResponsesDirectToolShapeContractNative',
  'buildResponsesDirectPassthroughBodyNative',
  'build_responses_direct_passthrough_body_json',
  'validate_responses_direct_tool_shape_contract_json',
  'resolveResponsesDirectPayloadNative',
  'resolve_responses_direct_payload_json',
  'applyResponsesDirectRouteParamsOverrideNative',
  'apply_responses_direct_route_params_override_json',
]) {
  if (directSource.includes(forbidden) || providerSource.includes(forbidden) || bridgeSource.includes(forbidden) || nativeTsSource.includes(forbidden) || rustSource.includes(forbidden)) {
    failures.push(`direct passthrough must not retain body builder/raw replay/runtime validator interface: ${forbidden}`);
  }
}

for (const expected of [
  'evaluateResponsesDirectRouteDecisionNative',
  'evaluate_responses_direct_route_decision_json',
  'has_declared_apply_patch_tool_json',
]) {
  if (!directSource.includes(expected) && !providerSource.includes(expected) && !bridgeSource.includes(expected) && !nativeTsSource.includes(expected) && !rustSource.includes(expected)) {
    failures.push(`missing direct route decision/apply_patch symbol mention: ${expected}`);
  }
}

if (directSource.includes('evaluateResponsesDirectRouteDecisionNative') || directSource.includes('evaluateDirectRouteDecision')) {
  failures.push('direct passthrough helper must not call native direct decision as provider-wire preflight');
}
if (!bridgeSource.includes('hasDeclaredApplyPatchToolNative')) {
  failures.push('host native exports must expose hasDeclaredApplyPatchToolNative');
}
if (!bridgeSource.includes('evaluateResponsesDirectRouteDecisionNative')) {
  failures.push('host native exports must expose evaluateResponsesDirectRouteDecisionNative');
}
if (!rustSource.includes('has_declared_apply_patch_tool_json')) {
  failures.push('Rust NAPI must export has_declared_apply_patch_tool_json');
}
if (!rustSource.includes('evaluate_responses_direct_route_decision_json')) {
  failures.push('Rust NAPI must export evaluate_responses_direct_route_decision_json');
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-rust-first] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-rust-first] ok');
console.log('- checked Rust exports, TS bridge, and direct/provider callsites');

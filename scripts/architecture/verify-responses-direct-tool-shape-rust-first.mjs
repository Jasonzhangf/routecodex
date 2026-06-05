import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const directPath = path.join(root, 'src/server/runtime/http-server/direct-passthrough-payload.ts');
const providerPath = path.join(root, 'src/providers/core/runtime/responses-provider.ts');
const bridgePath = path.join(root, 'src/modules/llmswitch/bridge/native-exports.ts');
const nativeTsPath = path.join(root, 'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.ts');
const rustPath = path.join(root, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');

for (const abs of [directPath, providerPath, bridgePath, nativeTsPath, rustPath]) {
  if (!fs.existsSync(abs)) {
    failures.push(`missing required file: ${path.relative(root, abs)}`);
  }
}

const directSource = fs.readFileSync(directPath, 'utf8');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const nativeTsSource = fs.readFileSync(nativeTsPath, 'utf8');
const rustSource = fs.readFileSync(rustPath, 'utf8');

for (const expected of [
  'validateResponsesDirectToolShapeContractNative',
  'buildResponsesDirectPassthroughBodyNative',
  'build_responses_direct_passthrough_body_json',
  'evaluateDirectRouteDecision',
  'evaluateResponsesDirectRouteDecisionNative',
  'evaluate_responses_direct_route_decision_json',
  'has_declared_apply_patch_tool_json',
  'resolveResponsesDirectPayloadNative',
  'resolve_responses_direct_payload_json',
]) {
  if (!directSource.includes(expected) && !providerSource.includes(expected) && !bridgeSource.includes(expected) && !nativeTsSource.includes(expected) && !rustSource.includes(expected)) {
    failures.push(`missing Rust-first direct tool-shape symbol mention: ${expected}`);
  }
}

if (!directSource.includes('resolveResponsesDirectPayloadNative')) {
  failures.push('direct passthrough raw replay must call resolveResponsesDirectPayloadNative');
}
if (!directSource.includes('evaluateResponsesDirectRouteDecisionNative')) {
  failures.push('direct passthrough helper must call evaluateResponsesDirectRouteDecisionNative');
}
if (!providerSource.includes('validateResponsesDirectToolShapeContractNative')) {
  failures.push('responses provider must call validateResponsesDirectToolShapeContractNative');
}
if (!providerSource.includes('buildResponsesDirectPassthroughBodyNative')) {
  failures.push('responses provider must call buildResponsesDirectPassthroughBodyNative');
}
if (!nativeTsSource.includes('buildResponsesDirectPassthroughBodyWithNative')) {
  failures.push('native TS bridge must expose buildResponsesDirectPassthroughBodyWithNative');
}
if (!nativeTsSource.includes('hasDeclaredApplyPatchToolWithNative')) {
  failures.push('native TS bridge must expose hasDeclaredApplyPatchToolWithNative');
}
if (!nativeTsSource.includes('evaluateResponsesDirectRouteDecisionWithNative')) {
  failures.push('native TS bridge must expose evaluateResponsesDirectRouteDecisionWithNative');
}
if (!nativeTsSource.includes('resolveResponsesDirectPayloadWithNative')) {
  failures.push('native TS bridge must expose resolveResponsesDirectPayloadWithNative');
}
if (!rustSource.includes('build_responses_direct_passthrough_body_json')) {
  failures.push('Rust NAPI must export build_responses_direct_passthrough_body_json');
}
if (!rustSource.includes('has_declared_apply_patch_tool_json')) {
  failures.push('Rust NAPI must export has_declared_apply_patch_tool_json');
}
if (!rustSource.includes('evaluate_responses_direct_route_decision_json')) {
  failures.push('Rust NAPI must export evaluate_responses_direct_route_decision_json');
}
if (!rustSource.includes('resolve_responses_direct_payload_json')) {
  failures.push('Rust NAPI must export resolve_responses_direct_payload_json');
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-rust-first] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-rust-first] ok');
console.log('- checked Rust exports, TS bridge, and direct/provider callsites');

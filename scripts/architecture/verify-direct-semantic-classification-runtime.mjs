import fs from 'node:fs';

// feature_id: hub.direct_semantic_classification
const files = {
  config: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs',
  registry: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_registry.rs',
  classification: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_semantic_classification.rs',
  request: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_model_hooks.rs',
  response: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_response_action.rs',
  host: 'src/modules/llmswitch/bridge/direct-route-model-hooks-host.ts',
  pipeline: 'src/server/runtime/http-server/router-direct-pipeline.ts',
  serverIndex: 'src/server/runtime/http-server/index.ts',
  selectionTypes: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/types.rs',
  selection: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs',
  route: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs',
  forwarder: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs',
  exports: 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
};
const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]),
);
const classificationRuntime = source.classification.split('#[cfg(test)]', 1)[0] ?? source.classification;
const failures = [];

for (const required of [
  'normalize_model_direct_semantic',
  'direct_semantics',
  'direct_semantic',
]) {
  if (!source.config.includes(required)) {
    failures.push(`${files.config}: missing config compiler symbol ${required}`);
  }
}
for (const required of [
  'enum DirectSemanticClass',
  'struct ConfigDirect01AuthoringPolicy',
  'struct ConfigDirect02ValidatedPolicy',
  'struct VrDirect03ResolvedSemantics',
  'struct DirectReq04ProjectionPlan',
  'struct DirectResp05ProjectionPlan',
  'resolve_direct_semantic_classification',
  'build_direct_req_04_projection_plan',
  'build_direct_resp_05_projection_plan',
]) {
  if (!source.classification.includes(required)) {
    failures.push(`${files.classification}: missing typed lifecycle symbol ${required}`);
  }
}
for (const required of [
  '"directSemantic"',
  'profile.direct_semantic',
]) {
  if (!source.registry.includes(required)) {
    failures.push(`${files.registry}: missing real-target policy projection ${required}`);
  }
}
for (const required of [
  'resolvedSemantics',
  'direct request projector requires resolvedSemantics',
]) {
  if (!source.request.includes(required)) {
    failures.push(`${files.request}: missing resolved-contract request projection ${required}`);
  }
}
for (const required of [
  'resolvedSemantics',
  'direct response projector requires resolvedSemantics',
  'passthrough',
]) {
  if (!source.response.includes(required)) {
    failures.push(`${files.response}: missing resolved-contract response projection ${required}`);
  }
}
for (const required of [
  'resolveDirectSemanticClassificationNative',
  'planDirectRouteRequestHooksNative',
]) {
  if (!source.host.includes(required) || !source.pipeline.includes(required)) {
    failures.push(`direct semantic host bridge missing ${required}`);
  }
}
for (const required of [
  'route_thinking: Option<String>',
  'with_route_thinking',
]) {
  if (!source.selectionTypes.includes(required)) {
    failures.push(`${files.selectionTypes}: missing SelectionResult route thinking contract ${required}`);
  }
}
for (const required of [
  'with_route_thinking(pool.thinking.clone())',
]) {
  if (!source.selection.includes(required)) {
    failures.push(`${files.selection}: missing RoutePoolTier.thinking to SelectionResult.route_thinking bridge ${required}`);
  }
}
for (const required of [
  '"routeThinking"',
  'selection.route_thinking',
]) {
  if (!source.route.includes(required)) {
    failures.push(`${files.route}: missing selected target routeThinking projection ${required}`);
  }
}
for (const required of [
  'routeThinking: target.routeThinking',
  'directSemantic: target.directSemantic',
]) {
  if (!source.serverIndex.includes(required)) {
    failures.push(`${files.serverIndex}: missing VR real-target direct semantic projection ${required}`);
  }
}
if (/routeParams[^\n]*(thinking|reasoning_effort|reasoningEffort)/u.test(classificationRuntime)) {
  failures.push(`${files.classification}: resolver must not read route thinking from routeParams`);
}
if (!source.exports.includes('"resolveDirectSemanticClassificationJson"')) {
  failures.push(`${files.exports}: missing native resolver export`);
}

for (const [label, text] of [
  [files.host, source.host],
  [files.pipeline, source.pipeline],
  [files.serverIndex, source.serverIndex],
]) {
  for (const forbidden of [
    /semanticClass\s*===/u,
    /semanticClass\s*!==/u,
    /switch\s*\([^)]*semanticClass/u,
    /directSemantic\s*===/u,
    /directSemantic\s*!==/u,
    /MetadataCenter[^;\n]*(directSemantic|semanticClass|direct\.semantic_policy)/u,
  ]) {
    if (forbidden.test(text)) {
      failures.push(`${label}: TS semantic owner residue ${forbidden}`);
    }
  }
}

for (const forbidden of [
  'directSemantic',
  'direct_semantic',
  'semanticClass',
  'semantic_class',
]) {
  if (source.forwarder.includes(forbidden)) {
    failures.push(`${files.forwarder}: forwarder must not own direct policy (${forbidden})`);
  }
}

for (const forbidden of [
  'payloadChanged',
  'providerName',
  'providerType',
]) {
  if (source.response.includes(forbidden)) {
    failures.push(`${files.response}: response projector must not infer semantic class from ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:direct-semantic-classification-runtime] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:direct-semantic-classification-runtime] ok');

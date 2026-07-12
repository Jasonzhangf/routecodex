import fs from 'node:fs';

// feature_id: hub.router_direct_model_observation_effect_plan
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-model-hooks-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_model_hooks.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  "key: 'clientModelId'",
  "key: 'assignedModelId'",
  'direct route: original client model before model override',
  'direct route: provider-assigned model after override',
  'const metadataCarrier =',
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS observation-plan residue ${residue}`);
if (!ts.includes('planDirectRouteModelObservationEffectsNative')) failures.push(`${tsPath}: missing native observation effect consumption`);
if (!host.includes('planDirectRouteModelObservationEffectsJson')) failures.push(`${hostPath}: missing narrow native binding`);
for (const required of ['plan_model_observation_effects', 'clientModelId', 'assignedModelId', 'provider_observation']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust observation effect contract ${required}`);
}
if (failures.length) {
  console.error('[verify:direct-route-model-observation-effect-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-model-observation-effect-rust-only] ok');

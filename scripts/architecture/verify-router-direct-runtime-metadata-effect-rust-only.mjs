import fs from 'node:fs';

// feature_id: hub.router_direct_runtime_metadata_effect_plan
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-runtime-metadata-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_runtime_metadata_projection.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  'propagatePipelineDryRunControl(input.pipelineMetadata',
  'if (runtimeMetadata) {',
  "runtimeMetadataPlan.action ?? 'attach'",
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS runtime metadata plan residue ${residue}`);
if (!ts.includes('planRouterDirectRuntimeMetadataEffectNative')) failures.push(`${tsPath}: missing Rust action consumption`);
if (!host.includes('planRouterDirectRuntimeMetadataEffectJson')) failures.push(`${hostPath}: missing narrow host capability`);
for (const required of ['plan_router_direct_runtime_metadata_effect', 'runtimeMetadataPresent', '"action":"skip"', '"action":"attach"']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust effect contract ${required}`);
}
if (failures.length) {
  console.error('[verify:router-direct-runtime-metadata-effect-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:router-direct-runtime-metadata-effect-rust-only] ok');

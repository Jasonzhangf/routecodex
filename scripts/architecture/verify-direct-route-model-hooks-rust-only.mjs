import fs from 'node:fs';

// feature_id: hub.direct_route_model_hooks
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-model-hooks-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_model_hooks.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  'function applyDirectRouteHooks',
  'function rewriteDirectResponseModelCompat',
  'function rewriteSseFrameClientModel',
  'function readThinkingLevel',
  'function resolveRouteThinkingLevel',
  'function ensureDirectClientSseHeaders',
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS semantic residue ${residue}`);
for (const required of [
  'planDirectRouteRequestHooksNative',
  'rewriteDirectRouteResponseModelNative',
  'rewriteDirectRouteSseFrameNative',
  'projectDirectRouteSseHeadersNative',
]) {
  if (!ts.includes(required)) failures.push(`${tsPath}: missing native delegation ${required}`);
  if (!host.includes(required)) failures.push(`${hostPath}: missing narrow host ${required}`);
}
for (const required of [
  'planDirectRouteRequestHooksJson',
  'rewriteDirectRouteResponseModelJson',
  'rewriteDirectRouteSseFrameJson',
  'projectDirectRouteSseHeadersJson',
]) if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust owner ${required}`);
if (failures.length) {
  console.error('[verify:direct-route-model-hooks-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-model-hooks-rust-only] ok');

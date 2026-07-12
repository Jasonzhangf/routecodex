import fs from 'node:fs';

// feature_id: hub.router_direct_response_error_projection
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-response-error-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_response_error.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  'function isRouterDirectRecoverableResponseStatus',
  'function buildRouterDirectResponseError(',
  'status === 401 || status === 402',
  'code = `HTTP_${status}`',
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS semantic residue ${residue}`);
if (!ts.includes('planDirectRouteResponseErrorNative')) failures.push(`${tsPath}: missing native planner consumption`);
if (!host.includes('planDirectRouteResponseErrorJson')) failures.push(`${hostPath}: missing narrow native host binding`);
for (const required of ['planDirectRouteResponseErrorJson', 'shouldRaise', '401 | 402 | 403 | 429']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust owner contract ${required}`);
}
if (failures.length) {
  console.error('[verify:direct-route-response-error-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-response-error-rust-only] ok');

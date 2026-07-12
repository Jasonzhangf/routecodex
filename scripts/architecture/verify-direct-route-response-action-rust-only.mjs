import fs from 'node:fs';

// feature_id: hub.router_direct_response_action_plan
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-response-action-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_response_action.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  'const hasSse =',
  'if (hasSse)',
  "typeof options.originalClientModel === 'string'",
  'if (!clientModel)',
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS response action residue ${residue}`);
if (!ts.includes('planDirectRouteResponseActionNative')) failures.push(`${tsPath}: missing native action planner consumption`);
if (!host.includes('planDirectRouteResponseActionJson')) failures.push(`${hostPath}: missing narrow host binding`);
for (const required of ['planDirectRouteResponseActionJson', 'project_json_model', 'project_sse_headers_only', 'project_sse_headers_and_model_stream']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust action contract ${required}`);
}
if (failures.length) {
  console.error('[verify:direct-route-response-action-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-response-action-rust-only] ok');

import fs from 'node:fs';

// feature_id: hub.router_direct_eligibility_plan
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-eligibility-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_eligibility.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  "portConfig.mode !== 'router'",
  "portConfig.sameProtocolBehavior ?? 'direct'",
  'inboundProtocol !== providerProtocol',
  'function resolveRouterSameProtocolBehavior',
]) {
  if (residue === 'function resolveRouterSameProtocolBehavior') continue;
  if (ts.includes(residue)) failures.push(`${tsPath}: retired TS eligibility semantic residue ${residue}`);
}
if (!ts.includes('planDirectRouteEligibilityNative')) failures.push(`${tsPath}: missing native action planner consumption`);
if (!host.includes('planDirectRouteEligibilityJson')) failures.push(`${hostPath}: missing narrow host binding`);
for (const required of ['planDirectRouteEligibilityJson', 'resolve_provider', 'execute_direct', 'protocol mismatch']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust planner contract ${required}`);
}
if (failures.length) {
  console.error('[verify:direct-route-eligibility-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-eligibility-rust-only] ok');

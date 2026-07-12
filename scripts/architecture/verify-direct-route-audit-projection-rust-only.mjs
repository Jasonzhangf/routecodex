import fs from 'node:fs';

// feature_id: hub.router_direct_audit_projection
const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-route-audit-projection-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_route_audit_projection.rs';
const ts = fs.readFileSync(tsPath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');
const rust = fs.readFileSync(rustPath, 'utf8');
const failures = [];
for (const residue of [
  "const OBSERVABLE_FIELDS",
  "['model', 'reasoning', 'thinking', 'max_tokens']",
  'ctx.observedFields.push',
]) if (ts.includes(residue)) failures.push(`${tsPath}: retired TS audit semantic residue ${residue}`);
if (!ts.includes('projectDirectRouteAuditFieldsNative')) failures.push(`${tsPath}: missing native projection consumption`);
if (!host.includes('projectDirectRouteAuditFieldsJson')) failures.push(`${hostPath}: missing narrow host binding`);
for (const required of ['projectDirectRouteAuditFieldsJson', 'OBSERVABLE_FIELDS', 'observedFields']) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust projection contract ${required}`);
}
if (failures.length) {
  console.error('[verify:direct-route-audit-projection-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-route-audit-projection-rust-only] ok');

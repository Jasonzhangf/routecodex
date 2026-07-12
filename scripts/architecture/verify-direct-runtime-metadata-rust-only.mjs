import fs from 'node:fs';
import path from 'node:path';

// feature_id: hub.direct_runtime_metadata_projection
const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_DIRECT_RUNTIME_METADATA_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_DIRECT_RUNTIME_METADATA_SCAN_ROOT)
  : root;
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(scanRoot, relPath), 'utf8');
}

const shellPath = 'src/server/runtime/http-server/direct-runtime-metadata.ts';
const hostPath = 'src/modules/llmswitch/bridge/direct-runtime-metadata-host.ts';
const rustPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_runtime_metadata_projection.rs';
const shell = read(shellPath);
const host = read(hostPath);
const rust = read(rustPath);

for (const pattern of [
  /DIRECT_PROVIDER_RUNTIME_METADATA_KEYS/u,
  /ROUTER_DIRECT_ROUTE_METADATA_PRIMITIVE_KEYS/u,
  /ROUTER_DIRECT_RUNTIME_CONTROL_KEYS/u,
  /\bcopyPrimitiveKey\b/u,
  /\bprojectRouteMetadataCenterSnapshot\b/u,
  /\bpropagatePipelineDryRunControl\b/u,
  /\bfor\s*\(/u,
]) {
  if (pattern.test(shell)) failures.push(`${shellPath}: TS semantic projection residue ${pattern}`);
}
for (const required of [
  'buildRouterDirectRouteMetadataNative(input)',
  'buildDirectProviderRuntimeMetadataNative(input)',
]) {
  if (!shell.includes(required)) failures.push(`${shellPath}: missing thin native delegation ${required}`);
}
for (const required of [
  'buildRouterDirectRouteMetadataJson',
  'buildDirectProviderRuntimeMetadataJson',
  'stringifyGraphForNative',
]) {
  if (!host.includes(required)) failures.push(`${hostPath}: missing host transport surface ${required}`);
}
for (const forbidden of ['ROUTE_PRIMITIVE_KEYS', 'RUNTIME_KEYS', 'CONTROL_KEYS', 'copy_dry_run']) {
  if (host.includes(forbidden)) failures.push(`${hostPath}: Rust projection semantic ${forbidden} leaked into TS host`);
}
for (const required of [
  'const ROUTE_PRIMITIVE_KEYS',
  'const RUNTIME_KEYS',
  'const CONTROL_KEYS',
  'fn copy_dry_run',
  'buildRouterDirectRouteMetadataJson',
  'buildDirectProviderRuntimeMetadataJson',
]) {
  if (!rust.includes(required)) failures.push(`${rustPath}: missing Rust owner evidence ${required}`);
}

if (failures.length > 0) {
  console.error('[verify:direct-runtime-metadata-rust-only] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:direct-runtime-metadata-rust-only] ok');

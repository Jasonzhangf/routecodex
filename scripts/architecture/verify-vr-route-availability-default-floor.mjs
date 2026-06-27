import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const FUNCTION_MAP = 'docs/architecture/function-map.yml';
const MAINLINE_MAP = 'docs/architecture/mainline-call-map.yml';
const VR_MAINLINE_DOC = 'docs/architecture/wiki/virtual-router-route-availability-mainline-source.md';
const RUST_SELECTION =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs';
const RUST_FORWARDER =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs';
const TS_CORE_UTILS =
  'src/server/runtime/http-server/executor/request-executor-core-utils.ts';
const TS_HTTP_INDEX =
  'src/server/runtime/http-server/index.ts';

const failures = [];

const functionMap = read(FUNCTION_MAP);
if (!functionMap.includes('feature_id: vr.route_availability_floor')) {
  failures.push('function-map: missing feature_id vr.route_availability_floor');
}
if (!functionMap.includes('verify:vr-route-availability-default-floor')) {
  failures.push('function-map: vr.route_availability_floor missing verify:vr-route-availability-default-floor gate');
}
if (!functionMap.includes('default-pool last-provider floor')) {
  failures.push('function-map: missing explicit default-pool last-provider floor note');
}

const mainline = read(MAINLINE_MAP);
for (const token of [
  'chain_id: vr.route_availability.mainline',
  'owner_doc: docs/architecture/wiki/virtual-router-route-availability-mainline-source.md',
  'owner_feature_id: vr.route_availability_floor',
  'owner_feature_id: virtual_router.primary_exhausted_to_default_pool',
  'step_id: vra-02',
  'step_id: vra-03',
]) {
  if (!mainline.includes(token)) {
    failures.push(`mainline-call-map: missing ${token}`);
  }
}

const doc = read(VR_MAINLINE_DOC);
const docLower = doc.toLowerCase();
for (const token of [
  'default-pool last provider',
  'ordinary route-pool filtering',
  'forwarder empty',
  'must not project `PROVIDER_NOT_AVAILABLE` while a default-pool last provider still exists',
]) {
  if (!docLower.includes(token.toLowerCase())) {
    failures.push(`vr mainline doc: missing phrase ${JSON.stringify(token)}`);
  }
}

const rustSelection = read(RUST_SELECTION);
for (const token of [
  'evaluate_singleton_route_pool_exhaustion',
  'build_provider_not_available_error',
  'forwarder_no_available_target',
]) {
  if (!rustSelection.includes(token)) {
    failures.push(`selection.rs: missing ${token}`);
  }
}

const rustForwarder = read(RUST_FORWARDER);
if (!rustForwarder.includes('ERR_FORWARDER_NO_AVAILABLE_TARGET')) {
  failures.push('forwarder.rs: missing ERR_FORWARDER_NO_AVAILABLE_TARGET');
}

const tsCoreUtils = read(TS_CORE_UTILS);
for (const token of [
  'resolveDefaultTierAvailableForErrorErr05',
  'resolvePrimaryExhaustedPlan',
]) {
  if (!tsCoreUtils.includes(token)) {
    failures.push(`request-executor-core-utils.ts: missing ${token}`);
  }
}

if (tsCoreUtils.includes('function resolveDefaultPoolLastProvider') || tsCoreUtils.includes('defaultPoolLastProvider')) {
  failures.push('request-executor-core-utils.ts: unexpected local default-pool-last-provider helper detected');
}

const tsHttpIndex = read(TS_HTTP_INDEX);
if (!tsHttpIndex.includes('resolvePrimaryExhaustedPlan')) {
  failures.push('http-server/index.ts: missing resolvePrimaryExhaustedPlan consumer');
}

if (failures.length > 0) {
  console.error('[verify:vr-route-availability-default-floor] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:vr-route-availability-default-floor] ok');

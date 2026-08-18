#!/usr/bin/env node
// Phase 0 admission contract and baseline red gate.
// This gate is intentionally read-only: it proves the design is registered and
// proves the current M8 baseline is still missing the real runtime path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const admissionPath = path.join(root, 'contracts/real-runtime-admission.manifest.json');
const resourceMapPath = path.join(root, '.appsdk/maps/resource-map.json');
const functionMapPath = path.join(root, '.appsdk/maps/function-map.json');
const mainlineMapPath = path.join(root, '.appsdk/maps/mainline-call-map.json');
const moduleMapPath = path.join(root, '.appsdk/maps/module-registry.json');
const verificationMapPath = path.join(root, '.appsdk/maps/verification-map.json');
const cargoPath = path.join(root, 'Cargo.toml');
const runtimePath = path.join(root, 'crates/routecodex-v4-runtime/src/lib.rs');
const providerPath = path.join(root, 'crates/routecodex-v4-provider/src/lib.rs');
const serverPath = path.join(root, 'crates/routecodex-v4-server/src/lib.rs');
const routerPath = path.join(root, 'crates/routecodex-v4-router/src/lib.rs');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readText = (file) => fs.readFileSync(file, 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function validateContract(input) {
  const failures = [];
  const requiredEntrypoints = new Set([
    'GET /health json',
    'GET /v1/models json',
    'POST /v1/responses json',
    'POST /v1/responses sse',
  ]);
  const entrypoints = new Set((input.admission.entrypoints ?? []).map(
    (entry) => `${entry.method} ${entry.path} ${entry.mode}`,
  ));
  for (const entrypoint of requiredEntrypoints) {
    if (!entrypoints.has(entrypoint)) failures.push(`missing entrypoint: ${entrypoint}`);
  }
  if (input.admission.status !== 'design') failures.push('admission contract must remain status=design in phase 0');
  if (input.admission.runtime_identity !== 'rccv4') failures.push('runtime identity must be rccv4');
  if (input.admission.binary_package !== 'routecodex-v4-runtime-bin') {
    failures.push('binary package must be routecodex-v4-runtime-bin');
  }
  if (input.admission.cold_start?.source !== 'v4_compiled_manifest') {
    failures.push('cold start must name v4_compiled_manifest');
  }
  if (input.admission.cold_start?.digest_required !== true || input.admission.cold_start?.drift !== 'fail_fast') {
    failures.push('cold start digest/drift contract is incomplete');
  }
  const requiredGates = new Set(input.admission.required_gates ?? []);
  const registeredGates = new Set((input.verification.gates ?? []).map((gate) => gate.gate_id));
  for (const gate of requiredGates) {
    if (!registeredGates.has(gate)) failures.push(`required gate is not registered: ${gate}`);
  }
  const requiredModules = ['governance', 'runtime', 'provider', 'protocol_plugins', 'router', 'server'];
  for (const moduleName of requiredModules) {
    if (!input.admission.modules?.[moduleName]) failures.push(`missing module binding: ${moduleName}`);
  }
  const resourceIds = new Set((input.resources.resources ?? []).map((resource) => resource.resource_id));
  for (const resourceId of [
    'v4.runtime.admission_manifest',
    'v4.runtime.compiled_manifest',
    'v4.runtime.binary_identity',
    'v4.provider.real_transport',
    'v4.server.http_listener',
  ]) {
    if (!resourceIds.has(resourceId)) failures.push(`resource map missing: ${resourceId}`);
  }
  const functionIds = new Set((input.functions.functions ?? []).map((entry) => entry.function_id));
  if (!functionIds.has('v4.runtime.independent_admission')) {
    failures.push('function map missing: v4.runtime.independent_admission');
  }
  if (!functionIds.has('v4.runtime.binary_cold_start')) {
    failures.push('function map missing: v4.runtime.binary_cold_start');
  }
  const moduleIds = new Set((input.modules.modules ?? []).map((module) => module.module_id));
  if (!moduleIds.has('routecodex-v4-runtime-bin')) failures.push('module registry missing routecodex-v4-runtime-bin');
  const pendingEdges = new Set((input.mainline.edges ?? [])
    .filter((edge) => edge.caller_feature_id === 'v4.runtime.independent_admission')
    .map((edge) => `${edge.from}->${edge.to}`));
  for (const edge of [
    'routecodex-v4-runtime-bin->routecodex-v4-server',
    'routecodex-v4-runtime->routecodex-v4-provider',
    'routecodex-v4-provider->routecodex-v4-runtime',
    'routecodex-v4-runtime->routecodex-v4-server',
  ]) {
    if (!pendingEdges.has(edge)) failures.push(`mainline map missing admission edge: ${edge}`);
  }
  const fixtures = input.admission.provider_fixtures ?? [];
  if (fixtures.some((fixture) => fixture.source.includes('*'))) {
    failures.push('provider fixture source must be deterministic; glob is forbidden');
  }
  if (fixtures.some((fixture) => fixture.source.includes('/fable'))) {
    failures.push('unavailable fable directory must not be declared as a real fixture');
  }
  if (input.admission.v3_isolation?.must_not_restart !== true
      || input.admission.v3_isolation?.must_not_modify !== true) {
    failures.push('V3 isolation must forbid restart and modification');
  }
  return failures;
}

function baselineGaps(input) {
  const failures = [];
  const cargo = input.cargo;
  const runtime = input.runtime;
  const provider = input.provider;
  const server = input.server;
  const requiredPackages = [
    'routecodex-v4-runtime',
    'routecodex-v4-provider',
    'routecodex-v4-router',
    'routecodex-v4-server',
  ];
  for (const packageName of requiredPackages) {
    if (!cargo.includes(`crates/${packageName}`)) failures.push(`workspace missing package: ${packageName}`);
  }
  if (!cargo.includes('routecodex-v4-runtime-bin')) failures.push('workspace missing independent binary package');
  if (!runtime.includes('execute_mock_transport_slice')) failures.push('baseline no longer exposes the M8 mock marker');
  if (!runtime.includes('pub fn load(')) failures.push('runtime baseline marker missing');
  if (!server.includes('/health') && !server.includes('health')) failures.push('server has no health endpoint');
  if (!server.includes('/v1/models') && !server.includes('models')) failures.push('server has no models endpoint');
  if (!server.includes('/v1/responses') && !server.includes('responses')) failures.push('server has no Responses endpoint');
  if (server.includes('TcpListener') || server.includes('hyper::') || server.includes('axum::')) {
    failures.push('server unexpectedly contains an HTTP listener');
  }
  if (!server.includes('V4RequestIdCounter') || !server.includes('WireEvidenceRecord')) {
    failures.push('server diagnostic baseline markers missing');
  }
  if (provider.includes('reqwest::') || provider.includes('hyper::') || provider.includes('TcpStream')) {
    failures.push('provider unexpectedly contains real transport');
  }
  if (!provider.includes('V4Availability01SessionScoped')) {
    failures.push('provider availability baseline marker missing');
  }
  if (!provider.includes('providerId') || !provider.includes('AvailabilityRecord')) {
    failures.push('provider has no shared provider configuration surface');
  }
  if (!runtime.includes('response.output') && !runtime.includes('data:')) {
    failures.push('runtime has no Responses JSON/SSE semantic parser');
  }
  if (!input.router.includes('typed_target_selection') && !input.router.includes('SelectedTarget')) {
    failures.push('router has no typed target selection owner');
  }
  if (runtime.includes('real-runtime-admission.manifest.json') || cargo.includes('routecodex-v4-runtime-bin')) {
    failures.push('compiled manifest/binary is already wired into the baseline');
  }
  if (input.manifest.status !== 'design') failures.push('baseline admission manifest must still be design');
  return failures;
}

function loadInput() {
  return {
    admission: readJson(admissionPath),
    resources: readJson(resourceMapPath),
    functions: readJson(functionMapPath),
    mainline: readJson(mainlineMapPath),
    modules: readJson(moduleMapPath),
    verification: readJson(verificationMapPath),
    cargo: readText(cargoPath),
    runtime: readText(runtimePath),
    provider: readText(providerPath),
    server: readText(serverPath),
    router: readText(routerPath),
    manifest: readJson(admissionPath),
  };
}

const input = loadInput();
const redSelfTest = process.argv.includes('--red-self-test');
const baselineRed = process.argv.includes('--baseline-red');

if (redSelfTest) {
  const cases = [
    ['status drift', (value) => { value.admission.status = 'active'; }],
    ['entrypoint drift', (value) => { value.admission.entrypoints.pop(); }],
    ['gate drift', (value) => { value.verification.gates = value.verification.gates.filter((gate) => gate.gate_id !== 'v4_real_runtime_admission_red'); }],
    ['identity drift', (value) => { value.admission.runtime_identity = 'routecodex'; }],
  ];
  let failed = 0;
  for (const [name, mutate] of cases) {
    const mutated = clone(input);
    mutate(mutated);
    if (validateContract(mutated).length === 0) {
      console.error(`[v4_real_runtime_admission] red self-test did not fail: ${name}`);
      failed += 1;
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`[v4_real_runtime_admission] red self-test OK ${cases.length}/${cases.length}`);
  process.exit(0);
}

const contractFailures = validateContract(input);
if (contractFailures.length > 0) {
  console.error('[v4_real_runtime_admission] contract FAIL');
  for (const failure of contractFailures) console.error(`  - ${failure}`);
  process.exit(1);
}

if (baselineRed) {
  const gaps = baselineGaps(input);
  if (gaps.length < 8) {
    console.error(`[v4_real_runtime_admission] baseline red FAIL: only ${gaps.length} gaps proven`);
    for (const failure of gaps) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[v4_real_runtime_admission] baseline red OK gaps=${gaps.length}`);
  process.exit(0);
}

console.log('[v4_real_runtime_admission] contract design OK baseline=expected-red');

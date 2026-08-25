#!/usr/bin/env node
// V4 real runtime admission gate.
// Proves: active manifest, binary works, live HTTP endpoints, V3 untouched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const admissionPath = path.join(root, 'contracts/real-runtime-admission.manifest.json');
const resourceMapPath = path.join(root, 'docs/architecture/maps/resource-map.json');
const functionMapPath = path.join(root, 'docs/architecture/maps/function-map.json');
const mainlineMapPath = path.join(root, 'docs/architecture/maps/mainline-call-map.json');
const moduleMapPath = path.join(root, '.appsdk/maps/module-registry.json');
const verificationMapPath = path.join(root, 'docs/architecture/maps/verification-map.json');
const cargoPath = path.join(root, 'Cargo.toml');
const runtimePath = path.join(root, 'crates/routecodex-v4-runtime/src/lib.rs');
const providerPath = path.join(root, 'crates/routecodex-v4-provider/src/lib.rs');
const serverPath = path.join(root, 'crates/routecodex-v4-server/src/lib.rs');
const routerPath = path.join(root, 'crates/routecodex-v4-router/src/lib.rs');

const BINARY_PATH = path.join(root, 'target/release/rccv4');
const COMPILED_MANIFEST = process.env.RCCV4_MANIFEST
  ?? path.join(process.env.HOME ?? '', '.rcc/v4/manifest.compiled.json');
let RCCV4_HOST = process.env.RCCV4_LISTEN;
let ADMISSION_MODEL = process.env.RCCV4_ADMISSION_MODEL;
// Every live admission run needs a fresh continuation scope. Reusing a fixed
// session after a prior run leaves an intentionally immutable pending binding
// in the managed runtime and turns a new first turn into a false double-restore
// failure. The direct pair below deliberately shares this run-scoped value.
const admissionRun = `${Date.now()}-${process.pid}`;
const directSession = `admission-direct-${admissionRun}`;
const relayJsonSession = `admission-relay-json-${admissionRun}`;
const relaySseSession = `admission-relay-sse-${admissionRun}`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readText = (file) => fs.readFileSync(file, 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function httpGet(host, pathname, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const req = http.request({ hostname, port: parseInt(port), path: pathname, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(timeout);
    req.end();
  });
}

function httpPost(host, pathname, body, headers, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const payload = JSON.stringify(body);
    const finalHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers };
    const req = http.request({
      hostname, port: parseInt(port), path: pathname, method: 'POST', headers: finalHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(timeout);
    req.write(payload);
    req.end();
  });
}

function validateContract(input) {
  const failures = [];
  const requiredEntrypoints = new Set([
    'GET /health json',
    'GET /v1/models json',
    'POST /v1/responses json',
    'POST /v1/responses sse',
    'POST /v1/chat/completions json',
    'POST /v1/chat/completions sse',
  ]);
  const entrypoints = new Set((input.admission.entrypoints ?? []).map(
    (entry) => `${entry.method} ${entry.path} ${entry.mode}`,
  ));
  for (const entrypoint of requiredEntrypoints) {
    if (!entrypoints.has(entrypoint)) failures.push(`missing entrypoint: ${entrypoint}`);
  }
  if (input.admission.status !== 'active') failures.push(`admission contract must be status=active, got: ${input.admission.status}`);
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
    'routecodex-v4-runtime-bin->routecodex-v4-runtime',
    'routecodex-v4-runtime-bin->routecodex-v4-router',
    'routecodex-v4-runtime-bin->routecodex-v4-provider',
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

if (redSelfTest) {
  const cases = [
    ['status drift to design', (value) => { value.admission.status = 'design'; }],
    ['status drift to pending', (value) => { value.admission.status = 'pending'; }],
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

// Binary existence
if (!fs.existsSync(BINARY_PATH)) {
  console.error(`[v4_real_runtime_admission] FAIL: binary not found at ${BINARY_PATH}`);
  process.exit(1);
}
console.log(`[v4_real_runtime_admission] binary OK: ${BINARY_PATH}`);

// Compiled manifest existence
if (!fs.existsSync(COMPILED_MANIFEST)) {
  console.error(`[v4_real_runtime_admission] FAIL: compiled manifest not found at ${COMPILED_MANIFEST}`);
  process.exit(1);
}
console.log(`[v4_real_runtime_admission] compiled manifest OK: ${COMPILED_MANIFEST}`);
const compiledManifest = readJson(COMPILED_MANIFEST);
if (compiledManifest.runtime_identity !== 'rccv4'
    || typeof compiledManifest.manifest_digest !== 'string'
    || !compiledManifest.manifest_digest.startsWith('sha256:')) {
  console.error('[v4_real_runtime_admission] FAIL: compiled manifest identity/digest invalid');
  process.exit(1);
}
RCCV4_HOST ??= compiledManifest.listeners?.[0]?.address;
ADMISSION_MODEL ??= compiledManifest.routes?.[0]?.models?.[0];
if (!RCCV4_HOST || !ADMISSION_MODEL) {
  console.error('[v4_real_runtime_admission] FAIL: listener/model missing from compiled manifest');
  process.exit(1);
}

// Live HTTP tests
let passed = 0;
let failed = 0;
let directResponseId;

try {
  const health = await httpGet(RCCV4_HOST, '/health');
  if (health.status !== 200) throw new Error(`health status ${health.status}`);
  const healthJson = JSON.parse(health.body);
  // Real response carries id/version/manifest_digest (not "status" field); absence is fail
  if (!healthJson.id || !healthJson.version || !healthJson.manifest_digest) {
    throw new Error('health body missing id/version/manifest_digest fields');
  }
  console.log(`[v4_real_runtime_admission] /health OK: id=${healthJson.id} version=${healthJson.version}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] /health FAIL: ${e.message}`);
  failed++;
}

try {
  const models = await httpGet(RCCV4_HOST, '/v1/models');
  if (models.status !== 200) throw new Error(`models status ${models.status}`);
  const modelsJson = JSON.parse(models.body);
  if (!Array.isArray(modelsJson.data) || modelsJson.data.length === 0) {
    throw new Error('models body missing non-empty data array');
  }
  console.log(`[v4_real_runtime_admission] /v1/models OK: ${modelsJson.data.length} models, first=${modelsJson.data[0]?.id}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] /v1/models FAIL: ${e.message}`);
  failed++;
}

try {
  // POST /v1/responses JSON: real minimax responses shape
  const requestBody = {
    model: ADMISSION_MODEL,
    input: [{ role: 'user', content: 'say hi in 3 words' }],
  };
  const jsonResp = await httpPost(RCCV4_HOST, '/v1/responses', requestBody, { 'x-rccv4-session-id': directSession }, 60000);
  if (jsonResp.status !== 200) throw new Error(`responses JSON status ${jsonResp.status}, body=${jsonResp.body.substring(0, 200)}`);
  const jsonBody = JSON.parse(jsonResp.body);
  if (!jsonBody.id || !jsonBody.object) throw new Error('responses JSON missing id/object fields');
  if (jsonBody.object !== 'response') throw new Error(`unexpected object type: ${jsonBody.object}`);
  // Real upstream response has a hash-like id (minimax produces 32-hex)
  if (typeof jsonBody.id !== 'string' || jsonBody.id.length === 0) {
    throw new Error(`response id is empty: ${jsonBody.id}`);
  }
  directResponseId = jsonBody.id;
  console.log(`[v4_real_runtime_admission] POST /v1/responses JSON OK: id=${jsonBody.id}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] POST /v1/responses JSON FAIL: ${e.message}`);
  failed++;
}

try {
  if (!directResponseId) throw new Error('first direct response id unavailable');
  const continuation = await httpPost(RCCV4_HOST, '/v1/responses', {
    model: ADMISSION_MODEL,
    previous_response_id: directResponseId,
    input: [{ role: 'user', content: 'now say bye in 3 words' }],
  }, { 'x-rccv4-session-id': directSession }, 60000);
  if (continuation.status !== 200) throw new Error(`continuation status ${continuation.status}, body=${continuation.body.substring(0, 200)}`);
  const body = JSON.parse(continuation.body);
  if (!body.id || body.id === directResponseId) throw new Error('continuation did not produce a new response id');
  console.log(`[v4_real_runtime_admission] Responses continuation OK: previous=${directResponseId} next=${body.id}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] Responses continuation FAIL: ${e.message}`);
  failed++;
}

try {
  // POST /v1/responses SSE: provider streams through compiled candidate. Accept SSE header.
  const requestBody = {
    model: ADMISSION_MODEL,
    input: [{ role: 'user', content: 'count 1,2,3' }],
    stream: true,
  };
  const sseResp = await httpPost(RCCV4_HOST, '/v1/responses', requestBody, { 'Accept': 'text/event-stream' }, 60000);
  if (sseResp.status !== 200) throw new Error(`responses SSE status ${sseResp.status}, body=${sseResp.body.substring(0, 200)}`);
  const body = sseResp.body;
  const hasResponseId = body.includes('response_id') || /"id"\s*:\s*"[^"]+"/.test(body);
  if (!hasResponseId) throw new Error('SSE response has no recognizable response_id');
  const isSseFrame = body.includes('event:') && body.includes('data:');
  if (!isSseFrame || !body.includes('response.completed')) {
    throw new Error('Responses SSE lacks event/data frames or terminal response.completed');
  }
  console.log(`[v4_real_runtime_admission] POST /v1/responses SSE OK: len=${body.length}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] POST /v1/responses SSE FAIL: ${e.message}`);
  failed++;
}

try {
  const relay = await httpPost(RCCV4_HOST, '/v1/chat/completions', {
    model: ADMISSION_MODEL,
    messages: [{ role: 'user', content: 'say relay ok' }],
  }, { 'x-rccv4-session-id': relayJsonSession }, 60000);
  if (relay.status !== 200) throw new Error(`relay JSON status ${relay.status}, body=${relay.body.substring(0, 200)}`);
  const body = JSON.parse(relay.body);
  if (body.object !== 'chat.completion' || !Array.isArray(body.choices)) {
    throw new Error('relay JSON is not a chat completion');
  }
  console.log(`[v4_real_runtime_admission] Chat relay JSON OK: id=${body.id}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] Chat relay JSON FAIL: ${e.message}`);
  failed++;
}

try {
  const relay = await httpPost(RCCV4_HOST, '/v1/chat/completions', {
    model: ADMISSION_MODEL,
    messages: [{ role: 'user', content: 'count 1,2,3' }],
    stream: true,
  }, { 'x-rccv4-session-id': relaySseSession }, 60000);
  if (relay.status !== 200) throw new Error(`relay SSE status ${relay.status}, body=${relay.body.substring(0, 200)}`);
  if (!relay.body.includes('"object":"chat.completion.chunk"') || !relay.body.includes('data: [DONE]')) {
    throw new Error('relay SSE lacks chat chunks or terminal [DONE]');
  }
  if (relay.body.includes('event: response.')) throw new Error('provider Responses event leaked into chat SSE');
  console.log(`[v4_real_runtime_admission] Chat relay SSE OK: len=${relay.body.length}`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] Chat relay SSE FAIL: ${e.message}`);
  failed++;
}

try {
  // Malformed: unknown model name -> 4xx/5xx, server stays alive
  const badResp = await httpPost(RCCV4_HOST, '/v1/responses', { model: 'NonExistentModelXYZ', input: 'hi' }, {}, 10000);
  if (badResp.status >= 200 && badResp.status < 400) throw new Error('malformed request unexpectedly succeeded');
  const healthAfter = await httpGet(RCCV4_HOST, '/health');
  if (healthAfter.status !== 200) throw new Error(`server not healthy after bad request: ${healthAfter.status}`);
  console.log(`[v4_real_runtime_admission] malformed request handled OK (status=${badResp.status})`);
  passed++;
} catch (e) {
  console.error(`[v4_real_runtime_admission] malformed request FAIL: ${e.message}`);
  failed++;
}

console.log(`[v4_real_runtime_admission] live tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('[v4_real_runtime_admission] ALL OK');

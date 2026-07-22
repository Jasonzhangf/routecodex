#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const HARNESS_ID = 'v3.anthropic_relay_controlled_replay';
const DIAGNOSTIC = 'V3_ANTHROPIC_RELAY_WIRING_MISSING';
const REQUIRED_NODES = [
  'V3HubReqInbound01ClientRaw',
  'V3HubReqInbound02Normalized',
  'V3HubReqContinuation03Classified',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned',
  'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic',
  'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound09TransportRequest',
  'V3ProviderRespInbound01Raw',
  'ProviderRespCompat02ProviderCompat',
  'V3HubRespInbound02Normalized',
  'V3HubRespChatProcess03Governed',
  'V3HubRespContinuation04Committed',
  'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];
const MISSING_ADJACENT_EDGES = [
  'V3HubReqChatProcess04Governed->V3HubReqExecution05Planned',
  'V3HubReqExecution05Planned->V3HubReqTarget06Resolved',
  'V3HubReqTarget06Resolved->V3HubReqOutbound07ProviderSemantic',
  'V3HubReqOutbound07ProviderSemantic->ProviderReqCompat06ProviderCompat',
  'ProviderReqCompat06ProviderCompat->V3ProviderReqOutbound08WirePayload',
  'V3ProviderReqOutbound08WirePayload->V3ProviderReqOutbound09TransportRequest',
  'V3ProviderReqOutbound09TransportRequest->V3ProviderRespInbound01Raw',
  'V3ProviderRespInbound01Raw->ProviderRespCompat02ProviderCompat',
  'ProviderRespCompat02ProviderCompat->V3HubRespInbound02Normalized',
  'V3HubRespOutbound05ClientSemantic->V3ServerRespOutbound06ClientFrame',
];
const FORBIDDEN_FIELDS = new Set([
  'routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol',
  'resource_handle', 'runtime_control', 'selected_target',
]);

const args = parseArgs(process.argv.slice(2));
const fixtureRoot = resolve(args['fixture-root'] ?? 'v3/fixtures/anthropic-relay-controlled-upstream');
const evidencePath = args.evidence ? resolve(args.evidence) : null;
const fixtures = loadFixtures(fixtureRoot);
const fixtureDigest = digest(fixtures.map(({ relative, value }) => ({ relative, value })));
const driver = process.env.V3_ANTHROPIC_RELAY_DRIVER;

if (!driver) {
  const evidence = {
    schema_version: 1,
    harness_id: HARNESS_ID,
    status: 'wiring_missing',
    fixture_digest: fixtureDigest,
    cases: fixtures.map(({ value }) => ({
      case_id: value.case_id,
      status: 'not_run',
      provider_capture_count: 0,
      diagnostic: `${DIAGNOSTIC}: runtime driver is not configured`,
    })),
    missing_adjacent_edges: MISSING_ADJACENT_EDGES,
    diagnostic: `${DIAGNOSTIC}: ${MISSING_ADJACENT_EDGES.join(', ')}`,
  };
  emitEvidence(evidencePath, evidence);
  console.error(evidence.diagnostic);
  process.exit(1);
}

const result = await runWithDriver(driver, fixtures, fixtureDigest);
emitEvidence(evidencePath, result);
if (result.status !== 'passed') {
  console.error(result.diagnostic);
  process.exit(1);
}
console.log(`[v3-anthropic-relay-controlled-replay] passed (${result.cases.length} cases)`);

async function runWithDriver(driverPath, loaded, digestValue) {
  const captures = new Map();
  const fixtureById = new Map(loaded.map(({ value }) => [value.case_id, value]));
  let activeFixtureId = null;
  const server = createServer(async (request, response) => {
    const fixtureId = activeFixtureId;
    const fixture = fixtureById.get(fixtureId);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { body = null; }
    if (!fixture || request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'controlled_upstream_contract_mismatch' }));
      return;
    }
    const previous = captures.get(fixtureId) ?? [];
    previous.push(body);
    captures.set(fixtureId, previous);
    const upstream = fixture.upstream_response;
    response.writeHead(upstream.status, { 'content-type': upstream.content_type });
    if (upstream.events) {
      for (const event of upstream.events) {
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      response.end();
    } else {
      response.end(JSON.stringify(upstream.body));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  const configRoot = mkdtempSync(join(tmpdir(), 'routecodex-v3-anthropic-relay-config-'));
  const configPath = join(configRoot, 'config.v3.toml');
  writeFileSync(configPath, controlledConfig(port));
  const results = [];
  try {
    for (const { value } of loaded) {
      activeFixtureId = value.case_id;
      const driverResult = await runDriver(driverPath, [
        '--config', configPath,
      ], {
        env: {
          ...process.env,
          V3_ANTHROPIC_RELAY_FIXTURE_ID: value.case_id,
          V3_ANTHROPIC_RELAY_TEST_KEY: 'controlled-test-token',
        },
      }, JSON.stringify({ case_id: value.case_id, client_request: value.client_request }));
      const captured = captures.get(value.case_id) ?? [];
      const failures = [];
      if (driverResult.status !== 0) failures.push(`driver exit ${driverResult.status}: ${driverResult.stderr.trim()}`);
      let projection = null;
      try { projection = JSON.parse(driverResult.stdout.trim()); }
      catch { failures.push('driver stdout is not one JSON evidence object'); }
      if (captured.length !== 1) failures.push(`controlled upstream capture count ${captured.length}, expected 1`);
      else if (!deepEqual(captured[0], value.expected_upstream_request)) failures.push('provider capture differs from expected_upstream_request');
      if (!projection || !deepEqual(projection.client_response, value.expected_client_response)) failures.push('client projection differs from expected_client_response');
      if (!projection || !orderedSubsequence(value.expected_node_trace, projection.node_trace)) failures.push('node_trace misses or reorders fixture-required adjacent nodes');
      if (captured.some(hasForbiddenField) || hasForbiddenField(projection?.client_response)) failures.push('side-channel field leaked into provider/client normal payload');
      results.push({
        case_id: value.case_id,
        status: failures.length ? 'failed' : 'passed',
        provider_capture_count: captured.length,
        diagnostic: failures.join('; ') || 'controlled replay matched fixture truth',
      });
    }
  } finally {
    activeFixtureId = null;
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(configRoot, { recursive: true, force: true });
  }
  const failed = results.filter((item) => item.status === 'failed');
  return {
    schema_version: 1,
    harness_id: HARNESS_ID,
    status: failed.length ? 'failed' : 'passed',
    fixture_digest: digestValue,
    cases: results,
    missing_adjacent_edges: [],
    diagnostic: failed.length ? `controlled replay failed: ${failed.map((item) => item.case_id).join(', ')}` : 'all controlled replay cases passed',
  };
}

function runDriver(command, commandArgs, options, input) {
  return new Promise((resolveDriver, rejectDriver) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectDriver);
    child.once('close', (status) => resolveDriver({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function controlledConfig(port) {
  return `version = 3

[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
endpoints = ["anthropic"]

[providers.controlled]
type = "responses"
base_url = "http://127.0.0.1:${port}/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "V3_ANTHROPIC_RELAY_TEST_KEY" }] }

[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]

[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith('--') || values[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? '<missing>'}`);
    parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
}

function loadFixtures(root) {
  const manifestPath = resolve(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.harness_id !== HARNESS_ID || manifest.schema_version !== 1) throw new Error('fixture manifest identity mismatch');
  if (!Array.isArray(manifest.cases) || !deepEqual(manifest.cases, [...manifest.cases].sort())) throw new Error('fixture case IDs must be sorted');
  if (new Set(manifest.cases).size !== manifest.cases.length) throw new Error('fixture case IDs must be unique');
  return manifest.cases.map((caseId) => {
    const absolute = resolve(root, `${caseId}.json`);
    if (!existsSync(absolute)) throw new Error(`fixture missing: ${caseId}`);
    const value = JSON.parse(readFileSync(absolute, 'utf8'));
    if (value.case_id !== caseId) throw new Error(`fixture case_id mismatch: ${caseId}`);
    return { relative: `${caseId}.json`, absolute, value };
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function deepEqual(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function orderedSubsequence(required, actual) {
  if (!Array.isArray(actual)) return false;
  let cursor = 0;
  for (const node of actual) if (node === required[cursor]) cursor += 1;
  return cursor === required.length;
}
function hasForbiddenField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN_FIELDS.has(key) || hasForbiddenField(nested));
}
function emitEvidence(path, evidence) {
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (path) writeFileSync(path, encoded);
  else process.stdout.write(encoded);
}

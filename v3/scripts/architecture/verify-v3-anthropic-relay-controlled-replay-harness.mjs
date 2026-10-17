#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = json('v3/fixtures/anthropic-relay-controlled-upstream/manifest.json');
const schema = json('docs/schemas/v3-anthropic-relay-controlled-replay-evidence.schema.json');
const failures = [];
const requiredCases = ['json_thinking_tool_use', 'provider_error', 'side_channel_isolation', 'sse_thinking_tool_use'];
const requiredNodes = [
  'V3HubReqInbound01ClientRaw', 'V3HubReqInbound02Normalized',
  'V3HubReqChatProcess04Governed',
  'V3HubReqExecution05Planned', 'V3HubReqTarget06Resolved',
  'V3HubReqOutbound07ProviderSemantic', 'ProviderReqCompat06ProviderCompat',
  'V3ProviderReqOutbound08WirePayload', 'V3ProviderReqOutbound09TransportRequest',
  'V3ProviderRespInbound01Raw', 'ProviderRespCompat02ProviderCompat',
  'V3HubRespInbound02Normalized', 'V3HubRespChatProcess03Governed',
  'V3HubRespOutbound05ClientSemantic',
  'V3ServerRespOutbound06ClientFrame',
];
const forbiddenFields = ['routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol', 'resource_handle', 'runtime_control', 'selected_target'];

if (manifest.harness_id !== 'v3.anthropic_relay_controlled_replay' || manifest.schema_version !== 1) fail('manifest identity mismatch');
if (JSON.stringify(manifest.cases) !== JSON.stringify(requiredCases)) fail('manifest cases must be complete, unique, and sorted');
for (const caseId of requiredCases) {
  const fixture = json(`v3/fixtures/anthropic-relay-controlled-upstream/${caseId}.json`);
  if (fixture.case_id !== caseId) fail(`${caseId}: case_id mismatch`);
  for (const field of ['transport', 'expected_node_trace', 'client_request', 'expected_upstream_request', 'upstream_response', 'expected_client_response']) {
    if (!(field in fixture)) fail(`${caseId}: missing ${field}`);
  }
  if (hasForbiddenField(fixture.expected_upstream_request) || hasForbiddenField(fixture.expected_client_response)) fail(`${caseId}: side-channel field in expected normal payload`);
}
for (const caseId of ['json_thinking_tool_use', 'side_channel_isolation', 'sse_thinking_tool_use']) {
  const trace = json(`v3/fixtures/anthropic-relay-controlled-upstream/${caseId}.json`).expected_node_trace;
  if (JSON.stringify(trace) !== JSON.stringify(requiredNodes)) fail(`${caseId}: success adjacent node trace mismatch`);
}
const providerErrorTrace = json('v3/fixtures/anthropic-relay-controlled-upstream/provider_error.json').expected_node_trace;
for (const node of ['V3Error01SourceRaised', 'V3Error02Classified', 'V3Error03TargetLocalAction', 'V3Error04TargetExhaustionDecision', 'V3Error05ExecutionDecision', 'V3Error06ClientProjected']) {
  if (!providerErrorTrace.includes(node)) fail(`provider_error: missing ${node}`);
}
if (json('v3/fixtures/anthropic-relay-controlled-upstream/json_thinking_tool_use.json').transport !== 'json') fail('JSON scenario transport mismatch');
if (json('v3/fixtures/anthropic-relay-controlled-upstream/sse_thinking_tool_use.json').transport !== 'sse') fail('SSE scenario transport mismatch');
if (json('v3/fixtures/anthropic-relay-controlled-upstream/provider_error.json').upstream_response.status < 400) fail('provider error scenario must remain an HTTP error');
if (schema.additionalProperties !== false || schema.properties?.status?.enum?.join(',') !== 'passed,failed,wiring_missing') fail('evidence schema status/additionalProperties contract mismatch');
for (const field of ['schema_version', 'harness_id', 'status', 'cases', 'missing_adjacent_edges', 'diagnostic']) {
  if (!schema.required?.includes(field)) fail(`evidence schema missing required ${field}`);
}

if (failures.length) {
  console.error('[verify:v3-anthropic-relay-controlled-replay-harness] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-anthropic-relay-controlled-replay-harness] ok');

function text(relative) { return readFileSync(resolve(sourceRoot, relative), 'utf8'); }
function json(relative) { return JSON.parse(text(relative)); }
function fail(message) { failures.push(message); }
function hasForbiddenField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => forbiddenFields.includes(key) || hasForbiddenField(nested));
}

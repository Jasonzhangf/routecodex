#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const canonicalCall = 'execute_v3_operation_runner_request_normalize_request_losslessly';
const rel = {
  verification: 'docs/architecture/v3-verification-map.yml',
  http: 'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
  websocket: 'v3/crates/routecodex-v3-server/src/websocket.rs',
  chatDirectOutcome: 'v3/crates/routecodex-v3-server/src/executors.rs',
  responsesDirectOutcome: 'v3/crates/routecodex-v3-server/src/responses_direct_server_outcome.rs',
  directCore: 'v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs',
  directCodec: 'v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_protocol_codec.rs',
  relayCore: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs',
  responsesRelay: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs',
  anthropicRelay: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs',
  relayRequest: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  operatorEntry: 'v3/crates/routecodex-v3-runtime/src/operation_runner/mod.rs',
  operators: 'v3/crates/routecodex-v3-runtime/src/operation_runner/operators/mod.rs',
  resolveOperator: 'v3/crates/routecodex-v3-runtime/src/operation_runner/operators/resolve_target.rs',
  planOperator: 'v3/crates/routecodex-v3-runtime/src/operation_runner/operators/plan_execution.rs',
};

function readFile(target) {
  return fs.readFileSync(path.join(root, target), 'utf8');
}

function exists(target) {
  return fs.existsSync(path.join(root, target));
}

function fail(message, evidence) {
  failures.push(evidence ? message + ': ' + evidence : message);
}

function bodyAt(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const brace = source.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const c = source[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === String.fromCharCode(92)) escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === String.fromCharCode(39) || c === String.fromCharCode(96)) {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function functionBody(target, marker, requirement) {
  if (!exists(target)) {
    fail('Node02 source absent', target + ' ' + requirement);
    return null;
  }
  const body = bodyAt(readFile(target), marker);
  if (!body) fail('Node02 function body unavailable', target + ' ' + marker);
  return body;
}

function hasCanonical(body) {
  return new RegExp('\\b' + canonicalCall + '\\b').test(body);
}

function beforeDispatch(body, dispatchMarker, label, target) {
  if (!body) return;
  if (!hasCanonical(body)) {
    fail(label + ' does not invoke Node02 normalize slice', target + ': missing ' + canonicalCall);
    return;
  }
  const dispatch = body.indexOf(dispatchMarker);
  const canonical = body.indexOf(canonicalCall);
  if (dispatch < 0 || canonical >= dispatch) fail(label + ' normalize slice must run before mode dispatch', target);
}

function assertNot(body, pattern, label, target) {
  if (body && pattern.test(body)) fail(label, target);
}

function callHits(target, symbol) {
  if (!exists(target)) {
    fail('Node02 source absent', target);
    return [];
  }
  const source = readFile(target);
  const hits = [];
  const re = new RegExp('\\b' + symbol + '\\b', 'g');
  let hit;
  while ((hit = re.exec(source)) !== null && hits.length < 8) {
    hits.push(target + ':' + source.slice(0, hit.index).split('\n').length);
  }
  return hits;
}

const verificationMap = readFile(rel.verification);
if (!verificationMap.includes('node02_required_positive:')) fail('Node02 required_positive contract missing', rel.verification);
if (!verificationMap.includes('node02_required_negative:')) fail('Node02 required_negative contract missing', rel.verification);

beforeDispatch(functionBody(rel.http, 'fn pending_endpoint_after_responses_admission_inner(', 'HTTP Node02 slice caller'), 'match effective_execution_mode', 'HTTP entry', rel.http);
beforeDispatch(functionBody(rel.websocket, 'fn handle_responses_websocket_message_with_mode(', 'WebSocket Node02 slice caller'), 'match effective_execution_mode', 'Responses WebSocket entry', rel.websocket);

const directBody = functionBody(rel.directCore, 'fn execute_v3_direct_runtime_kernel_core_resident<', 'Direct canonical consumer');
assertNot(directBody, /C::build_standardized\s*\(/, 'Direct runtime kernel still calls old raw build_standardized', rel.directCore);

const directCodecCalls = [
  ...callHits(rel.directCodec, 'build_v3_req_04_standardized_responses_from_v3_server_03'),
  ...callHits(rel.directCodec, 'build_v3_chat_req_04_standardized_from_v3_server_03'),
];
if (directCodecCalls.length) fail('Direct codec still contains old raw normalization call', directCodecCalls.join('; '));

const relayContracts = [
  ['shared Relay', rel.relayCore, 'fn execute_v3_relay_runtime_core<', /C::req_inbound_02\s*\(/, 'shared Relay still calls old Req02 mapping'],
  ['Responses Relay', rel.responsesRelay, 'fn execute_v3_responses_relay_runtime_inner<', /build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01\s*\(/, 'Responses Relay still calls old Req02 mapping'],
  ['Anthropic Relay', rel.anthropicRelay, 'fn execute_v3_anthropic_relay_runtime_inner<', /run_v3_anthropic_relay_runtime_req_inbound\s*\(/, 'Anthropic Relay still calls old Req02 hook'],
  ['public relay_request', rel.relayRequest, 'pub fn run(', /build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01\s*\(/, 'public relay_request still calls old Req02 mapping'],
];
for (const [label, target, marker, oldCall, oldLabel] of relayContracts) {
  const body = functionBody(target, marker, label + ' canonical consumer');
  assertNot(body, oldCall, oldLabel, target);
}

const websocketRelay = functionBody(rel.websocket, 'fn execute_responses_relay_websocket_output(', 'WebSocket Relay canonical consumer');
assertNot(websocketRelay, /payload:\s*payload(\.clone\(\))?/, 'Responses WebSocket still sends raw payload to Relay', rel.websocket);
assertNot(websocketRelay, /handoff\.request_payload\.clone\(\)/, 'Responses WebSocket still passes handoff raw request_payload to Direct', rel.websocket);

const chatDirectOutcome = functionBody(rel.chatDirectOutcome, 'fn execute_v3_openai_chat_direct_server_outcome(', 'OpenAI Chat Direct-to-Relay handoff');
assertNot(chatDirectOutcome, /V3OpenAiChatRelayRuntimeInput\s*\{[^}]*\bpayload\s*,/, 'OpenAI Chat Direct-to-Relay still passes raw payload', rel.chatDirectOutcome);
const responsesDirectOutcome = functionBody(rel.responsesDirectOutcome, 'fn execute_responses_direct_server_outcome(', 'Responses Direct-to-Relay handoff');
assertNot(responsesDirectOutcome, /V3ResponsesRelayRuntimeInput\s*\{[^}]*\bpayload:\s*payload\.clone\(\)/, 'Responses Direct-to-Relay still passes raw payload', rel.responsesDirectOutcome);
assertNot(responsesDirectOutcome, /next_handoff\.request_payload\.clone\(\)/, 'Responses nested handoff still passes raw request_payload', rel.responsesDirectOutcome);

for (const target of [rel.operatorEntry, rel.operators]) {
  if (!exists(target)) continue;
  if (/routecodex\.v3\.operation\.(resolve_target|plan_execution)\b/.test(readFile(target))) fail('Node03/04 runtime registration found', target);
}
for (const target of [rel.resolveOperator, rel.planOperator]) {
  if (exists(target)) fail('Node03/04 production operator source found', target);
}

if (failures.length) {
  console.error('[verify:v3-operation-runner-node02-cutover] RED: old production path remains');
  console.error('- first: ' + failures[0]);
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[verify:v3-operation-runner-node02-cutover] ok');
console.log('- Node02 HTTP/WebSocket canonical entry before dispatch: verified');
console.log('- Direct/Relay/Anthropic/public relay old raw normalization callers removed: verified');
console.log('- Responses WebSocket raw Relay and handoff bypasses removed: verified');
console.log('- OpenAI Chat and Responses Direct-to-Relay raw handoffs removed: verified');
console.log('- Node03/04 runtime registration absent: verified');

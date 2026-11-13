import { isDeepStrictEqual } from 'node:util';
import {
  CELL_MODES,
  CELL_TRANSPORTS,
  CLIENT_TRANSPORTS,
  PROTOCOLS,
  SCRIPT_MODES,
  SCHEMA_VERSION,
} from './corpus-contract.mjs';
import { CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION } from './codex-exec-consumer.mjs';

const PROTOCOL_SET = new Set(PROTOCOLS);
const TRANSPORT_SET = new Set(CELL_TRANSPORTS);
const MODE_SET = new Set(CELL_MODES);
const SCRIPT_SET = new Set(SCRIPT_MODES);
const CLIENT_TRANSPORT_SET = new Set(CLIENT_TRANSPORTS);
const ID_PATTERN = /^[a-z0-9-]+$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RUNTIME_SETUP_KEYS = new Set([
  'provider_id',
  'model',
  'wire_model',
  'candidate_ids',
  'all_candidates_fail',
  'attempt_store',
  'process',
  'health',
]);
const PROVIDER_HEALTH_KEYS = new Set([
  'enabled',
  'failure_threshold',
  'cooldown_ms',
  'probe_interval_ms',
  'advisory_probe',
]);
const REQUEST_INDEPENDENCE_KINDS = new Set(['provider_request_independence']);
const REQUEST_INDEPENDENCE_SHAPES = new Set(['held_concurrent_requests', 'failure_isolation']);
const CODEX_INTEGER_REPLAY_CASES = new Set([
  'issue-3192e71-codex-integer-positive',
  'issue-3192e71-fractional-negative',
  'issue-3192e71-user-schema-negative',
  'issue-3192e71-duplicate-keys-negative',
  'issue-3192e71-over-safe-int-negative',
  'issue-3192e71-nested-extra-negative',
  'issue-3192e71-missing-optional-preserved',
]);
const CODEX_NEGATIVE_CASES = new Set([
  'issue-3192e71-fractional-negative',
  'issue-3192e71-user-schema-negative',
  'issue-3192e71-duplicate-keys-negative',
  'issue-3192e71-over-safe-int-negative',
  'issue-3192e71-nested-extra-negative',
  'issue-3192e71-missing-optional-preserved',
]);
const CODEX_REAL_EXEC_CASES = new Set([
  'issue-57c0176-singular-tool-call-text',
  ...CODEX_INTEGER_REPLAY_CASES,
]);
const CODEX_INTEGER_ARGUMENT_CASES = new Map([
  ['issue-3192e71-codex-integer-positive', {
    call_id: 'call_int_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"yield_time_ms":20000.0}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":8000,"yield_time_ms":20000}',
  }],
  ['issue-3192e71-fractional-negative', {
    call_id: 'call_frac_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":8000.5,"yield_time_ms":20000.0}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":8000.5,"yield_time_ms":20000.0}',
  }],
  ['issue-3192e71-user-schema-negative', {
    call_id: 'call_user_schema_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"yield_time_ms":20000.0}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"yield_time_ms":20000.0}',
  }],
  ['issue-3192e71-duplicate-keys-negative', {
    call_id: 'call_duplicate_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"max_output_tokens":9000.0,"yield_time_ms":20000.0}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"max_output_tokens":9000.0,"yield_time_ms":20000.0}',
  }],
  ['issue-3192e71-over-safe-int-negative', {
    call_id: 'call_over_safe_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":9007199254740993.0,"yield_time_ms":20000.0}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":9007199254740993.0,"yield_time_ms":20000.0}',
  }],
  ['issue-3192e71-nested-extra-negative', {
    call_id: 'call_nested_extra_1',
    upstream_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"extra":{"nested":9007199254740993.0,"key":1,"key":2}}',
    client_arguments: '{"cmd":"pwd","max_output_tokens":8000.0,"extra":{"nested":9007199254740993.0,"key":1,"key":2}}',
  }],
  ['issue-3192e71-missing-optional-preserved', {
    call_id: 'call_missing_optional_1',
    upstream_arguments: '{"cmd":"pwd"}',
    client_arguments: '{"cmd":"pwd"}',
  }],
]);
const SINGULAR_TOOL_CALL_TEXT =
  '{"tool_call":[{"name":"functions.exec","arguments":"{\\"input\\":\\"pwd\\"}"}]}';

export function validateCase(relative, value) {
  const findings = [];
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(value)) {
    fail('case must be an object');
    return findings;
  }
  if (typeof value.case_id !== 'string' || !ID_PATTERN.test(value.case_id)) fail(`case_id invalid: ${value.case_id ?? 'null'}`);
  if (value.schema_version !== SCHEMA_VERSION) fail(`schema_version must be ${SCHEMA_VERSION}: ${value.schema_version ?? 'null'}`);
  const cell = value.cell;
  if (!isObject(cell)) {
    fail('cell object missing');
  } else {
    if (!PROTOCOL_SET.has(cell.entry_protocol)) fail(`cell.entry_protocol invalid: ${cell.entry_protocol}`);
    if (!PROTOCOL_SET.has(cell.provider_protocol)) fail(`cell.provider_protocol invalid: ${cell.provider_protocol}`);
    if (!TRANSPORT_SET.has(cell.transport)) fail(`cell.transport invalid: ${cell.transport}`);
    if (!MODE_SET.has(cell.mode)) fail(`cell.mode invalid: ${cell.mode}`);
    if (cell.mode === 'direct' && cell.entry_protocol !== cell.provider_protocol) {
      fail(`direct cell must target the same protocol: ${cell.entry_protocol} -> ${cell.provider_protocol}`);
    }
  }
  validateClientRequest(relative, value.client_request, findings);
  validateExpectedProvider(relative, value.expected_provider, findings);
  validateExpectedClient(relative, value.expected_client, findings);
  validateUpstream(relative, value.upstream_response, findings, 'upstream_response');
  validateAssertions(relative, value, findings);
  validateRuntimeSetup(relative, value.runtime_setup, findings);
  validateTurns(relative, value, findings);
  validateSource(relative, value.source, findings);
  validateToolFollowup(relative, value, findings);
  validateCodexReplayCase(relative, value, findings);
  validateRequestIndependenceReplay(relative, value, findings);
  if (value.concurrency_replay !== undefined) {
    findings.push(`${relative}: concurrency_replay is retired; declare request_independence_replay`);
  }
  return findings;
}

function validateClientRequest(relative, request, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(request)) {
    fail('client_request object missing');
    return;
  }
  if (request.method !== 'POST') fail(`client_request.method must be POST: ${request.method}`);
  if (typeof request.path !== 'string' || !request.path.startsWith('/')) fail('client_request.path must be an absolute path');
  if (!isObject(request.body)) fail('client_request.body must be an object');
}

function validateExpectedProvider(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(expected)) {
    fail('expected_provider object missing');
    return;
  }
  if (!Array.isArray(expected.paths) || expected.paths.length === 0 || expected.paths.some((path) => typeof path !== 'string')) {
    fail('expected_provider.paths must be a non-empty string array');
  }
  if (expected.method !== 'POST') fail(`expected_provider.method must be POST: ${expected.method}`);
  if (typeof expected.auth_required !== 'boolean') fail('expected_provider.auth_required must be boolean');
  if (!isObject(expected.body_must) && !isObject(expected.exact)) {
    fail('expected_provider needs body_must or exact');
  }
  if (expected.body_must_not !== undefined && !Array.isArray(expected.body_must_not)) {
    fail('expected_provider.body_must_not must be an array when present');
  }
  validateAuthOrders(relative, expected, findings);
}

function validateAuthOrders(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (expected.auth_orders === undefined) return;
  if (expected.auth_required !== true) {
    fail('expected_provider.auth_orders requires auth_required true');
  }
  if (!Array.isArray(expected.auth_orders) || expected.auth_orders.length !== 2) {
    fail('expected_provider.auth_orders must declare exactly two allowed identity orders');
    return;
  }
  for (const [index, order] of expected.auth_orders.entries()) {
    if (!Array.isArray(order) || order.length !== 2 || order.some((token) => typeof token !== 'string' || token.length === 0)) {
      fail(`expected_provider.auth_orders[${index}] must be exactly two non-empty auth strings`);
      continue;
    }
    if (new Set(order).size !== order.length) {
      fail(`expected_provider.auth_orders[${index}] must list two distinct identities`);
    }
  }
  if (expected.auth_orders.every((order) => Array.isArray(order) && order.every((token) => typeof token === 'string' && token.length > 0))) {
    const identities = new Set(expected.auth_orders.flat());
    if (identities.size !== 2) {
      fail('expected_provider.auth_orders must use exactly two identities across both orders');
    }
  }
}

function validateExpectedClient(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(expected)) {
    fail('expected_client object missing');
    return;
  }
  if (!CLIENT_TRANSPORT_SET.has(expected.transport)) fail(`expected_client.transport invalid: ${expected.transport}`);
  if (expected.transport === 'complete') {
    if (!Number.isInteger(expected.status) || expected.status < 200 || expected.status >= 300) {
      fail(`expected_client.status must be 2xx for complete transport: ${expected.status}`);
    }
    if (!isObject(expected.body_must)) fail('expected_client.body_must must be an object for complete transport');
  }
  if (expected.body_must_not !== undefined && !Array.isArray(expected.body_must_not)) {
    fail('expected_client.body_must_not must be an array when present');
  }
  if (typeof expected.semantic_terminal_required !== 'boolean') {
    fail('expected_client.semantic_terminal_required must be boolean');
  }
}

function validateUpstream(relative, upstream, findings, label) {
  const prefix = `${relative}: ${label}`;
  const fail = (message) => findings.push(`${prefix}: ${message}`);
  if (!isObject(upstream)) {
    fail('object missing');
    return;
  }
  if (!PROTOCOL_SET.has(upstream.protocol)) fail(`protocol invalid: ${upstream.protocol}`);
  if (!SCRIPT_SET.has(upstream.mode)) {
    fail(`mode invalid: ${upstream.mode}`);
    return;
  }
  if (upstream.mode === 'json') {
    if (!isObject(upstream.body)) fail('body must be an object for json mode');
  } else if (upstream.mode === 'sse') {
    if (!Array.isArray(upstream.sse_events) || upstream.sse_events.length === 0) {
      fail('sse_events must be a non-empty array for sse mode');
    }
  } else if (upstream.mode === 'fault') {
    if (typeof upstream.fault !== 'string' || upstream.fault.length === 0) fail('fault must be a non-empty string for fault mode');
    if (!Array.isArray(upstream.attempts) || upstream.attempts.length === 0) {
      fail('attempts must be a non-empty array for fault mode');
    }
    for (const [index, attempt] of (upstream.attempts ?? []).entries()) {
      validateScriptedAttempt(prefix, attempt, index, findings);
    }
  }
}

function validateScriptedAttempt(prefix, attempt, index, findings) {
  const fail = (message) => findings.push(`${prefix}.attempts[${index}]: ${message}`);
  if (!isObject(attempt)) {
    fail('must be an object');
    return;
  }
  if (!SCRIPT_SET.has(attempt.kind)) fail(`kind invalid: ${attempt.kind}`);
  if (attempt.kind === 'json' && !isObject(attempt.body)) fail('body must be an object for kind=json');
  if (attempt.kind === 'sse' && (!Array.isArray(attempt.sse_events) || attempt.sse_events.length === 0)) fail('sse_events must be a non-empty array for kind=sse');
  if (attempt.kind === 'fault' && (typeof attempt.fault !== 'string' || attempt.fault.length === 0)) fail('fault must be a non-empty string for kind=fault');
}

function validateAssertions(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const assertions = value.assertions;
  if (!isObject(assertions)) {
    fail('assertions object missing');
    return;
  }
  if (!Number.isInteger(assertions.provider_attempt_count) || assertions.provider_attempt_count < 0) {
    fail(`assertions.provider_attempt_count invalid: ${assertions.provider_attempt_count}`);
  }
  if (typeof assertions.probe_attempts_may_occur !== 'boolean') fail('assertions.probe_attempts_may_occur must be boolean');
  if (typeof assertions.no_control_leakage !== 'boolean') fail('assertions.no_control_leakage must be boolean');
  // provider_attempt_count is asserted per turn by the runner; it is not a
  // reconciliation of the total scripted attempts across turns.
}

function validateRuntimeSetup(relative, setup, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (setup === undefined) return;
  if (!isObject(setup)) {
    fail('runtime_setup must be an object when present');
    return;
  }
  for (const key of Object.keys(setup)) {
    if (!RUNTIME_SETUP_KEYS.has(key)) fail(`runtime_setup.${key} is not a supported field`);
  }
  if (typeof setup.provider_id !== 'string' || !PROVIDER_ID_PATTERN.test(setup.provider_id)) {
    fail(`runtime_setup.provider_id invalid: ${setup.provider_id ?? 'null'}`);
  }
  if (typeof setup.model !== 'string' || setup.model.length === 0) {
    fail('runtime_setup.model must be a non-empty string');
  }
  if (typeof setup.wire_model !== 'string' || setup.wire_model.length === 0) {
    fail('runtime_setup.wire_model must be a non-empty string');
  }
  if (!Array.isArray(setup.candidate_ids) || setup.candidate_ids.length === 0 || setup.candidate_ids.some((candidate) => typeof candidate !== 'string')) {
    fail('runtime_setup.candidate_ids must be a non-empty string array');
    return;
  }
  for (const candidate of setup.candidate_ids) {
    const parts = candidate.split('/');
    if (parts.length !== 2 || parts.some((part) => !PROVIDER_ID_PATTERN.test(part))) {
      fail(`runtime_setup.candidate_ids entry must be provider/model: ${candidate}`);
    }
  }
  if (new Set(setup.candidate_ids).size !== setup.candidate_ids.length) {
    fail('runtime_setup.candidate_ids must be unique');
  }
  const firstCandidate = `${setup.provider_id}/${setup.model}`;
  if (setup.candidate_ids[0] !== firstCandidate) {
    fail(`runtime_setup.candidate_ids[0] must be ${firstCandidate}`);
  }
  if (setup.all_candidates_fail !== undefined && typeof setup.all_candidates_fail !== 'boolean') {
    fail('runtime_setup.all_candidates_fail must be boolean when present');
  }
  if (setup.attempt_store !== undefined) {
    const store = setup.attempt_store;
    if (!isObject(store)) {
      fail('runtime_setup.attempt_store must be an object');
      return;
    }
    const keys = ['request_max_attempts', 'attempt_max_bytes', 'attempt_max_frames', 'request_max_bytes', 'process_max_bytes', 'residence_timeout_ms'];
    for (const [key, value] of Object.entries(store)) {
      if (!keys.includes(key)) fail(`runtime_setup.attempt_store.${key} is not a supported field`);
      if (!Number.isInteger(value) || value < 1) fail(`runtime_setup.attempt_store.${key} must be a positive integer`);
    }
    for (const [lower, upper] of [['attempt_max_bytes', 'request_max_bytes'], ['request_max_bytes', 'process_max_bytes']]) {
      if (store[lower] !== undefined && store[upper] !== undefined && store[lower] > store[upper]) {
        fail(`runtime_setup.attempt_store.${lower} must not exceed ${upper}`);
      }
    }
  }
  if (setup.process !== undefined) {
    if (typeof setup.process !== 'string' || setup.process.trim().length === 0) {
      fail('runtime_setup.process must be a non-empty string when present');
    }
  }
  if (setup.health !== undefined) {
    const health = setup.health;
    if (!isObject(health)) {
      fail('runtime_setup.health must be an object');
      return;
    }
    const keys = Object.keys(health);
    if (keys.length === 0) {
      fail('runtime_setup.health must declare at least one field');
    }
    for (const [key, value] of Object.entries(health)) {
      if (!PROVIDER_HEALTH_KEYS.has(key)) {
        fail(`runtime_setup.health.${key} is not a supported field`);
      }
      if (key === 'enabled' || key === 'advisory_probe') {
        if (typeof value !== 'boolean') fail(`runtime_setup.health.${key} must be boolean`);
      } else if (!Number.isInteger(value) || value < 1) {
        fail(`runtime_setup.health.${key} must be a positive integer`);
      }
    }
  }
}

const CLIENT_ERROR_MARKERS = ['provider_error', 'internal_error', 'routecodex_internal'];

function validateRequestIndependenceReplay(relative, value, findings) {
  const replay = value.request_independence_replay;
  if (replay === undefined) return;
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(replay)) {
    fail('request_independence_replay must be an object when present');
    return;
  }
  if (!REQUEST_INDEPENDENCE_KINDS.has(replay.kind)) {
    fail(`request_independence_replay.kind must be provider_request_independence: ${replay.kind ?? 'null'}`);
  }
  const shape = replay.shape ?? 'held_concurrent_requests';
  if (!REQUEST_INDEPENDENCE_SHAPES.has(shape)) {
    fail(`request_independence_replay.shape invalid: ${shape}`);
    return;
  }
  if (!Array.isArray(replay.typed_error_codes_must_not)
    || replay.typed_error_codes_must_not.some((code) => typeof code !== 'string' || code.length === 0)) {
    fail('request_independence_replay.typed_error_codes_must_not must be a string array');
  } else if (!replay.typed_error_codes_must_not.includes('provider_concurrency_busy')) {
    fail('request_independence_replay.typed_error_codes_must_not must include provider_concurrency_busy');
  }
  if (value.upstream_response?.attempts?.[0]?.fault !== 'hold-open-controlled') {
    fail('request_independence_replay requires first upstream attempt fault hold-open-controlled');
  }
  const holderSession = value.client_request?.headers?.['session-id'];
  if (typeof holderSession !== 'string' || holderSession.length === 0) {
    fail('client_request.headers.session-id must be a non-empty string');
  }
  if (value.cell?.mode === 'direct' && value.runtime_setup?.process !== 'direct') {
    fail('direct request_independence_replay requires runtime_setup.process = direct');
  }
  if (shape === 'held_concurrent_requests') {
    validateHeldConcurrentRequestReplay(relative, value, replay, holderSession, fail, findings);
    return;
  }
  validateFailureIsolationReplay(relative, value, replay, holderSession, fail, findings);
}

function validateHeldConcurrentRequestReplay(relative, value, replay, holderSession, fail, findings) {
  const requests = replay.concurrent_client_requests;
  if (!Array.isArray(requests) || requests.length < 1) {
    fail('request_independence_replay.concurrent_client_requests must be a non-empty array');
    return;
  }
  requests.forEach((request, index) => {
    const label = `request_independence_replay.concurrent_client_requests[${index}]`;
    validateClientRequest(`${relative}: ${label}`, request, findings);
    if (!isObject(request)) return;
    if (request.path !== value.client_request?.path) {
      fail(`${label}.path must equal client_request.path`);
    }
    const session = request.headers?.['session-id'];
    if (typeof session !== 'string' || session.length === 0) {
      fail(`${label}.headers.session-id must be a non-empty string`);
    }
  });
  if (replay.expected_upstream_business_sends !== requests.length + 1) {
    fail('request_independence_replay.expected_upstream_business_sends must equal one holder plus each concurrent request');
  }
  validateCompleteClientExpectation(
    'request_independence_replay.expected_concurrent_client',
    replay.expected_concurrent_client,
    fail,
  );
}

function validateFailureIsolationReplay(relative, value, replay, holderSession, fail, findings) {
  const failedRequest = replay.failed_client_request;
  validateClientRequest(`${relative}: request_independence_replay.failed_client_request`, failedRequest, findings);
  const recoveryRequest = replay.post_recovery_client_request;
  validateClientRequest(`${relative}: request_independence_replay.post_recovery_client_request`, recoveryRequest, findings);
  for (const [label, request] of [
    ['failed_client_request', failedRequest],
    ['post_recovery_client_request', recoveryRequest],
  ]) {
    if (!isObject(request)) continue;
    if (request.path !== value.client_request?.path) {
      fail(`request_independence_replay.${label}.path must equal client_request.path`);
    }
    const session = request.headers?.['session-id'];
    if (typeof session !== 'string' || session.length === 0) {
      fail(`request_independence_replay.${label}.headers.session-id must be a non-empty string`);
    }
  }
  validateCompleteClientExpectation(
    'request_independence_replay.expected_failed_client',
    replay.expected_failed_client,
    fail,
  );
  validateCompleteClientExpectation(
    'request_independence_replay.expected_post_recovery_client',
    replay.expected_post_recovery_client,
    fail,
  );
  const isolation = replay.failure_isolation;
  if (!isObject(isolation)) {
    fail('request_independence_replay.failure_isolation must be an object');
    return;
  }
  for (const key of ['failed_provider_id', 'recovered_provider_id']) {
    if (typeof isolation[key] !== 'string' || isolation[key].length === 0) {
      fail(`request_independence_replay.failure_isolation.${key} must be a non-empty string`);
    }
  }
  const candidates = Array.isArray(value.runtime_setup?.candidate_ids)
    ? value.runtime_setup.candidate_ids
    : [];
  if (candidates.length < 2) {
    fail('failure_isolation requires at least two candidate_ids');
  }
  if (isolation.failed_provider_id && !candidates.some((candidate) => candidate.startsWith(`${isolation.failed_provider_id}/`))) {
    fail('failure_isolation.failed_provider_id must be one of runtime_setup.candidate_ids');
  }
  if (isolation.recovered_provider_id && !candidates.some((candidate) => candidate.startsWith(`${isolation.recovered_provider_id}/`))) {
    fail('failure_isolation.recovered_provider_id must be one of runtime_setup.candidate_ids');
  }
  if (!Number.isInteger(isolation.expected_provider_status)
    || isolation.expected_provider_status < 400
    || isolation.expected_provider_status > 599) {
    fail('failure_isolation.expected_provider_status must be a provider HTTP error status 400-599');
  }
  if (isolation.expected_action !== 'switch_provider') {
    fail('failure_isolation.expected_action must be switch_provider');
  }
  if (isolation.expected_failed_business_sends !== 1) {
    fail('failure_isolation.expected_failed_business_sends must be 1');
  }
  if (!Number.isInteger(isolation.expected_recovery_business_sends)
    || isolation.expected_recovery_business_sends < 1) {
    fail('failure_isolation.expected_recovery_business_sends must be a positive integer');
  }
  if (isolation.expected_holder_business_sends !== 1) {
    fail('failure_isolation.expected_holder_business_sends must be 1');
  }
  if (value.runtime_setup?.health?.enabled !== true) {
    fail('failure_isolation requires runtime_setup.health.enabled = true');
  }
  if (value.upstream_response?.attempts?.[1]?.status !== isolation.expected_provider_status) {
    fail('failure_isolation requires the second upstream attempt to return the declared provider error status');
  }
}

function validateCompleteClientExpectation(label, expected, fail) {
  if (!isObject(expected)) {
    fail(`${label} must be an object`);
    return;
  }
  if (expected.transport !== 'complete') {
    fail(`${label}.transport must be complete`);
  }
  if (expected.status !== 200) {
    fail(`${label}.status must be 200`);
  }
  if (!isObject(expected.body_must) || Object.keys(expected.body_must).length === 0) {
    fail(`${label}.body_must must declare the genuine response fields`);
  }
  if (!Array.isArray(expected.body_must_not)) {
    fail(`${label}.body_must_not must be a string array`);
  } else if (!CLIENT_ERROR_MARKERS.every((marker) => expected.body_must_not.includes(marker))) {
    fail(`${label}.body_must_not must forbid provider_error, internal_error and routecodex_internal`);
  }
  if (expected.semantic_terminal_required !== true) {
    fail(`${label}.semantic_terminal_required must be true`);
  }
}

function validateTurns(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const turns = value.turns;
  if (turns === undefined) return;
  if (!Array.isArray(turns) || turns.length < 2) {
    fail('turns must be an array with at least two entries when present');
    return;
  }
  const seenIds = new Set();
  for (const [index, turn] of turns.entries()) {
    if (!isObject(turn)) {
      fail(`turns[${index}] must be an object`);
      continue;
    }
    if (typeof turn.turn_id !== 'string' || !ID_PATTERN.test(turn.turn_id)) {
      fail(`turns[${index}].turn_id invalid: ${turn.turn_id}`);
    } else if (seenIds.has(turn.turn_id)) {
      fail(`turns[${index}].turn_id duplicate: ${turn.turn_id}`);
    } else {
      seenIds.add(turn.turn_id);
    }
    const hasRequest = isObject(turn.client_request);
    const hasProvider = isObject(turn.expected_provider);
    const hasProviderExact = isObject(turn.expected_provider_exact);
    const hasProviderExactAttempts = turn.expected_provider_exact_attempts !== undefined;
    const hasClientMust = isObject(turn.expected_client_must);
    if (index === 0 && hasProviderExact && typeof turn.expected_provider_exact === 'object') {
      fail('turns[0].expected_provider_exact must not redefine the top-level first provider shape');
    }
    if (index === 0 && isObject(turn.upstream_response)) {
      fail('turns[0].upstream_response must not redefine the top-level first upstream script');
    }
    if (index > 0 && !hasRequest) fail(`turns[${index}] must declare client_request`);
    if (index > 0 && !hasRequest && !hasProvider && !hasProviderExact && !hasClientMust) {
      fail(`turns[${index}] must assert a follow-up provider shape or client output`);
    }
    if (index > 0 && hasProvider && hasProviderExact) {
      fail(`turns[${index}] must not declare both expected_provider and expected_provider_exact`);
    }
    if (hasProviderExactAttempts) {
      if (index === 0) fail('turns[0].expected_provider_exact_attempts is not allowed on the first turn');
      if (!hasProviderExact) fail(`turns[${index}].expected_provider_exact_attempts requires expected_provider_exact`);
      if (!Array.isArray(turn.expected_provider_exact_attempts) || turn.expected_provider_exact_attempts.length < 2) {
        fail(`turns[${index}].expected_provider_exact_attempts must be an array with at least two entries`);
      } else if (turn.expected_provider_exact_attempts.some((body) => !isObject(body))) {
        fail(`turns[${index}].expected_provider_exact_attempts entries must be objects`);
      }
    }
    if (hasRequest) validateClientRequest(`${relative}: turns[${index}].client_request`, turn.client_request, findings);
    if (hasProvider) validateExpectedProvider(`${relative}: turns[${index}].expected_provider`, turn.expected_provider, findings);
    if (isObject(turn.upstream_response)) validateUpstream(relative, turn.upstream_response, findings, `turns[${index}].upstream_response`);
  }
}

function validateSource(relative, source, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(source)) {
    fail('source object missing');
    return;
  }
  if (!Array.isArray(source.files)) fail('source.files must be an array');
  if (!Array.isArray(source.tests)) fail('source.tests must be an array');
  for (const test of source.tests ?? []) {
    if (typeof test !== 'string' || !test.includes('::')) fail(`source.tests entry must be file::TestName: ${test}`);
  }
}

function validateToolFollowup(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const followup = value.tool_followup;
  if (followup === undefined) return;
  if (!isObject(followup)) {
    fail('tool_followup must be an object when present');
    return;
  }
  const hasToolFlag = followup.assert_no_synthesized_tool_result === true
    || followup.assert_declared_tool_binding_only === true
    || followup.assert_tool_executed_once === true;
  if (!hasToolFlag) fail('tool_followup must declare at least one tool assertion flag');
  const executingConsumers = new Set(['echo', 'structured-echo', 'echo-line-result', 'local-namespace-mock', 'unknown-tool-correction', 'codex-real-exec']);
  if (followup.assert_tool_executed_once === true && !executingConsumers.has(followup.consumer)) {
    fail('tool_followup.assert_tool_executed_once requires an executing consumer (echo, echo-line-result, local-namespace-mock or unknown-tool-correction)');
  }
  if (followup.consumer === 'local-namespace-mock') {
    const binding = followup.binding;
    if (!isObject(binding) || binding.namespace !== 'collaboration' || binding.name !== 'spawn_agent' || binding.type !== 'function') {
      fail('tool_followup.consumer local-namespace-mock requires binding {namespace: collaboration, name: spawn_agent, type: function}');
    }
    if (followup.side_effect !== 'exclusive-local-file') {
      fail('tool_followup.consumer local-namespace-mock requires side_effect exclusive-local-file');
    }
    const firstRequest = value.turns?.[0]?.client_request ?? value.client_request;
    const tools = firstRequest?.body?.tools;
    const declared = Array.isArray(tools)
      && (tools.find((tool) => tool.type === 'namespace' && tool.name === 'collaboration')
        ?.tools ?? []).some((tool) => tool.type === 'function' && tool.name === 'spawn_agent');
    if (!declared) {
      fail('tool_followup.consumer local-namespace-mock requires the originating collaboration.spawn_agent declaration');
    }
  }
  if (!Array.isArray(value.turns) || value.turns.length < 2) {
    fail('tool_followup requires at least two turns');
    return;
  }
  if (followup.consumer === 'echo-line-result') {
    validateEchoLineResultFollowup(relative, value, followup, findings);
    return;
  }
  if (followup.consumer === 'structured-echo') {
    if (value.cell?.entry_protocol !== 'responses') {
      fail('tool_followup.consumer structured-echo requires the responses entry protocol');
    }
    if (followup.side_effect !== 'none') {
      fail('tool_followup.consumer structured-echo requires side_effect none');
    }
    if (followup.assert_no_synthesized_tool_result !== true
      || followup.assert_declared_tool_binding_only !== true
      || followup.assert_tool_executed_once !== true) {
      fail('tool_followup.consumer structured-echo requires all three tool assertion flags');
    }
  }
  if (followup.consumer === 'codex-real-exec') {
    validateCodexRealExecFollowup(relative, value, followup, findings);
    return;
  }
  // Search only the scripted request/turn history. Including tool_followup
  // would make its own input/expected_output trivially self-match.
  const corpus = `${JSON.stringify(value.client_request)}\n${JSON.stringify(value.turns)}`;
  if (followup.expected_output !== undefined) {
    const needle = historyNeedle(followup.expected_output);
    if (needle && !corpus.includes(needle)) fail(`tool_followup.expected_output not present in scripted history: ${needle}`);
  }
  if (isObject(followup.input)) {
    for (const [key, expected] of Object.entries(followup.input)) {
      const needle = historyNeedle(expected);
      if (typeof expected === 'string' && !corpus.includes(needle)) {
        fail(`tool_followup.input.${key} not present in scripted history: ${needle}`);
      }
    }
  }
  const followupTurn = value.turns[value.turns.length - 1];
  if (!isObject(followupTurn) || !isObject(followupTurn.client_request)) {
    fail('tool_followup requires a final follow-up turn with client_request');
  }
}

function validateCodexRealExecFollowup(relative, value, followup, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (value.case_id !== 'issue-3192e71-codex-integer-positive') {
    fail('tool_followup.consumer codex-real-exec is reserved for issue-3192e71-codex-integer-positive');
  }
  if (followup.side_effect !== 'read-only-command') {
    fail('tool_followup.consumer codex-real-exec requires side_effect read-only-command');
  }
  if (!Array.isArray(followup.authorized_commands)
    || followup.authorized_commands.length !== 1
    || followup.authorized_commands[0] !== 'pwd') {
    fail('tool_followup.consumer codex-real-exec requires authorized_commands ["pwd"]');
  }
  if (followup.expected_call_id !== 'call_int_1') {
    fail('tool_followup.consumer codex-real-exec requires expected_call_id call_int_1');
  }
  if (followup.expected_arguments !== '{"cmd":"pwd","max_output_tokens":8000,"yield_time_ms":20000}') {
    fail('tool_followup.consumer codex-real-exec requires the exact normalized expected_arguments');
  }
  if (followup.expected_output !== undefined) {
    fail('tool_followup.consumer codex-real-exec must derive output from the execution receipt');
  }
  if (followup.assert_no_synthesized_tool_result !== true
    || followup.assert_declared_tool_binding_only !== true
    || followup.assert_tool_executed_once !== true) {
    fail('tool_followup.consumer codex-real-exec requires all three tool assertion flags');
  }
}

function validateCodexReplayCase(relative, value, findings) {
  if (!CODEX_REAL_EXEC_CASES.has(value.case_id)) return;
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const realClient = value.case_id === 'issue-3192e71-codex-integer-positive';
  const cell = value.cell;
  if (cell?.entry_protocol !== 'responses'
    || cell?.provider_protocol !== 'openai_chat'
    || cell?.transport !== (realClient ? 'sse' : 'json')
    || cell?.mode !== 'relay') {
    fail(`Codex replay cases require the exact responses->openai_chat ${realClient ? 'sse' : 'json'} relay cell`);
  }
  if (value.client_request?.path !== '/v1/responses') {
    fail('Codex replay client_request.path must be /v1/responses');
  }
  if (value.client_request?.body?.model !== 'mock.chat-model') {
    fail('Codex replay client_request.body.model must be mock.chat-model');
  }
  const expectedStream = realClient;
  if (value.client_request?.body?.stream !== expectedStream) {
    fail(`Codex replay client_request.body.stream must be ${expectedStream}`);
  }
  if (value.expected_provider?.body_must?.stream !== expectedStream) {
    fail(`Codex replay expected_provider.body_must.stream must be ${expectedStream}`);
  }
  if (value.upstream_response?.mode !== (realClient ? 'sse' : 'json')) {
    fail(`Codex replay upstream_response.mode must be ${realClient ? 'sse' : 'json'}`);
  }

  if (value.case_id === 'issue-57c0176-singular-tool-call-text') {
    validateSingularTextCase(relative, value, findings);
    return;
  }

  const tools = value.client_request?.body?.tools;
  const execTools = Array.isArray(tools)
    ? tools.filter((tool) => tool?.type === 'function' && tool?.name === 'exec_command')
    : [];
  if (execTools.length !== 1) {
    fail(`Codex integer replay requires exactly one exec_command declaration, observed ${execTools.length}`);
    return;
  }
  const tool = execTools[0];
  if (tool.strict !== false) fail('Codex exec_command.strict must be false');
  if (tool.parameters?.type !== 'object' || tool.parameters?.additionalProperties !== false) {
    fail('Codex exec_command.parameters must be a closed object');
  }
  if (JSON.stringify(tool.parameters?.required) !== JSON.stringify(['cmd'])) {
    fail('Codex exec_command.parameters.required must be ["cmd"]');
  }
  const integerFields = ['max_output_tokens', 'yield_time_ms'];
  if (value.case_id === 'issue-3192e71-user-schema-negative') {
    if (tool.description !== 'User-defined command tool') {
      fail('user-schema-negative must use description User-defined command tool');
    }
    if (tool.parameters?.properties?.max_output_tokens?.minimum !== 1) {
      fail('user-schema-negative must preserve max_output_tokens.minimum 1');
    }
  } else if (tool.description !== CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION) {
    fail(`registered exec_command description must be ${JSON.stringify(CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION)}`);
  }
  for (const field of integerFields) {
    if (tool.parameters?.properties?.[field]?.type !== 'number') {
      fail(`client exec_command.${field}.type must be number so inbound conversion is exercised`);
    }
  }
  const expectedType = value.case_id === 'issue-3192e71-user-schema-negative' ? 'number' : 'integer';
  for (const field of integerFields) {
    const path = `tools.0.function.parameters.properties.${field}.type`;
    if (value.expected_provider?.body_must?.[path] !== expectedType) {
      fail(`expected_provider.body_must.${path} must be ${expectedType}`);
    }
  }
  const expectedCall = CODEX_INTEGER_ARGUMENT_CASES.get(value.case_id);
  const providerCall = upstreamProviderToolCall(value.upstream_response);
  if (!expectedCall
    || providerCall?.id !== expectedCall.call_id
    || providerCall?.type !== 'function'
    || providerCall?.function?.name !== 'exec_command'
    || providerCall?.function?.arguments !== expectedCall.upstream_arguments) {
    fail('upstream exec_command call must preserve the exact declared call id, name, and raw arguments');
  }
  if (!expectedCall
    || value.expected_client?.body_must?.['output.length'] !== 1
    || value.expected_client?.body_must?.['output.0.type'] !== 'function_call'
    || value.expected_client?.body_must?.['output.0.call_id'] !== expectedCall.call_id
    || value.expected_client?.body_must?.['output.0.name'] !== 'exec_command'
    || value.expected_client?.body_must?.['output.0.arguments'] !== expectedCall.client_arguments) {
    fail('client exec_command call must preserve the declared call id, name, and exact raw arguments');
  }
  if (CODEX_NEGATIVE_CASES.has(value.case_id)) {
    if (value.tool_followup !== undefined) fail('Codex integer negative cases may not declare tool_followup');
    if (value.turns !== undefined) fail('Codex integer negative cases must be one-turn assertion-only fixtures');
  }
  if (value.case_id === 'issue-3192e71-codex-integer-positive') {
    if (value.tool_followup === undefined) {
      fail('codex-integer-positive must declare the real codex-real-exec tool_followup');
    }
    if (!Array.isArray(value.turns) || value.turns.length !== 2) {
      fail('codex-integer-positive requires exactly two turns');
    }
  }
}

function upstreamProviderToolCall(upstream) {
  const direct = upstream?.body?.choices?.[0]?.message?.tool_calls?.[0];
  if (direct) return direct;
  const events = Array.isArray(upstream?.sse_events) ? upstream.sse_events : [];
  for (const event of events) {
    const call = event?.data?.choices?.[0]?.delta?.tool_calls?.[0];
    if (call?.function?.arguments) return call;
  }
  return null;
}

function validateSingularTextCase(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const namespace = value.client_request?.body?.tools?.[0];
  if (namespace?.type !== 'namespace'
    || namespace?.name !== 'functions'
    || namespace?.tools?.length !== 1
    || namespace.tools[0]?.type !== 'custom'
    || namespace.tools[0]?.name !== 'exec') {
    fail('singular-text case requires the exact functions.exec custom namespace declaration');
  }
  if (value.tool_followup !== undefined) {
    fail('singular-text case is assertion-only and must not declare tool_followup');
  }
  if (!Array.isArray(value.turns) || value.turns.length !== 2) {
    fail('singular-text case requires exactly two assertion-only turns');
  }
  if (value.upstream_response?.body?.choices?.[0]?.message?.content !== SINGULAR_TOOL_CALL_TEXT
    || value.upstream_response?.body?.choices?.[0]?.message?.tool_calls !== undefined) {
    fail('singular-text upstream response must contain only the exact assistant text and no typed call');
  }
  if (value.expected_client?.body_must?.['output.0.content.0.text'] !== SINGULAR_TOOL_CALL_TEXT
    || value.expected_client?.body_must?.output_text !== SINGULAR_TOOL_CALL_TEXT) {
    fail('singular-text client response must preserve the exact assistant text');
  }
  if (value.expected_provider?.body_must?.['tools.0.function.name'] !== 'functions__exec') {
    fail('singular-text expected provider tool name must be functions__exec');
  }
  const singularOutputLength = value.expected_client?.body_must?.['output.length'];
  if (singularOutputLength !== 2
    || value.expected_client?.body_must?.['output.0.type'] !== 'message') {
    fail(`singular-text client response must assert exactly two assistant messages, saw ${singularOutputLength}`);
  }
}

// The echo-line-result consumer is a pure local test function bound to the
// declared `echo` tool. Its declared result is a fixed structured business
// value, so the paired Gemini functionResponse must carry exactly that object.
function validateEchoLineResultFollowup(relative, value, followup, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  // The paired response is compared structurally, never through a history
  // substring. The template's own business fields are not a source of truth.
  const expected = followup.expected_output;
  if (followup.side_effect !== 'none') {
    fail('tool_followup.consumer echo-line-result requires side_effect none');
  }
  if (!isObject(followup.input) || typeof followup.input.message !== 'string') {
    fail('tool_followup.consumer echo-line-result requires a string input.message');
  }
  const expectedOk = isObject(expected)
    && Object.keys(expected).length === 2
    && typeof expected.output === 'string'
    && expected.exitCode === 0;
  if (!expectedOk) {
    fail('tool_followup.consumer echo-line-result requires expected_output {output: string, exitCode: 0}');
  }
  if (followup.assert_no_synthesized_tool_result !== true
    || followup.assert_declared_tool_binding_only !== true
    || followup.assert_tool_executed_once !== true) {
    fail('tool_followup.consumer echo-line-result requires all three tool assertion flags');
  }
  if (value.cell?.entry_protocol !== 'gemini') {
    fail('tool_followup.consumer echo-line-result requires the gemini entry protocol');
  }
  const firstRequest = value.turns?.[0]?.client_request ?? value.client_request;
  const declared = (firstRequest?.body?.tools ?? []).some((tool) => Array.isArray(tool.functionDeclarations)
    && tool.functionDeclarations.some((declaration) => declaration.name === 'echo'));
  if (!declared) {
    fail('tool_followup.consumer echo-line-result requires the originating echo declaration');
  }
  // Locate the paired functionResponse by structure, then compare the complete
  // response object. A JSON history substring must not stand in for this.
  const finalTurn = value.turns[value.turns.length - 1];
  const contents = finalTurn?.client_request?.body?.contents;
  const response = Array.isArray(contents)
    ? contents.flatMap((entry) => entry?.parts ?? []).map((part) => part?.functionResponse).find((entry) => isObject(entry) && entry.name === 'echo')?.response
    : undefined;
  if (!isObject(response) || !isDeepStrictEqual(response, expected)) {
    fail('tool_followup.consumer echo-line-result requires the paired functionResponse.response to equal expected_output');
  }
}

// The history is compared as JSON text, so a value is present when its
// JSON-escaped form appears. This keeps newline-bearing echo outputs (for
// example "native-tool-result\n") exact instead of comparing a raw newline
// against the escaped `\n` the JSON text actually stores.
function historyNeedle(value) {
  return typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : JSON.stringify(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

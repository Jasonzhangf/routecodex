// Fixture/turn contract interpretation for the `v3.protocol_live_mock_matrix`
// case runner. This module owns raw client receipt observation and the
// contract helpers used by case flow. It never sends HTTP or writes evidence.
//
// Import-safe: no listeners, no CLI, no I/O at import time.

import { parseClientBody, SUPPORTED_PROTOCOLS } from './protocol-semantics.mjs';

const MOCK_CAPABILITIES = Object.freeze(['setActiveCase', 'setTurn', 'getCaptures']);

// Connection-level failures that prove the endpoint itself was unavailable.
// Socket resets from an intentionally closed transport stay product evidence.
const ENDPOINT_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export function describeTurns(fixture) {
  const declared = Array.isArray(fixture.turns) && fixture.turns.length > 0 ? fixture.turns : [];
  const count = Math.max(1, declared.length);
  const turns = [];
  for (let index = 0; index < count; index += 1) {
    const turn = declared[index] ?? null;
    const isFirst = index === 0;
    turns.push({
      index,
      turn_id: turn?.turn_id ?? null,
      request: isFirst ? (turn?.client_request ?? fixture.client_request) : turn?.client_request ?? null,
      providerExpected: turn?.expected_provider_exact
        ? { ...laterTurnProviderShape(fixture.expected_provider ?? {}), exact: turn.expected_provider_exact }
        : (isFirst ? fixture.expected_provider : null),
      clientExpected: describeClientExpected(fixture, turn, isFirst),
      upstream: isFirst
        ? (fixture.upstream_response ?? turn?.upstream_response ?? null)
        : (turn?.upstream_response ?? null),
      declaredAttemptCount: isFirst && Number.isInteger(fixture.assertions?.provider_attempt_count)
        ? fixture.assertions.provider_attempt_count
        : null,
    });
  }
  return turns;
}

// A later turn's `expected_provider_exact` is the complete intended provider
// body for that turn. Inherit only the stable non-body assertions (method,
// paths, auth, forbidden keys); the first-turn `body_must` subset describes the
// first turn and would contradict the later turn's exact body.
function laterTurnProviderShape(provider) {
  const stable = { ...provider };
  delete stable.body_must;
  return stable;
}

function describeClientExpected(fixture, turn, isFirst) {
  const base = isFirst ? (fixture.expected_client ?? null) : null;
  const turnMust = turn?.expected_client_must;
  const turnContract = turn?.expected_client_contract;

  if (!turnMust && !turnContract) return base;

  const expected = {
    ...clientContractFields(base),
    ...clientContractFields(turnContract),
  };
  if (turnMust) {
    expected.transport = expected.transport ?? 'complete';
    expected.body_must = turnMust;
  } else if (isFirst && base?.body_must) {
    expected.body_must = base.body_must;
  }
  return expected;
}

function clientContractFields(value) {
  if (!isPlainObject(value)) return {};
  const fields = {};
  for (const key of [
    'transport',
    'status',
    'body_must_not',
    'semantic_terminal_required',
    'committed_business_stream',
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) fields[key] = value[key];
  }
  return fields;
}

export function capabilityGaps({ fixture, mock, rccUrl, sendHttp, evidenceRoot, entryProtocol }) {
  const gaps = [];
  if (!isPlainObject(fixture)) gaps.push('capability_missing: fixture object required');
  if (typeof rccUrl !== 'string' || rccUrl.length === 0) gaps.push('capability_missing: rccUrl required');
  if (typeof sendHttp !== 'function') gaps.push('capability_missing: caller sendHttp adapter required');
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) gaps.push('capability_missing: evidenceRoot required');
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol)) {
    gaps.push(`capability_missing: unsupported entry_protocol ${text(entryProtocol) || 'null'}`);
  }
  if (!isPlainObject(mock)) {
    gaps.push('capability_missing: mock provider handle required');
  } else {
    for (const name of MOCK_CAPABILITIES) {
      if (typeof mock[name] !== 'function') gaps.push(`capability_missing: mock.${name} required`);
    }
  }
  return gaps;
}

export function observeClientResult(raw, entryProtocol) {
  const source = isPlainObject(raw) ? raw : {};
  const headers = normalizeHeaders(source.headers ?? source.received_headers);
  const bodyText = bodyTextOf(source);
  const contentType = headerValue(headers, 'content-type') ?? '';
  let parsed;
  try {
    parsed = parseClientBody(entryProtocol, bodyText, contentType);
  } catch (error) {
    const failure = new Error(`client body parse failed: ${error.message}`);
    failure.code = 'PROTOCOL_PARSE';
    throw failure;
  }
  const observation = parsed?.ok === true ? parsed : null;
  const parseDiagnostic = observation === null ? parsed : null;
  return {
    ...source,
    headers,
    bodyText,
    observation,
    parse_diagnostic: parseDiagnostic,
  };
}

export function scriptedAttemptCount(upstream) {
  if (!isPlainObject(upstream)) return 0;
  if (Array.isArray(upstream.attempts) && upstream.attempts.length > 0) return upstream.attempts.length;
  return 1;
}

export function requestHeaders(request) {
  return {
    'content-type': 'application/json',
    ...(isPlainObject(request.headers) ? request.headers : {}),
  };
}

export function endpointUnavailable(raw) {
  if (!isPlainObject(raw)) return false;
  if (raw.status !== null && raw.status !== undefined) return false;
  return ENDPOINT_UNAVAILABLE_CODES.has(errorCodeOf(raw));
}

export function errorSummary(raw) {
  const code = errorCodeOf(raw);
  return [code, raw?.error, raw?.error_detail?.message].filter(Boolean).join(' ');
}

export function bodyTextOf(raw) {
  if (typeof raw?.bodyText === 'string') return raw.bodyText;
  if (typeof raw?.text === 'string') return raw.text;
  return '';
}

export function errorCodeOf(raw) {
  const detail = raw?.error_detail;
  if (detail?.code) return String(detail.code);
  if (detail?.errno) return String(detail.errno);
  return null;
}

export function normalizeHeaders(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      output[String(key).toLowerCase()] = String(value);
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers)) {
    output[String(key).toLowerCase()] = value === undefined || value === null ? '' : String(value);
  }
  return output;
}

function headerValue(headers, name) {
  return Object.prototype.hasOwnProperty.call(headers || {}, name) ? headers[name] : undefined;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value) {
  return typeof value === 'string' ? value : '';
}

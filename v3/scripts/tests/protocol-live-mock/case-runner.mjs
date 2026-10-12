// Per-case orchestration for the `v3.protocol_live_mock_matrix` harness.
//
// This module owns the case flow only: it drives one fixture through the
// caller-provided real RCC HTTP endpoint, retains raw client evidence, routes
// client bodies through the single protocol observation owner, activates the
// mock provider turn script, and delegates all assertions to the shared
// assertion layer. It never starts RCC, never calls a codec/internal driver,
// and never claims source provenance from an installed binary.
//
// Import-safe: no listeners, no CLI, no I/O at import time.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertClientResult,
  assertProviderAttemptSequence,
  assertProviderCaptures,
} from './assertions.mjs';
import {
  findSemanticTerminal,
  parseClientBody,
  SUPPORTED_PROTOCOLS,
} from './protocol-semantics.mjs';
import { runToolFollowup } from './tool-consumer.mjs';

const PROTOCOL_DEPS = Object.freeze({
  parseClientBody,
  findSemanticTerminal,
});

// Must stay aligned with PROBE_ATTEMPT_KINDS in assertions.mjs: only an
// explicit capture kind removes a request from the business attempt count.
const EXCLUDED_ATTEMPT_KINDS = new Set(['probe', 'startup']);

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
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

/**
 * Run one fixture case through `rccUrl` using `sendHttp`.
 *
 * @param {{fixture: object, mock: object, rccUrl: string, sendHttp: Function,
 *   evidenceRoot: string, timeoutMs?: number}} input The mock handle follows
 *   the published API: `setActiveCase(fixture, turnIndex)`, `setTurn(turnIndex)`,
 *   `getCaptures(caseId)`, `close()`.
 * @returns {Promise<object>} per-case report compatible with the main runner
 *   fields plus explicit `observations.live`, `observations.infra` and
 *   `evidence_refs`.
 */
export async function runCase({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const cell = isPlainObject(fixture?.cell) ? fixture.cell : {};
  const entryProtocol = text(cell.entry_protocol ?? fixture?.entry_protocol);
  const providerProtocol = text(cell.provider_protocol ?? fixture?.provider_protocol);
  const caseId = text(fixture?.case_id) || 'unknown-case';
  const report = {
    case_id: caseId,
    cell: {
      entry_protocol: entryProtocol,
      provider_protocol: providerProtocol,
      transport: text(cell.transport),
      mode: text(cell.mode),
    },
    classification: null,
  };

  const gaps = capabilityGaps({ fixture, mock, rccUrl, sendHttp, evidenceRoot, entryProtocol });
  if (gaps.length > 0) {
    return finalizeReport(report, {
      productDiagnostics: [],
      runnerDiagnostics: [],
      capabilityDiagnostics: gaps,
      live: [],
      turnResults: [],
      evidenceRefs: [],
    });
  }

  const productDiagnostics = [];
  const runnerDiagnostics = [];
  const live = [];
  const turnResults = [];
  const evidenceRefs = [];
  const captureDir = join(evidenceRoot, 'captures');

  try {
    mkdirSync(captureDir, { recursive: true });
  } catch (error) {
    runnerDiagnostics.push(`evidence root unwritable: ${error.message}`);
    return finalizeReport(report, {
      productDiagnostics,
      runnerDiagnostics,
      capabilityDiagnostics: [],
      live,
      turnResults,
      evidenceRefs,
    });
  }

  const noControlLeakage = fixture.assertions?.no_control_leakage !== false;
  const turns = describeTurns(fixture);
  let lastSent = null;

  try {
    lastSent = await sendTurn(turns[0], turns[0].request, 'fixture');
    const firstTurnPassed = processTurn(turns[0], lastSent);

    if (firstTurnPassed && turns.length > 1 && fixture.tool_followup?.consumer === 'echo') {
      const followup = await runToolFollowup({
        fixture,
        firstResult: lastSent.observed,
        sendTurn: async (request, turnIndex) => {
          lastSent = await sendTurn(turns[turnIndex], request, 'tool-consumer');
          return lastSent.observed;
        },
      });
      live.push({
        kind: 'tool_execution',
        executions: followup.executions ?? [],
        diagnostics: followup.diagnostics ?? [],
      });
      if (!followup.ok) {
        productDiagnostics.push(...(followup.diagnostics ?? []).map((line) => `tool_followup: ${line}`));
      } else if (turns.length > 1 && lastSent !== null) {
        processTurn(turns[1], lastSent);
      }
      for (const turn of turns.slice(2)) {
        lastSent = await sendTurn(turn, turn.request, 'fixture-declared');
        processTurn(turn, lastSent);
      }
    } else if (firstTurnPassed) {
      for (const turn of turns.slice(1)) {
        lastSent = await sendTurn(turn, turn.request, 'fixture-declared');
        processTurn(turn, lastSent);
      }
    }
  } catch (error) {
    if (error?.code === 'ENDPOINT_UNAVAILABLE' || error?.code === 'MOCK_ACTIVATION' || error?.code === 'PROTOCOL_PARSE') {
      runnerDiagnostics.push(error.message);
    } else if (error?.code === 'TOOL_FOLLOWUP') {
      productDiagnostics.push(error.message);
    } else if (error?.message) {
      runnerDiagnostics.push(`runner error: ${error.message}`);
    } else {
      runnerDiagnostics.push('runner error: unknown case flow failure');
    }
  }

  return finalizeReport(report, {
    productDiagnostics,
    runnerDiagnostics,
    capabilityDiagnostics: [],
    live,
    turnResults,
    evidenceRefs,
  });

  // ---- case flow helpers (closures over the case inputs) ----

  async function sendTurn(turn, request, source) {
    let baseline;
    try {
      if (typeof mock.setActiveCase === 'function') mock.setActiveCase(fixture, turn.index);
      if (typeof mock.setTurn === 'function') mock.setTurn(turn.index);
      baseline = captureCount();
    } catch (error) {
      const failure = new Error(`mock turn activation failed for turn ${turn.index + 1}: ${error.message}`);
      failure.code = 'MOCK_ACTIVATION';
      throw failure;
    }

    if (!isPlainObject(request) || typeof request.path !== 'string' || !request.path.startsWith('/')) {
      const failure = new Error(`missing client_request for turn ${turn.index + 1}`);
      failure.code = 'CAPABILITY_MISSING';
      throw failure;
    }

    const method = text(request.method) || 'POST';
    const headers = requestHeaders(request);
    const bodyText = JSON.stringify(request.body ?? {});
    let raw;
    try {
      raw = await sendHttp(`${String(rccUrl).replace(/\/+$/, '')}${request.path}`, {
        method,
        headers,
        body: bodyText,
        timeoutMs,
      });
    } catch (error) {
      const failure = new Error(`http adapter rejected the client request: ${error?.message ?? error}`);
      failure.code = 'HTTP_ADAPTER';
      throw failure;
    }

    if (endpointUnavailable(raw)) {
      const failure = new Error(
        `RCC endpoint unavailable for turn ${turn.index + 1} at ${request.path}: ${errorSummary(raw)}`,
      );
      failure.code = 'ENDPOINT_UNAVAILABLE';
      throw failure;
    }

    const observed = observeClientResult(raw, entryProtocol);
    const window = captureWindow(baseline);
    return { raw, observed, window, request, requestHeaders: headers, requestBody: bodyText, source };
  }

  function processTurn(turn, sent) {
    const diagnostics = [];
    const window = Array.isArray(sent.window) ? sent.window : [];
    const business = window.filter((capture) => !EXCLUDED_ATTEMPT_KINDS.has(capture?.attempt_kind));
    const probes = window.filter((capture) => EXCLUDED_ATTEMPT_KINDS.has(capture?.attempt_kind));
    const scripted = scriptedAttemptCount(turn.upstream);

    if (business.length !== scripted) {
      diagnostics.push(`provider attempt count ${business.length} != scripted ${scripted} for turn ${turn.index + 1}`);
    }
    if (turn.declaredAttemptCount !== null && business.length !== turn.declaredAttemptCount) {
      diagnostics.push(`provider attempt count ${business.length} != asserted ${turn.declaredAttemptCount} for turn ${turn.index + 1}`);
    }
    if (turn.providerExpected) {
      const providerResult = turn.providerExpected.auth_orders
        ? assertProviderAttemptSequence(window, turn.providerExpected, {
            providerProtocol,
            noControlLeakage,
          })
        : assertProviderCaptures(window, 0, turn.providerExpected, {
            providerProtocol,
            noControlLeakage,
          });
      diagnostics.push(...providerResult.diagnostics);
    }
    if (turn.clientExpected) {
      const clientResult = assertClientResult(sent.observed, {
        ...turn.clientExpected,
        no_control_leakage: noControlLeakage,
      }, entryProtocol, PROTOCOL_DEPS);
      diagnostics.push(...clientResult.diagnostics);
    }
    productDiagnostics.push(...diagnostics);

    const clientEvidence = writeEvidence(`${caseId}-turn-${turn.index + 1}-client.json`, {
      case_id: caseId,
      turn: turn.index + 1,
      turn_id: turn.turn_id ?? null,
      request_source: sent.source,
      request: {
        method: sent.request.method ?? 'POST',
        path: sent.request.path,
        headers: sent.requestHeaders,
        body_text: sent.requestBody,
      },
      client_response: sent.raw,
      observation: sent.observed.observation,
      parse_diagnostic: sent.observed.parse_diagnostic,
      diagnostics,
    });
    const providerEvidence = writeEvidence(`${caseId}-turn-${turn.index + 1}-provider.json`, {
      case_id: caseId,
      turn: turn.index + 1,
      turn_id: turn.turn_id ?? null,
      provider_captures: window,
      business_attempts: business.length,
      scripted_attempts: scripted,
      probe_attempts: probes.length,
    });

    live.push({
      kind: 'turn',
      turn: turn.index + 1,
      turn_id: turn.turn_id ?? null,
      request_source: sent.source,
      request: {
        method: sent.request.method ?? 'POST',
        path: sent.request.path,
        headers: sent.requestHeaders,
        body_bytes: Buffer.byteLength(sent.requestBody, 'utf8'),
        body_sha256: sha256Text(sent.requestBody),
      },
      client: {
        status: sent.raw.status ?? null,
        status_text: sent.raw.status_text ?? null,
        headers: normalizeHeaders(sent.raw.headers ?? sent.raw.received_headers),
        body_bytes: bodyByteLength(sent.raw),
        closed: Boolean(sent.raw.closed ?? sent.raw.aborted ?? false),
        truncated: Boolean(sent.raw.truncated ?? false),
        response_ended: sent.raw.response_ended ?? false,
        complete: sent.raw.complete ?? null,
        error: sent.raw.error ?? null,
        error_code: errorCodeOf(sent.raw),
      },
      provider_attempts: business.length,
      scripted_attempts: scripted,
      probe_attempts: probes.length,
      diagnostics,
      evidence: [clientEvidence, providerEvidence],
    });

    turnResults.push({
      turn: turn.index + 1,
      turn_id: turn.turn_id ?? null,
      status: diagnostics.length ? 'failed' : 'passed',
      request_source: sent.source,
      provider_attempts: business.length,
      scripted_attempts: scripted,
      probe_attempts: probes.length,
      client_status: sent.raw.status ?? null,
      client_closed: Boolean(sent.raw.closed ?? sent.raw.aborted ?? false),
      diagnostics,
    });
    return diagnostics.length === 0;
  }

  function captureCount() {
    const all = mock.getCaptures(caseId);
    if (!Array.isArray(all)) throw new Error('mock getCaptures did not return an array');
    return all.length;
  }

  function captureWindow(since) {
    let all;
    try {
      all = mock.getCaptures(caseId);
    } catch (error) {
      const failure = new Error(`mock capture read failed: ${error.message}`);
      failure.code = 'MOCK_ACTIVATION';
      throw failure;
    }
    if (!Array.isArray(all)) throw new Error('mock getCaptures did not return an array');
    return since < 0 ? all : all.slice(since);
  }

  function writeEvidence(name, value) {
    const path = join(captureDir, name);
    try {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    } catch (error) {
      const failure = new Error(`evidence write failed for ${name}: ${error.message}`);
      failure.code = 'EVIDENCE_WRITE';
      throw failure;
    }
    evidenceRefs.push(join('captures', name));
    return join('captures', name);
  }
}

function describeTurns(fixture) {
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
        ? { ...(fixture.expected_provider ?? {}), exact: turn.expected_provider_exact }
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

function capabilityGaps({ fixture, mock, rccUrl, sendHttp, evidenceRoot, entryProtocol }) {
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

function observeClientResult(raw, entryProtocol) {
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

function scriptedAttemptCount(upstream) {
  if (!isPlainObject(upstream)) return 0;
  if (Array.isArray(upstream.attempts) && upstream.attempts.length > 0) return upstream.attempts.length;
  return 1;
}

function requestHeaders(request) {
  return {
    'content-type': 'application/json',
    ...(isPlainObject(request.headers) ? request.headers : {}),
  };
}

function endpointUnavailable(raw) {
  if (!isPlainObject(raw)) return false;
  if (raw.status !== null && raw.status !== undefined) return false;
  return ENDPOINT_UNAVAILABLE_CODES.has(errorCodeOf(raw));
}

function errorSummary(raw) {
  const code = errorCodeOf(raw);
  return [code, raw?.error, raw?.error_detail?.message].filter(Boolean).join(' ');
}

function finalizeReport(report, context) {
  const {
    productDiagnostics,
    runnerDiagnostics,
    capabilityDiagnostics,
    live,
    turnResults,
    evidenceRefs,
  } = context;
  const productFailures = productDiagnostics.length;
  const runnerFailures = runnerDiagnostics.length;
  const status = capabilityDiagnostics.length
    ? 'not_run'
    : runnerFailures > 0
      ? 'infra_failure'
      : productFailures > 0
        ? 'failed'
        : 'passed';
  const allDiagnostics = [
    ...capabilityDiagnostics,
    ...runnerDiagnostics,
    ...productDiagnostics,
  ];
  const providerAttempts = sumField(turnResults, 'provider_attempts');
  const probeAttempts = sumField(turnResults, 'probe_attempts');

  return {
    ...report,
    status,
    classification: status === 'passed'
      ? 'pass'
      : status === 'infra_failure'
        ? 'infrastructure'
        : status === 'not_run'
          ? 'capability'
          : 'product',
    diagnostic: allDiagnostics.length ? dedupe(allDiagnostics).join('; ') : 'case flow assertions passed',
    product_failures: productFailures,
    runner_failures: runnerFailures,
    provider_attempt_count: providerAttempts,
    probe_attempt_count: probeAttempts,
    turn_results: turnResults,
    first_divergence: firstDivergence(status, allDiagnostics),
    observations: {
      live,
      infra: [
        ...capabilityDiagnostics.map((line) => ({ kind: 'capability_missing', message: line })),
        ...runnerDiagnostics.map((line) => ({ kind: 'infra_failure', message: line })),
      ],
    },
    source_provenance: {
      verified: false,
      note: 'module evidence only; no provenance claim from an installed binary',
    },
    evidence_refs: dedupe(evidenceRefs),
    captures: dedupe(evidenceRefs.filter((reference) => reference.includes('-provider.json'))),
    client_evidence: dedupe(evidenceRefs.filter((reference) => reference.includes('-client.json'))),
  };
}

function firstDivergence(status, diagnostics) {
  if (status === 'infra_failure') return 'setup';
  if (status === 'not_run') return 'capability';
  if (status === 'passed') return null;
  const first = diagnostics[0] ?? '';
  if (first.includes('attempt count')) return 'provider_attempt_count';
  if (first.includes('provider')) return 'provider_request_shape';
  if (first.includes('tool_followup')) return 'tool_followup';
  return 'client_response';
}

function bodyTextOf(raw) {
  if (typeof raw?.bodyText === 'string') return raw.bodyText;
  if (typeof raw?.text === 'string') return raw.text;
  return '';
}

function bodyByteLength(raw) {
  if (raw?.bodyBytes && typeof raw.bodyBytes.length === 'number') return raw.bodyBytes.length;
  if (typeof raw?.bodyBytesBase64 === 'string') return Math.floor(raw.bodyBytesBase64.length * 3 / 4);
  return Buffer.byteLength(bodyTextOf(raw), 'utf8');
}

function errorCodeOf(raw) {
  const detail = raw?.error_detail;
  if (detail?.code) return String(detail.code);
  if (detail?.errno) return String(detail.errno);
  return null;
}

function sha256Text(textValue) {
  return createHash('sha256').update(String(textValue)).digest('hex');
}

function normalizeHeaders(headers) {
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function sumField(entries, key) {
  return (Array.isArray(entries) ? entries : []).reduce(
    (total, entry) => total + (Number.isFinite(Number(entry?.[key])) ? Number(entry[key]) : 0),
    0,
  );
}

function dedupe(values) {
  return [...new Set(values)];
}

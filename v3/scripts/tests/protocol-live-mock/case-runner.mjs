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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertClientResult,
  assertProviderAttemptSequence,
  assertProviderCaptures,
} from './assertions.mjs';
import {
  findSemanticTerminal,
  parseClientBody,
} from './protocol-semantics.mjs';
import { runToolFollowup } from './tool-consumer.mjs';
import {
  bodyTextOf,
  capabilityGaps,
  describeTurns,
  endpointUnavailable,
  errorCodeOf,
  errorSummary,
  isPlainObject,
  normalizeHeaders,
  observeClientResult,
  requestHeaders,
  scriptedAttemptCount,
  text,
} from './case-contract.mjs';

const PROTOCOL_DEPS = Object.freeze({
  parseClientBody,
  findSemanticTerminal,
});

// Must stay aligned with PROBE_ATTEMPT_KINDS in assertions.mjs: only an
// explicit capture kind removes a request from the business attempt count.
const EXCLUDED_ATTEMPT_KINDS = new Set(['probe', 'startup']);

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// Explicit expected-mode table for the seven accepted same-protocol Direct and
// explicit/cross-protocol Relay controls. Every other case keeps observational
// mode evidence only and receives no new acceptance assertion from this table.
export const REQUIRED_EXECUTION_MODES = Object.freeze({
  'anthropic-to-anthropic-json': 'direct',
  'anthropic-to-anthropic-sse': 'direct',
  'gemini-to-gemini-json': 'direct',
  'gemini-to-gemini-sse': 'direct',
  'same-protocol-relay-chat-to-chat-json': 'relay',
  'anthropic-to-chat-json': 'relay',
  'gemini-to-chat-json': 'relay',
});

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
  const turnAttempts = [];
  const report = {
    case_id: caseId,
    cell: {
      entry_protocol: entryProtocol,
      provider_protocol: providerProtocol,
      transport: text(cell.transport),
      mode: text(cell.mode),
    },
    // Harness-local per-attempt receipts survive a failed send so the matrix
    // collector can bind persisted records even when processTurn never runs.
    turn_attempts: turnAttempts,
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

    if (firstTurnPassed && turns.length > 1 && ['echo', 'echo-line-result', 'local-namespace-mock', 'unknown-tool-correction'].includes(fixture.tool_followup?.consumer)) {
      const consumer = fixture.tool_followup.consumer;
      const correction = consumer === 'unknown-tool-correction';
      const localMock = consumer === 'local-namespace-mock';
      const effectPath = localMock
        ? join(captureDir, `${caseId}-local-namespace-mock-effect.json`)
        : undefined;
      const followup = await runToolFollowup({
        fixture,
        firstResult: lastSent.observed,
        effectPath,
        onExecution: localMock
          ? (invocation) => writeEvidence(`${caseId}-local-namespace-mock-execution.json`, localExecutionReceipt(invocation))
          : undefined,
        sendTurn: async (request, turnIndex) => {
          lastSent = await sendTurn(turns[turnIndex], request, 'tool-consumer');
          if (correction && !processTurn(turns[turnIndex], lastSent)) {
            throw new Error(`correction turn ${turnIndex + 1} failed its client/provider contract`);
          }
          return lastSent.observed;
        },
      });
      live.push({
        kind: 'tool_execution',
        consumer,
        executions: followup.executions ?? [],
        diagnostics: followup.diagnostics ?? [],
      });
      if (!followup.ok) {
        productDiagnostics.push(...(followup.diagnostics ?? []).map((line) => `tool_followup: ${line}`));
      } else if (!correction && turns.length > 1 && lastSent !== null) {
        processTurn(turns[1], lastSent);
      }
      for (const turn of correction ? [] : turns.slice(2)) {
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
    const attempt = {
      attempt_index: turnAttempts.length,
      turn: turn.index + 1,
      turn_index: turn.index,
      turn_id: turn.turn_id ?? null,
      source,
      endpoint: typeof request?.path === 'string' ? request.path : null,
      method: text(request?.method) || 'POST',
      entry_protocol: entryProtocol,
      send_started_epoch_ms: null,
      send_settled_epoch_ms: null,
      outcome: 'pending',
      failure_code: null,
      failure_message: null,
    };
    turnAttempts.push(attempt);

    try {
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
      attempt.endpoint = request.path;
      attempt.method = method;

      attempt.send_started_epoch_ms = Date.now();
      let raw;
      try {
        raw = await sendHttp(`${String(rccUrl).replace(/\/+$/, '')}${request.path}`, {
          method,
          headers,
          body: bodyText,
          timeoutMs,
        });
      } catch (error) {
        attempt.send_settled_epoch_ms = Date.now();
        attempt.outcome = 'send_rejected';
        const failure = new Error(`http adapter rejected the client request: ${error?.message ?? error}`);
        failure.code = 'HTTP_ADAPTER';
        throw failure;
      }
      attempt.send_settled_epoch_ms = Date.now();

      // Read the provider window before deciding the failure class. A business
      // attempt proves the endpoint was reachable and dispatched, so a later
      // client ETIMEDOUT is a product failure, not an unavailable endpoint.
      const window = captureWindow(baseline);
      const dispatched = window.some((capture) => capture?.attempt_kind === 'business');
      if (endpointUnavailable(raw) && !(errorCodeOf(raw) === 'ETIMEDOUT' && dispatched)) {
        attempt.outcome = 'endpoint_unavailable';
        const failure = new Error(
          `RCC endpoint unavailable for turn ${turn.index + 1} at ${request.path}: ${errorSummary(raw)}`,
        );
        failure.code = 'ENDPOINT_UNAVAILABLE';
        throw failure;
      }

      let observed;
      try {
        observed = observeClientResult(raw, entryProtocol);
      } catch (error) {
        attempt.outcome = 'protocol_parse';
        throw error;
      }
      attempt.outcome = 'settled';
      return { raw, observed, window, request, requestHeaders: headers, requestBody: bodyText, source, attempt };
    } catch (error) {
      if (attempt.send_settled_epoch_ms === null && attempt.send_started_epoch_ms !== null) {
        attempt.send_settled_epoch_ms = Date.now();
      }
      if (attempt.outcome === 'pending') attempt.outcome = 'failed';
      attempt.failure_code = error?.code ?? null;
      attempt.failure_message = error?.message ?? String(error);
      throw error;
    }
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
      attempt: sent.attempt ?? null,
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
      attempt: sent.attempt ?? null,
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

  function localExecutionReceipt(invocation) {
    return {
      case_id: caseId,
      consumer: fixture.tool_followup?.consumer ?? null,
      binding: fixture.tool_followup?.binding ?? null,
      observed_call: {
        call_id: invocation.call_id,
        name: invocation.name,
        namespace: invocation.namespace,
        type: invocation.type,
        raw_arguments: invocation.raw_arguments,
      },
      parsed_arguments: invocation.arguments,
      operation: invocation.effect_receipt?.operation ?? 'exclusive-local-file',
      effect: {
        path: invocation.effect_receipt?.path ?? null,
        bytes: invocation.effect_receipt?.bytes ?? null,
      },
      actual_output: invocation.output,
      authority_scope: 'local-client-mock',
      cleanup_disposition: 'retained as evidence',
    };
  }
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

function bodyByteLength(raw) {
  if (raw?.bodyBytes && typeof raw.bodyBytes.length === 'number') return raw.bodyBytes.length;
  if (typeof raw?.bodyBytesBase64 === 'string') return Math.floor(raw.bodyBytesBase64.length * 3 / 4);
  return Buffer.byteLength(bodyTextOf(raw), 'utf8');
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

// ---- persisted execution-mode evidence collection (one disk read) ----

/**
 * Read the per-listener request-records store once, fold lifecycle snapshots by
 * request_key, bind each harness turn to at most one persisted row, and retain
 * the raw bytes plus the interpretation.
 *
 * The store path is the canonical `<config dir>/logs/server-v3-<port>.request-records.jsonl`.
 * The runtime is the only writer, so this collector is observational: it never
 * selects a route, reconstructs control truth, or uses an expected mode as a
 * prefilter. A required-case mismatch or a collection/correlation gap yields a
 * non-pass status; the caller decides how that acceptance finding is recorded.
 */
export function collectExecutionModeEvidence({
  caseId,
  caseRoot,
  storePath,
  attempts = [],
  captures = [],
  listenerPort = null,
  expectedMode,
  collectionPhase = 'post_stop_missing',
  stopReceipt = null,
} = {}) {
  const expected = expectedMode !== undefined ? expectedMode : REQUIRED_EXECUTION_MODES[caseId] ?? null;
  const read = readPersistedRecords(storePath);
  const folded = foldPersistedRecords(read.records);
  const findings = [...read.findings, ...folded.findings];
  const turns = correlateTurns({ attempts, captures, folded: folded.rows, caseId, listenerPort });
  const gaps = turns.filter((turn) => Boolean(turn.gap));
  const observedModes = [...new Set(
    turns.filter((turn) => !turn.gap && turn.execution_mode).map((turn) => turn.execution_mode),
  )];
  const actualMode = observedModes.length <= 1 ? observedModes[0] ?? null : observedModes;

  let status;
  if (expected === null || expected === undefined) {
    status = 'observational';
  } else if (!storePath) {
    status = 'incomplete';
  } else if (collectionPhase !== 'post_stop_complete') {
    status = 'incomplete';
    findings.push(`collection phase ${collectionPhase} cannot prove flush completeness`);
  } else if (read.bytes === null || findings.length > 0) {
    status = 'incomplete';
  } else if (gaps.length > 0) {
    status = 'incomplete';
    findings.push(...gaps.map((gap) =>
      `turn ${gap.turn}: ${gap.gap}${gap.candidate_request_keys.length ? ` candidates=${gap.candidate_request_keys.join(',')}` : ''}`));
  } else if (turns.some((turn) => !turn.execution_mode)) {
    status = 'incomplete';
    findings.push('correlated row has no execution_mode');
  } else if (observedModes.length === 0) {
    status = 'incomplete';
    findings.push('no correlated execution_mode');
  } else if (turns.some((turn) => turn.event_type !== 'request.completed')) {
    status = 'incomplete';
    findings.push('correlated row is not a request.completed terminal');
  } else if (observedModes.some((mode) => mode !== expected)) {
    status = 'mismatch';
    findings.push(`execution mode mismatch: expected ${expected}, observed ${observedModes.join(',')}`);
  } else {
    status = 'pass';
  }

  const recordsPath = caseRoot ? join(caseRoot, 'execution-mode-records.jsonl') : null;
  const evidencePath = caseRoot ? join(caseRoot, 'execution-mode-evidence.json') : null;
  const artifactFindings = [];
  let recordsRef = null;
  if (caseRoot && read.bytes) {
    try {
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(recordsPath, read.bytes);
      recordsRef = recordsPath;
    } catch (error) {
      artifactFindings.push(`execution-mode-records.jsonl write failed: ${error.message}`);
    }
  } else if (caseRoot && !read.bytes) {
    artifactFindings.push('no raw request-record bytes available for execution-mode-records.jsonl');
  }
  if (!caseRoot) artifactFindings.push('case root unavailable; execution-mode artifacts not written');

  // An artifact write failure cannot prove retained evidence, so an otherwise
  // passing required-case result is downgraded. Business status is untouched.
  let finalStatus = status;
  if (expected !== null && expected !== undefined && status === 'pass' && artifactFindings.length > 0) {
    finalStatus = 'incomplete';
  }
  const evidence = {
    case_id: caseId ?? null,
    status: finalStatus,
    expected_mode: expected ?? null,
    actual_mode: actualMode,
    collection_phase: collectionPhase,
    source_path: storePath ?? null,
    listener_port: listenerPort,
    stop_receipt: stopReceipt,
    raw_record_count: read.records.length,
    folded_record_count: folded.rows.length,
    request_ids: folded.rows.map((row) => row.request_id).filter(Boolean),
    request_keys: folded.rows.map((row) => row.request_key),
    turns,
    findings: [...findings, ...artifactFindings],
    artifacts: { records_path: recordsPath, evidence_path: evidencePath, records_written: recordsRef !== null },
  };
  let evidenceRef = null;
  if (caseRoot) {
    try {
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      evidenceRef = evidencePath;
    } catch (error) {
      artifactFindings.push(`execution-mode-evidence.json write failed: ${error.message}`);
      if (expected !== null && expected !== undefined && finalStatus === 'pass') finalStatus = 'incomplete';
    }
  }

  return {
    ...evidence,
    status: finalStatus,
    findings: [...findings, ...artifactFindings],
    records_ref: recordsRef,
    evidence_ref: evidenceRef,
  };
}

function readPersistedRecords(storePath) {
  if (!storePath) {
    return { bytes: null, records: [], findings: ['request-records store path unavailable'] };
  }
  if (!existsSync(storePath)) {
    return { bytes: null, records: [], findings: [`store missing: ${storePath}`] };
  }
  let bytes;
  try {
    bytes = readFileSync(storePath);
  } catch (error) {
    return { bytes: null, records: [], findings: [`store read failed: ${error.message}`] };
  }
  const records = [];
  const findings = [];
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      findings.push(`line ${index + 1} invalid JSON: ${error.message}`);
      continue;
    }
    if (!isPlainObject(envelope) || envelope.schema_version !== 1) {
      findings.push(`line ${index + 1} unsupported schema_version`);
      continue;
    }
    if (!isPlainObject(envelope.row)) {
      findings.push(`line ${index + 1} missing row`);
      continue;
    }
    records.push({ line: index + 1, row: envelope.row });
  }
  return { bytes, records, findings };
}

function foldPersistedRecords(records) {
  const order = [];
  const byKey = new Map();
  const findings = [];
  for (const record of records) {
    const key = typeof record.row.request_key === 'string' && record.row.request_key ? record.row.request_key : null;
    if (!key) {
      findings.push(`line ${record.line} has no request_key`);
      continue;
    }
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, interpretPersistedRow(record, key));
  }
  return { rows: order.map((key) => byKey.get(key)), findings };
}

function interpretPersistedRow(record, requestKey) {
  const row = record.row;
  const meta = isPlainObject(row.meta) ? row.meta : {};
  const scope = isPlainObject(row.scope) ? row.scope : {};
  return {
    line: record.line,
    request_key: requestKey,
    request_id: text(meta.request_id) || null,
    endpoint: text(meta.endpoint) || null,
    entry_protocol: text(meta.entry_protocol) || null,
    execution_mode: text(meta.execution_mode) || null,
    event_type: text(row.event_type) || null,
    result: text(row.result) || null,
    started_epoch_ms: epochMs(row.started_epoch_ms),
    updated_epoch_ms: epochMs(row.updated_epoch_ms),
    finished_epoch_ms: row.finished_epoch_ms === null || row.finished_epoch_ms === undefined
      ? null
      : epochMs(row.finished_epoch_ms),
    attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : null,
    port: Number.isFinite(Number(scope.port)) ? Number(scope.port) : null,
  };
}

function correlateTurns({ attempts, captures, folded, caseId, listenerPort }) {
  const windows = attempts.map((attempt) => {
    const started = epochMs(attempt.send_started_epoch_ms);
    const settled = epochMs(attempt.send_settled_epoch_ms);
    const business = captures.some((capture) => isBusinessCapture(capture, attempt, caseId, started, settled));
    const candidates = started !== null && settled !== null
      ? folded.filter((row) => isCandidateRow(row, attempt, listenerPort, started, settled))
      : [];
    return { attempt, started, settled, business, candidates };
  });
  const claims = new Map();
  for (const window of windows) {
    for (const row of window.candidates) claims.set(row.request_key, (claims.get(row.request_key) ?? 0) + 1);
  }
  return windows.map((window) => {
    const attempt = window.attempt;
    const base = {
      turn: attempt.turn ?? null,
      turn_id: attempt.turn_id ?? null,
      source: attempt.source ?? null,
      endpoint: attempt.endpoint ?? null,
      entry_protocol: attempt.entry_protocol ?? null,
      send_started_epoch_ms: window.started,
      send_settled_epoch_ms: window.settled,
      send_outcome: attempt.outcome ?? null,
      business_capture: window.business,
      candidate_request_keys: window.candidates.map((row) => row.request_key),
      request_key: null,
      request_id: null,
      execution_mode: null,
      event_type: null,
      started_epoch_ms: null,
      finished_epoch_ms: null,
      result: null,
      line: null,
      gap: null,
    };
    if (window.started === null || window.settled === null) return { ...base, gap: 'attempt never reached the wire' };
    if (!window.business) return { ...base, gap: 'no business provider capture for turn' };
    if (window.candidates.length === 0) return { ...base, gap: 'no persisted record started inside the send window' };
    if (window.candidates.length > 1) return { ...base, gap: 'multiple persisted records started inside the send window' };
    const row = window.candidates[0];
    if ((claims.get(row.request_key) ?? 0) > 1) return { ...base, gap: 'request key claimed by multiple turns' };
    return {
      ...base,
      request_key: row.request_key,
      request_id: row.request_id,
      execution_mode: row.execution_mode,
      event_type: row.event_type,
      started_epoch_ms: row.started_epoch_ms,
      finished_epoch_ms: row.finished_epoch_ms,
      result: row.result,
      line: row.line,
    };
  });
}

function isCandidateRow(row, attempt, listenerPort, started, settled) {
  if (listenerPort !== null && listenerPort !== undefined && row.port !== listenerPort) return false;
  if (row.endpoint !== attempt.endpoint) return false;
  if (row.entry_protocol !== attempt.entry_protocol) return false;
  if (row.started_epoch_ms === null) return false;
  return row.started_epoch_ms >= started && row.started_epoch_ms <= settled;
}

function isBusinessCapture(capture, attempt, caseId, started, settled) {
  if (started === null || settled === null) return false;
  if (!isPlainObject(capture) || capture.attempt_kind !== 'business') return false;
  if (typeof capture.case_id === 'string' && capture.case_id !== caseId) return false;
  if (Number.isInteger(capture.turn) && capture.turn !== attempt.turn_index) return false;
  const capturedAt = epochMs(capture.captured_at_epoch_ms);
  if (capturedAt === null) return false;
  return capturedAt >= started && capturedAt <= settled;
}

function epochMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

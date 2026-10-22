// Deterministic installed-binary replay for provider concurrency exhaustion.
//
// This module owns one explicit concurrent flow. The first request holds a
// loopback provider attempt while the second request must terminate locally
// without another upstream business send.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertClientResult, assertProviderCaptures } from './assertions.mjs';
import {
  errorCodeOf,
  isPlainObject,
  observeClientResult,
  requestHeaders,
  text,
} from './case-contract.mjs';
import { findSemanticTerminal, parseClientBody } from './protocol-semantics.mjs';

export const PROVIDER_CONCURRENCY_REPLAY_KIND = 'provider_concurrency_all_busy';
export const PROVIDER_CONCURRENCY_MIXED_SHAPE = 'mixed_exclusion';

const PROTOCOL_DEPS = Object.freeze({ parseClientBody, findSemanticTerminal });
const EXCLUDED_ATTEMPT_KINDS = new Set(['probe', 'startup']);
const HOLD_TIMEOUT_MS = 5_000;
const PROBE_INPUT_MARKER = 'ping; reply pong';
const HEALTH_POOL_PATH = '/_routecodex/health/cooldown-pool';
const HEALTH_POOL_ADD_PATH = '/_routecodex/health/cooldown-pool/add';
const TYPED_SOURCE_FILE_NAMES = new Set([
  'provider-failed-attempts.json',
  'error.json',
]);

export function isProviderConcurrencyReplay(fixture) {
  return fixture?.concurrency_replay?.kind === PROVIDER_CONCURRENCY_REPLAY_KIND;
}

/**
 * Run the two-request all-busy replay and retain client/provider evidence.
 */
export async function runProviderConcurrencyReplay({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs = 30_000,
} = {}) {
  const caseId = text(fixture?.case_id) || 'unknown-case';
  const entryProtocol = text(fixture?.cell?.entry_protocol);
  const providerProtocol = text(fixture?.cell?.provider_protocol);
  const replay = isPlainObject(fixture?.concurrency_replay) ? fixture.concurrency_replay : {};
  if (replay.shape === PROVIDER_CONCURRENCY_MIXED_SHAPE) {
    return runProviderMixedExclusionReplay({
      fixture,
      mock,
      rccUrl,
      sendHttp,
      evidenceRoot,
      timeoutMs,
    });
  }
  const holderRequest = fixture?.client_request;
  const exhaustedRequest = replay.exhaustion_client_request;
  const expectedExhaustion = replay.expected_exhaustion_client ?? {};
  const expectedBusinessSends = replay.upstream_business_sends;
  const expectedTypedCodes = Array.isArray(replay.typed_error_codes) ? replay.typed_error_codes : [];
  const productDiagnostics = [];
  const runnerDiagnostics = [];
  const capabilityDiagnostics = [];
  const evidenceRefs = [];
  const turnAttempts = [];
  const captureDir = join(evidenceRoot, 'captures');
  let debugStatus = null;

  if (!isProviderConcurrencyReplay(fixture)) {
    capabilityDiagnostics.push(`capability_missing: unsupported concurrency replay for ${caseId}`);
  }
  for (const [label, value] of [
    ['holder request', holderRequest],
    ['exhaustion request', exhaustedRequest],
  ]) {
    if (!isPlainObject(value) || typeof value.path !== 'string' || !value.path.startsWith('/')) {
      capabilityDiagnostics.push(`capability_missing: ${label} must declare an absolute path`);
    }
  }
  for (const [name, value] of [
    ['setActiveCase', mock?.setActiveCase],
    ['getCaptures', mock?.getCaptures],
    ['waitForHeld', mock?.waitForHeld],
    ['releaseHeld', mock?.releaseHeld],
    ['sendHttp', sendHttp],
  ]) {
    if (typeof value !== 'function') capabilityDiagnostics.push(`capability_missing: ${name} function required`);
  }
  if (!Number.isInteger(expectedBusinessSends) || expectedBusinessSends !== 1) {
    capabilityDiagnostics.push(`capability_missing: upstream_business_sends must be 1`);
  }
  if (!Array.isArray(expectedExhaustion.error_codes_must_not)) {
    capabilityDiagnostics.push('capability_missing: expected_exhaustion_client.error_codes_must_not required');
  }
  if (capabilityDiagnostics.length > 0) {
    return finalizeConcurrencyReport({
      fixture,
      capabilityDiagnostics,
      runnerDiagnostics,
      productDiagnostics,
      turnAttempts,
      evidenceRefs,
      observations: {},
    });
  }

  try {
    mkdirSync(captureDir, { recursive: true });
  } catch (error) {
    runnerDiagnostics.push(`evidence root unwritable: ${error.message}`);
    return finalizeConcurrencyReport({
      fixture,
      capabilityDiagnostics,
      runnerDiagnostics,
      productDiagnostics,
      turnAttempts,
      evidenceRefs,
      observations: {},
    });
  }

  const holderAttempt = attemptReceipt(holderRequest, 'holder', turnAttempts.length);
  const exhaustedAttempt = attemptReceipt(exhaustedRequest, 'all-busy-probe', turnAttempts.length + 1);
  turnAttempts.push(holderAttempt, exhaustedAttempt);
  let holderOutcome = null;
  let exhaustedRaw = null;
  let heldObserved = false;
  let releaseCount = 0;
  let holdObservedEpochMs = null;
  let releaseStartedEpochMs = null;
  let releaseCompletedEpochMs = null;

  try {
    try {
      debugStatus = await sendHttp(`${String(rccUrl).replace(/\/+$/, '')}/_routecodex/debug/status`, {
        method: 'GET',
        headers: {},
        timeoutMs: 1500,
      });
      writeConcurrencyEvidence(captureDir, `${caseId}-debug-status.json`, {
        case_id: caseId,
        response: debugStatus,
      }, evidenceRefs);
    } catch (error) {
      debugStatus = { error: error.message };
    }
    mock.setActiveCase(fixture, 0);
    holderAttempt.send_started_epoch_ms = Date.now();
    const holderPromise = sendClient(holderRequest, timeoutMs).then(
      (raw) => ({ raw, error: null }),
      (error) => ({ raw: null, error }),
    );
    holderOutcome = holderPromise;
    try {
      await mock.waitForHeld(caseId, Math.min(timeoutMs, HOLD_TIMEOUT_MS));
      heldObserved = true;
      holdObservedEpochMs = Date.now();
      holderAttempt.outcome = 'held';
    } catch (error) {
      exhaustedAttempt.outcome = 'not_sent';
      throw runnerFailure(`controlled provider hold failed: ${error.message}`, 'MOCK_HOLD');
    }

    exhaustedAttempt.send_started_epoch_ms = Date.now();
    try {
      exhaustedRaw = await sendClient(exhaustedRequest, expectedExhaustion.deadline_ms);
    } catch (error) {
      throw runnerFailure(`exhaustion client send rejected: ${error.message}`, 'HTTP_ADAPTER');
    } finally {
      exhaustedAttempt.send_settled_epoch_ms = Date.now();
    }
  } catch (error) {
    if (error?.code === 'MOCK_HOLD' || error?.code === 'HTTP_ADAPTER') runnerDiagnostics.push(error.message);
    else runnerDiagnostics.push(`concurrency runner error: ${error?.message ?? String(error)}`);
  } finally {
    releaseStartedEpochMs = Date.now();
    try {
      releaseCount = await mock.releaseHeld(caseId);
    } catch (error) {
      runnerDiagnostics.push(`controlled provider release failed: ${error.message}`);
    } finally {
      releaseCompletedEpochMs = Date.now();
    }
  }

  let holderRaw = null;
  if (holderOutcome) {
    try {
      const settled = await holderOutcome;
      holderRaw = settled.raw;
      if (settled.error) {
        runnerDiagnostics.push(`holder client send rejected: ${settled.error.message}`);
      }
      holderAttempt.send_settled_epoch_ms = Date.now();
      if (holderRaw) holderAttempt.outcome = 'settled';
    } catch (error) {
      runnerDiagnostics.push(`holder settlement failed: ${error.message}`);
    }
  }

  if (releaseCount !== 1) {
    productDiagnostics.push(`controlled hold release count ${releaseCount} != 1`);
  }
  if (!heldObserved) productDiagnostics.push('controlled provider hold was not observed');
  const timeline = {
    holder_send_started_epoch_ms: holderAttempt.send_started_epoch_ms,
    hold_observed_epoch_ms: holdObservedEpochMs,
    exhausted_send_started_epoch_ms: exhaustedAttempt.send_started_epoch_ms,
    exhausted_send_settled_epoch_ms: exhaustedAttempt.send_settled_epoch_ms,
    release_started_epoch_ms: releaseStartedEpochMs,
    release_completed_epoch_ms: releaseCompletedEpochMs,
    holder_send_settled_epoch_ms: holderAttempt.send_settled_epoch_ms,
  };
  if (holdObservedEpochMs === null
    || exhaustedAttempt.send_started_epoch_ms === null
    || holdObservedEpochMs > exhaustedAttempt.send_started_epoch_ms) {
    productDiagnostics.push('exhausted request started before the controlled provider hold was observed');
  }
  if (exhaustedAttempt.send_settled_epoch_ms === null
    || releaseStartedEpochMs === null
    || releaseStartedEpochMs < exhaustedAttempt.send_settled_epoch_ms) {
    productDiagnostics.push('controlled provider capacity was released before the exhausted request settled');
  }

  const holderObserved = holderRaw ? observeClient(holderRaw, entryProtocol) : null;
  if (holderObserved) {
    const clientResult = assertClientResult(
      holderObserved,
      {
        ...(fixture.expected_client ?? {}),
        no_control_leakage: fixture.assertions?.no_control_leakage !== false,
      },
      entryProtocol,
      PROTOCOL_DEPS,
    );
    productDiagnostics.push(...clientResult.diagnostics.map((line) => `holder: ${line}`));
  } else {
    productDiagnostics.push('holder client response missing');
  }

  const captures = readCaptures(mock, runnerDiagnostics);
  const business = captures.filter((capture) => !EXCLUDED_ATTEMPT_KINDS.has(capture?.attempt_kind));
  if (business.length !== expectedBusinessSends) {
    productDiagnostics.push(`provider business send count ${business.length} != ${expectedBusinessSends}`);
  }
  if (fixture.expected_provider) {
    const providerResult = assertProviderCaptures(captures, 0, fixture.expected_provider, {
      providerProtocol,
      noControlLeakage: fixture.assertions?.no_control_leakage !== false,
    });
    productDiagnostics.push(...providerResult.diagnostics.map((line) => `holder provider: ${line}`));
  }

  if (!exhaustedRaw) {
    productDiagnostics.push('all-busy client response missing');
  } else {
    const forbidden = new Set(expectedExhaustion.error_codes_must_not ?? []);
    const exhaustedCode = errorCodeOf(exhaustedRaw);
    if (exhaustedCode && forbidden.has(exhaustedCode)) {
      productDiagnostics.push(`all-busy client used forbidden ${exhaustedCode}; product must close before timeout`);
    }
    if (!Boolean(exhaustedRaw.closed ?? exhaustedRaw.aborted)) {
      productDiagnostics.push('all-busy client transport was not observably closed');
    }
    if (exhaustedRaw.response_ended) {
      productDiagnostics.push('all-busy client transport completed instead of closing');
    }
    if (Number.isFinite(exhaustedRaw.elapsed_ms)
      && exhaustedRaw.elapsed_ms > expectedExhaustion.deadline_ms) {
      productDiagnostics.push(
        `all-busy client close ${exhaustedRaw.elapsed_ms}ms exceeded deadline ${expectedExhaustion.deadline_ms}ms`,
      );
    }
    const exhaustedStatus = Number.isInteger(exhaustedRaw.status) ? exhaustedRaw.status : null;
    const exhaustedContentType = text(exhaustedRaw.headers?.['content-type']).toLowerCase();
    const exhaustedBody = text(exhaustedRaw.bodyText);
    if (exhaustedStatus !== null && exhaustedStatus !== 200) {
      productDiagnostics.push(`all-busy client received HTTP ${exhaustedStatus} instead of a transport close`);
    }
    if (exhaustedBody.length > 0) {
      if (exhaustedStatus !== 200 || !exhaustedContentType.includes('text/event-stream')) {
        productDiagnostics.push('all-busy client received a response body without SSE transport framing');
      } else if (hasSseSemanticContent(exhaustedBody)) {
        productDiagnostics.push('all-busy client received a business/error SSE frame instead of keepalive-only framing');
      }
    }
  }

  exhaustedAttempt.outcome = exhaustedRaw ? 'closed' : 'missing';
  const holderEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-holder-client.json`, {
    case_id: caseId,
    role: 'holder',
    request: requestEvidence(holderRequest),
    client_response: holderRaw,
    attempt: holderAttempt,
  }, evidenceRefs);
  const exhaustedEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-all-busy-client.json`, {
    case_id: caseId,
    role: 'all-busy',
    request: requestEvidence(exhaustedRequest),
    client_response: exhaustedRaw,
    expected: expectedExhaustion,
    attempt: exhaustedAttempt,
  }, evidenceRefs);
  const providerEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-provider.json`, {
    case_id: caseId,
    provider_captures: captures,
    business_sends: business.length,
    expected_business_sends: expectedBusinessSends,
  }, evidenceRefs);

  return finalizeConcurrencyReport({
    fixture,
    capabilityDiagnostics,
    runnerDiagnostics,
    productDiagnostics,
    turnAttempts,
    evidenceRefs,
    observations: {
      provider_concurrency: {
        holder_held: heldObserved,
        release_count: releaseCount,
        upstream_business_sends: business.length,
        expected_upstream_business_sends: expectedBusinessSends,
        exhausted_client: exhaustedRaw ? {
          status: exhaustedRaw.status ?? null,
          closed: Boolean(exhaustedRaw.closed ?? exhaustedRaw.aborted),
          response_ended: Boolean(exhaustedRaw.response_ended),
          error_code: errorCodeOf(exhaustedRaw),
          elapsed_ms: exhaustedRaw.elapsed_ms ?? null,
        } : null,
        typed_error_codes: expectedTypedCodes,
        debug_status: debugStatus ? {
          error: debugStatus.error ?? null,
          status: debugStatus.status ?? null,
          body_text: debugStatus.bodyText ?? null,
        } : null,
        timeline,
        exhausted_window: {
          started_epoch_ms: exhaustedAttempt.send_started_epoch_ms,
          settled_epoch_ms: exhaustedAttempt.send_settled_epoch_ms,
        },
        evidence: [holderEvidence, exhaustedEvidence, providerEvidence],
      },
    },
  });

  async function sendClient(request, deadlineMs) {
    return sendHttp(`${String(rccUrl).replace(/\/+$/, '')}${request.path}`, {
      method: text(request.method) || 'POST',
      headers: requestHeaders(request),
      body: JSON.stringify(request.body ?? {}),
      timeoutMs: deadlineMs,
    });
  }
}

/**
 * Run one mixed Direct/Relay exhaustion case: the first candidate holds its
 * only capacity while a second request-local health exclusion prevents a pure
 * all-busy relabel. The excluded candidate receives one recovery probe and the
 * client transport closes without another upstream business send.
 */
export async function runProviderMixedExclusionReplay({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs = 30_000,
} = {}) {
  const caseId = text(fixture?.case_id) || 'unknown-case';
  const entryProtocol = text(fixture?.cell?.entry_protocol);
  const providerProtocol = text(fixture?.cell?.provider_protocol);
  const replay = isPlainObject(fixture?.concurrency_replay) ? fixture.concurrency_replay : {};
  const mixed = isPlainObject(replay.mixed_exclusion) ? replay.mixed_exclusion : {};
  const holderRequest = fixture?.client_request;
  const exhaustedRequest = replay.exhaustion_client_request;
  const reuseRequest = replay.capacity_reuse_client_request;
  const expectedExhaustion = replay.expected_exhaustion_client ?? {};
  const expectedReuseClient = replay.expected_capacity_reuse_client ?? {};
  const expectedTypedCodes = Array.isArray(replay.typed_error_codes) ? replay.typed_error_codes : [];
  const forbiddenTypedCodes = Array.isArray(replay.typed_error_codes_must_not)
    ? replay.typed_error_codes_must_not
    : [];
  const expectedProbeSends = Number.isInteger(mixed.expected_probe_sends)
    ? mixed.expected_probe_sends
    : 1;
  const expectedHolderBusinessSends = Number.isInteger(mixed.expected_holder_business_sends)
    ? mixed.expected_holder_business_sends
    : 1;
  const expectedReuseBusinessSends = Number.isInteger(mixed.expected_reuse_business_sends)
    ? mixed.expected_reuse_business_sends
    : 1;
  const expectedHealthEntryCount = Number.isInteger(mixed.expected_health_entry_count)
    ? mixed.expected_health_entry_count
    : null;
  const excludedProviderId = text(mixed.excluded_provider_id)
    || excludedProviderIdFromFixture(fixture);
  const cooldownIdentity = isPlainObject(mixed.cooldown_identity) ? mixed.cooldown_identity : {};
  const probeMarker = text(mixed.probe_input_contains) || PROBE_INPUT_MARKER;
  const productDiagnostics = [];
  const runnerDiagnostics = [];
  const capabilityDiagnostics = [];
  const evidenceRefs = [];
  const turnAttempts = [];
  const captureDir = join(evidenceRoot, 'captures');
  let debugStatus = null;

  if (replay.shape !== PROVIDER_CONCURRENCY_MIXED_SHAPE) {
    capabilityDiagnostics.push(`capability_missing: unsupported mixed concurrency replay for ${caseId}`);
  }
  for (const [label, value] of [
    ['holder request', holderRequest],
    ['exhaustion request', exhaustedRequest],
    ['capacity reuse request', reuseRequest],
  ]) {
    if (!isPlainObject(value) || typeof value.path !== 'string' || !value.path.startsWith('/')) {
      capabilityDiagnostics.push(`capability_missing: ${label} must declare an absolute path`);
    }
  }
  for (const [name, value] of [
    ['setActiveCase', mock?.setActiveCase],
    ['getCaptures', mock?.getCaptures],
    ['waitForHeld', mock?.waitForHeld],
    ['releaseHeld', mock?.releaseHeld],
    ['sendHttp', sendHttp],
  ]) {
    if (typeof value !== 'function') capabilityDiagnostics.push(`capability_missing: ${name} function required`);
  }
  if (!excludedProviderId) capabilityDiagnostics.push('capability_missing: excluded_provider_id required');
  if (!Array.isArray(expectedExhaustion.error_codes_must_not)) {
    capabilityDiagnostics.push('capability_missing: expected_exhaustion_client.error_codes_must_not required');
  }
  if (capabilityDiagnostics.length > 0) {
    return finalizeConcurrencyReport({
      fixture,
      capabilityDiagnostics,
      runnerDiagnostics,
      productDiagnostics,
      turnAttempts,
      evidenceRefs,
      observations: {},
    });
  }

  try {
    mkdirSync(captureDir, { recursive: true });
  } catch (error) {
    runnerDiagnostics.push(`evidence root unwritable: ${error.message}`);
    return finalizeConcurrencyReport({
      fixture,
      capabilityDiagnostics,
      runnerDiagnostics,
      productDiagnostics,
      turnAttempts,
      evidenceRefs,
      observations: {},
    });
  }

  const holderAttempt = attemptReceipt(holderRequest, 'holder', turnAttempts.length);
  const exhaustedAttempt = attemptReceipt(exhaustedRequest, 'mixed-exhaustion', turnAttempts.length + 1);
  const reuseAttempt = attemptReceipt(reuseRequest, 'capacity-reuse', turnAttempts.length + 2);
  turnAttempts.push(holderAttempt, exhaustedAttempt, reuseAttempt);
  let holderOutcome = null;
  let holderRaw = null;
  let exhaustedRaw = null;
  let reuseRaw = null;
  let heldObserved = false;
  let releaseCount = 0;
  let healthBefore = null;
  let healthAfter = null;
  let holdObservedEpochMs = null;
  let releaseStartedEpochMs = null;
  let releaseCompletedEpochMs = null;

  try {
    try {
      debugStatus = await sendHttp(`${String(rccUrl).replace(/\/+$/, '')}/_routecodex/debug/status`, {
        method: 'GET',
        headers: {},
        timeoutMs: 1500,
      });
      writeConcurrencyEvidence(captureDir, `${caseId}-debug-status.json`, {
        case_id: caseId,
        response: debugStatus,
      }, evidenceRefs);
    } catch (error) {
      debugStatus = { error: error.message };
    }
    mock.setActiveCase(fixture, 0);

    const addCooldown = await sendHttp(`${String(rccUrl).replace(/\/+$/, '')}${HEALTH_POOL_ADD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: excludedProviderId,
        interface_id: text(cooldownIdentity.interface_id) || 'default',
        auth_alias: text(cooldownIdentity.auth_alias) || 'key1',
        model_id: null,
        kind: text(cooldownIdentity.kind) || 'auth_key',
        duration_ms: Number.isInteger(cooldownIdentity.duration_ms)
          ? cooldownIdentity.duration_ms
          : 60_000,
      }),
      timeoutMs: Math.min(timeoutMs, 5000),
    });
    if (addCooldown.status !== 200 || addCooldown.body?.ok !== true) {
      throw runnerFailure(
        `manual cooldown setup returned ${addCooldown.status ?? 'unknown'}: ${text(addCooldown.bodyText)}`,
        'COOLDOWN_SETUP',
      );
    }

    healthBefore = await readHealthPool(sendHttp, String(rccUrl).replace(/\/+$/, ''), timeoutMs);
    if (healthBefore.error) {
      throw runnerFailure(`baseline health read failed: ${healthBefore.error}`, 'HEALTH_READ');
    }
    if (expectedHealthEntryCount !== null && healthBefore.entries.length !== expectedHealthEntryCount) {
      productDiagnostics.push(
        `baseline health entry count ${healthBefore.entries.length} != ${expectedHealthEntryCount}`,
      );
    }

    holderAttempt.send_started_epoch_ms = Date.now();
    const holderPromise = sendClient(holderRequest, timeoutMs).then(
      (raw) => ({ raw, error: null }),
      (error) => ({ raw: null, error }),
    );
    holderOutcome = holderPromise;
    try {
      await mock.waitForHeld(caseId, Math.min(timeoutMs, HOLD_TIMEOUT_MS));
      heldObserved = true;
      holdObservedEpochMs = Date.now();
      holderAttempt.outcome = 'held';
    } catch (error) {
      exhaustedAttempt.outcome = 'not_sent';
      reuseAttempt.outcome = 'not_sent';
      throw runnerFailure(`controlled provider hold failed: ${error.message}`, 'MOCK_HOLD');
    }

    exhaustedAttempt.send_started_epoch_ms = Date.now();
    try {
      exhaustedRaw = await sendClient(exhaustedRequest, expectedExhaustion.deadline_ms);
    } catch (error) {
      throw runnerFailure(`mixed exhaustion client send rejected: ${error.message}`, 'HTTP_ADAPTER');
    } finally {
      exhaustedAttempt.send_settled_epoch_ms = Date.now();
    }
  } catch (error) {
    if (['COOLDOWN_SETUP', 'HEALTH_READ', 'MOCK_HOLD', 'HTTP_ADAPTER'].includes(error?.code)) {
      runnerDiagnostics.push(error.message);
    } else {
      runnerDiagnostics.push(`mixed concurrency runner error: ${error?.message ?? String(error)}`);
    }
  } finally {
    releaseStartedEpochMs = Date.now();
    try {
      releaseCount = await mock.releaseHeld(caseId);
    } catch (error) {
      runnerDiagnostics.push(`controlled provider release failed: ${error.message}`);
    } finally {
      releaseCompletedEpochMs = Date.now();
    }
  }

  if (holderOutcome) {
    try {
      const settled = await holderOutcome;
      holderRaw = settled.raw;
      if (settled.error) runnerDiagnostics.push(`holder client send rejected: ${settled.error.message}`);
      holderAttempt.send_settled_epoch_ms = Date.now();
      if (holderRaw) holderAttempt.outcome = 'settled';
    } catch (error) {
      runnerDiagnostics.push(`holder settlement failed: ${error.message}`);
    }
  }

  if (holderRaw && reuseRequest && !runnerDiagnostics.length) {
    reuseAttempt.send_started_epoch_ms = Date.now();
    try {
      reuseRaw = await sendClient(reuseRequest, timeoutMs);
      reuseAttempt.outcome = 'settled';
    } catch (error) {
      runnerDiagnostics.push(`capacity reuse client send rejected: ${error.message}`);
    } finally {
      reuseAttempt.send_settled_epoch_ms = Date.now();
    }
  } else if (!runnerDiagnostics.length) {
    productDiagnostics.push('capacity reuse request was skipped because the holder did not settle');
  }

  if (releaseCount !== 1) productDiagnostics.push(`controlled hold release count ${releaseCount} != 1`);
  if (!heldObserved) productDiagnostics.push('controlled provider hold was not observed');

  const timeline = {
    holder_send_started_epoch_ms: holderAttempt.send_started_epoch_ms,
    hold_observed_epoch_ms: holdObservedEpochMs,
    exhausted_send_started_epoch_ms: exhaustedAttempt.send_started_epoch_ms,
    exhausted_send_settled_epoch_ms: exhaustedAttempt.send_settled_epoch_ms,
    release_started_epoch_ms: releaseStartedEpochMs,
    release_completed_epoch_ms: releaseCompletedEpochMs,
    holder_send_settled_epoch_ms: holderAttempt.send_settled_epoch_ms,
    reuse_send_started_epoch_ms: reuseAttempt.send_started_epoch_ms,
    reuse_send_settled_epoch_ms: reuseAttempt.send_settled_epoch_ms,
  };
  if (holdObservedEpochMs === null
    || exhaustedAttempt.send_started_epoch_ms === null
    || holdObservedEpochMs > exhaustedAttempt.send_started_epoch_ms) {
    productDiagnostics.push('exhausted request started before the controlled provider hold was observed');
  }
  if (exhaustedAttempt.send_settled_epoch_ms === null
    || releaseStartedEpochMs === null
    || releaseStartedEpochMs < exhaustedAttempt.send_settled_epoch_ms) {
    productDiagnostics.push('controlled provider capacity was released before the exhausted request settled');
  }

  const holderObserved = holderRaw ? observeClient(holderRaw, entryProtocol) : null;
  if (holderObserved) {
    const clientResult = assertClientResult(
      holderObserved,
      {
        ...(fixture.expected_client ?? {}),
        no_control_leakage: fixture.assertions?.no_control_leakage !== false,
      },
      entryProtocol,
      PROTOCOL_DEPS,
    );
    productDiagnostics.push(...clientResult.diagnostics.map((line) => `holder: ${line}`));
  } else {
    productDiagnostics.push('holder client response missing');
  }

  const captures = readCaptures(mock, runnerDiagnostics);
  const probeCaptures = captures.filter((capture) => captureContainsInput(capture, probeMarker));
  const businessCaptures = captures.filter((capture) => {
    return !EXCLUDED_ATTEMPT_KINDS.has(capture?.attempt_kind)
      && !captureContainsInput(capture, probeMarker);
  });
  const holderCaptures = businessCaptures.slice(0, expectedHolderBusinessSends);
  const reuseCaptures = expectedReuseBusinessSends > 0
    ? businessCaptures.slice(-expectedReuseBusinessSends)
    : [];
  const expectedBusinessSendCount = expectedHolderBusinessSends + expectedReuseBusinessSends;
  const holderToken = authTokenOf(holderCaptures[0]);
  const probeToken = authTokenOf(probeCaptures[0]);

  if (businessCaptures.length !== expectedBusinessSendCount) {
    productDiagnostics.push(
      `mixed provider business sends ${businessCaptures.length} != ${expectedBusinessSendCount}`,
    );
  }
  if (holderCaptures.length !== expectedHolderBusinessSends) {
    productDiagnostics.push(
      `holder provider business sends ${holderCaptures.length} != ${expectedHolderBusinessSends}`,
    );
  }
  if (reuseCaptures.length !== expectedReuseBusinessSends) {
    productDiagnostics.push(
      `capacity reuse provider business sends ${reuseCaptures.length} != ${expectedReuseBusinessSends}`,
    );
  }
  if (probeCaptures.length !== expectedProbeSends) {
    productDiagnostics.push(`excluded provider probe sends ${probeCaptures.length} != ${expectedProbeSends}`);
  }
  if (holderToken && probeToken && holderToken === probeToken) {
    productDiagnostics.push('recovery probe used the holder provider identity instead of the excluded provider');
  }
  const unexpectedBusinessSends = businessCaptures
    .filter((capture) => holderToken && authTokenOf(capture) !== holderToken);
  const excludedBusinessSends = unexpectedBusinessSends
    .filter((capture) => probeToken && authTokenOf(capture) === probeToken);
  if (excludedBusinessSends.length !== 0) {
    productDiagnostics.push(`excluded provider received ${excludedBusinessSends.length} business sends instead of only a probe`);
  }
  if (unexpectedBusinessSends.length !== excludedBusinessSends.length) {
    productDiagnostics.push(
      `mixed provider received ${unexpectedBusinessSends.length} business send(s) from an unselected identity`,
    );
  }
  const reuseToken = authTokenOf(reuseCaptures[0]);
  if (holderToken && reuseToken && reuseToken !== holderToken) {
    productDiagnostics.push('capacity reuse did not return to the released holder provider identity');
  }

  if (fixture.expected_provider && holderCaptures[0]) {
    const providerResult = assertProviderCaptures(captures, 0, fixture.expected_provider, {
      providerProtocol,
      noControlLeakage: fixture.assertions?.no_control_leakage !== false,
    });
    productDiagnostics.push(...providerResult.diagnostics.map((line) => `holder provider: ${line}`));
  }

  if (!exhaustedRaw) {
    productDiagnostics.push('mixed-exhaustion client response missing');
  } else {
    const forbidden = new Set(expectedExhaustion.error_codes_must_not ?? []);
    const exhaustedCode = errorCodeOf(exhaustedRaw);
    if (exhaustedCode && forbidden.has(exhaustedCode)) {
      productDiagnostics.push(`mixed-exhaustion client used forbidden ${exhaustedCode}; product must close before timeout`);
    }
    if (!Boolean(exhaustedRaw.closed ?? exhaustedRaw.aborted)) {
      productDiagnostics.push('mixed-exhaustion client transport was not observably closed');
    }
    if (exhaustedRaw.response_ended) {
      productDiagnostics.push('mixed-exhaustion client transport completed instead of closing');
    }
    if (Number.isFinite(exhaustedRaw.elapsed_ms)
      && exhaustedRaw.elapsed_ms > expectedExhaustion.deadline_ms) {
      productDiagnostics.push(
        `mixed-exhaustion client close ${exhaustedRaw.elapsed_ms}ms exceeded deadline ${expectedExhaustion.deadline_ms}ms`,
      );
    }
    const exhaustedStatus = Number.isInteger(exhaustedRaw.status) ? exhaustedRaw.status : null;
    const exhaustedContentType = text(exhaustedRaw.headers?.['content-type']).toLowerCase();
    const exhaustedBody = text(exhaustedRaw.bodyText);
    if (exhaustedStatus !== null && exhaustedStatus !== 200) {
      productDiagnostics.push(`mixed-exhaustion client received HTTP ${exhaustedStatus} instead of a transport close`);
    }
    if (exhaustedBody.length > 0) {
      if (exhaustedStatus !== 200 || !exhaustedContentType.includes('text/event-stream')) {
        productDiagnostics.push('mixed-exhaustion client received a response body without SSE transport framing');
      } else if (hasSseSemanticContent(exhaustedBody)) {
        productDiagnostics.push('mixed-exhaustion client received a business/error SSE frame instead of keepalive-only framing');
      }
    }
  }

  if (!reuseRaw) {
    productDiagnostics.push('capacity reuse client response missing');
  } else {
    const reuseObserved = observeClient(reuseRaw, entryProtocol);
    if (reuseObserved) {
      const clientResult = assertClientResult(
        reuseObserved,
        {
          ...(isPlainObject(expectedReuseClient) ? expectedReuseClient : {}),
          no_control_leakage: fixture.assertions?.no_control_leakage !== false,
        },
        entryProtocol,
        PROTOCOL_DEPS,
      );
      productDiagnostics.push(...clientResult.diagnostics.map((line) => `capacity reuse: ${line}`));
    } else {
      productDiagnostics.push('capacity reuse client response could not be observed');
    }
  }

  try {
    healthAfter = await readHealthPool(sendHttp, String(rccUrl).replace(/\/+$/, ''), timeoutMs);
  } catch (error) {
    runnerDiagnostics.push(`after-health read failed: ${error.message}`);
  }
  if (healthBefore && healthAfter?.error) {
    productDiagnostics.push(`after-health read failed: ${healthAfter.error}`);
  } else if (healthBefore && healthAfter) {
    if (healthAfter.entries.length !== healthBefore.entries.length) {
      productDiagnostics.push(
        `health entry count changed from ${healthBefore.entries.length} to ${healthAfter.entries.length}`,
      );
    }
    const beforeSignature = cooldownIdentitySignature(healthBefore.entries);
    const afterSignature = cooldownIdentitySignature(healthAfter.entries);
    if (JSON.stringify(beforeSignature) !== JSON.stringify(afterSignature)) {
      productDiagnostics.push('cooldown identity entries changed across the mixed exhaustion');
    }
    if (healthAfter.entries.some((entry) => text(entry?.provider_id) !== excludedProviderId)) {
      productDiagnostics.push('mixed exhaustion mutated a non-excluded provider health entry');
    }
  }

  exhaustedAttempt.outcome = exhaustedRaw ? 'closed' : 'missing';
  const holderEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-holder-client.json`, {
    case_id: caseId,
    role: 'holder',
    request: requestEvidence(holderRequest),
    client_response: holderRaw,
    attempt: holderAttempt,
  }, evidenceRefs);
  const exhaustedEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-mixed-exhaustion-client.json`, {
    case_id: caseId,
    role: 'mixed-exhaustion',
    request: requestEvidence(exhaustedRequest),
    client_response: exhaustedRaw,
    expected: expectedExhaustion,
    attempt: exhaustedAttempt,
  }, evidenceRefs);
  const reuseEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-capacity-reuse-client.json`, {
    case_id: caseId,
    role: 'capacity-reuse',
    request: requestEvidence(reuseRequest),
    client_response: reuseRaw,
    attempt: reuseAttempt,
  }, evidenceRefs);
  const providerEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-provider.json`, {
    case_id: caseId,
    provider_captures: captures,
    probe_sends: probeCaptures.length,
    holder_business_sends: holderCaptures.length,
    reuse_business_sends: reuseCaptures.length,
  }, evidenceRefs);
  const healthEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-health.json`, {
    case_id: caseId,
    before: healthBefore,
    after: healthAfter,
    excluded_provider_id: excludedProviderId,
  }, evidenceRefs);

  return finalizeConcurrencyReport({
    fixture,
    capabilityDiagnostics,
    runnerDiagnostics,
    productDiagnostics,
    turnAttempts,
    evidenceRefs,
    observations: {
      provider_concurrency: {
        replay_kind: PROVIDER_CONCURRENCY_REPLAY_KIND,
        shape: PROVIDER_CONCURRENCY_MIXED_SHAPE,
        holder_held: heldObserved,
        release_count: releaseCount,
        upstream_business_sends: businessCaptures.length,
        holder_business_sends: holderCaptures.length,
        expected_holder_business_sends: expectedHolderBusinessSends,
        probe_sends: probeCaptures.length,
        expected_probe_sends: expectedProbeSends,
        reuse_business_sends: reuseCaptures.length,
        expected_reuse_business_sends: expectedReuseBusinessSends,
        excluded_provider_id: excludedProviderId,
        exhausted_client: exhaustedRaw ? {
          status: exhaustedRaw.status ?? null,
          closed: Boolean(exhaustedRaw.closed ?? exhaustedRaw.aborted),
          response_ended: Boolean(exhaustedRaw.response_ended),
          error_code: errorCodeOf(exhaustedRaw),
          elapsed_ms: exhaustedRaw.elapsed_ms ?? null,
        } : null,
        capacity_reuse_client: reuseRaw ? {
          status: reuseRaw.status ?? null,
          closed: Boolean(reuseRaw.closed ?? reuseRaw.aborted),
          response_ended: Boolean(reuseRaw.response_ended),
          error_code: errorCodeOf(reuseRaw),
        } : null,
        health: {
          before: healthBefore ? { entries: healthBefore.entries } : null,
          after: healthAfter ? { entries: healthAfter.entries } : null,
          before_signature: healthBefore ? cooldownSignature(healthBefore.entries) : null,
          after_signature: healthAfter ? cooldownSignature(healthAfter.entries) : null,
        },
        typed_error_codes: expectedTypedCodes,
        forbidden_typed_error_codes: forbiddenTypedCodes,
        debug_status: debugStatus ? {
          error: debugStatus.error ?? null,
          status: debugStatus.status ?? null,
          body_text: debugStatus.bodyText ?? null,
        } : null,
        timeline,
        exhausted_window: {
          started_epoch_ms: exhaustedAttempt.send_started_epoch_ms,
          settled_epoch_ms: exhaustedAttempt.send_settled_epoch_ms,
        },
        evidence: [holderEvidence, exhaustedEvidence, reuseEvidence, providerEvidence, healthEvidence],
      },
    },
  });

  async function sendClient(request, deadlineMs) {
    return sendHttp(`${String(rccUrl).replace(/\/+$/, '')}${request.path}`, {
      method: text(request.method) || 'POST',
      headers: requestHeaders(request),
      body: JSON.stringify(request.body ?? {}),
      timeoutMs: deadlineMs,
    });
  }
}

/**
 * Read request-records after the owned stop and require one terminal all-busy
 * row carrying the expected typed source code and execution mode.
 */
export function collectProviderConcurrencyEvidence({
  fixture,
  caseRoot,
  storePath,
  sampleRoot = null,
  listenerPort = null,
  exhaustedWindow = {},
  collectionPhase = 'post_stop_missing',
  stopReceipt = null,
} = {}) {
  const expectedMode = text(fixture?.cell?.mode) || null;
  const expectedCodes = fixture?.concurrency_replay?.typed_error_codes ?? [];
  const expectedSourceKind = text(fixture?.concurrency_replay?.expected_source_kind)
    || 'target_pool_exhausted';
  const expectedSourceStage = Object.prototype.hasOwnProperty.call(
    fixture?.concurrency_replay ?? {},
    'expected_source_stage',
  )
    ? fixture.concurrency_replay.expected_source_stage
    : 'V3Target10ConcreteProviderSelected';
  const requireEmptyAttempts = fixture?.concurrency_replay?.expected_attempts_empty === true;
  const expectedEndpoint = fixture?.concurrency_replay?.exhaustion_client_request?.path ?? null;
  const read = readStore(storePath);
  const findings = [...read.findings];
  const latest = latestRowsByRequestKey(read.rows);
  const started = finiteInteger(exhaustedWindow.started_epoch_ms);
  const settled = finiteInteger(exhaustedWindow.settled_epoch_ms);
  const windowRows = latest.filter((row) => {
    if (listenerPort !== null && Number(row.scope?.port) !== Number(listenerPort)) return false;
    if (expectedEndpoint && row.meta?.endpoint !== expectedEndpoint) return false;
    const rowStarted = finiteInteger(row.started_epoch_ms);
    return started !== null && settled !== null && rowStarted !== null
      && rowStarted >= started && rowStarted <= settled + 1000;
  });
  const terminalRows = windowRows.filter((row) => row.event_type === 'request.failed');
  const requestIds = [...new Set(windowRows
    .map((row) => text(row.meta?.request_id))
    .filter(Boolean))];
  const sample = readTypedSourceEvidence({
    sampleRoot,
    requestIds,
    expectedCodes,
  });
  const sampleInventory = readSampleInventory(sampleRoot);
  findings.push(...sample.findings);
  const matched = terminalRows.find(
    (row) => text(row.meta?.request_id) === text(sample.candidate?.request_id),
  ) ?? null;
  const observedMode = collectActualModeEvidence({
    rows: read.rows,
    listenerPort,
    expectedEndpoint,
    exhaustedSettled: settled,
  });
  const actualMode = observedMode.mode;
  const terminalSource = sample.candidate?.terminal_source;
  const foundCodes = isPlainObject(terminalSource) && typeof terminalSource.code === 'string'
    && expectedCodes.includes(terminalSource.code)
    ? [terminalSource.code]
    : [];
  const typedSource = sample.candidate
    ? {
      kind: sample.candidate.kind,
      request_id: sample.candidate.request_id,
      codes: foundCodes,
      observed_codes: sample.candidate.observed_codes,
      terminal_source: sample.candidate.terminal_source,
      terminal_cause: sample.candidate.terminal_cause,
    }
    : matched
    ? {
      kind: 'request.failed',
      request_id: text(matched.meta?.request_id) || null,
      codes: foundCodes,
    }
    : null;
  let status = 'pass';

  if (!storePath || read.bytes === null) {
    status = 'incomplete';
  } else if (collectionPhase !== 'post_stop_complete') {
    status = 'incomplete';
    findings.push(`collection phase ${collectionPhase} cannot prove flush completeness`);
  } else if (findings.length > 0) {
    status = 'incomplete';
  } else if (!typedSource) {
    status = 'mismatch';
    findings.push('no typed concurrency source matched the exhausted request window');
  } else {
    const acceptanceFindings = [];
    if (sample.candidate.kind !== 'provider_failed_attempts') {
      acceptanceFindings.push(`typed source kind ${sample.candidate.kind} != provider_failed_attempts`);
    }
    if (!isPlainObject(terminalSource)) {
      acceptanceFindings.push('typed source terminal_source is missing');
    } else {
      if (terminalSource.source_kind !== expectedSourceKind) {
        acceptanceFindings.push(
          `terminal source kind ${terminalSource.source_kind ?? 'missing'} != ${expectedSourceKind}`,
        );
      }
      if (expectedSourceStage !== null && terminalSource.source_stage !== expectedSourceStage) {
        acceptanceFindings.push(
          `terminal source stage ${terminalSource.source_stage ?? 'missing'} != ${expectedSourceStage}`,
        );
      }
    }
    if (foundCodes.length !== expectedCodes.length) {
      acceptanceFindings.push(
        `typed error codes missing at terminal source: expected ${expectedCodes.join(', ')}, observed ${foundCodes.join(', ') || 'none'}`,
      );
    }
    if (actualMode !== expectedMode) {
      acceptanceFindings.push(`execution mode mismatch: expected ${expectedMode}, observed ${actualMode}`);
    }
    if (requireEmptyAttempts && Array.isArray(sample.candidate.attempts) && sample.candidate.attempts.length > 0) {
      acceptanceFindings.push(
        `terminal source recorded ${sample.candidate.attempts.length} upstream attempt(s); capacity rejection must record none`,
      );
    }
    if (expectedMode === 'relay') {
      if (!matched) {
        acceptanceFindings.push(
          `relay exhausted request ${sample.candidate.request_id} is missing its matching request.failed row`,
        );
      } else {
        const hasFailureMode = isPlainObject(matched.meta)
          && Object.prototype.hasOwnProperty.call(matched.meta, 'execution_mode');
        const failureMode = matched.meta?.execution_mode;
        if (failureMode !== 'relay') {
          const observedFailureMode = !hasFailureMode
            ? 'missing'
            : failureMode === null
            ? 'null'
            : text(failureMode) || JSON.stringify(failureMode);
          acceptanceFindings.push(
            `relay exhausted request ${sample.candidate.request_id} failure row execution mode expected relay, observed ${observedFailureMode}`,
          );
        }
        if (!hasCompleteErrorChain(matched)) {
          acceptanceFindings.push(
            `relay exhausted request ${sample.candidate.request_id} is missing the V3Error01-06 chain`,
          );
        }
      }
    }
    if (acceptanceFindings.length > 0) {
      status = 'mismatch';
      findings.push(...acceptanceFindings);
    }
  }

  const recordsPath = caseRoot ? join(caseRoot, 'provider-concurrency-records.jsonl') : null;
  const evidencePath = caseRoot ? join(caseRoot, 'provider-concurrency-evidence.json') : null;
  const typedSourcePath = caseRoot ? join(caseRoot, 'provider-concurrency-typed-source.json') : null;
  const artifacts = {
    records_path: recordsPath,
    evidence_path: evidencePath,
    typed_source_path: typedSourcePath,
    records_written: false,
    evidence_written: false,
    typed_source_written: false,
  };
  const artifactFindings = [];
  if (caseRoot && read.bytes) {
    try {
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(recordsPath, read.bytes);
      artifacts.records_written = true;
    } catch (error) {
      artifactFindings.push(`provider-concurrency-records.jsonl write failed: ${error.message}`);
    }
  } else if (caseRoot) {
    artifactFindings.push('no raw request-record bytes available for provider concurrency evidence');
  }
  if (typedSourcePath && sample.candidate?.bytes) {
    try {
      writeFileSync(typedSourcePath, sample.candidate.bytes);
      artifacts.typed_source_written = true;
    } catch (error) {
      artifactFindings.push(`provider-concurrency-typed-source.json write failed: ${error.message}`);
    }
  }
  const result = {
    kind: 'provider concurrency typed exhaustion',
    status,
    expected_mode: expectedMode,
    actual_mode: actualMode,
    actual_mode_source: observedMode.source,
    expected_typed_error_codes: expectedCodes,
    typed_error_codes: foundCodes,
    collection_phase: collectionPhase,
    source_path: storePath ?? null,
    sample_root: sampleRoot ?? null,
    sample_inventory: sampleInventory,
    typed_source: typedSource,
    listener_port: listenerPort,
    stop_receipt: stopReceipt,
    raw_record_count: read.rows.length,
    request_keys: latest.map((row) => row.request_key).filter(Boolean),
    exhausted_window: { started_epoch_ms: started, settled_epoch_ms: settled },
    request_started_row: windowRows.find((row) => row.event_type === 'request.started') ?? null,
    matched_row: matched ? {
      request_key: matched.request_key ?? null,
      request_id: text(matched.meta?.request_id) || null,
      event_type: matched.event_type ?? null,
      execution_mode: matched.meta?.execution_mode ?? null,
      started_epoch_ms: matched.started_epoch_ms ?? null,
      finished_epoch_ms: matched.finished_epoch_ms ?? null,
      observed_error: matched.meta?.observed_error ?? null,
    } : null,
    findings: [...findings, ...artifactFindings],
    artifacts,
    records_ref: null,
    typed_source_ref: null,
    evidence_ref: null,
  };
  if (result.status === 'pass' && artifactFindings.length > 0) result.status = 'incomplete';
  result.records_ref = artifacts.records_written ? recordsPath : null;
  result.typed_source_ref = artifacts.typed_source_written ? typedSourcePath : null;
  if (evidencePath) {
    try {
      artifacts.evidence_written = true;
      result.evidence_ref = evidencePath;
      writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      artifacts.evidence_written = false;
      result.evidence_ref = null;
      result.findings.push(`provider-concurrency-evidence.json write failed: ${error.message}`);
      if (result.status === 'pass') result.status = 'incomplete';
    }
  }
  return result;
}

function attemptReceipt(request, source, attemptIndex) {
  return {
    attempt_index: attemptIndex,
    turn: null,
    turn_index: null,
    turn_id: null,
    source,
    endpoint: text(request?.path) || null,
    method: text(request?.method) || 'POST',
    entry_protocol: null,
    send_started_epoch_ms: null,
    send_settled_epoch_ms: null,
    outcome: 'pending',
    failure_code: null,
    failure_message: null,
  };
}

function requestEvidence(request) {
  return {
    method: text(request?.method) || 'POST',
    path: text(request?.path) || null,
    headers: requestHeaders(request),
    body_text: JSON.stringify(request?.body ?? {}),
  };
}

function observeClient(raw, entryProtocol) {
  try {
    return observeClientResult(raw, entryProtocol);
  } catch {
    return null;
  }
}

function readCaptures(mock, runnerDiagnostics) {
  try {
    const captures = mock.getCaptures();
    if (!Array.isArray(captures)) throw new Error('getCaptures did not return an array');
    return captures;
  } catch (error) {
    runnerDiagnostics.push(`provider capture read failed: ${error.message}`);
    return [];
  }
}

function writeConcurrencyEvidence(directory, name, value, refs) {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  refs.push(path);
  return path;
}

function runnerFailure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finalizeConcurrencyReport({
  fixture,
  capabilityDiagnostics,
  runnerDiagnostics,
  productDiagnostics,
  turnAttempts,
  evidenceRefs,
  observations,
}) {
  const status = capabilityDiagnostics.length
    ? 'not_run'
    : runnerDiagnostics.length
      ? 'infra_failure'
      : productDiagnostics.length
        ? 'failed'
        : 'passed';
  const diagnostics = [...capabilityDiagnostics, ...runnerDiagnostics, ...productDiagnostics];
  const providerAttempts = observations.provider_concurrency?.upstream_business_sends ?? 0;
  return {
    case_id: fixture?.case_id ?? null,
    cell: {
      entry_protocol: fixture?.cell?.entry_protocol ?? null,
      provider_protocol: fixture?.cell?.provider_protocol ?? null,
      transport: fixture?.cell?.transport ?? null,
      mode: fixture?.cell?.mode ?? null,
    },
    status,
    classification: status === 'passed'
      ? 'pass'
      : status === 'not_run'
        ? 'capability'
        : status === 'infra_failure'
          ? 'infrastructure'
          : 'product',
    diagnostic: diagnostics.length ? diagnostics.join('; ') : 'provider concurrency replay passed',
    product_failures: productDiagnostics.length,
    runner_failures: runnerDiagnostics.length,
    provider_attempt_count: providerAttempts,
    probe_attempt_count: 0,
    turn_attempts: turnAttempts,
    turn_results: [{
      turn: null,
      status: status === 'passed' ? 'passed' : 'failed',
      request_source: 'provider-concurrency-replay',
      provider_attempts: providerAttempts,
      client_closed: Boolean(observations.provider_concurrency?.exhausted_client?.closed),
      diagnostics,
    }],
    first_divergence: diagnostics.length ? 'provider_concurrency' : null,
    observations: {
      live: [{
        kind: 'provider_concurrency_all_busy',
        ...observations.provider_concurrency,
      }],
      infra: runnerDiagnostics.map((message) => ({ kind: 'infra_failure', message })),
      provider_concurrency: observations.provider_concurrency ?? null,
    },
    source_provenance: {
      verified: false,
      note: 'module evidence only; no provenance claim from an installed binary',
    },
    evidence_refs: evidenceRefs,
    captures: evidenceRefs.filter((path) => path.endsWith('-provider.json')),
    client_evidence: evidenceRefs.filter((path) => path.includes('-client.json')),
  };
}

function readStore(storePath) {
  if (!storePath) return { bytes: null, rows: [], findings: ['request-records store path unavailable'] };
  if (!existsSync(storePath)) return { bytes: null, rows: [], findings: [`store missing: ${storePath}`] };
  let bytes;
  try {
    bytes = readFileSync(storePath);
  } catch (error) {
    return { bytes: null, rows: [], findings: [`store read failed: ${error.message}`] };
  }
  const rows = [];
  const findings = [];
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    let envelope;
    try {
      envelope = JSON.parse(lines[index]);
    } catch (error) {
      findings.push(`line ${index + 1} invalid JSON: ${error.message}`);
      continue;
    }
    if (!isPlainObject(envelope) || envelope.schema_version !== 1 || !isPlainObject(envelope.row)) {
      findings.push(`line ${index + 1} unsupported request-record envelope`);
      continue;
    }
    rows.push(envelope.row);
  }
  return { bytes, rows, findings };
}

function latestRowsByRequestKey(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (typeof row.request_key !== 'string' || row.request_key.length === 0) continue;
    const previous = byKey.get(row.request_key);
    if (!previous || Number(row.updated_epoch_ms ?? 0) >= Number(previous.updated_epoch_ms ?? 0)) {
      byKey.set(row.request_key, row);
    }
  }
  return [...byKey.values()];
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function collectActualModeEvidence({
  rows,
  listenerPort,
  expectedEndpoint,
  exhaustedSettled,
}) {
  const candidates = rows.filter((row) => {
    if (row.event_type !== 'request.route_selected') return false;
    if (listenerPort !== null && Number(row.scope?.port) !== Number(listenerPort)) return false;
    if (expectedEndpoint && row.meta?.endpoint !== expectedEndpoint) return false;
    if (!text(row.meta?.execution_mode)) return false;
    const rowStarted = finiteInteger(row.started_epoch_ms);
    return exhaustedSettled === null || rowStarted === null || rowStarted <= exhaustedSettled + 1000;
  });
  const modes = [...new Set(candidates.map((row) => text(row.meta.execution_mode)))];
  if (modes.length !== 1) return { mode: null, source: null };
  const source = candidates.at(-1);
  return {
    mode: modes[0],
    source: {
      event_type: source.event_type,
      request_id: text(source.meta?.request_id) || null,
      execution_mode: modes[0],
      started_epoch_ms: source.started_epoch_ms ?? null,
    },
  };
}

function hasCompleteErrorChain(row) {
  const entries = row?.meta?.observed_error?.chain;
  if (!Array.isArray(entries)) return false;
  const nodes = new Set(entries.map((entry) => text(entry?.node)).filter(Boolean));
  return [
    'V3Error01SourceRaised',
    'V3Error02Classified',
    'V3Error03TargetLocalAction',
    'V3Error04TargetExhaustionDecision',
    'V3Error05ExecutionDecision',
    'V3Error06ClientProjected',
  ].every((node) => nodes.has(node));
}

function readTypedSourceEvidence({ sampleRoot, requestIds, expectedCodes }) {
  if (!sampleRoot || requestIds.length === 0) return { candidate: null, findings: [] };
  if (!existsSync(sampleRoot)) {
    return { candidate: null, findings: [`typed source sample root missing: ${sampleRoot}`] };
  }
  const findings = [];
  const paths = [];
  const walk = (directory, depth) => {
    if (depth > 6 || paths.length >= 1000) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      findings.push(`typed source directory read failed: ${error.message}`);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile() && TYPED_SOURCE_FILE_NAMES.has(entry.name)) {
        paths.push(path);
      }
    }
  };
  walk(sampleRoot, 0);
  const wantedRequestIds = new Set(requestIds);
  paths.sort((left, right) => typedSourcePriority(left) - typedSourcePriority(right)
    || left.localeCompare(right));
  let firstRequestCandidate = null;
  for (const path of paths) {
    let bytes;
    let payload;
    try {
      bytes = readFileSync(path);
      payload = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      findings.push(`typed source read failed for ${path}: ${error.message}`);
      continue;
    }
    const requestId = text(payload?.request_id);
    if (!requestId || !wantedRequestIds.has(requestId)) continue;
    const observedCodes = collectTypedCodes(payload);
    const candidate = {
      kind: path.endsWith('provider-failed-attempts.json')
        ? 'provider_failed_attempts'
        : 'error_evidence',
      path,
      request_id: requestId,
      bytes,
      codes: expectedCodes.filter((code) => observedCodes.includes(code)),
      observed_codes: observedCodes,
      terminal_source: payload?.terminal_source ?? null,
      terminal_cause: payload?.terminal_cause ?? null,
      attempts: Array.isArray(payload?.attempts) ? payload.attempts : [],
    };
    if (candidate.codes.length === expectedCodes.length) {
      return {
        candidate,
        findings,
      };
    }
    if (!firstRequestCandidate) {
      firstRequestCandidate = candidate;
    }
  }
  if (firstRequestCandidate) {
    return {
      candidate: firstRequestCandidate,
      findings,
    };
  }
  return { candidate: null, findings };
}

function collectTypedCodes(payload) {
  const codes = [];
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      if (key === 'code' && !codes.includes(value)) codes.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry, key);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [entryKey, entry] of Object.entries(value)) collect(entry, entryKey);
  };
  collect(payload);
  return codes;
}

function readSampleInventory(sampleRoot) {
  if (!sampleRoot || !existsSync(sampleRoot)) return [];
  const files = [];
  const walk = (directory, depth) => {
    if (depth > 6 || files.length >= 1000) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.slice(sampleRoot.length + 1));
      }
    }
  };
  walk(sampleRoot, 0);
  return files;
}

function typedSourcePriority(path) {
  return path.endsWith('provider-failed-attempts.json') ? 0 : 1;
}

function hasSseSemanticContent(bodyText) {
  return bodyText
    .split(/\r\n|\n|\r/)
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0)
    .some((line) => !line.startsWith(':'));
}

function excludedProviderIdFromFixture(fixture) {
  const candidates = Array.isArray(fixture?.runtime_setup?.candidate_ids)
    ? fixture.runtime_setup.candidate_ids
    : [];
  if (candidates.length < 2) return '';
  return text(candidates[1]?.split('/')[0]) || '';
}

async function readHealthPool(sendHttp, baseUrl, timeoutMs) {
  const raw = await sendHttp(`${baseUrl}${HEALTH_POOL_PATH}`, {
    method: 'GET',
    headers: {},
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  return {
    error: raw.error ?? null,
    status: raw.status ?? null,
    entries: Array.isArray(raw.body?.entries) ? raw.body.entries : [],
    port: raw.body?.port ?? null,
  };
}

function cooldownSignature(entries) {
  return (entries ?? [])
    .map((entry) => [
      text(entry?.provider_id),
      text(entry?.interface_id),
      text(entry?.auth_alias),
      text(entry?.model_id),
      text(entry?.kind),
      text(entry?.state),
    ].join('|'))
    .sort();
}

function cooldownIdentitySignature(entries) {
  return (entries ?? [])
    .map((entry) => [
      text(entry?.provider_id),
      text(entry?.interface_id),
      text(entry?.auth_alias),
      text(entry?.model_id),
      text(entry?.kind),
    ].join('|'))
    .sort();
}

function captureContainsInput(capture, marker) {
  const input = capture?.body?.input;
  if (typeof input === 'string') return input.includes(marker);
  return JSON.stringify(input ?? capture?.raw_body ?? '').includes(marker);
}

function authTokenOf(capture) {
  const header = capture?.headers?.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
}

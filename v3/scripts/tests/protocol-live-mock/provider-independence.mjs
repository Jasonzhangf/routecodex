// Deterministic installed-binary replay for independent provider requests.
//
// Two behaviors are covered:
//   1. Requests held at the same upstream identity reach that upstream
//      independently. The arrival barrier, not a final 200, proves the old
//      request-concurrency admission limit no longer exists.
//   2. A real provider HTTP error on one candidate is isolated in the typed
//      Error chain, switches candidates, and still returns a genuine client
//      response. The held sibling request is unaffected.

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

export const PROVIDER_REQUEST_INDEPENDENCE_KIND = 'provider_request_independence';
export const PROVIDER_HELD_CONCURRENT_SHAPE = 'held_concurrent_requests';
export const PROVIDER_FAILURE_ISOLATION_SHAPE = 'failure_isolation';

const PROTOCOL_DEPS = Object.freeze({ parseClientBody, findSemanticTerminal });
const EXCLUDED_ATTEMPT_KINDS = new Set(['probe', 'startup']);
const HOLD_TIMEOUT_MS = 5_000;
const HEALTH_POOL_PATH = '/_routecodex/health/cooldown-pool';
const TYPED_SOURCE_FILE_NAMES = new Set(['provider-failed-attempts.json', 'error.json']);
const CLIENT_ERROR_MARKERS = ['provider_error', 'internal_error', 'routecodex_internal'];

/**
 * Historical name kept for the matrix entrypoint: these fixtures are still the
 * issue-745f6e9 provider-concurrency cases, but the contract is request
 * independence, not capacity saturation.
 */
export function isProviderConcurrencyReplay(fixture) {
  return fixture?.request_independence_replay?.kind === PROVIDER_REQUEST_INDEPENDENCE_KIND;
}

export async function runProviderConcurrencyReplay({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs = 30_000,
} = {}) {
  const replay = isPlainObject(fixture?.request_independence_replay)
    ? fixture.request_independence_replay
    : {};
  const shape = replay.shape ?? PROVIDER_HELD_CONCURRENT_SHAPE;
  if (shape === PROVIDER_FAILURE_ISOLATION_SHAPE) {
    return runFailureIsolationReplay({ fixture, mock, rccUrl, sendHttp, evidenceRoot, timeoutMs });
  }
  if (shape === PROVIDER_HELD_CONCURRENT_SHAPE) {
    return runHeldConcurrentReplay({ fixture, mock, rccUrl, sendHttp, evidenceRoot, timeoutMs });
  }
  return finalizeIndependenceReport(fixture, {
    capabilityDiagnostics: [`capability_missing: unsupported request independence shape ${shape}`],
  });
}

async function runHeldConcurrentReplay({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs,
}) {
  const caseId = text(fixture?.case_id) || 'unknown-case';
  const entryProtocol = text(fixture?.cell?.entry_protocol);
  const providerProtocol = text(fixture?.cell?.provider_protocol);
  const replay = fixture.request_independence_replay ?? {};
  const holderRequest = fixture?.client_request;
  const concurrentRequests = Array.isArray(replay.concurrent_client_requests)
    ? replay.concurrent_client_requests
    : [];
  const expectedConcurrent = replay.expected_concurrent_client ?? {};
  const expectedBusinessSends = replay.expected_upstream_business_sends;
  const forbiddenCodes = Array.isArray(replay.typed_error_codes_must_not)
    ? replay.typed_error_codes_must_not
    : [];
  const expectedTotal = concurrentRequests.length + 1;
  const capabilityDiagnostics = [];
  if (!isProviderConcurrencyReplay(fixture)) {
    capabilityDiagnostics.push(`capability_missing: request independence replay not declared for ${caseId}`);
  }
  for (const [label, request] of [
    ['holder request', holderRequest],
    ...concurrentRequests.map((request, index) => [`concurrent request ${index + 1}`, request]),
  ]) {
    if (!isPlainObject(request) || typeof request.path !== 'string' || !request.path.startsWith('/')) {
      capabilityDiagnostics.push(`capability_missing: ${label} must declare an absolute path`);
    }
  }
  for (const name of ['setActiveCase', 'getCaptures', 'waitForHeldCount', 'releaseHeldAll', 'heldCount']) {
    if (typeof mock?.[name] !== 'function') capabilityDiagnostics.push(`capability_missing: ${name} function required`);
  }
  if (typeof sendHttp !== 'function') capabilityDiagnostics.push('capability_missing: sendHttp function required');
  if (expectedBusinessSends !== expectedTotal) {
    capabilityDiagnostics.push(
      `capability_missing: expected_upstream_business_sends must be ${expectedTotal} (holder plus concurrent requests)`,
    );
  }
  if (capabilityDiagnostics.length > 0) {
    return finalizeIndependenceReport(fixture, { capabilityDiagnostics });
  }

  const captureDir = join(evidenceRoot, 'captures');
  try {
    mkdirSync(captureDir, { recursive: true });
  } catch (error) {
    return finalizeIndependenceReport(fixture, { runnerDiagnostics: [`evidence root unwritable: ${error.message}`] });
  }

  const productDiagnostics = [];
  const runnerDiagnostics = [];
  const evidenceRefs = [];
  const attempts = [];
  const clients = [];
  let releaseCount = 0;
  let heldAtBarrier = 0;
  let barrierReached = false;
  let debugStatus = null;
  let releaseStartedEpochMs = null;

  mock.setActiveCase(fixture, 0);
  const holderAttempt = attemptReceipt(holderRequest, 'holder', attempts.length);
  attempts.push(holderAttempt);
  holderAttempt.send_started_epoch_ms = Date.now();
  const holderPromise = sendClient(holderRequest, timeoutMs).then(
    (raw) => ({ raw, error: null, attempt: holderAttempt }),
    (error) => ({ raw: null, error, attempt: holderAttempt }),
  );
  const concurrentSettlements = [];
  try {
    debugStatus = await readDebugStatus(sendHttp, rccUrl);
    await mock.waitForHeldCount(caseId, 1, Math.min(timeoutMs, HOLD_TIMEOUT_MS));
    for (const [index, request] of concurrentRequests.entries()) {
      const attempt = attemptReceipt(request, `independent-${index + 2}`, attempts.length);
      attempts.push(attempt);
      attempt.send_started_epoch_ms = Date.now();
      const settlement = sendClient(request, timeoutMs).then(
        (raw) => ({ raw, error: null, attempt }),
        (error) => ({ raw: null, error, attempt }),
      );
      concurrentSettlements.push(settlement);
    }
    await mock.waitForHeldCount(caseId, expectedTotal, Math.min(timeoutMs, HOLD_TIMEOUT_MS));
    heldAtBarrier = mock.heldCount(caseId);
    barrierReached = heldAtBarrier >= expectedTotal;
    if (!barrierReached) {
      productDiagnostics.push(
        `only ${heldAtBarrier} of ${expectedTotal} independent requests reached the upstream before release`,
      );
    }
  } catch (error) {
    heldAtBarrier = typeof mock.heldCount === 'function' ? mock.heldCount(caseId) : 0;
    productDiagnostics.push(
      `independent arrival barrier failed after ${heldAtBarrier} of ${expectedTotal} requests: ${error.message}`,
    );
  } finally {
    releaseStartedEpochMs = Date.now();
    try {
      releaseCount = await mock.releaseHeldAll(caseId);
    } catch (error) {
      runnerDiagnostics.push(`controlled provider release failed: ${error.message}`);
    }
  }

  const holderSettled = await settle(holderPromise, 'holder', holderAttempt, runnerDiagnostics);
  const concurrentRaws = [];
  for (const settlement of concurrentSettlements) {
    const settled = await settle(settlement, 'independent', null, runnerDiagnostics);
    concurrentRaws.push(settled);
  }

  if (releaseCount !== expectedTotal) {
    productDiagnostics.push(`controlled hold release count ${releaseCount} != ${expectedTotal}`);
  }
  const holders = [holderSettled, ...concurrentRaws];
  for (const [index, entry] of holders.entries()) {
    const label = index === 0 ? 'holder' : `independent request ${index + 1}`;
    const expected = index === 0 ? fixture.expected_client : expectedConcurrent;
    const observed = entry.raw ? observeClient(entry.raw, entryProtocol) : null;
    if (!observed) {
      productDiagnostics.push(`${label} client response missing`);
      continue;
    }
    const result = assertClientResult(
      observed,
      {
        ...expected,
        no_control_leakage: fixture.assertions?.no_control_leakage !== false,
      },
      entryProtocol,
      PROTOCOL_DEPS,
    );
    productDiagnostics.push(...result.diagnostics.map((line) => `${label}: ${line}`));
    clients.push(clientSummary(label, entry.raw));
  }

  const captures = readCaptures(mock, runnerDiagnostics);
  const business = businessCaptures(captures);
  if (business.length !== expectedBusinessSends) {
    productDiagnostics.push(`provider business sends ${business.length} != ${expectedBusinessSends}`);
  }
  const lateCaptures = business.filter((capture) => {
    const capturedAt = finiteInteger(capture?.captured_at_epoch_ms);
    return releaseStartedEpochMs !== null && capturedAt !== null && capturedAt > releaseStartedEpochMs;
  });
  if (lateCaptures.length > 0) {
    productDiagnostics.push(`${lateCaptures.length} provider business send(s) arrived after the controlled release`);
  }
  const identities = new Set(business.map((capture) => authTokenOf(capture)).filter(Boolean));
  if (identities.size > 1) {
    productDiagnostics.push(`independent requests used ${identities.size} provider identities instead of one`);
  }
  if (fixture.expected_provider && business[0]) {
    const providerResult = assertProviderCaptures(captures, 0, fixture.expected_provider, {
      providerProtocol,
      noControlLeakage: fixture.assertions?.no_control_leakage !== false,
    });
    productDiagnostics.push(...providerResult.diagnostics.map((line) => `holder provider: ${line}`));
  }
  checkForbiddenCodes(captures, forbiddenCodes, productDiagnostics);

  const window = requestWindow(holderAttempt, holders);
  const providerEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-provider.json`, {
    case_id: caseId,
    provider_captures: captures,
    business_sends: business.length,
    expected_business_sends: expectedBusinessSends,
    release_started_epoch_ms: releaseStartedEpochMs,
  }, evidenceRefs);
  const clientEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-clients.json`, {
    case_id: caseId,
    clients: holders.map((entry, index) => ({
      role: index === 0 ? 'holder' : `independent_${index + 1}`,
      request: requestEvidence(index === 0 ? holderRequest : concurrentRequests[index - 1]),
      client_response: entry.raw,
    })),
  }, evidenceRefs);

  return finalizeIndependenceReport(fixture, {
    runnerDiagnostics,
    productDiagnostics,
    turnAttempts: attempts,
    evidenceRefs,
    observations: {
      provider_concurrency: {
        replay_kind: PROVIDER_REQUEST_INDEPENDENCE_KIND,
        shape: PROVIDER_HELD_CONCURRENT_SHAPE,
        expected_requests: expectedTotal,
        held_at_barrier: heldAtBarrier,
        arrival_barrier_reached: barrierReached,
        release_count: releaseCount,
        upstream_business_sends: business.length,
        expected_upstream_business_sends: expectedBusinessSends,
        clients,
        typed_error_codes_must_not: forbiddenCodes,
        debug_status: debugStatus,
        exhausted_window: window,
        request_window: window,
        evidence: [providerEvidence, clientEvidence],
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

async function runFailureIsolationReplay({
  fixture,
  mock,
  rccUrl,
  sendHttp,
  evidenceRoot,
  timeoutMs,
}) {
  const caseId = text(fixture?.case_id) || 'unknown-case';
  const entryProtocol = text(fixture?.cell?.entry_protocol);
  const providerProtocol = text(fixture?.cell?.provider_protocol);
  const replay = fixture.request_independence_replay ?? {};
  const isolation = isPlainObject(replay.failure_isolation) ? replay.failure_isolation : {};
  const holderRequest = fixture?.client_request;
  const failedRequest = replay.failed_client_request;
  const recoveryRequest = replay.post_recovery_client_request;
  const expectedFailed = replay.expected_failed_client ?? {};
  const expectedRecovery = replay.expected_post_recovery_client ?? {};
  const forbiddenCodes = Array.isArray(replay.typed_error_codes_must_not)
    ? replay.typed_error_codes_must_not
    : [];
  const expectedFailedStatus = isolation.expected_provider_status;
  const expectedHolderBusinessSends = isolation.expected_holder_business_sends ?? 1;
  const expectedFailedBusinessSends = isolation.expected_failed_business_sends ?? 1;
  const expectedRecoveryBusinessSends = isolation.expected_recovery_business_sends ?? 1;
  const capabilityDiagnostics = [];
  if (!isProviderConcurrencyReplay(fixture)) {
    capabilityDiagnostics.push(`capability_missing: request independence replay not declared for ${caseId}`);
  }
  for (const [label, request] of [
    ['holder request', holderRequest],
    ['failed request', failedRequest],
    ['post-recovery request', recoveryRequest],
  ]) {
    if (!isPlainObject(request) || typeof request.path !== 'string' || !request.path.startsWith('/')) {
      capabilityDiagnostics.push(`capability_missing: ${label} must declare an absolute path`);
    }
  }
  if (!text(isolation.failed_provider_id) || !text(isolation.recovered_provider_id)) {
    capabilityDiagnostics.push('capability_missing: failed_provider_id and recovered_provider_id required');
  }
  for (const name of ['setActiveCase', 'getCaptures', 'waitForHeldCount', 'releaseHeldAll']) {
    if (typeof mock?.[name] !== 'function') capabilityDiagnostics.push(`capability_missing: ${name} function required`);
  }
  if (typeof sendHttp !== 'function') capabilityDiagnostics.push('capability_missing: sendHttp function required');
  if (!Number.isInteger(expectedFailedStatus) || expectedFailedStatus < 400 || expectedFailedStatus > 599) {
    capabilityDiagnostics.push('capability_missing: expected_provider_status must be a provider HTTP error status');
  }
  if (capabilityDiagnostics.length > 0) {
    return finalizeIndependenceReport(fixture, { capabilityDiagnostics });
  }

  const captureDir = join(evidenceRoot, 'captures');
  try {
    mkdirSync(captureDir, { recursive: true });
  } catch (error) {
    return finalizeIndependenceReport(fixture, { runnerDiagnostics: [`evidence root unwritable: ${error.message}`] });
  }

  const productDiagnostics = [];
  const runnerDiagnostics = [];
  const evidenceRefs = [];
  const attempts = [];
  const clients = [];
  let releaseCount = 0;
  let healthBefore = null;
  let healthAfter = null;
  let debugStatus = null;
  let heldObserved = false;
  let releaseStartedEpochMs = null;

  mock.setActiveCase(fixture, 0);
  const holderAttempt = attemptReceipt(holderRequest, 'holder', attempts.length);
  const failedAttempt = attemptReceipt(failedRequest, 'provider-failure-recovery', attempts.length + 1);
  const recoveryAttempt = attemptReceipt(recoveryRequest, 'post-recovery', attempts.length + 2);
  attempts.push(holderAttempt, failedAttempt, recoveryAttempt);
  holderAttempt.send_started_epoch_ms = Date.now();
  const holderPromise = sendClient(holderRequest, timeoutMs).then(
    (raw) => ({ raw, error: null, attempt: holderAttempt }),
    (error) => ({ raw: null, error, attempt: holderAttempt }),
  );
  let failedRaw = null;
  try {
    debugStatus = await readDebugStatus(sendHttp, rccUrl);
    await mock.waitForHeldCount(caseId, 1, Math.min(timeoutMs, HOLD_TIMEOUT_MS));
    heldObserved = true;
    healthBefore = await readHealthPool(sendHttp, baseUrl(rccUrl), timeoutMs);
    failedAttempt.send_started_epoch_ms = Date.now();
    failedRaw = await sendClient(failedRequest, timeoutMs);
  } catch (error) {
    productDiagnostics.push(`independent provider failure request failed to complete: ${error.message}`);
  } finally {
    failedAttempt.send_settled_epoch_ms = Date.now();
    releaseStartedEpochMs = Date.now();
    try {
      releaseCount = await mock.releaseHeldAll(caseId);
    } catch (error) {
      runnerDiagnostics.push(`controlled provider release failed: ${error.message}`);
    }
  }
  const holderSettled = await settle(holderPromise, 'holder', holderAttempt, runnerDiagnostics);
  let recoveryRaw = null;
  try {
    recoveryAttempt.send_started_epoch_ms = Date.now();
    recoveryRaw = await sendClient(recoveryRequest, timeoutMs);
  } catch (error) {
    productDiagnostics.push(`post-recovery request failed: ${error.message}`);
  } finally {
    recoveryAttempt.send_settled_epoch_ms = Date.now();
  }
  try {
    healthAfter = await readHealthPool(sendHttp, baseUrl(rccUrl), timeoutMs);
  } catch (error) {
    runnerDiagnostics.push(`after-health read failed: ${error.message}`);
  }

  if (!heldObserved) productDiagnostics.push('controlled provider hold was not observed');
  if (releaseCount !== 1) productDiagnostics.push(`controlled hold release count ${releaseCount} != 1`);
  for (const [label, entry, expected] of [
    ['holder', holderSettled, fixture.expected_client],
    ['provider-failure recovery', { raw: failedRaw }, expectedFailed],
    ['post-recovery', { raw: recoveryRaw }, expectedRecovery],
  ]) {
    const observed = entry.raw ? observeClient(entry.raw, entryProtocol) : null;
    if (!observed) {
      productDiagnostics.push(`${label} client response missing`);
      continue;
    }
    const result = assertClientResult(
      observed,
      {
        ...expected,
        no_control_leakage: fixture.assertions?.no_control_leakage !== false,
      },
      entryProtocol,
      PROTOCOL_DEPS,
    );
    productDiagnostics.push(...result.diagnostics.map((line) => `${label}: ${line}`));
    if (errorCodeOf(entry.raw)) productDiagnostics.push(`${label} client used transport error ${errorCodeOf(entry.raw)}`);
    clients.push(clientSummary(label, entry.raw));
  }

  const captures = readCaptures(mock, runnerDiagnostics);
  const business = businessCaptures(captures);
  const expectedBusiness = expectedHolderBusinessSends + expectedFailedBusinessSends + expectedRecoveryBusinessSends;
  if (business.length !== expectedBusiness) {
    productDiagnostics.push(`provider business sends ${business.length} != ${expectedBusiness}`);
  }
  const holderCapture = business[0];
  const failedCapture = business[1];
  const recoveredCaptures = business.slice(2);
  const failedScriptStatus = Number.isInteger(failedCapture?.response_script?.status)
    ? failedCapture.response_script.status
    : null;
  if (failedScriptStatus !== expectedFailedStatus) {
    productDiagnostics.push(
      `failed provider attempt status ${failedScriptStatus ?? 'missing'} != ${expectedFailedStatus}`,
    );
  }
  if (recoveredCaptures.length !== expectedRecoveryBusinessSends) {
    productDiagnostics.push(
      `recovered candidate business sends ${recoveredCaptures.length} != ${expectedRecoveryBusinessSends}`,
    );
  }
  if (fixture.expected_provider && holderCapture) {
    const providerResult = assertProviderCaptures(captures, 0, fixture.expected_provider, {
      providerProtocol,
      noControlLeakage: fixture.assertions?.no_control_leakage !== false,
    });
    productDiagnostics.push(...providerResult.diagnostics.map((line) => `holder provider: ${line}`));
  }
  checkForbiddenCodes(captures, forbiddenCodes, productDiagnostics);

  const window = {
    started_epoch_ms: failedAttempt.send_started_epoch_ms,
    settled_epoch_ms: recoveryAttempt.send_settled_epoch_ms ?? failedAttempt.send_settled_epoch_ms,
    failed_started_epoch_ms: failedAttempt.send_started_epoch_ms,
    failed_settled_epoch_ms: failedAttempt.send_settled_epoch_ms,
    recovery_started_epoch_ms: recoveryAttempt.send_started_epoch_ms,
    recovery_settled_epoch_ms: recoveryAttempt.send_settled_epoch_ms,
  };
  const providerEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-provider.json`, {
    case_id: caseId,
    provider_captures: captures,
    business_sends: business.length,
    expected_business_sends: expectedBusiness,
    failed_provider_id: isolation.failed_provider_id,
    recovered_provider_id: isolation.recovered_provider_id,
    release_started_epoch_ms: releaseStartedEpochMs,
  }, evidenceRefs);
  const clientEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-clients.json`, {
    case_id: caseId,
    clients: [
      { role: 'holder', request: requestEvidence(holderRequest), client_response: holderSettled.raw },
      { role: 'provider-failure-recovery', request: requestEvidence(failedRequest), client_response: failedRaw },
      { role: 'post-recovery', request: requestEvidence(recoveryRequest), client_response: recoveryRaw },
    ],
  }, evidenceRefs);
  const healthEvidence = writeConcurrencyEvidence(captureDir, `${caseId}-health.json`, {
    case_id: caseId,
    before: healthBefore,
    after: healthAfter,
  }, evidenceRefs);

  return finalizeIndependenceReport(fixture, {
    runnerDiagnostics,
    productDiagnostics,
    turnAttempts: attempts,
    evidenceRefs,
    observations: {
      provider_concurrency: {
        replay_kind: PROVIDER_REQUEST_INDEPENDENCE_KIND,
        shape: PROVIDER_FAILURE_ISOLATION_SHAPE,
        holder_held: heldObserved,
        release_count: releaseCount,
        upstream_business_sends: business.length,
        expected_upstream_business_sends: expectedBusiness,
        failed_provider_id: isolation.failed_provider_id,
        recovered_provider_id: isolation.recovered_provider_id,
        failed_provider_status: failedScriptStatus,
        expected_failed_provider_status: expectedFailedStatus,
        failed_provider_business_sends: failedCapture ? 1 : 0,
        recovered_business_sends: recoveredCaptures.length,
        clients,
        health: {
          before: healthBefore ? { entries: healthBefore.entries } : null,
          after: healthAfter ? { entries: healthAfter.entries } : null,
        },
        typed_error_codes_must_not: forbiddenCodes,
        debug_status: debugStatus,
        exhausted_window: window,
        request_window: window,
        evidence: [providerEvidence, clientEvidence, healthEvidence],
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
 * Read request-records after the owned stop and bind the replay to persisted
 * execution-mode and typed-error evidence.
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
  const replay = isPlainObject(fixture?.request_independence_replay)
    ? fixture.request_independence_replay
    : {};
  const shape = replay.shape ?? PROVIDER_HELD_CONCURRENT_SHAPE;
  const isolation = isPlainObject(replay.failure_isolation) ? replay.failure_isolation : {};
  const expectedMode = text(fixture?.cell?.mode) || null;
  const forbiddenCodes = Array.isArray(replay.typed_error_codes_must_not)
    ? replay.typed_error_codes_must_not
    : [];
  const expectedEndpoint = fixture?.client_request?.path ?? null;
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
  const completedRows = windowRows.filter((row) => row.event_type === 'request.completed');
  const failedRows = windowRows.filter((row) => row.event_type === 'request.failed');
  const requestIds = uniqueRequestIds(windowRows);
  const failedWindowStarted = finiteInteger(exhaustedWindow.failed_started_epoch_ms);
  const failedWindowSettled = finiteInteger(exhaustedWindow.failed_settled_epoch_ms);
  const failedRequestIds = failedWindowStarted !== null && failedWindowSettled !== null
    ? uniqueRequestIds(rowsForWindow(
        latest,
        failedWindowStarted,
        failedWindowSettled,
        listenerPort,
        expectedEndpoint,
      ))
    : [];
  const typedRequestIds = shape === PROVIDER_FAILURE_ISOLATION_SHAPE
    ? (failedRequestIds.length > 0 ? failedRequestIds : requestIds)
    : requestIds;
  const sample = readTypedSourceEvidence({ sampleRoot, requestIds: typedRequestIds });
  sample.findings.forEach((finding) => findings.push(finding));
  const sampleInventory = readSampleInventory(sampleRoot);
  const observedMode = collectActualModeEvidence({
    rows: read.rows,
    listenerPort,
    expectedEndpoint,
    windowSettled: settled,
  });
  const actualMode = observedMode.mode;
  let status = 'pass';

  if (!storePath || read.bytes === null) {
    status = 'incomplete';
  } else if (collectionPhase !== 'post_stop_complete') {
    status = 'incomplete';
    findings.push(`collection phase ${collectionPhase} cannot prove flush completeness`);
  } else if (findings.length > 0) {
    status = 'incomplete';
  } else if (!actualMode) {
    status = 'mismatch';
    findings.push('no persisted route-selected execution mode matched the replay window');
  } else {
    const acceptanceFindings = [];
    if (actualMode !== expectedMode) {
      acceptanceFindings.push(`execution mode mismatch: expected ${expectedMode}, observed ${actualMode}`);
    }
    const typedCodes = sample.candidate?.observed_codes ?? [];
    const forbiddenFound = typedCodes.filter((code) => forbiddenCodes.includes(code));
    if (forbiddenFound.length > 0) {
      acceptanceFindings.push(`retired concurrency/error code(s) observed: ${forbiddenFound.join(', ')}`);
    }
    if (shape === PROVIDER_HELD_CONCURRENT_SHAPE) {
      if (failedRows.length > 0) {
        acceptanceFindings.push(`independent requests recorded ${failedRows.length} request.failed row(s)`);
      }
      const expectedSends = replay.expected_upstream_business_sends;
      if (Number.isInteger(expectedSends) && completedRows.length < expectedSends) {
        acceptanceFindings.push(
          `independent replay recorded ${completedRows.length} completed request(s), expected ${expectedSends}`,
        );
      }
    } else {
      if (failedRows.length > 0) {
        acceptanceFindings.push(
          `recovered provider-failure request closed with ${failedRows.length} request.failed row(s)`,
        );
      }
      const candidate = sample.candidate;
      if (!candidate) {
        acceptanceFindings.push('no typed provider-failure source matched the recovery request');
      } else {
        const attempts = Array.isArray(candidate.attempts) ? candidate.attempts : [];
        const candidateIds = Array.isArray(fixture?.runtime_setup?.candidate_ids)
          ? fixture.runtime_setup.candidate_ids.map((id) => String(id).split('/')[0])
          : [];
        const failedAttempt = attempts.find((attempt) => {
          return Number(attempt?.status) === Number(isolation.expected_provider_status)
            && text(attempt?.action) === text(isolation.expected_action);
        });
        if (!failedAttempt) {
          acceptanceFindings.push(
            `typed source has no provider attempt with status ${isolation.expected_provider_status ?? 'missing'} and action ${isolation.expected_action ?? 'missing'}`,
          );
        } else if (candidateIds.length > 0 && !candidateIds.includes(text(failedAttempt.provider_id))) {
          acceptanceFindings.push(
            `typed failed provider ${failedAttempt.provider_id ?? 'missing'} is not a declared candidate`,
          );
        }
        if (candidate.terminal_source && isolation.expected_action !== 'switch_provider') {
          acceptanceFindings.push('recovered request must not publish a terminal exhaustion source');
        }
      }
      // The failure window opens when the failed request starts and closes
      // after the post-recovery request settles; both requests complete.
      const expectedCompletedRows = 2;
      if (completedRows.length < expectedCompletedRows) {
        acceptanceFindings.push(
          `recovery replay recorded ${completedRows.length} completed request(s), expected ${expectedCompletedRows}`,
        );
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
    kind: 'provider request independence',
    shape,
    status,
    expected_mode: expectedMode,
    actual_mode: actualMode,
    actual_mode_source: observedMode.source,
    expected_typed_error_codes_must_not: forbiddenCodes,
    observed_typed_codes: sample.candidate?.observed_codes ?? [],
    collection_phase: collectionPhase,
    source_path: storePath ?? null,
    sample_root: sampleRoot ?? null,
    sample_inventory: sampleInventory,
    typed_source: sample.candidate
      ? {
          request_id: sample.candidate.request_id,
          observed_codes: sample.candidate.observed_codes,
          attempts: sample.candidate.attempts,
          terminal_source: sample.candidate.terminal_source,
        }
      : null,
    listener_port: listenerPort,
    stop_receipt: stopReceipt,
    raw_record_count: read.rows.length,
    request_keys: latest.map((row) => row.request_key).filter(Boolean),
    exhausted_window: { started_epoch_ms: started, settled_epoch_ms: settled },
    request_started_row: windowRows.find((row) => row.event_type === 'request.started') ?? null,
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

async function settle(settlementPromise, label, attempt, runnerDiagnostics) {
  const settled = await settlementPromise;
  const receipt = attempt ?? settled.attempt ?? null;
  if (receipt) receipt.send_settled_epoch_ms = Date.now();
  if (settled.error) runnerDiagnostics.push(`${label} client send rejected: ${settled.error.message}`);
  if (receipt) receipt.outcome = settled.raw ? 'settled' : 'failed';
  return settled;
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

function businessCaptures(captures) {
  return captures.filter((capture) => !EXCLUDED_ATTEMPT_KINDS.has(capture?.attempt_kind));
}

function clientSummary(role, raw) {
  return {
    role,
    status: raw?.status ?? null,
    closed: Boolean(raw?.closed ?? raw?.aborted),
    response_ended: Boolean(raw?.response_ended),
    error_code: raw ? errorCodeOf(raw) : null,
    elapsed_ms: raw?.elapsed_ms ?? null,
  };
}

function requestWindow(holderAttempt, holders) {
  const starts = holders
    .map((entry) => entry.attempt?.send_started_epoch_ms)
    .filter((value) => Number.isSafeInteger(value));
  const ends = holders
    .map((entry) => entry.attempt?.send_settled_epoch_ms)
    .filter((value) => Number.isSafeInteger(value));
  return {
    started_epoch_ms: starts.length > 0 ? Math.min(...starts) : holderAttempt.send_started_epoch_ms,
    settled_epoch_ms: ends.length > 0 ? Math.max(...ends) : holderAttempt.send_settled_epoch_ms,
  };
}

function checkForbiddenCodes(captures, forbiddenCodes, diagnostics) {
  if (forbiddenCodes.length === 0) return;
  const bodyText = JSON.stringify(captures);
  for (const code of forbiddenCodes) {
    if (bodyText.includes(`"${code}"`)) diagnostics.push(`retired concurrency/error code observed upstream: ${code}`);
  }
}

async function readDebugStatus(sendHttp, rccUrl) {
  try {
    const response = await sendHttp(`${baseUrl(rccUrl)}/_routecodex/debug/status`, {
      method: 'GET',
      headers: {},
      timeoutMs: 1500,
    });
    return {
      status: response.status ?? null,
      body_text: response.bodyText ?? null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

function baseUrl(rccUrl) {
  return String(rccUrl).replace(/\/+$/, '');
}

function writeConcurrencyEvidence(directory, name, value, refs) {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  refs.push(path);
  return path;
}

function finalizeIndependenceReport(fixture, {
  capabilityDiagnostics = [],
  runnerDiagnostics = [],
  productDiagnostics = [],
  turnAttempts = [],
  evidenceRefs = [],
  observations = {},
} = {}) {
  const status = capabilityDiagnostics.length
    ? 'not_run'
    : runnerDiagnostics.length
      ? 'infra_failure'
      : productDiagnostics.length
        ? 'failed'
        : 'passed';
  const diagnostics = [...capabilityDiagnostics, ...runnerDiagnostics, ...productDiagnostics];
  const replay = observations.provider_concurrency ?? null;
  const providerAttempts = replay?.upstream_business_sends ?? 0;
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
    diagnostic: diagnostics.length ? diagnostics.join('; ') : 'provider request independence replay passed',
    product_failures: productDiagnostics.length,
    runner_failures: runnerDiagnostics.length,
    provider_attempt_count: providerAttempts,
    probe_attempt_count: 0,
    turn_attempts: turnAttempts,
    turn_results: [{
      turn: null,
      status: status === 'passed' ? 'passed' : 'failed',
      request_source: 'provider-request-independence-replay',
      provider_attempts: providerAttempts,
      client_closed: false,
      diagnostics,
    }],
    first_divergence: diagnostics.length ? 'provider_request_independence' : null,
    observations: {
      live: [{
        kind: 'provider_request_independence',
        ...replay,
      }],
      infra: runnerDiagnostics.map((message) => ({ kind: 'infra_failure', message })),
      provider_concurrency: replay,
    },
    source_provenance: {
      verified: false,
      note: 'module evidence only; no provenance claim from an installed binary',
    },
    evidence_refs: evidenceRefs,
    captures: evidenceRefs.filter((path) => path.endsWith('-provider.json')),
    client_evidence: evidenceRefs.filter((path) => path.endsWith('-clients.json')),
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

function rowsForWindow(rows, started, settled, listenerPort, expectedEndpoint) {
  return rows.filter((row) => {
    if (listenerPort !== null && Number(row.scope?.port) !== Number(listenerPort)) return false;
    if (expectedEndpoint && row.meta?.endpoint !== expectedEndpoint) return false;
    const rowStarted = finiteInteger(row.started_epoch_ms);
    return rowStarted !== null && rowStarted >= started && rowStarted <= settled + 1000;
  });
}

function uniqueRequestIds(rows) {
  return [...new Set(rows.map((row) => text(row.meta?.request_id)).filter(Boolean))];
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function collectActualModeEvidence({
  rows,
  listenerPort,
  expectedEndpoint,
  windowSettled,
}) {
  const candidates = rows.filter((row) => {
    if (row.event_type !== 'request.route_selected') return false;
    if (listenerPort !== null && Number(row.scope?.port) !== Number(listenerPort)) return false;
    if (expectedEndpoint && row.meta?.endpoint !== expectedEndpoint) return false;
    if (!text(row.meta?.execution_mode)) return false;
    const rowStarted = finiteInteger(row.started_epoch_ms);
    return windowSettled === null || rowStarted === null || rowStarted <= windowSettled + 1000;
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

function readTypedSourceEvidence({ sampleRoot, requestIds }) {
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
  const wanted = new Set(requestIds);
  paths.sort((left, right) => typedSourcePriority(left) - typedSourcePriority(right)
    || left.localeCompare(right));
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
    if (!requestId || !wanted.has(requestId)) continue;
    return {
      candidate: {
        path,
        request_id: requestId,
        bytes,
        observed_codes: collectTypedCodes(payload),
        attempts: Array.isArray(payload?.attempts) ? payload.attempts : [],
        terminal_source: payload?.terminal_source ?? null,
      },
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

async function readHealthPool(sendHttp, base, timeoutMs) {
  const raw = await sendHttp(`${base}${HEALTH_POOL_PATH}`, {
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

function authTokenOf(capture) {
  const header = capture?.headers?.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
}

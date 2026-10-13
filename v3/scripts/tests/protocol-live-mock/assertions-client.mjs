// Client transport and business-receipt assertions for the
// `v3.protocol_live_mock_matrix` harness. This module is import-safe: it has no
// side effects, listeners, or I/O, and never mutates the actual or expected
// objects it is given. It depends only on the shared pure value helpers.
//
// The integration owner wires the sibling protocol module through the optional
// `deps` argument:
//   assertClientResult(clientResult, expected, entryProtocol, {
//     parseClientBody(entryProtocol, bodyText, contentType) -> observation,
//     findSemanticTerminal(entryProtocol, observation, bodyText) -> boolean,
//   });
// Without those dependencies the client layer still accepts a whole-body JSON
// response or an explicitly supplied `clientResult.observation`. It never falls
// back to substring scanning to prove an SSE terminal or body expectation.

import {
  CONTROL_VALUE_PATTERN,
  dedupe,
  deepEqual,
  findControlLeakage,
  forbiddenHits,
  headerValue,
  normalizeHeaders,
  parseJsonText,
  resolvePath,
} from './assertions-common.mjs';

/**
 * Assert the raw client result for one turn.
 *
 * @param {object} clientResult `{status, bodyText, body, error, headers?,
 *   received_headers?, closed?, observation?, parsed?}`. `body` is whole-body
 *   JSON for JSON responses. `observation` is the structured view produced by
 *   the protocol module for SSE or otherwise framed bodies.
 *
 *   The transport receipt is authoritative for completion: `error`, `aborted`,
 *   `truncated`, `complete`, `response_ended` and `closed`. Buffered bytes and
 *   a semantic terminal never prove a completed transport.
 * @param {object} expected `{transport, status, body_must, body_must_not,
 *   semantic_terminal_required, committed_business_stream?}`.
 * @param {string} entryProtocol one of responses|anthropic|openai_chat|gemini.
 * @param {{parseClientBody?: Function, findSemanticTerminal?: Function}} [deps]
 * @returns {{ok: boolean, diagnostics: string[]}}
 */
export function assertClientResult(clientResult, expected, entryProtocol, deps = {}) {
  const diagnostics = [];
  const result = clientResult ?? {};
  const headers = normalizeHeaders(result.headers ?? result.received_headers);
  const contentType = headerValue(headers, 'content-type') ?? '';
  const bodyText = typeof result.bodyText === 'string' ? result.bodyText : '';
  const transport = expected?.transport;
  const committed = expected?.committed_business_stream === true;
  const hasStatus = result.status !== null && result.status !== undefined;
  const hasHeaders = Object.keys(headers).length > 0;
  const hasBytes = bodyText.length > 0;
  const hasBody = result.body !== null && result.body !== undefined;
  const hasObservation = (result.observation ?? result.observed ?? result.parsed) !== null
    && (result.observation ?? result.observed ?? result.parsed) !== undefined;

  if (transport === 'closed' && !committed) {
    if (hasStatus) diagnostics.push(`expected closed transport but received status ${result.status}`);
    if (hasHeaders) diagnostics.push('expected closed transport but received response headers');
    if (hasBytes) diagnostics.push('expected closed transport but received response body bytes');
    if (hasBody) diagnostics.push('expected closed transport but received a parsed response body');
    if (hasObservation) diagnostics.push('expected closed transport but received a parsed observation');
    return { ok: diagnostics.length === 0, diagnostics: dedupe(diagnostics) };
  }

  if (transport !== undefined && transport !== null && transport !== 'complete' && transport !== 'closed') {
    diagnostics.push(`unknown expected client transport ${transport}`);
    return { ok: false, diagnostics };
  }

  if (transport === 'complete') {
    diagnostics.push(...completeReceiptDiagnostics(result));
  }

  if (hasStatus) {
    if (result.status < 200 || result.status >= 300) {
      diagnostics.push(`client status ${result.status} not 2xx`);
    }
    if (expected?.status !== undefined && expected?.status !== null && result.status !== expected.status) {
      diagnostics.push(`client status ${result.status} != ${expected.status}`);
    }
  } else if (transport === 'complete') {
    diagnostics.push('client status missing for completed response');
  }

  const { roots, error } = collectObservationRoots(result, entryProtocol, deps, contentType);
  if (error) diagnostics.push(error);

  if (!hasBytes && !hasBody && roots.length === 0) {
    diagnostics.push('client body missing for completed response');
  }

  for (const [key, value] of Object.entries(expected?.body_must ?? {})) {
    const resolved = resolveAcrossRoots(roots, key, value);
    if (resolved.status === 'match') continue;
    if (resolved.status === 'mismatch') diagnostics.push(`client body_must ${key} mismatch`);
    else diagnostics.push(`client body_must ${key} missing`);
  }

  for (const forbidden of expected?.body_must_not ?? []) {
    const payloadRoots = roots.length ? roots : (result.body === undefined ? [] : [result.body]);
    let hit = payloadRoots.some((root) => forbiddenHits(root, null, forbidden).length);
    if (!hit && hasBytes && bodyText.includes(forbidden)) hit = true;
    if (hit) diagnostics.push(`client output contains forbidden ${forbidden}`);
  }

  if (expected?.semantic_terminal_required) {
    if (!evaluateSemanticTerminal(entryProtocol, roots, bodyText, deps, diagnostics)) {
      diagnostics.push('semantic terminal missing from client output');
    }
  }

  if (expected?.no_control_leakage !== false) {
    for (const root of roots) {
      for (const marker of findControlLeakage(root)) {
        diagnostics.push(`client payload leaks control marker ${marker}`);
      }
    }
    if (hasBytes) {
      const match = bodyText.match(CONTROL_VALUE_PATTERN);
      if (match) diagnostics.push(`client payload leaks control marker ${match[0]}`);
    }
  }

  return { ok: diagnostics.length === 0, diagnostics: dedupe(diagnostics) };
}

// A declared complete transport is proven by the adapter receipt, not by the
// buffered bytes it managed to deliver. `lifecycle.sendHttp` records all of
// these fields, so a successful call always passes them.
function completeReceiptDiagnostics(result) {
  const diagnostics = [];
  if (result.error !== null && result.error !== undefined) {
    diagnostics.push(`client transport error: ${result.error}`);
  }
  if (result.aborted === true) {
    diagnostics.push('client transport aborted before completion');
  }
  if (result.truncated === true) {
    diagnostics.push('client transport was truncated');
  }
  if (result.complete !== true) {
    diagnostics.push(`client response is not complete (complete=${result.complete ?? null})`);
  }
  if (result.response_ended !== true) {
    diagnostics.push('client response end was not received');
  }
  if (result.closed === true) {
    diagnostics.push('client transport closed before completion');
  }
  return diagnostics;
}

function collectObservationRoots(result, entryProtocol, deps, contentType) {
  const roots = [];
  const push = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') return;
    if (!roots.includes(value)) roots.push(value);
  };

  for (const supplied of [result.observation, result.observed, result.parsed]) {
    push(supplied?.observation);
    push(supplied?.parsed);
    push(supplied?.semantic);
    push(supplied?.body);
    push(supplied?.frames);
    push(supplied);
  }

  const body = result.body;
  if (body && typeof body === 'object') {
    push(body.observation);
    push(body.parsed);
    push(body.semantic);
    push(body.body);
    push(body.frames);
    push(body);
  }

  let error = null;
  const bodyText = typeof result.bodyText === 'string' ? result.bodyText : '';
  if (roots.length === 0 && bodyText.trim() !== '' && typeof deps?.parseClientBody === 'function') {
    try {
      const observation = deps.parseClientBody(entryProtocol, bodyText, contentType);
      if (observation && typeof observation === 'object') {
        push(observation.observation);
        push(observation.parsed);
        push(observation.semantic);
        push(observation.body);
        push(observation.frames);
        push(observation);
      }
    } catch (parseError) {
      error = `client body parser failed: ${parseError.message}`;
    }
  }

  if (roots.length === 0 && bodyText.trim() !== '') {
    const parsed = parseJsonText(bodyText);
    if (parsed && typeof parsed === 'object') push(parsed);
  }

  return { roots, error };
}

function resolveAcrossRoots(roots, key, expectedValue) {
  let present = false;
  for (const root of roots) {
    const actual = resolvePath(root, key);
    if (actual === undefined) continue;
    present = true;
    if (deepEqual(actual, expectedValue)) return { status: 'match' };
  }
  return { status: present ? 'mismatch' : 'missing' };
}

function evaluateSemanticTerminal(entryProtocol, roots, bodyText, deps, diagnostics) {
  if (typeof deps?.findSemanticTerminal === 'function') {
    try {
      return Boolean(deps.findSemanticTerminal(entryProtocol, roots[0] ?? null, bodyText));
    } catch (error) {
      diagnostics.push(`semantic terminal evaluation failed: ${error.message}`);
      return false;
    }
  }
  return structuredTerminal(entryProtocol, roots);
}

function structuredTerminal(entryProtocol, roots) {
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    if (entryProtocol === 'openai_chat') {
      if (Array.isArray(root.choices)
        && root.choices.some((choice) => choice && choice.finish_reason !== null && choice.finish_reason !== undefined)) {
        return true;
      }
      // Aggregated observation produced by the protocol module.
      if (root.finish_reason !== null && root.finish_reason !== undefined) return true;
    } else if (entryProtocol === 'responses') {
      const status = root.status ?? root.response?.status;
      if (status === 'completed' || status === 'incomplete') return true;
    } else if (entryProtocol === 'anthropic') {
      if (root.stop_reason !== null && root.stop_reason !== undefined) return true;
    } else if (entryProtocol === 'gemini') {
      if (Array.isArray(root.candidates)
        && root.candidates.some((candidate) => candidate
          && candidate.finishReason !== null
          && candidate.finishReason !== undefined)) {
        return true;
      }
      // Aggregated observation produced by the protocol module.
      if (root.finishReason !== null && root.finishReason !== undefined) return true;
    }
  }
  return false;
}

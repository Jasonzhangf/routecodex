// Independent provider/client fixture assertion layer for the
// `v3.protocol_live_mock_matrix` harness.
//
// This module is import-safe: it has no side effects, no listeners, and no I/O.
// Every helper is pure and never mutates the actual or expected objects it is
// given. It does not depend on RCC, Magpie, or any protocol codec.
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

const PROBE_ATTEMPT_KINDS = new Set(['probe', 'startup']);

// Control-plane markers that must never appear in provider or client business
// payloads. Mirrors v3/fixtures/protocol-live-mock-matrix/interface-needs.md.
const CONTROL_MARKERS = [
  'routecodex_internal',
  'metadata_center',
  'debug_snapshot',
  'provider_protocol',
  'resource_handle',
  'runtime_control',
  'selected_target',
];
const CONTROL_KEY_PATTERN = /^routecodex_/i;
const CONTROL_VALUE_PATTERN = /routecodex_[a-z0-9_]+/i;

/**
 * Resolve a JSON Pointer-ish dotted path against a value.
 *
 * - Empty/null path returns the value unchanged.
 * - A numeric segment indexes an array (and also a numeric object key).
 * - A missing segment returns `undefined`, which `deepEqual` keeps distinct
 *   from an explicit `null` or `0`.
 */
export function resolvePath(value, path) {
  if (path === undefined || path === null || path === '') return value;
  const segments = String(path).split('.');
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === '') return undefined;
    if (typeof current !== 'object' && typeof current !== 'function') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Structural, coercion-free equality.
 *
 * - Arrays compare in order with equal length (no prefix or wildcard match).
 * - Objects compare by exact key set, independent of insertion order.
 * - `null`, `undefined`, and `0` are all distinct.
 * - Pure: neither argument is mutated.
 */
export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) {
    return true;
  }
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) return false;
  if (leftIsArray) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

// Protocol-defined representation equivalence only. Keep every other field;
// this view never changes captures, exact-wire checks, or native tool authority.
function plainText(value, type) {
  if (Array.isArray(value) && value.length === 1 && value[0]?.type === type
    && typeof value[0].text === 'string' && Object.keys(value[0]).length === 2) return value[0].text;
  return value;
}

function providerComparisonBody(body, protocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (protocol === 'anthropic') {
    return { ...body,
      ...(body.system === undefined ? {} : { system: plainText(body.system, 'text') }),
      ...(Array.isArray(body.messages) ? { messages: body.messages.map((message) => ({ ...message, content: plainText(message.content, 'text') })) } : {}),
    };
  }
  if (protocol === 'responses' && body.instructions === undefined && body.previous_response_id === undefined && Array.isArray(body.input)) {
    const [first, ...rest] = body.input;
    const content = plainText(first?.content, 'input_text');
    if (first?.role === 'system' && (first.type === undefined || first.type === 'message')
      && Object.keys(first).every((key) => ['type', 'role', 'content'].includes(key))
      && typeof content === 'string' && !rest.some((item) => ['system', 'developer'].includes(item?.role))) {
      return { ...body, instructions: content, input: rest };
    }
  }
  return body;
}

/**
 * Assert the provider capture for one business turn.
 *
 * @param {Array<object>} captures capture records with explicit `attempt_kind`.
 * @param {number} turnIndex index into the business captures for this case.
 * @param {object} expected `{method, paths, auth_required, body_must,
 *   body_must_not, exact, provider_protocol?}`.
 * @param {{providerProtocol?: string, noControlLeakage?: boolean}} [options]
 *   `providerProtocol` selects the protocol-native auth carrier. Startup and
 *   probe captures are excluded only when their `attempt_kind` is explicitly
 *   `probe` or `startup`; every other capture counts as a business attempt.
 * @returns {{ok: boolean, diagnostics: string[]}}
 */
export function assertProviderCaptures(captures, turnIndex, expected, options = {}) {
  const diagnostics = [];
  const list = Array.isArray(captures) ? captures : [];
  const business = list.filter((capture) => !PROBE_ATTEMPT_KINDS.has(capture?.attempt_kind));
  const index = Number.isInteger(turnIndex) ? turnIndex : 0;
  const target = business[index];
  if (!target) {
    diagnostics.push(`provider business attempt missing for turn ${index + 1}`);
    return { ok: false, diagnostics };
  }

  if (expected?.method && target.method !== expected.method) {
    diagnostics.push(`provider method ${target.method} != ${expected.method}`);
  }

  if (Array.isArray(expected?.paths) && expected.paths.length) {
    const matched = expected.paths.some((candidate) => candidate === target.path);
    if (!matched) {
      diagnostics.push(`provider path ${target.path} not in expected paths [${expected.paths.join(', ')}]`);
    }
  }

  const body = target.body === undefined || target.body === null ? parseJsonText(target.raw_body) : target.body;
  const comparisonBody = providerComparisonBody(body, options.providerProtocol ?? expected?.provider_protocol ?? expected?.protocol);

  if (expected?.exact !== undefined && expected.exact !== null && !deepEqual(body, expected.exact)) {
    diagnostics.push('provider request body differs from exact expected');
  }

  for (const [key, value] of Object.entries(expected?.body_must ?? {})) {
    const comparisonRoot = ['system', 'messages', 'instructions', 'input'].includes(key) ? comparisonBody : body;
    if (!deepEqual(resolvePath(comparisonRoot, key), value)) {
      diagnostics.push(`provider body_must ${key} mismatch`);
    }
  }

  for (const forbidden of expected?.body_must_not ?? []) {
    if (forbiddenHits(body, target.raw_body, forbidden).length) {
      diagnostics.push(`provider body contains forbidden ${forbidden}`);
    }
  }

  if (expected?.auth_required) {
    const headers = normalizeHeaders(target.headers);
    const protocol = options.providerProtocol ?? expected?.provider_protocol ?? expected?.protocol ?? null;
    if (!hasProtocolAuth(protocol, headers, target.query)) {
      diagnostics.push(`provider auth missing or empty for ${protocol ?? 'unknown'} carrier`);
    }
  }

  if (options.noControlLeakage !== false) {
    for (const hit of findControlLeakage(body)) {
      diagnostics.push(`provider payload leaks control marker ${hit}`);
    }
  }

  return { ok: diagnostics.length === 0, diagnostics: dedupe(diagnostics) };
}

/**
 * Assert the ordered provider business-attempt sequence against declared,
 * independent fixture expectations.
 *
 * Probe/startup captures are excluded only when their `attempt_kind` is
 * explicitly `probe` or `startup`; every other capture counts as a business
 * attempt, in capture order. Each business attempt is re-checked with the same
 * method, path, body, auth and control-leakage rules as
 * `assertProviderCaptures`.
 *
 * `expected.auth_orders` must be a non-empty array of allowed authorization
 * orders, each an ordered array of exact Authorization header values. The
 * observed authorization sequence must equal one of them exactly. The allowed
 * orders are declared by the fixture; they are never derived from the captures
 * themselves or from business payload metadata.
 *
 * @param {Array<object>} captures capture records with explicit `attempt_kind`.
 * @param {object} expected `{auth_orders, method?, paths?, body_must?, exact?,
 *   body_must_not?, auth_required?, provider_protocol?}`.
 * @param {{providerProtocol?: string, noControlLeakage?: boolean}} [options]
 * @returns {{ok: boolean, diagnostics: string[]}}
 */
export function assertProviderAttemptSequence(captures, expected, options = {}) {
  const diagnostics = [];
  const list = Array.isArray(captures) ? captures : [];
  const business = list.filter((capture) => !PROBE_ATTEMPT_KINDS.has(capture?.attempt_kind));

  const orders = normalizeAuthOrders(expected?.auth_orders);
  if (!orders) {
    diagnostics.push('expected.auth_orders must declare at least one allowed authorization order');
    return { ok: false, diagnostics: dedupe(diagnostics) };
  }

  if (new Set(orders.map((order) => order.length)).size > 1) {
    diagnostics.push('expected.auth_orders declares inconsistent attempt counts');
  }
  const expectedCount = orders[0].length;

  // Reuse the single-capture provider assertions for each ordered attempt.
  for (let index = 0; index < business.length; index += 1) {
    diagnostics.push(...assertProviderCaptures(list, index, expected, options).diagnostics);
  }

  if (business.length < expectedCount) {
    diagnostics.push(`missing provider business attempt: expected ${expectedCount}, saw ${business.length}`);
  } else if (business.length > expectedCount) {
    diagnostics.push(`extra provider business attempt: expected ${expectedCount}, saw ${business.length}`);
  }

  const knownTokens = new Set(orders.flat());
  const actual = business.map((capture) => headerValue(normalizeHeaders(capture?.headers), 'authorization'));
  const seen = new Set();
  for (let index = 0; index < actual.length; index += 1) {
    const token = actual[index];
    if (!isNonEmpty(token)) {
      diagnostics.push(`missing provider auth identity at attempt ${index + 1}`);
      continue;
    }
    if (!knownTokens.has(token)) {
      diagnostics.push(`unknown provider auth identity ${token} at attempt ${index + 1}`);
    }
    if (seen.has(token)) {
      diagnostics.push(`repeated provider auth identity ${token} at attempt ${index + 1}`);
    }
    seen.add(token);
  }

  if (!orders.some((order) => deepEqual(order, actual))) {
    diagnostics.push(`provider auth order [${actual.join(', ')}] is not an allowed order`);
  }

  return { ok: diagnostics.length === 0, diagnostics: dedupe(diagnostics) };
}

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

function parseJsonText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pathPresent(value, path) {
  if (path === '') return value !== undefined;
  const segments = String(path).split('.');
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return false;
    if (typeof current !== 'object' && typeof current !== 'function') return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function containsKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((item) => containsKeyDeep(item, key));
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((entry) => entry === key || containsKeyDeep(value[entry], key));
}

function containsStringDeep(value, needle) {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsStringDeep(item, needle));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsStringDeep(item, needle));
  }
  return false;
}

function forbiddenHits(payload, rawText, entry) {
  if (typeof entry !== 'string' || entry === '') return [];
  const hits = new Set();
  if (containsKeyDeep(payload, entry)) hits.add('key');
  if (entry.includes('.') && pathPresent(payload, entry)) hits.add('path');
  if (containsStringDeep(payload, entry)) hits.add('value');
  if (typeof rawText === 'string' && rawText.includes(entry)) hits.add('raw');
  return [...hits];
}

function findControlLeakage(value) {
  const hits = new Set();
  const visit = (node) => {
    if (typeof node === 'string') {
      if (CONTROL_MARKERS.includes(node)) hits.add(node);
      const match = node.match(CONTROL_VALUE_PATTERN);
      if (match) hits.add(match[0]);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (CONTROL_MARKERS.includes(key) || CONTROL_KEY_PATTERN.test(key)) hits.add(key);
        visit(child);
      }
    }
  };
  visit(value);
  return [...hits];
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
  return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : undefined;
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasBearer(headers) {
  const value = headerValue(headers, 'authorization');
  return isNonEmpty(value) && /^Bearer\s+\S/i.test(value.trim());
}

function hasApiKeyHeader(headers) {
  return isNonEmpty(headerValue(headers, 'api-key')) || isNonEmpty(headerValue(headers, 'x-api-key'));
}

function hasGeminiKey(headers, query) {
  if (isNonEmpty(headerValue(headers, 'x-goog-api-key'))) return true;
  return /(?:^|[?&])key=[^&\s]/.test(String(query ?? ''));
}

function hasAnyRecognizedAuth(headers, query) {
  return hasBearer(headers) || hasApiKeyHeader(headers) || hasGeminiKey(headers, query);
}

function hasProtocolAuth(protocol, headers, query) {
  if (protocol === 'openai_chat' || protocol === 'responses') {
    return hasBearer(headers) || isNonEmpty(headerValue(headers, 'api-key'));
  }
  if (protocol === 'anthropic') {
    return isNonEmpty(headerValue(headers, 'x-api-key')) || hasBearer(headers);
  }
  if (protocol === 'gemini') {
    return hasGeminiKey(headers, query);
  }
  return hasAnyRecognizedAuth(headers, query);
}

function normalizeAuthOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return null;
  const normalized = [];
  for (const order of orders) {
    if (!Array.isArray(order) || order.length === 0) return null;
    if (!order.every((token) => typeof token === 'string' && token.trim() !== '')) return null;
    normalized.push(order.slice());
  }
  return normalized;
}

function dedupe(values) {
  return [...new Set(values)];
}

// Provider capture and attempt-sequence assertions for the
// `v3.protocol_live_mock_matrix` harness.
//
// This module is import-safe: it has no side effects, no listeners, and no I/O.
// Every helper is pure and never mutates the actual or expected objects it is
// given. It does not depend on RCC, Magpie, or any protocol codec.
// The public facade re-exports the client and shared value APIs from the
// sibling modules.

import {
  dedupe,
  deepEqual,
  findControlLeakage,
  forbiddenHits,
  headerValue,
  normalizeHeaders,
  parseJsonText,
  resolvePath,
} from './assertions-common.mjs';

export { assertClientResult } from './assertions-client.mjs';
export { deepEqual, resolvePath } from './assertions-common.mjs';

const PROBE_ATTEMPT_KINDS = new Set(['probe', 'startup']);

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

// Shared pure value and control-plane helpers for the protocol-live-mock
// assertion layers. This module has no side effects, listeners, or I/O.

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
export const CONTROL_VALUE_PATTERN = /routecodex_[a-z0-9_]+/i;

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

export function parseJsonText(text) {
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

export function forbiddenHits(payload, rawText, entry) {
  if (typeof entry !== 'string' || entry === '') return [];
  const hits = new Set();
  if (containsKeyDeep(payload, entry)) hits.add('key');
  if (entry.includes('.') && pathPresent(payload, entry)) hits.add('path');
  if (containsStringDeep(payload, entry)) hits.add('value');
  if (typeof rawText === 'string' && rawText.includes(entry)) hits.add('raw');
  return [...hits];
}

export function findControlLeakage(value) {
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

export function headerValue(headers, name) {
  return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : undefined;
}

export function dedupe(values) {
  return [...new Set(values)];
}

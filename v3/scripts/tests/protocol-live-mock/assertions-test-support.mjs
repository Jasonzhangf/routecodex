// Shared literal fixtures and receipt helpers for the assertion-layer tests.
// This support module does not register tests or listeners.

export function providerCapture(overrides = {}) {
  const body = overrides.body ?? {
    model: 'chat-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };
  return {
    attempt_kind: 'business',
    method: 'POST',
    path: '/v1/chat/completions',
    query: '',
    headers: { authorization: 'Bearer sk-test' },
    body,
    raw_body: JSON.stringify(body),
    ...overrides,
    body,
  };
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Fields `lifecycle.sendHttp` always emits. A `transport=complete` check
// needs them; omitted fields are exactly what hid the Finding 1 false pass.
export const COMPLETE_RECEIPT = Object.freeze({
  response_ended: true,
  complete: true,
  closed: false,
  aborted: false,
  truncated: false,
  error: null,
  error_detail: null,
});

/**
 * SSE runtime native bridge surface.
 *
 * SSE body materialization remains Rust/NAPI-owned; this host exposes only the
 * native JSON capability needed by runtime integrations.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

type AnyRecord = Record<string, unknown>;

function requireSseRuntimeFn<T extends (...args: any[]) => unknown>(
  capability: string,
): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${capability} not available`);
  }
  return fn as T;
}

export function buildJsonFromSseWithNative(input: {
  protocol: string;
  bodyText: string;
  requestId?: string;
  model?: string;
  config?: AnyRecord;
}): AnyRecord {
  const fn = requireSseRuntimeFn<(inputJson: string) => string>('buildJsonFromSseJson');
  const raw = fn(JSON.stringify({
    protocol: input.protocol,
    body_text: input.bodyText,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  }));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] buildJsonFromSseJson returned invalid result');
  }
  return parsed as AnyRecord;
}

export function assertSseRuntimeNativeAvailable(): void {
  requireSseRuntimeFn<(inputJson: string) => string>('buildJsonFromSseJson');
}

import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type NativeGovernedFilterPayload = {
  model?: unknown;
  messages: unknown[];
  tools?: unknown;
  tool_choice?: unknown;
  stream: boolean;
  parameters: Record<string, unknown>;
};

function parsePayload(raw: string): NativeGovernedFilterPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const messages = Array.isArray(row.messages) ? row.messages : null;
    const parameters =
      row.parameters && typeof row.parameters === 'object' && !Array.isArray(row.parameters)
        ? (row.parameters as Record<string, unknown>)
        : null;
    if (!messages || !parameters || typeof row.stream !== 'boolean') {
      return null;
    }
    return {
      model: row.model,
      messages,
      ...(row.tools !== undefined ? { tools: row.tools } : {}),
      ...(row.tool_choice !== undefined ? { tool_choice: row.tool_choice } : {}),
      stream: row.stream,
      parameters
    };
  } catch {
    return null;
  }
}

export function buildGovernedFilterPayloadWithNative(
  request: unknown
): NativeGovernedFilterPayload {
  const capability = 'buildGovernedFilterPayloadJson';
  const fail = (reason?: string) => failNativeRequired<NativeGovernedFilterPayload>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.buildGovernedFilterPayloadJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  const requestJson = (() => {
    try {
      return JSON.stringify(request ?? null);
    } catch {
      return undefined;
    }
  })();
  if (!requestJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parsePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

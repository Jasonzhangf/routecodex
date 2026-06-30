import { callNativeJson } from './native-router-hotpath.js';
import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

function parseNativeEvent(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function canonicalizeResponsesSseEventPayloadWithNative(event: unknown): Record<string, unknown> {
  return callNativeJson(
    'canonicalizeResponsesSseEventPayloadJson',
    'canonicalizeResponsesSseEventPayloadJson',
    [JSON.stringify(event)],
    parseNativeEvent,
    {
      emptyReason: 'empty Responses SSE event payload result',
      invalidReason: 'invalid Responses SSE event payload result'
    }
  );
}

export function normalizeResponsesSseResponsePayloadWithNative(
  response: unknown,
  status: string
): Record<string, unknown> {
  const capability = 'normalizeResponsesSseResponsePayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let responseJson: string;
  try {
    responseJson = JSON.stringify(response);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson, status);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE response payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE response payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

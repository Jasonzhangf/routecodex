import { callNativeJson } from './native-router-hotpath.js';

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

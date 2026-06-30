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

function parseNativeSummaryEntries(raw: string): Array<{ type: 'summary_text'; text: string }> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const row = entry as Record<string, unknown>;
      if (row.type !== 'summary_text' || typeof row.text !== 'string') {
        return null;
      }
    }
    return parsed as Array<{ type: 'summary_text'; text: string }>;
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

export function normalizeResponsesSseReasoningSummaryWithNative(
  summary: unknown
): Array<{ type: 'summary_text'; text: string }> | undefined {
  const capability = 'normalizeResponsesSseReasoningSummaryJson';
  const fail = (reason?: string) => failNative<Array<{ type: 'summary_text'; text: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let summaryJson: string;
  try {
    summaryJson = JSON.stringify(summary);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(summaryJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses reasoning summary result');
    }
    const parsed = parseNativeSummaryEntries(raw);
    if (!parsed) {
      return fail('invalid Responses reasoning summary result');
    }
    return parsed.length ? parsed : undefined;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseOutputItemDescriptorWithNative(
  outputItem: unknown,
  lifecycle: 'added' | 'done'
): Record<string, unknown> {
  const capability = 'buildResponsesSseOutputItemDescriptorJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let outputItemJson: string;
  try {
    outputItemJson = JSON.stringify(outputItem);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(outputItemJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses output item descriptor result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses output item descriptor result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseErrorPayloadWithNative(message: string): Record<string, unknown> {
  const capability = 'buildResponsesSseErrorPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messageJson = JSON.stringify(message);
  try {
    const raw = fn(messageJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE error payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE error payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

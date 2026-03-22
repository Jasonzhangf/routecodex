import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { collectToolOutputsWithNative } from './native-hub-pipeline-inbound-outbound-semantics.js';
import {
  parseOptionalString,
  parseRecord,
  parseArray,
  parseToolOutputSnapshotBuildResult
} from './native-hub-pipeline-req-inbound-semantics-parsers.js';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function replaceRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

export function mapReqInboundBridgeToolsToChatWithNative(
  rawTools: unknown
): Array<Record<string, unknown>> {
  const capability = 'mapBridgeToolsToChatJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(rawTools) ? rawTools : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapChatToolsToBridgeWithNative(
  rawTools: unknown
): Array<Record<string, unknown>> {
  const capability = 'mapChatToolsToBridgeJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(rawTools) ? rawTools : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function captureReqInboundResponsesContextSnapshotWithNative(input: {
  rawRequest: Record<string, unknown>;
  requestId?: string;
  toolCallIdStyle?: unknown;
}): Record<string, unknown> {
  const capability = 'captureReqInboundResponsesContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify({
    rawRequest: input.rawRequest,
    requestId: input.requestId,
    toolCallIdStyle: input.toolCallIdStyle
  });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length) {
        return fail(message.trim());
      }
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function collectReqInboundToolOutputsWithNative(
  payload: unknown
): Array<{ tool_call_id: string; call_id: string; output?: string; name?: string }> {
  return collectToolOutputsWithNative(payload);
}

export function buildReqInboundToolOutputSnapshotWithNative(
  payload: Record<string, unknown>,
  providerProtocol: string | undefined
): Record<string, unknown> {
  const capability = 'buildReqInboundToolOutputSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  const providerProtocolJson = safeStringify(providerProtocol ?? null);
  if (!payloadJson || !providerProtocolJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, providerProtocolJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolOutputSnapshotBuildResult(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    replaceRecord(payload, parsed.payload);
    return parsed.snapshot;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function appendReqInboundToolParseDiagnosticTextWithNative(
  outputText: string,
  toolName: string | undefined
): string | undefined {
  const capability = 'appendToolParseDiagnosticTextJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('appendToolParseDiagnosticTextJson');
  if (!fn) {
    return fail();
  }
  const toolNameJson = safeStringify(toolName ?? null);
  if (!toolNameJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(outputText, toolNameJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectReqInboundToolParseDiagnosticsWithNative(
  payload: Record<string, unknown>
): void {
  const capability = 'injectToolParseDiagnosticsJson';
  const fail = (reason?: string) => failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('injectToolParseDiagnosticsJson');
  if (!fn) {
    return fail();
  }
  try {
    const payloadJson = JSON.stringify(payload);
    if (typeof payloadJson !== 'string') {
      return fail('json stringify failed');
    }
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    replaceRecord(payload, parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReqInboundShellLikeToolCallsWithNative(
  payload: Record<string, unknown>
): void {
  const capability = 'normalizeShellLikeToolCallsBeforeGovernanceJson';
  const fail = (reason?: string) => failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeShellLikeToolCallsBeforeGovernanceJson');
  if (!fn) {
    return fail();
  }
  try {
    const payloadJson = JSON.stringify(payload);
    if (typeof payloadJson !== 'string') {
      return fail('json stringify failed');
    }
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    replaceRecord(payload, parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

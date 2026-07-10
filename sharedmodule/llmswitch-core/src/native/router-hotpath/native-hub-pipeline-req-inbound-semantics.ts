import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { sanitizeFormatEnvelopeWithNative } from './native-hub-pipeline-edge-stage-semantics.js';
import { formatUnknownError } from './native-shared-conversion-semantics-core.js';


export interface NativeReqInboundChatToStandardizedInput {
  chatEnvelope: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
  endpoint: string;
  requestId?: string;
}

const NON_BLOCKING_REQ_INBOUND_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingReqInboundParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-inbound-semantics.parse-failed');

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

function logNativeReqInboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingReqInboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_REQ_INBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingReqInboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-inbound-semantics] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqInboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseOptionalString(raw: string): string | undefined | null {
  const parsed = parseJson('parseOptionalString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== 'string') {
    return null;
  }
  const normalized = parsed.trim();
  return normalized ? normalized : undefined;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseArray(raw: string): unknown[] | null {
  const parsed = parseJson('parseArray', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function replaceRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

export type NativeContextToolOutput = { tool_call_id: string; call_id: string; output?: string; name?: string };

function parseToolOutputEntry(raw: unknown): NativeContextToolOutput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const toolCallId =
    (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
    (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
    (typeof row.call_id === 'string' && row.call_id.trim()) ||
    (typeof row.callId === 'string' && row.callId.trim()) ||
    '';
  const callId =
    (typeof row.call_id === 'string' && row.call_id.trim()) ||
    (typeof row.callId === 'string' && row.callId.trim()) ||
    (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
    (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
    '';
  if (!toolCallId || !callId) {
    return null;
  }

  const outputRaw = row.output;
  let output: string | undefined;
  if (typeof outputRaw === 'string') {
    output = outputRaw;
  } else if (outputRaw !== undefined) {
    try {
      output = JSON.stringify(outputRaw);
    } catch {
      output = String(outputRaw);
    }
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
  return {
    tool_call_id: toolCallId,
    call_id: callId,
    ...(output !== undefined ? { output } : {}),
    ...(name ? { name } : {})
  };
}

function parseCollectedToolOutputs(raw: string): NativeContextToolOutput[] | null {
  const parsed = parseJson('parseCollectedToolOutputs', raw);
  if (parsed === JSON_PARSE_FAILED || !Array.isArray(parsed)) {
    return null;
  }
  const out: NativeContextToolOutput[] = [];
  for (const entry of parsed) {
    const normalized = parseToolOutputEntry(entry);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

function parseToolOutputSnapshotBuildResult(
  raw: string
): { snapshot: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  return parsed as { snapshot: Record<string, unknown>; payload: Record<string, unknown> };
}

export function buildSlimResponsesContextWithNative(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!context) return null;
  const capability = 'buildSlimResponsesContextJson';
  const fail = () => { throw new Error(`[buildSlimResponsesContext] ${capability} unavailable`); };
  if (isNativeDisabledByEnv()) return fail();
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const inputJson = safeStringify(context);
  if (!inputJson) return fail();
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) return fail();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    return fail();
  }
}

export function pruneChatRequestPayloadWithNative(
  payload: Record<string, unknown>,
  preserveStreamField = false
): Record<string, unknown> {
  const capability = 'pruneChatRequestPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload, preserveStreamField });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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

export function sanitizeReqInboundFormatEnvelopeWithNative<T>(
  candidate: unknown
): T {
  return sanitizeFormatEnvelopeWithNative(candidate) as T;
}

export function normalizeProviderProtocolTokenWithNative(
  value: string | undefined
): string | undefined {
  const capability = 'normalizeProviderProtocolTokenJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeProviderProtocolTokenJson');
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
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

export function chatEnvelopeToStandardizedWithNative(
  input: NativeReqInboundChatToStandardizedInput
): Record<string, unknown> {
  const capability = 'chatEnvelopeToStandardizedJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chatJson = safeStringify(input.chatEnvelope);
  const adapterContextJson = safeStringify(input.adapterContext);
  if (!chatJson || !adapterContextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chatJson, adapterContextJson, String(input.endpoint || ''), input.requestId);
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

export function collectToolOutputsWithNative(
  payload: unknown
): NativeContextToolOutput[] {
  const capability = 'collectToolOutputsJson';
  const fail = (reason?: string) => failNativeRequired<NativeContextToolOutput[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('collectToolOutputsJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseCollectedToolOutputs(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
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

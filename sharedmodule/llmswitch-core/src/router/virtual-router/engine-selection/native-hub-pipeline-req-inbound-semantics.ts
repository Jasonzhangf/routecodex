import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { sanitizeFormatEnvelopeWithNative } from './native-hub-pipeline-edge-stage-semantics.js';
import {
  augmentContextSnapshotWithNative,
  collectToolOutputsWithNative,
  mapResumeToolOutputsDetailedWithNative,
  normalizeToolCallIdStyleCandidateWithNative,
  resolveServerToolFollowupSnapshotWithNative
} from './native-hub-pipeline-inbound-outbound-semantics.js';

export type {
  NativeContextToolOutput,
  NativeResumeToolOutput
} from './native-hub-pipeline-inbound-outbound-semantics.js';

export interface NativeReqInboundSemanticLiftApplyInput {
  chatEnvelope: Record<string, unknown>;
  payload?: Record<string, unknown>;
  protocol?: string;
  entryEndpoint?: string;
  responsesResume?: Record<string, unknown>;
}
export type NativeProviderProtocolToken =
  NonNullable<NativeReqInboundSemanticLiftApplyInput['protocol']>;

export interface NativeReqInboundChatToStandardizedInput {
  chatEnvelope: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
  endpoint: string;
  requestId?: string;
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function parseOptionalString(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const normalized = parsed.trim();
    return normalized ? normalized : undefined;
  } catch {
    return null;
  }
}

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseToolOutputSnapshotBuildResult(
  raw: string
): { snapshot: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const snapshot = parsed.snapshot;
  const payload = parsed.payload;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  return {
    snapshot: snapshot as Record<string, unknown>,
    payload: payload as Record<string, unknown>
  };
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

export function mapReqInboundResumeToolOutputsDetailedWithNative(
  responsesResume: unknown
): Array<{ tool_call_id: string; content: string }> {
  return mapResumeToolOutputsDetailedWithNative(responsesResume);
}

export function resolveClientInjectReadyWithNative(
  metadata: Record<string, unknown>
): boolean {
  const capability = 'resolveClientInjectReadyJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveClientInjectReadyJson');
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeContextCaptureLabelWithNative(
  label: string | undefined
): string {
  const capability = 'normalizeContextCaptureLabelJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeContextCaptureLabelJson');
  if (!fn) {
    return fail();
  }
  const labelJson = safeStringify(label ?? null);
  if (!labelJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(labelJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(raw);
    if (parsed === null) {
      return fail('invalid payload');
    }
    return parsed ?? 'context_capture';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function shouldRunHubChatProcessWithNative(
  requestId: string,
  entryEndpoint: string
): boolean {
  const capability = 'shouldRunHubChatProcessJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('shouldRunHubChatProcessJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(requestId, entryEndpoint);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
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

export function isShellLikeToolNameTokenWithNative(
  name: string | undefined
): boolean {
  const capability = 'isShellLikeToolNameTokenJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('isShellLikeToolNameTokenJson');
  if (!fn) {
    return fail();
  }
  const nameJson = safeStringify(name ?? null);
  if (!nameJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(nameJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyReqInboundSemanticLiftWithNative(
  input: NativeReqInboundSemanticLiftApplyInput
): Record<string, unknown> {
  const capability = 'applyReqInboundSemanticLiftJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('applyReqInboundSemanticLiftJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
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

export function resolveReqInboundServerToolFollowupSnapshotWithNative(
  adapterContext: unknown
): Record<string, unknown> | undefined {
  return resolveServerToolFollowupSnapshotWithNative(adapterContext);
}

export function augmentReqInboundContextSnapshotWithNative(
  context: Record<string, unknown>,
  fallbackSnapshot: Record<string, unknown>
): Record<string, unknown> {
  return augmentContextSnapshotWithNative(context, fallbackSnapshot);
}

export function normalizeReqInboundToolCallIdStyleWithNative(
  value: unknown
): 'fc' | 'preserve' | undefined {
  return normalizeToolCallIdStyleCandidateWithNative(value);
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

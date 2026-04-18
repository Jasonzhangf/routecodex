import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type NativeResumeToolOutput = { tool_call_id: string; content: string };
export type NativeContextToolOutput = { tool_call_id: string; call_id: string; output?: string; name?: string };

const NON_BLOCKING_INBOUND_OUTBOUND_LOG_THROTTLE_MS = 60_000;
const nonBlockingInboundOutboundLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-inbound-outbound-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeInboundOutboundNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingInboundOutboundLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_INBOUND_OUTBOUND_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingInboundOutboundLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-inbound-outbound-semantics] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeInboundOutboundNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logNativeInboundOutboundNonBlocking('safeStringify', error);
    return undefined;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalRecord(raw: string): Record<string, unknown> | undefined | null {
  const parsed = parseJson('parseOptionalRecord', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseStyle(raw: string): 'fc' | 'preserve' | undefined | null {
  const parsed = parseJson('parseStyle', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null || parsed === undefined) {
    return undefined;
  }
  if (typeof parsed !== 'string') {
    return null;
  }
  const normalized = parsed.trim().toLowerCase();
  if (normalized === 'fc' || normalized === 'preserve') {
    return normalized;
  }
  return null;
}

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

function parseResumeToolOutputs(raw: string): NativeResumeToolOutput[] | null {
  const parsed = parseJson('parseResumeToolOutputs', raw);
  if (parsed === JSON_PARSE_FAILED || !Array.isArray(parsed)) {
    return null;
  }
  const out: NativeResumeToolOutput[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const toolCallId =
      (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
      (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
      '';
    if (!toolCallId || typeof row.content !== 'string') {
      continue;
    }
    out.push({ tool_call_id: toolCallId, content: row.content });
  }
  return out;
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

function parseMergedToolOutputs(raw: string): Array<{ tool_call_id: string; content: string; name?: string }> | undefined | null {
  const parsed = parseJson('parseMergedToolOutputs', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ tool_call_id: string; content: string; name?: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const toolCallId =
      (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
      (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
      '';
    if (!toolCallId || typeof row.content !== 'string') {
      continue;
    }
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
    out.push({ tool_call_id: toolCallId, content: row.content, ...(name ? { name } : {}) });
  }
  return out;
}

function parseNormalizedTools(raw: string): unknown[] | undefined | null {
  const parsed = parseJson('parseNormalizedTools', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed;
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
  const trimmed = parsed.trim();
  return trimmed ? trimmed : undefined;
}

export function mapResumeToolOutputsDetailedWithNative(
  responsesResume: unknown
): NativeResumeToolOutput[] {
  const capability = 'mapResumeToolOutputsDetailedJson';
  const fail = (reason?: string) => failNativeRequired<NativeResumeToolOutput[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('mapResumeToolOutputsDetailedJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(responsesResume ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResumeToolOutputs(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServerToolFollowupSnapshotWithNative(
  adapterContext: unknown
): Record<string, unknown> | undefined {
  const capability = 'resolveServerToolFollowupSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveServerToolFollowupSnapshotJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(adapterContext ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalRecord(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function augmentContextSnapshotWithNative(
  context: Record<string, unknown>,
  fallbackSnapshot: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'augmentContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('augmentContextSnapshotJson');
  if (!fn) {
    return fail();
  }
  const contextJson = safeStringify(context);
  const fallbackJson = safeStringify(fallbackSnapshot);
  if (!contextJson || !fallbackJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contextJson, fallbackJson);
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

export function normalizeToolCallIdStyleCandidateWithNative(
  value: unknown
): 'fc' | 'preserve' | undefined {
  const capability = 'normalizeToolCallIdStyleCandidateJson';
  const fail = (reason?: string) => failNativeRequired<'fc' | 'preserve' | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeToolCallIdStyleCandidateJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(value ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStyle(raw);
    return parsed === null ? fail('invalid payload') : parsed;
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

export function mergeContextToolOutputsWithNative(
  existing: unknown,
  snapshot: Record<string, unknown>
): Array<{ tool_call_id: string; content: string; name?: string }> | undefined {
  const capability = 'mergeContextToolOutputsJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ tool_call_id: string; content: string; name?: string }> | undefined>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('mergeContextToolOutputsJson');
  if (!fn) {
    return fail();
  }
  const existingJson = safeStringify(existing ?? null);
  const snapshotJson = safeStringify(snapshot);
  if (!existingJson || !snapshotJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(existingJson, snapshotJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseMergedToolOutputs(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeContextToolsWithNative(
  snapshot: Record<string, unknown>
): unknown[] | undefined {
  const capability = 'normalizeContextToolsJson';
  const fail = (reason?: string) => failNativeRequired<unknown[] | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeContextToolsJson');
  if (!fn) {
    return fail();
  }
  const snapshotJson = safeStringify(snapshot);
  if (!snapshotJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(snapshotJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizedTools(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function selectToolCallIdStyleWithNative(
  adapterContext: unknown,
  snapshot: Record<string, unknown>,
  current: string | undefined
): string | undefined {
  const capability = 'selectToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('selectToolCallIdStyleJson');
  if (!fn) {
    return fail();
  }
  const adapterContextJson = safeStringify(adapterContext);
  const snapshotJson = safeStringify(snapshot);
  const currentJson = safeStringify(current ?? null);
  if (!adapterContextJson || !snapshotJson || !currentJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(adapterContextJson, snapshotJson, currentJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStyle(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

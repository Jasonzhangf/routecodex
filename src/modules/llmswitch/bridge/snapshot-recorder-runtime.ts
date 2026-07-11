import { buildInfo } from '../../../build-info.js';
import { resolveLlmswitchCoreVersion } from '../../../utils/runtime-versions.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';

type AnyRecord = Record<string, unknown>;
export type SnapshotRecorder = unknown;
type RuntimeErrorGroup = 'parse-error' | 'exec-error';
export interface RuntimeErrorSignal {
  group: RuntimeErrorGroup;
  errorType: string;
  matchedText: string;
}
export interface ToolExecutionFailureSignal {
  toolName: 'exec_command' | 'apply_patch' | 'shell_command';
  errorType: string;
  matchedText: string;
  toolCallId?: string;
  callId?: string;
}
export interface StageTraceEntry {
  at: string;
  stage: string;
  payload: unknown;
}
export interface ClientToolTraceSummaryEntry {
  at: string;
  stage: string;
}
const MAX_STAGE_TRACE_ENTRIES = 40;
const MAX_STAGE_TRACE_PAYLOAD_CHARS = 120_000;
export const MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES = 6;
const DEFAULT_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS = 30 * 60_000;
const clientToolErrorSampleWindow = new Map<string, number>();
const truthy = new Set(['1', 'true', 'yes', 'on']);
let cachedTracePayloadCaptureEnabled: boolean | null = null;

export function resetSnapshotRecorderErrorsampleStateForTests(): void {
  clientToolErrorSampleWindow.clear();
  cachedTracePayloadCaptureEnabled = null;
}

function isTracePayloadCaptureEnabled(): boolean {
  if (cachedTracePayloadCaptureEnabled !== null) {
    return cachedTracePayloadCaptureEnabled;
  }
  const raw = String(
    process.env.ROUTECODEX_STAGE_TRACE_CAPTURE_PAYLOAD
    ?? process.env.RCC_STAGE_TRACE_CAPTURE_PAYLOAD
    ?? ''
  ).trim().toLowerCase();
  cachedTracePayloadCaptureEnabled = truthy.has(raw);
  return cachedTracePayloadCaptureEnabled;
}

function clipText(input: string, max = 320): string {
  const text = String(input || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function getRecorderMetadata(context: AnyRecord): Record<string, unknown> {
  if (!context || typeof context !== 'object') {
    return {};
  }
  return {
    requestId: (context as any).requestId,
    providerProtocol: (context as any).providerProtocol,
    runtime: (context as any).runtime
  };
}

export function writeBridgeErrorsample(args: {
  group: string;
  kind: string;
  sampleKind: string;
  endpoint: string;
  stage: string;
  context: AnyRecord;
  observation: unknown;
  extras?: Record<string, unknown>;
}): void {
  void writeErrorsampleJson({
    group: args.group,
    kind: args.kind,
    payload: {
      kind: args.sampleKind,
      timestamp: new Date().toISOString(),
      endpoint: args.endpoint,
      stage: args.stage,
      versions: {
        routecodex: buildInfo.version,
        llms: resolveLlmswitchCoreVersion(),
        node: process.version
      },
      ...getRecorderMetadata(args.context),
      ...(args.extras ?? {}),
      observation: args.observation
    }
  }).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[snapshot-recorder] writeBridgeErrorsample failed group=${args.group} kind=${args.kind} stage=${args.stage}: ${reason}`
    );
  });
}

export function logClientToolError(args: {
  requestId?: string;
  stage: string;
  toolName: string;
  errorType: string;
  matchedText: string;
  condensed?: boolean;
}): void {
  const req = args.requestId && args.requestId.trim().length ? args.requestId.trim() : 'unknown';
  const stage = args.stage && args.stage.trim().length ? args.stage.trim() : 'unknown';
  const tool = args.toolName && args.toolName.trim().length ? args.toolName.trim() : 'unknown';
  const errorType = args.errorType && args.errorType.trim().length ? args.errorType.trim() : 'unknown';
  const detail = clipText(args.matchedText || '', 240);
  const detailPart = detail ? ` detail=${detail}` : '';
  const condensedPart = args.condensed
    ? ' (more client-tool errors suppressed for this request; see ~/.rcc/errorsamples/client-tool-error/)'
    : '';
  console.error(
    `\x1b[31m[client-tool-error] requestId=${req} stage=${stage} tool=${tool} errorType=${errorType}${detailPart}${condensedPart}\x1b[0m`
  );
}

export function logRuntimeErrorSignal(args: {
  requestId?: string;
  stage: string;
  group: 'parse-error' | 'exec-error';
  errorType: string;
  matchedText: string;
}): void {
  const req = args.requestId && args.requestId.trim().length ? args.requestId.trim() : 'unknown';
  const stage = args.stage && args.stage.trim().length ? args.stage.trim() : 'unknown';
  const detail = clipText(args.matchedText || '', 240);
  const detailPart = detail ? ` detail=${detail}` : '';
  console.error(
    `\x1b[31m[runtime-error] requestId=${req} group=${args.group} stage=${stage} errorType=${args.errorType}${detailPart}\x1b[0m`
  );
}

function cloneForErrorsample(value: unknown): unknown {
  if (!isTracePayloadCaptureEnabled()) {
    return undefined;
  }
  try {
    const text = JSON.stringify(value);
    if (text.length <= MAX_STAGE_TRACE_PAYLOAD_CHARS) {
      return JSON.parse(text);
    }
    return {
      clipped: true,
      bytes: text.length,
      preview: text.slice(0, MAX_STAGE_TRACE_PAYLOAD_CHARS)
    };
  } catch {
    return { clipped: true, reason: 'serialize_failed' };
  }
}

export function appendStageTrace(trace: StageTraceEntry[], stage: string, payload: AnyRecord): void {
  const shouldCapturePayload = isTracePayloadCaptureEnabled();
  trace.push({
    at: new Date().toISOString(),
    stage,
    payload: shouldCapturePayload ? cloneForErrorsample(payload) : undefined
  });
  if (trace.length > MAX_STAGE_TRACE_ENTRIES) {
    trace.splice(0, trace.length - MAX_STAGE_TRACE_ENTRIES);
  }
}

export function cloneStageTraceSummary(
  trace: StageTraceEntry[],
  limit = MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES
): ClientToolTraceSummaryEntry[] {
  const tail = limit > 0 ? trace.slice(-limit) : trace;
  return tail.map((item) => ({
    at: item.at,
    stage: item.stage
  }));
}

function resolveClientToolErrorSampleWindowMs(): number {
  const raw =
    process.env.ROUTECODEX_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS ||
    process.env.RCC_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS;
  }
  return Math.floor(parsed);
}

export function shouldWriteClientToolErrorsample(args: {
  endpoint: string;
  stage: string;
  failure: ToolExecutionFailureSignal;
}): boolean {
  if (
    args.failure.toolName === 'exec_command' &&
    args.failure.errorType === 'exec_command_non_zero_exit' &&
    /\bcode 1\b/i.test(args.failure.matchedText || '')
  ) {
    return false;
  }
  const windowMs = resolveClientToolErrorSampleWindowMs();
  if (windowMs <= 0) {
    return true;
  }
  const now = Date.now();
  const matchedFingerprint =
    args.failure.toolName === 'apply_patch'
      ? clipText(String(args.failure.matchedText || '').replace(/\s+/g, ' ').toLowerCase(), 120)
      : '';
  const key = [
    args.endpoint,
    args.stage,
    args.failure.toolName,
    args.failure.errorType,
    matchedFingerprint
  ].join('|');
  for (const [sampleKey, seenAt] of clientToolErrorSampleWindow.entries()) {
    if (now - seenAt > windowMs) {
      clientToolErrorSampleWindow.delete(sampleKey);
    }
  }
  const lastSeenAt = clientToolErrorSampleWindow.get(key);
  if (typeof lastSeenAt === 'number' && now - lastSeenAt <= windowMs) {
    return false;
  }
  clientToolErrorSampleWindow.set(key, now);
  return true;
}

/**
 * Snapshot Recorder Bridge
 *
 * Creates and manages snapshot recorders for HubPipeline.
 */

import { buildInfo } from '../../../build-info.js';
import { resolveLlmswitchCoreVersion } from '../../../utils/runtime-versions.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import type { AnyRecord } from './module-loader.js';
import { importCoreDist } from './module-loader.js';

type SnapshotRecorder = unknown;

type SnapshotRecorderModule = {
  createSnapshotRecorder?: (context: AnyRecord, endpoint: string) => SnapshotRecorder;
};

type RuntimeErrorGroup = 'parse-error' | 'exec-error';

interface RuntimeErrorSignal {
  group: RuntimeErrorGroup;
  errorType: string;
  matchedText: string;
}

type SignalFieldPath = ReadonlyArray<string | number>;

interface SignalTextCandidate {
  path: SignalFieldPath;
  value: string;
}

interface ToolExecutionFailureSignal {
  toolName: 'exec_command' | 'apply_patch' | 'shell_command';
  errorType: string;
  matchedText: string;
  toolCallId?: string;
  callId?: string;
}

interface StageTraceEntry {
  at: string;
  stage: string;
  payload: unknown;
}

interface ClientToolTraceSummaryEntry {
  at: string;
  stage: string;
}

let cachedSnapshotRecorderFactory:
  | ((context: AnyRecord, endpoint: string) => SnapshotRecorder)
  | null = null;

const MAX_STAGE_TRACE_ENTRIES = 40;
const MAX_STAGE_TRACE_PAYLOAD_CHARS = 120_000;
const MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES = 6;
const DEFAULT_CLIENT_TOOL_ERROR_SAMPLE_WINDOW_MS = 30 * 60_000;

const clientToolErrorSampleWindow = new Map<string, number>();

export function resetSnapshotRecorderErrorsampleStateForTests(): void {
  clientToolErrorSampleWindow.clear();
}

const PARSE_ERROR_SIGNALS: Array<{ needle: string; errorType: string }> = [
  { needle: 'failed to parse function arguments', errorType: 'tool_args_parse_failed' },
  { needle: 'missing field `cmd`', errorType: 'tool_args_missing_cmd' },
  { needle: 'missing field `input`', errorType: 'tool_args_missing_input' },
  { needle: 'missing field `command`', errorType: 'tool_args_missing_command' },
  { needle: 'failed to decode sse payload', errorType: 'sse_decode_failed' },
  { needle: 'upstream sse terminated', errorType: 'sse_upstream_terminated' },
  { needle: 'does not support sse decoding', errorType: 'sse_protocol_unsupported' }
];

const EXEC_ERROR_SIGNALS: Array<{ needle: string; errorType: string }> = [
  { needle: 'apply_patch verification failed', errorType: 'apply_patch_verification_failed' },
  { needle: 'followup failed for flow', errorType: 'followup_execution_failed' },
  { needle: 'tool execution failed', errorType: 'tool_execution_failed' }
];

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

function writeBridgeErrorsample(args: {
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

function logClientToolError(args: {
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
  // Red warning on console for immediate operator visibility.
  console.error(
    `\x1b[31m[client-tool-error] requestId=${req} stage=${stage} tool=${tool} errorType=${errorType}${detailPart}${condensedPart}\x1b[0m`
  );
}

function logRuntimeErrorSignal(args: {
  requestId?: string;
  stage: string;
  group: RuntimeErrorGroup;
  errorType: string;
  matchedText: string;
}): void {
  const req = args.requestId && args.requestId.trim().length ? args.requestId.trim() : 'unknown';
  const stage = args.stage && args.stage.trim().length ? args.stage.trim() : 'unknown';
  const group = args.group;
  const errorType = args.errorType && args.errorType.trim().length ? args.errorType.trim() : 'unknown';
  const detail = clipText(args.matchedText || '', 240);
  const detailPart = detail ? ` detail=${detail}` : '';
  console.error(
    `\x1b[31m[runtime-error] requestId=${req} group=${group} stage=${stage} errorType=${errorType}${detailPart}\x1b[0m`
  );
}

function shouldLogRuntimeErrorSignalToConsole(signal: RuntimeErrorSignal): boolean {
  // 噪音控制：执行失败（exec-error）统一只落样本，不刷控制台。
  // 解析错误（parse-error）保留控制台提示，便于快速定位兼容问题。
  if (signal.group === 'exec-error') {
    return false;
  }
  return true;
}

function shouldInspectRuntimeError(stage: string, payload: AnyRecord): boolean {
  if (stage === 'chat_process.resp.stage1.sse_decode') {
    return true;
  }
  if (stage.startsWith('chat_process.req.') || stage.startsWith('chat_process.resp.')) {
    if (
      stage.includes('format_parse') ||
      stage.includes('semantic_map') ||
      stage.includes('format_build') ||
      stage.includes('tool_governance')
    ) {
      return true;
    }
  }
  if (stage.includes('tool_governance')) {
    return true;
  }
  if (stage.startsWith('servertool.') || stage.startsWith('hub_followup.')) {
    return true;
  }
  return (
    typeof payload.error === 'string' ||
    typeof payload.message === 'string' ||
    typeof payload.reason === 'string'
  );
}

function isLikelyContentPath(path: SignalFieldPath): boolean {
  return path.some((segment) => {
    if (typeof segment !== 'string') {
      return false;
    }
    return (
      segment === 'message' ||
      segment === 'content' ||
      segment === 'contents' ||
      segment === 'text' ||
      segment === 'messages' ||
      segment === 'tool_calls' ||
      segment === 'function' ||
      segment === 'arguments' ||
      segment === 'call_id' ||
      segment === 'input' ||
      segment === 'output' ||
      segment === 'reasoning' ||
      segment === 'summary' ||
      segment === 'excerpt' ||
      segment === 'observation'
    );
  });
}

function shouldSkipSignalPath(path: SignalFieldPath): boolean {
  if (isLikelyContentPath(path)) {
    return true;
  }
  return path.some((segment) => typeof segment === 'string' && segment.startsWith('trace'));
}

function collectRuntimeSignalTexts(payload: unknown): SignalTextCandidate[] {
  const candidates: SignalTextCandidate[] = [];
  const queue: Array<{ value: unknown; path: SignalFieldPath }> = [{ value: payload, path: [] }];
  const seen = new WeakSet<object>();
  let steps = 0;

  while (queue.length > 0 && steps < 1200) {
    steps += 1;
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const { value, path } = current;
    if (typeof value === 'string') {
      if (!shouldSkipSignalPath(path)) {
        candidates.push({ path, value });
      }
      continue;
    }
    if (!value || typeof value !== 'object') {
      continue;
    }
    if (seen.has(value as object)) {
      continue;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        queue.push({ value: item, path: [...path, index] });
      });
      continue;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === 'error' ||
        key === 'message' ||
        key === 'reason' ||
        key === 'detail' ||
        key === 'details' ||
        key === 'statusText' ||
        key === 'failure' ||
        key === 'failureReason' ||
        key.endsWith('Error') ||
        key.endsWith('Reason') ||
        key.endsWith('Message') ||
        key.endsWith('Detail')
      ) {
        queue.push({ value: child, path: [...path, key] });
      }
    }
  }

  return candidates;
}

function classifyRuntimeErrorSignal(stage: string, payload: AnyRecord): RuntimeErrorSignal | null {
  if (stage === 'chat_process.resp.stage1.sse_decode') {
    const decoded = (payload as any).decoded;
    const err = typeof (payload as any).error === 'string' ? String((payload as any).error) : '';
    if (decoded === false && err) {
      return {
        group: 'parse-error',
        errorType: 'sse_decode_error',
        matchedText: err
      };
    }
  }

  const candidates = collectRuntimeSignalTexts(payload);
  if (candidates.length <= 0) {
    return null;
  }

  for (const candidate of candidates) {
    const lower = candidate.value.toLowerCase();

    if (lower.includes('apply_patch verification failed')) {
      const resolved = classifyApplyPatchVerificationFailure(candidate.value);
      return {
        group: 'exec-error',
        errorType: resolved.errorType,
        matchedText: resolved.matchedText
      };
    }

    for (const signal of EXEC_ERROR_SIGNALS) {
      if (lower.includes(signal.needle)) {
        return {
          group: 'exec-error',
          errorType: signal.errorType,
          matchedText: signal.needle
        };
      }
    }

    for (const signal of PARSE_ERROR_SIGNALS) {
      if (lower.includes(signal.needle)) {
        return {
          group: 'parse-error',
          errorType: signal.errorType,
          matchedText: signal.needle
        };
      }
    }
  }

  return null;
}

function clipText(input: string, max = 320): string {
  const text = String(input || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function cloneForErrorsample(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text.length <= MAX_STAGE_TRACE_PAYLOAD_CHARS) {
      return JSON.parse(text);
    }
    return {
      truncated: true,
      originalLength: text.length,
      preview: text.slice(0, MAX_STAGE_TRACE_PAYLOAD_CHARS)
    };
  } catch {
    return {
      unserializable: true,
      preview: clipText(String(value), 500)
    };
  }
}

function appendStageTrace(trace: StageTraceEntry[], stage: string, payload: AnyRecord): void {
  trace.push({
    at: new Date().toISOString(),
    stage,
    payload: cloneForErrorsample(payload)
  });
  if (trace.length > MAX_STAGE_TRACE_ENTRIES) {
    trace.splice(0, trace.length - MAX_STAGE_TRACE_ENTRIES);
  }
}

function cloneStageTrace(trace: StageTraceEntry[], limit = MAX_STAGE_TRACE_ENTRIES): StageTraceEntry[] {
  const tail = limit > 0 ? trace.slice(-limit) : trace;
  return tail.map((item) => ({
    at: item.at,
    stage: item.stage,
    payload: cloneForErrorsample(item.payload)
  }));
}

function cloneStageTraceSummary(
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

function shouldWriteClientToolErrorsample(args: {
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
  const key = [args.endpoint, args.stage, args.failure.toolName, args.failure.errorType].join('|');
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

function summarizeClientToolObservation(payload: AnyRecord): Record<string, unknown> {
  const toolMessages = collectToolMessages(payload);
  return {
    topLevelKeys: Object.keys(payload || {}).slice(0, 20),
    toolMessageCount: toolMessages.length,
    toolMessages: toolMessages.slice(-4).map((msg) => ({
      name: typeof msg.name === 'string' ? msg.name : undefined,
      tool_call_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined,
      call_id: typeof msg.call_id === 'string' ? msg.call_id : undefined,
      contentPreview: clipText(typeof msg.content === 'string' ? msg.content : '', 180)
    }))
  };
}

function looksLikeToolOutputTranscript(content: string): boolean {
  const raw = String(content || '').trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasChunkId = lower.includes('chunk id:');
  if (!hasChunkId) {
    return false;
  }
  if (!lower.includes('wall time:')) {
    return false;
  }
  if (!lower.includes('process exited with code')) {
    return false;
  }
  if (!lower.includes('output:') && !lower.includes('original token count:')) {
    return false;
  }
  return true;
}

function resolveExecCommandFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('failed to parse function arguments')) {
    if (lower.includes('missing field `cmd`')) {
      return {
        errorType: 'exec_command_args_missing_cmd',
        matchedText: 'missing field `cmd`'
      };
    }
    if (lower.includes('missing field `input`')) {
      return {
        errorType: 'exec_command_args_missing_input',
        matchedText: 'missing field `input`'
      };
    }
    return {
      errorType: 'exec_command_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  const nonZeroExit = raw.match(/process exited with code\s+(-?\d+)/i);
  if (nonZeroExit) {
    const code = Number(nonZeroExit[1]);
    if (Number.isFinite(code) && code !== 0) {
      return {
        errorType: 'exec_command_non_zero_exit',
        matchedText: `process exited with code ${code}`
      };
    }
  }
  if (lower.includes('exec_command failed')) {
    return {
      errorType: 'exec_command_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
}

function classifyApplyPatchVerificationFailure(content: string): { errorType: string; matchedText: string } {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (
    lower.includes("expected update hunk to start with a @@ context marker, got: '======='") ||
    lower.includes("expected update hunk to start with a @@ context marker, got: '<<<<<<<") ||
    lower.includes("expected update hunk to start with a @@ context marker, got: '>>>>>>>")
  ) {
    return {
      errorType: 'apply_patch_conflict_markers_or_merge_chunks',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('failed to find context') && lower.includes('@@')) {
    return {
      errorType: 'apply_patch_gnu_line_number_context_not_found',
      matchedText: clipText(raw)
    };
  }
  if (
    lower.includes('is not a valid hunk header') &&
    (lower.includes("'--- a/") || lower.includes("'--- /dev/null") || lower.includes("'+++ b/"))
  ) {
    return {
      errorType: 'apply_patch_mixed_gnu_diff_inside_begin_patch',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('failed to find expected lines in ')) {
    return {
      errorType: 'apply_patch_expected_lines_not_found',
      matchedText: clipText(raw)
    };
  }
  return {
    errorType: 'apply_patch_verification_failed',
    matchedText: clipText(raw)
  };
}

function resolveApplyPatchFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('failed to parse function arguments')) {
    if (lower.includes('missing field `input`')) {
      return {
        errorType: 'apply_patch_args_missing_input',
        matchedText: 'missing field `input`'
      };
    }
    if (lower.includes('missing field `patch`')) {
      return {
        errorType: 'apply_patch_args_missing_patch',
        matchedText: 'missing field `patch`'
      };
    }
    return {
      errorType: 'apply_patch_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('apply_patch verification failed')) {
    return classifyApplyPatchVerificationFailure(raw);
  }
  if (lower.includes('apply_patch failed') || lower.includes('invalid patch')) {
    return {
      errorType: 'apply_patch_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
}

function resolveShellCommandFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('missing field `command`')) {
    return {
      errorType: 'shell_command_args_missing_command',
      matchedText: 'missing field `command`'
    };
  }
  if (lower.includes('missing field `cmd`')) {
    return {
      errorType: 'shell_command_args_missing_cmd',
      matchedText: 'missing field `cmd`'
    };
  }
  if (lower.includes('missing field `input`')) {
    return {
      errorType: 'shell_command_args_missing_input',
      matchedText: 'missing field `input`'
    };
  }
  if (lower.includes('failed to parse function arguments')) {
    return {
      errorType: 'shell_command_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
}

function collectToolMessages(payload: AnyRecord): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const queue: unknown[] = [payload];
  const seen = new WeakSet<object>();
  let steps = 0;

  while (queue.length > 0 && steps < 3000) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (seen.has(current as object)) {
      continue;
    }
    seen.add(current as object);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') {
          queue.push(item);
        }
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : '';
    const name = typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
    const content = typeof record.content === 'string' ? record.content : '';
    if (role === 'tool' && name && content) {
      messages.push(record);
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return messages;
}

function detectToolExecutionFailures(payload: AnyRecord): ToolExecutionFailureSignal[] {
  const failures: ToolExecutionFailureSignal[] = [];
  const dedup = new Set<string>();
  for (const msg of collectToolMessages(payload)) {
    const rawToolName = typeof msg.name === 'string' ? msg.name.trim().toLowerCase() : '';
    const toolName =
      rawToolName === 'shell' || rawToolName === 'bash' || rawToolName === 'terminal'
        ? 'shell_command'
        : rawToolName;
    if (toolName !== 'exec_command' && toolName !== 'apply_patch' && toolName !== 'shell_command') {
      continue;
    }
    const content = typeof msg.content === 'string' ? msg.content : '';
    const resolver =
      toolName === 'exec_command'
        ? resolveExecCommandFailure(content)
        : toolName === 'apply_patch'
          ? resolveApplyPatchFailure(content)
          : resolveShellCommandFailure(content);
    if (!resolver) {
      continue;
    }
    const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined;
    const callId = typeof msg.call_id === 'string' ? msg.call_id : undefined;
    const key = [toolName, resolver.errorType, resolver.matchedText, toolCallId || '', callId || ''].join('|');
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);
    failures.push({
      toolName: toolName as 'exec_command' | 'apply_patch' | 'shell_command',
      errorType: resolver.errorType,
      matchedText: resolver.matchedText,
      toolCallId,
      callId
    });
  }
  return failures;
}

function shouldLogClientToolErrorToConsole(failure: ToolExecutionFailureSignal): boolean {
  if (failure.toolName === 'apply_patch') {
    return (
      failure.errorType === 'apply_patch_args_missing_input' ||
      failure.errorType === 'apply_patch_args_missing_patch' ||
      failure.errorType === 'apply_patch_args_parse_failed'
    );
  }
  if (failure.toolName === 'exec_command') {
    return (
      failure.errorType === 'exec_command_args_missing_cmd' ||
      failure.errorType === 'exec_command_args_missing_input' ||
      failure.errorType === 'exec_command_args_parse_failed'
    );
  }
  return false;
}

/**
 * 为 HubPipeline / provider 响应路径创建阶段快照记录器。
 * 内部通过 llmswitch-core 的 snapshot-recorder 模块实现。
 */
export async function createSnapshotRecorder(
  context: AnyRecord,
  endpoint: string
): Promise<SnapshotRecorder> {
  if (!cachedSnapshotRecorderFactory) {
    const mod = await importCoreDist<SnapshotRecorderModule>('conversion/hub/snapshot-recorder');
    const factory = mod.createSnapshotRecorder;
    if (typeof factory !== 'function') {
      throw new Error('[llmswitch-bridge] createSnapshotRecorder not available');
    }
    cachedSnapshotRecorderFactory = factory;
  }
  const recorder = cachedSnapshotRecorderFactory(context, endpoint) as any;
  const baseRecord = typeof recorder?.record === 'function' ? recorder.record.bind(recorder) : null;
  if (!baseRecord) {
    return recorder;
  }
  const runtimeErrorDedup = new Set<string>();
  const clientToolErrorDedup = new Set<string>();
  let clientToolParseConsoleLogged = false;
  const stageTrace: StageTraceEntry[] = [];

  return {
    ...recorder,
    record(stage: string, payload: object) {
      baseRecord(stage, payload);
      try {
        if (!stage || typeof stage !== 'string') return;
        const p = payload as any;
        if (!p || typeof p !== 'object') return;
        appendStageTrace(stageTrace, stage, p);

        if (stage.startsWith('hub_policy.')) {
          const violations = p.violations;
          if (!Array.isArray(violations) || violations.length <= 0) return;
          writeBridgeErrorsample({
            group: 'policy',
            kind: stage,
            sampleKind: 'hub_policy_violation',
            endpoint,
            stage,
            context,
            observation: payload
          });
          return;
        }

        if (stage.startsWith('hub_toolsurface.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          writeBridgeErrorsample({
            group: 'tool-surface',
            kind: stage,
            sampleKind: 'hub_toolsurface_diff',
            endpoint,
            stage,
            context,
            observation: payload
          });
          return;
        }

        if (stage.startsWith('hub_followup.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          writeBridgeErrorsample({
            group: 'followup',
            kind: stage,
            sampleKind: 'hub_followup_diff',
            endpoint,
            stage,
            context,
            observation: payload
          });
          return;
        }

        const toolFailures = detectToolExecutionFailures(p);
        if (toolFailures.length > 0) {
          const requestId = typeof (context as any)?.requestId === 'string' ? String((context as any).requestId) : '';
          for (const failure of toolFailures) {
            const dedupKey = [
              requestId,
              failure.toolName,
              failure.errorType,
              failure.matchedText,
              failure.toolCallId || '',
              failure.callId || ''
            ].join('|');
            if (clientToolErrorDedup.has(dedupKey)) {
              continue;
            }
            clientToolErrorDedup.add(dedupKey);
            if (!clientToolParseConsoleLogged && shouldLogClientToolErrorToConsole(failure)) {
              clientToolParseConsoleLogged = true;
              logClientToolError({
                requestId,
                stage,
                toolName: failure.toolName,
                errorType: failure.errorType,
                matchedText: failure.matchedText,
                condensed: true
              });
            }
            if (!shouldWriteClientToolErrorsample({ endpoint, stage, failure })) {
              continue;
            }
            writeBridgeErrorsample({
              group: 'client-tool-error',
              kind: `${stage}.${failure.toolName}`,
              sampleKind: 'client_tool_execution_error',
              endpoint,
              stage,
              context,
              extras: {
                toolName: failure.toolName,
                errorType: failure.errorType,
                matchedText: failure.matchedText,
                toolCallId: failure.toolCallId,
                callId: failure.callId,
                trace: cloneStageTraceSummary(stageTrace, MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES)
              },
              observation: summarizeClientToolObservation(p)
            });
          }
        }

        if (shouldInspectRuntimeError(stage, p)) {
          const signal = classifyRuntimeErrorSignal(stage, p);
          if (!signal) return;
          const requestId = typeof (context as any)?.requestId === 'string' ? String((context as any).requestId) : '';
          const dedupKey = [requestId, stage, signal.group, signal.errorType, signal.matchedText].join('|');
          if (runtimeErrorDedup.has(dedupKey)) return;
          runtimeErrorDedup.add(dedupKey);
          if (shouldLogRuntimeErrorSignalToConsole(signal)) {
            logRuntimeErrorSignal({
              requestId,
              stage,
              group: signal.group,
              errorType: signal.errorType,
              matchedText: signal.matchedText
            });
          }
          writeBridgeErrorsample({
            group: signal.group,
            kind: stage,
            sampleKind: signal.group === 'parse-error' ? 'runtime_parse_error' : 'runtime_exec_error',
            endpoint,
            stage,
            context,
            extras: {
              errorType: signal.errorType,
              matchedText: signal.matchedText
            },
            observation: payload
          });
        }
      } catch {
        // best-effort only; must never break request path
      }
    }
  } as SnapshotRecorder;
}

export type { SnapshotRecorder };

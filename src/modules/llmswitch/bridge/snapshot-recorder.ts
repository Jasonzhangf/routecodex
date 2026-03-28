/**
 * Snapshot Recorder Bridge
 *
 * Creates and manages snapshot recorders for HubPipeline.
 */

import type { AnyRecord } from './module-loader.js';
import { importCoreDist } from './module-loader.js';
import {
  type SnapshotRecorder,
  type SnapshotRecorderModule,
  type StageTraceEntry,
  MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES
} from './snapshot-recorder-types.js';
import {
  appendStageTrace,
  classifyRuntimeErrorSignal,
  cloneStageTraceSummary,
  isRecordableApplyPatchErrorType,
  logClientToolError,
  logRuntimeErrorSignal,
  resetSnapshotRecorderErrorsampleStateForTests,
  shouldInspectRuntimeError,
  shouldLogRuntimeErrorSignalToConsole,
  shouldWriteClientToolErrorsample,
  summarizeClientToolObservation,
  writeBridgeErrorsample
} from './snapshot-recorder-runtime.js';
import {
  detectToolExecutionFailures,
  shouldLogClientToolErrorToConsole
} from './snapshot-recorder-tool-failures.js';

let cachedSnapshotRecorderFactory:
  | ((context: AnyRecord, endpoint: string) => SnapshotRecorder)
  | null = null;

export { resetSnapshotRecorderErrorsampleStateForTests };

type EmptyResponseSignal = {
  errorType: string;
  matchedText: string;
  responseSummary: Record<string, unknown>;
};

type RequestTailSummary = {
  stage: string;
  preview: string;
} | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTrimmedString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function clipPreview(value: unknown, max = 240): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value ?? '');
        }
      })();
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

function collectTextParts(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) {
        texts.push(text);
      }
      continue;
    }
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    for (const key of ['text', 'output_text', 'input_text']) {
      const text = readTrimmedString(row[key]);
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts;
}

function hasAnyRequiredActionToolCalls(payload: Record<string, unknown>): boolean {
  const requiredAction = asRecord(payload.required_action);
  if (!requiredAction) {
    return false;
  }
  const submit = asRecord(requiredAction.submit_tool_outputs);
  const toolCalls = submit?.tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function hasAnyOutputFunctionCalls(payload: Record<string, unknown>): boolean {
  const output = payload.output;
  if (!Array.isArray(output)) {
    return false;
  }
  for (const item of output) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const itemType = readTrimmedString(row.type).toLowerCase();
    if (itemType === 'function_call' || itemType === 'function') {
      return true;
    }
    const toolCalls = row.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return true;
    }
  }
  return false;
}

function classifyEmptyResponseSignal(stage: string, payload: Record<string, unknown>): EmptyResponseSignal | null {
  if (!stage.startsWith('chat_process.resp.')) {
    return null;
  }
  if (payload.error && typeof payload.error !== 'undefined') {
    return null;
  }
  if (hasAnyRequiredActionToolCalls(payload) || hasAnyOutputFunctionCalls(payload)) {
    return null;
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (choices.length > 0) {
    const first = asRecord(choices[0]);
    if (!first) {
      return null;
    }
    const finishReason = readTrimmedString(first.finish_reason).toLowerCase();
    const message = asRecord(first.message);
    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return null;
    }
    const textCandidates = [
      ...collectTextParts(message?.content),
      ...collectTextParts(first.content)
    ];
    if (finishReason === 'stop' && textCandidates.length <= 0) {
      return {
        errorType: 'empty_response_no_text_or_tool_calls',
        matchedText: 'finish_reason=stop but assistant text/tool_calls are empty',
        responseSummary: {
          protocol: 'chat',
          finishReason,
          hasToolCalls: false,
          textCount: 0
        }
      };
    }
    return null;
  }

  const status = readTrimmedString(payload.status).toLowerCase();
  if (status !== 'completed' && status !== 'stop') {
    return null;
  }
  const outputText = readTrimmedString(payload.output_text);
  const output = Array.isArray(payload.output) ? payload.output : [];
  const outputTexts: string[] = [];
  for (const item of output) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    outputTexts.push(...collectTextParts(row.content));
    outputTexts.push(...collectTextParts(row.text));
    outputTexts.push(...collectTextParts(row.output_text));
  }
  if (!outputText && outputTexts.length <= 0) {
    return {
      errorType: 'empty_response_no_text_or_tool_calls',
      matchedText: 'responses status completed but output_text/output content are empty',
      responseSummary: {
        protocol: 'responses',
        status,
        hasRequiredAction: false,
        hasOutputFunctionCalls: false,
        outputItems: output.length,
        textCount: 0
      }
    };
  }
  return null;
}

function resolveRequestTailFromPayload(stage: string, payload: Record<string, unknown>): RequestTailSummary {
  const messagesPreview = clipPreview(payload.messages, 3200);
  if (messagesPreview) {
    return {
      stage,
      preview: `messages_tail=${messagesPreview}`
    };
  }
  const inputPreview = clipPreview(payload.input, 3200);
  if (inputPreview) {
    return {
      stage,
      preview: `input_tail=${inputPreview}`
    };
  }
  const nestedPayload = asRecord(payload.payload);
  if (nestedPayload) {
    const nestedMessagesPreview = clipPreview(nestedPayload.messages, 3200);
    if (nestedMessagesPreview) {
      return {
        stage,
        preview: `payload.messages_tail=${nestedMessagesPreview}`
      };
    }
    const nestedInputPreview = clipPreview(nestedPayload.input, 3200);
    if (nestedInputPreview) {
      return {
        stage,
        preview: `payload.input_tail=${nestedInputPreview}`
      };
    }
  }
  return null;
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
  const emptyResponseDedup = new Set<string>();
  let clientToolParseConsoleLogged = false;
  const stageTrace: StageTraceEntry[] = [];
  let latestRequestTail: RequestTailSummary = null;

  return {
    ...recorder,
    record(stage: string, payload: object) {
      if (stage && stage.startsWith('chat_process.req.') && payload && typeof payload === 'object') {
        try {
          const resolved = resolveRequestTailFromPayload(stage, payload as unknown as Record<string, unknown>);
          if (resolved) {
            latestRequestTail = resolved;
          }
        } catch {
          // non-blocking; fallback to trace summary only
        }
      }
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
          if (signal && isRecordableApplyPatchErrorType(signal.errorType)) {
            const requestId = typeof (context as any)?.requestId === 'string' ? String((context as any).requestId) : '';
            const dedupKey = [requestId, stage, signal.group, signal.errorType, signal.matchedText].join('|');
            if (!runtimeErrorDedup.has(dedupKey)) {
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
          }
        }

        const emptySignal = classifyEmptyResponseSignal(stage, p);
        if (emptySignal) {
          const requestId = typeof (context as any)?.requestId === 'string' ? String((context as any).requestId) : '';
          const dedupKey = [requestId, stage, emptySignal.errorType, emptySignal.matchedText].join('|');
          if (emptyResponseDedup.has(dedupKey)) {
            return;
          }
          emptyResponseDedup.add(dedupKey);
          const latestReqTraceEntry = [...stageTrace].reverse().find((entry) =>
            typeof entry.stage === 'string' && entry.stage.startsWith('chat_process.req.')
          );
          const requestTailStage = latestRequestTail?.stage || latestReqTraceEntry?.stage;
          const requestTailPreview = latestRequestTail?.preview || clipPreview(latestReqTraceEntry?.payload, 3200);
          writeBridgeErrorsample({
            group: 'empty-response-request',
            kind: stage,
            sampleKind: 'empty_response_request_shape',
            endpoint,
            stage,
            context,
            extras: {
              errorType: emptySignal.errorType,
              matchedText: emptySignal.matchedText,
              trace: cloneStageTraceSummary(stageTrace, MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES),
              responseSummary: emptySignal.responseSummary,
              requestTailStage
            },
            observation: {
              requestTailPreview: requestTailPreview || '',
              response: emptySignal.responseSummary
            }
          });
          return;
        }
      } catch {
        // best-effort only; must never break request path
      }
    }
  } as SnapshotRecorder;
}

export type { SnapshotRecorder };

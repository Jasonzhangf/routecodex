/**
 * Snapshot Recorder Bridge
 *
 * Creates and manages snapshot recorders for HubPipeline.
 */

import {
  type StageTraceEntry,
  type ClientToolTraceSummaryEntry,
  MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES
} from './snapshot-recorder-runtime.js';
import {
  appendStageTrace,
  cloneStageTraceSummary,
  logClientToolError,
  logRuntimeErrorSignal,
  resetSnapshotRecorderErrorsampleStateForTests,
  shouldLogRuntimeErrorSignalToConsole,
  shouldWriteClientToolErrorsample,
  writeBridgeErrorsample,
  type SnapshotRecorder
} from './snapshot-recorder-runtime.js';
import {
  classifyRuntimeErrorSignalNative,
  classifyEmptyResponseSignalNative,
  detectToolExecutionFailuresNative,
  getRouterHotpathJsonBindingSync,
  resolveRequestTailSummaryNative,
  shouldInspectRuntimeErrorFastNative,
  shouldInspectToolFailuresNative,
  shouldLogClientToolErrorToConsoleNative,
  shouldRecordSnapshotsNative,
  summarizeClientToolObservationNative,
  writeSnapshotViaHooksNative
} from './native-exports.js';

export { resetSnapshotRecorderErrorsampleStateForTests };

type AnyRecord = Record<string, unknown>;
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

function shouldInspectToolFailures(stage: string): boolean {
  return shouldInspectToolFailuresNative(stage);
}

function shouldInspectRuntimeErrorFast(stage: string, payload: Record<string, unknown>): boolean {
  return shouldInspectRuntimeErrorFastNative(stage, payload);
}

function resolveRequestTailFromPayload(stage: string, payload: Record<string, unknown>): RequestTailSummary {
  return resolveRequestTailSummaryNative(stage, payload);
}

function classifyEmptyResponseSignal(stage: string, payload: Record<string, unknown>): EmptyResponseSignal | null {
  return classifyEmptyResponseSignalNative(stage, payload);
}

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type MetadataCenterLike = {
  readRuntimeControl?: () => Record<string, unknown>;
  readRequestTruth?: () => Record<string, unknown>;
  readContinuationContext?: () => Record<string, unknown>;
  readProviderObservation?: () => Record<string, unknown>;
};

function readMetadataCenterSnapshotFromAnyBoundTarget(target: unknown): Record<string, unknown> | null {
  const row = asRecord(target);
  if (!row) {
    return null;
  }
  const center = Reflect.get(row, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  const metadataSnapshot = center
    ? {
        requestTruth: typeof center.readRequestTruth === 'function' ? center.readRequestTruth() : {},
        continuationContext: typeof center.readContinuationContext === 'function' ? center.readContinuationContext() : {},
        runtimeControl: typeof center.readRuntimeControl === 'function' ? center.readRuntimeControl() : {},
        providerObservation: typeof center.readProviderObservation === 'function' ? center.readProviderObservation() : {}
      }
    : undefined;
  if (metadataSnapshot) {
    return metadataSnapshot;
  }
  const metadata = asRecord(row.metadata);
  return metadata ? readMetadataCenterSnapshotFromAnyBoundTarget(metadata) : null;
}

function callSnapshotNativeJson(capability: string, args: unknown[]): unknown {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${capability} not available`);
  }
  const raw = fn(...args);
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`[llmswitch-bridge] ${capability} returned empty result`);
  }
  return JSON.parse(raw) as unknown;
}

function stringifySnapshotNativeArg(capability: string, value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch (error) {
    if (capability === 'normalizeSnapshotStagePayloadJson') {
      return null;
    }
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] ${capability} JSON stringify failed: ${detail}`);
  }
}

function normalizeSnapshotStagePayloadNative(stage: string, payload: unknown): unknown {
  if (payload === undefined || payload === null) {
    return null;
  }
  const payloadJson = stringifySnapshotNativeArg('normalizeSnapshotStagePayloadJson', payload);
  if (!payloadJson) {
    return payload;
  }
  return callSnapshotNativeJson('normalizeSnapshotStagePayloadJson', [
    typeof stage === 'string' ? stage : '',
    payloadJson
  ]);
}

function buildSnapshotRecorderWriteOptionsNative(input: Record<string, unknown>): Record<string, unknown> {
  const inputJson = stringifySnapshotNativeArg('buildSnapshotRecorderWriteOptionsJson', input);
  const parsed = callSnapshotNativeJson('buildSnapshotRecorderWriteOptionsJson', [inputJson]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] buildSnapshotRecorderWriteOptionsJson returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

function createBaseSnapshotRecorder(context: AnyRecord, endpoint: string): SnapshotRecorder {
  const stageRequestId = typeof context.requestId === 'string' && context.requestId.trim()
    ? context.requestId.trim()
    : 'unknown_req';
  return {
    record(stage: string, payload: object): void {
      if (!shouldRecordSnapshotsNative()) {
        return;
      }
      const normalized = normalizeSnapshotStagePayloadNative(stage, payload);
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
        return;
      }
      try {
        const writeOptions = buildSnapshotRecorderWriteOptionsNative({
          endpoint,
          stage,
          requestId: stageRequestId,
          data: normalized as Record<string, unknown>,
          providerKey: typeof context.providerId === 'string' ? context.providerId : undefined,
          context,
          metadataCenterSnapshot: readMetadataCenterSnapshotFromAnyBoundTarget(context)
        });
        writeSnapshotViaHooksNative(writeOptions);
      } catch (err) {
        console.warn('[snapshot-recorder] write failed (non-blocking):', err instanceof Error ? err.message : String(err));
      }
    }
  } as SnapshotRecorder;
}

/**
 * 为 HubPipeline / provider 响应路径创建阶段快照记录器。
 * 内部通过 router_hotpath_napi snapshot hooks 实现。
 */
export async function createSnapshotRecorder(
  context: AnyRecord,
  endpoint: string
): Promise<SnapshotRecorder> {
  const recorder = createBaseSnapshotRecorder(context, endpoint) as any;
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

        const toolFailures = shouldInspectToolFailures(stage) ? detectToolExecutionFailuresNative(p) : [];
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
            if (!clientToolParseConsoleLogged && shouldLogClientToolErrorToConsoleNative(failure)) {
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
              observation: summarizeClientToolObservationNative(p, toolFailures)
            });
          }
        }

        if (shouldInspectRuntimeErrorFast(stage, p)) {
          const signal = classifyRuntimeErrorSignalNative(stage, p);
          if (signal) {
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
          const requestTailPreview = latestRequestTail?.preview || '';
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

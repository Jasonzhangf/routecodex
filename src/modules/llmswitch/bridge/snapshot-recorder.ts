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
          if (!isRecordableApplyPatchErrorType(signal.errorType)) return;
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

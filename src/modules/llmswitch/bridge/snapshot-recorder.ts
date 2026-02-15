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

let cachedSnapshotRecorderFactory:
  | ((context: AnyRecord, endpoint: string) => SnapshotRecorder)
  | null = null;

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
  }).catch(() => {});
}

function shouldInspectRuntimeError(stage: string, payload: AnyRecord): boolean {
  if (stage === 'chat_process.resp.stage1.sse_decode') {
    return true;
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

function stringifyForSignal(payload: AnyRecord): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 120000 ? text.slice(0, 120000) : text;
  } catch {
    return '';
  }
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

  const raw = stringifyForSignal(payload);
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();

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

  return {
    ...recorder,
    record(stage: string, payload: object) {
      baseRecord(stage, payload);
      try {
        if (!stage || typeof stage !== 'string') return;
        const p = payload as any;
        if (!p || typeof p !== 'object') return;

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

        if (shouldInspectRuntimeError(stage, p)) {
          const signal = classifyRuntimeErrorSignal(stage, p);
          if (!signal) return;
          const requestId = typeof (context as any)?.requestId === 'string' ? String((context as any).requestId) : '';
          const dedupKey = [requestId, stage, signal.group, signal.errorType, signal.matchedText].join('|');
          if (runtimeErrorDedup.has(dedupKey)) return;
          runtimeErrorDedup.add(dedupKey);
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

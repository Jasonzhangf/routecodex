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

let cachedSnapshotRecorderFactory:
  | ((context: AnyRecord, endpoint: string) => SnapshotRecorder)
  | null = null;

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
          void writeErrorsampleJson({
            group: 'policy',
            kind: stage,
            payload: {
              kind: 'hub_policy_violation',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }

        if (stage.startsWith('hub_toolsurface.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          void writeErrorsampleJson({
            group: 'tool-surface',
            kind: stage,
            payload: {
              kind: 'hub_toolsurface_diff',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }

        if (stage.startsWith('hub_followup.')) {
          const diffCount = typeof p.diffCount === 'number' ? p.diffCount : 0;
          if (!(diffCount > 0)) return;
          void writeErrorsampleJson({
            group: 'followup',
            kind: stage,
            payload: {
              kind: 'hub_followup_diff',
              timestamp: new Date().toISOString(),
              endpoint,
              stage,
              versions: {
                routecodex: buildInfo.version,
                llms: resolveLlmswitchCoreVersion(),
                node: process.version
              },
              ...(context && typeof context === 'object'
                ? {
                    requestId: (context as any).requestId,
                    providerProtocol: (context as any).providerProtocol,
                    runtime: (context as any).runtime
                  }
                : {}),
              observation: payload
            }
          }).catch(() => {});
          return;
        }
      } catch {
        // best-effort only; must never break request path
      }
    }
  } as SnapshotRecorder;
}

export type { SnapshotRecorder };

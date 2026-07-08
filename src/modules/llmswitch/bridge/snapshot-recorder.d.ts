/**
 * Snapshot Recorder Bridge
 *
 * Creates and manages snapshot recorders for HubPipeline.
 */
import type { AnyRecord } from './module-loader.js';
import { type SnapshotRecorder } from './snapshot-recorder-types.js';
import { resetSnapshotRecorderErrorsampleStateForTests } from './snapshot-recorder-runtime.js';
export { resetSnapshotRecorderErrorsampleStateForTests };
/**
 * 为 HubPipeline / provider 响应路径创建阶段快照记录器。
 * 内部通过 router_hotpath_napi snapshot hooks 实现。
 */
export declare function createSnapshotRecorder(context: AnyRecord, endpoint: string): Promise<SnapshotRecorder>;
export type { SnapshotRecorder };

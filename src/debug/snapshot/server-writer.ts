/**
 * M3 thin shell: server snapshot writer delegates to the unified debug snapshot writer.
 * This file must not contain direct fs.writeFile or independent path/queue logic.
 * Owner: debug.unified_surface -> src/debug/snapshot/writer.ts
 * Migration target: physical deletion in M9.
 */
import { writeUnifiedSnapshot, isSnapshotsEnabled } from './writer.js';

export type ServerSnapshotPhase =
  | 'http-request'
  | 'routing-selected'
  | 'llm-switch-request'
  | 'compatibility-request'
  | 'compatibility-response'
  | 'llm-switch-response'
  | 'final-response'
  | 'http-response'
  | 'http-response.error'
  | string;

export async function writeServerSnapshot(options: {
  phase: ServerSnapshotPhase;
  requestId: string;
  data: unknown;
  entryEndpoint?: string;
  entryPort?: number;
  providerKey?: string;
  groupRequestId?: string;
}): Promise<void> {
  return writeUnifiedSnapshot({
    scope: 'server',
    stage: String(options.phase),
    requestId: options.requestId,
    groupRequestId: options.groupRequestId,
    providerKey: options.providerKey,
    entryEndpoint: options.entryEndpoint,
    entryPort: options.entryPort,
    data: options.data,
    verbosity: 'verbose',
  });
}

export { isSnapshotsEnabled };

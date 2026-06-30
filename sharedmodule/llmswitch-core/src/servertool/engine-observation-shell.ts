import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { appendServerToolProgressFileEvent } from './log/progress-file.js';
import type { ServerToolExecution } from './types.js';
import { readProviderProtocolFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

export function recordServertoolEngineMatchSkipped(args: {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  engineMode: 'passthrough' | 'tool_flow';
  stageRecorder?: StageRecorder;
  adapterContext?: AdapterContext;
}): void {
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.adapterContext as Record<string, unknown> | undefined);
  if (!providerProtocol) {
    throw new Error('Servertool observation requires metadata center runtime_control.providerProtocol');
  }
  const skipReason = args.engineMode === 'passthrough' ? 'passthrough' : 'no_execution';
  args.stageRecorder?.record('servertool.match', {
    matched: false,
    mode: args.engineMode,
    reason: skipReason
  });
  appendServerToolProgressFileEvent({
    requestId: args.requestId,
    flowId: 'none',
    tool: 'none',
    stage: 'match',
    result: 'skipped_' + skipReason,
    message: 'skipped (' + skipReason + ')',
    step: 0,
    entryEndpoint: args.entryEndpoint,
    providerProtocol
  });
}

export function recordServertoolEngineMatchHit(args: {
  requestId: string;
  execution: ServerToolExecution;
  stageRecorder?: StageRecorder;
}): string {
  const flowId = args.execution.flowId;
  if (typeof flowId !== 'string' || !flowId.trim()) {
    throw new Error('Servertool match hit requires execution.flowId');
  }
  args.stageRecorder?.record('servertool.match', {
    matched: true,
    flowId,
    hasFollowup: false
  });
  return flowId;
}

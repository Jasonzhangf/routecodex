import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { ServerToolExecution } from './types.js';
import { appendServertoolMatchSkippedProgressEvent } from './progress-log-block.js';

export function recordServertoolEngineMatchSkipped(args: {
  requestId: string;
  entryEndpoint: string;
  engineMode: 'passthrough' | 'tool_flow';
  skipReason: string;
  stageRecorder?: StageRecorder;
  adapterContext?: AdapterContext;
}): void {
  args.stageRecorder?.record('servertool.match', {
    matched: false,
    mode: args.engineMode,
    reason: args.skipReason
  });
  appendServertoolMatchSkippedProgressEvent({
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    adapterContext: args.adapterContext,
    skipReason: args.skipReason
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

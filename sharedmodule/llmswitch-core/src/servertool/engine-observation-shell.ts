import type { AdapterContext, StageRecorder, ServerToolExecution } from './types.js';
import { appendServertoolMatchSkippedProgressEvent } from './progress-log-block.js';
import { resolveServertoolEngineMatchHitWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';

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
  const { flowId } = resolveServertoolEngineMatchHitWithNative({
    execution: args.execution
  });
  args.stageRecorder?.record('servertool.match', {
    matched: true,
    flowId,
    hasFollowup: false
  });
  return flowId;
}

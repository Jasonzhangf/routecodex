import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { ServerToolExecution } from './types.js';
import { appendServerToolProgressFileEvent } from './log/progress-file.js';

export function recordServertoolMatchSkipped(args: {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  engineMode: 'passthrough' | 'tool_flow';
  stageRecorder?: StageRecorder;
  logNonBlocking: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): void {
  const skipReason = args.engineMode === 'passthrough' ? 'passthrough' : 'no_execution';
  try {
    args.stageRecorder?.record('servertool.match', {
      matched: false,
      mode: args.engineMode,
      reason: skipReason
    });
  } catch (error) {
    args.logNonBlocking('record_servertool_match_skipped', error, {
      requestId: args.requestId
    });
  }
  appendServerToolProgressFileEvent({
    requestId: args.requestId,
    flowId: 'none',
    tool: 'none',
    stage: 'match',
    result: 'skipped_' + skipReason,
    message: 'skipped (' + skipReason + ')',
    step: 0,
    entryEndpoint: args.entryEndpoint,
    providerProtocol: args.providerProtocol
  });
}

export function recordServertoolMatchHit(args: {
  requestId: string;
  execution: ServerToolExecution;
  stageRecorder?: StageRecorder;
  logNonBlocking: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
}): string {
  const flowId = args.execution.flowId ?? 'unknown';
  try {
    args.stageRecorder?.record('servertool.match', {
      matched: true,
      flowId,
      hasFollowup: Boolean(args.execution.followup)
    });
  } catch (error) {
    args.logNonBlocking('record_servertool_match_hit', error, {
      requestId: args.requestId
    });
  }
  return flowId;
}

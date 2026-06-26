import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { createServertoolProgressLogger } from './progress-log-block.js';
import { recordServertoolMatchHit, recordServertoolMatchSkipped } from './match-log-block.js';
import type { ServerToolExecution } from './types.js';
import { readProviderProtocolFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

type ServertoolProgressLogger = ReturnType<typeof createServertoolProgressLogger>;

export function logServertoolNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  const detailEntries =
    details && typeof details === 'object'
      ? Object.entries(details)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
      : '';
  // eslint-disable-next-line no-console
  console.warn(`[servertool][non-blocking] stage=${stage} error=${message}${detailEntries ? ` ${detailEntries}` : ''}`);
}

export function createServertoolObservation(args: {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}): {
  logStopEntry: ServertoolProgressLogger['logStopEntry'];
  logProgress: ServertoolProgressLogger['logProgress'];
  logAutoHookTrace: ServertoolProgressLogger['logAutoHookTrace'];
  logStopCompare: ServertoolProgressLogger['logStopCompare'];
  logNonBlocking: typeof logServertoolNonBlocking;
} {
  const BLUE = '\x1b[38;5;39m';
  const YELLOW = '\x1b[38;5;214m';
  const GOLD = '\x1b[38;5;220m';
  const RESET = '\x1b[0m';
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool observation requires metadata center runtime_control.providerProtocol');
  }
  const logger = createServertoolProgressLogger({
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    providerProtocol,
    adapterContext: args.adapterContext,
    stageRecorder: args.stageRecorder,
    blue: BLUE,
    yellow: YELLOW,
    gold: GOLD,
    reset: RESET,
    logNonBlocking: logServertoolNonBlocking
  });
  return {
    ...logger,
    logNonBlocking: logServertoolNonBlocking
  };
}

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
  recordServertoolMatchSkipped({
    ...args,
    providerProtocol,
    logNonBlocking: logServertoolNonBlocking
  });
}

export function recordServertoolEngineMatchHit(args: {
  requestId: string;
  execution: ServerToolExecution;
  stageRecorder?: StageRecorder;
}): string {
  return recordServertoolMatchHit({
    ...args,
    logNonBlocking: logServertoolNonBlocking
  });
}

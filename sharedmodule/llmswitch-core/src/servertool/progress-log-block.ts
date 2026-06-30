import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { appendServerToolProgressFileEvent } from './log/progress-file.js';
import {
  normalizeServertoolProgressFlowIdWithNative,
  normalizeServertoolProgressResultWithNative,
  normalizeServertoolProgressTokenWithNative,
  resolveServertoolProgressStageWithNative,
  resolveServertoolProgressToolNameWithNative,
  shouldUseServertoolGoldProgressHighlightWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { formatStopMessageCompareContextWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  readProviderProtocolFromAnyBoundMetadataCenter,
  readStopMessageCompareContext
} from './metadata-center-carrier.js';

const WHITE = '\u001b[97m';

function highlightValue(value: string, color: string, reset: string): string {
  return `${WHITE}${value}${reset}${color}`;
}

function shouldHighlightValue(key: string, value: string): boolean {
  return key === 'finish_reason' || /^-?\d+(?:\.\d+)?%?$/.test(value);
}

function field(key: string, value: string, color: string, reset: string): string {
  return `${key}=${shouldHighlightValue(key, value) ? highlightValue(value, color, reset) : value}`;
}

function compactStopCompareSummary(summary: string): string {
  const fields = new Map<string, string>();
  for (const part of summary.split(/\s+/)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    fields.set(part.slice(0, index), part.slice(index + 1));
  }
  const decision = fields.get('decision');
  const reason = fields.get('reason');
  const showBudget = decision === 'trigger' || fields.get('active') === 'true';
  return [
    ['decision', fields.get('decision')],
    ['reason', reason],
    ...(showBudget ? ([['used', fields.get('used')], ['left', fields.get('left')]] as Array<[string, string | undefined]>) : []),
    ['active', fields.get('active')]
  ]
    .filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

type CommonArgs = {
  requestId: string;
  entryEndpoint: string;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
  blue: string;
  yellow: string;
  gold: string;
  reset: string;
};

export function createServertoolProgressLogger(args: CommonArgs) {
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool progress logger requires metadata center runtime_control.providerProtocol');
  }
  let stopEntryBrief: Record<string, string> | null = null;
  let stopMatchBrief: Record<string, string> | null = null;

  const logStopEntry = (
    stage: 'entry' | 'trigger',
    result: string,
    extra?: Record<string, unknown>
  ): void => {
    const color = args.blue;
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const source = typeof extra?.source === 'string' ? extra.source : 'unknown';
    const reason = typeof extra?.reason === 'string' ? extra.reason : 'unknown';
    const eligible = typeof extra?.eligible === 'boolean' ? String(extra.eligible) : 'unknown';
    const flowId = typeof extra?.flowId === 'string' ? extra.flowId : '';
    if (stage === 'entry') {
      stopEntryBrief = { source, reason, eligible };
    } else {
      stopMatchBrief = { result, flow: flowId || 'none' };
    }
    appendServerToolProgressFileEvent({
      requestId: args.requestId,
      flowId: 'stop_message_flow',
      tool: 'stop_message_auto',
      stage,
      result,
      message: result,
      step: stage === 'entry' ? 0 : 2,
      entryEndpoint: args.entryEndpoint,
      providerProtocol
    });
  };

  const logProgress = (step: number, _total: number, message: string, extra?: Record<string, unknown>): void => {
    const flowId = normalizeServertoolProgressFlowIdWithNative({ value: extra?.flowId });
    const tool = resolveServertoolProgressToolNameWithNative({ flowId });
    const stage = resolveServertoolProgressStageWithNative({ step, message });
    const result = normalizeServertoolProgressResultWithNative({ message });
    const color = shouldUseServertoolGoldProgressHighlightWithNative({ flowId }) ? args.gold : args.yellow;
    const shouldPrintConsole = tool !== 'stop_message_auto';
    if (shouldPrintConsole) {
      console.log(`${color}[servertool] ${[
        field('requestId', args.requestId, color, args.reset),
        `tool=${tool}`,
        `stage=${stage}`,
        field('result', result, color, args.reset)
      ].join(' ')}${args.reset}`);
    }
    appendServerToolProgressFileEvent({
      requestId: args.requestId,
      flowId: flowId || 'none',
      tool,
      stage,
      result,
      message,
      step,
      entryEndpoint: args.entryEndpoint,
      providerProtocol
    });
  };

  const logAutoHookTrace = (event: {
    hookId: string;
    phase: string;
    priority: number;
    queue: 'A_optional' | 'B_mandatory';
    queueIndex: number;
    queueTotal: number;
    result: 'miss' | 'match' | 'error';
    reason: string;
    flowId?: string;
  }): void => {
    const reasonToken = normalizeServertoolProgressTokenWithNative({ value: event.reason });
    appendServerToolProgressFileEvent({
      requestId: args.requestId,
      flowId: event.flowId || `hook:${event.hookId}`,
      tool: event.hookId,
      stage: 'hook',
      result: `${event.result}_${reasonToken || 'unknown'}`,
      message: `${event.result} (${event.reason}) queue=${event.queue}[${event.queueIndex}/${event.queueTotal}] phase=${event.phase} priority=${event.priority}`,
      step: 2,
      entryEndpoint: args.entryEndpoint,
      providerProtocol
    });
    args.stageRecorder?.record('servertool.hook', {
      hookId: event.hookId,
      phase: event.phase,
      priority: event.priority,
      result: event.result,
      reason: event.reason,
      queue: event.queue,
      queueIndex: event.queueIndex,
      queueTotal: event.queueTotal,
      ...(event.flowId ? { flowId: event.flowId } : {})
    });
  };

  const logStopCompare = (stage: 'entry' | 'trigger', flowId?: string): void => {
    const compareContext = readStopMessageCompareContext(args.adapterContext);
    const summary = formatStopMessageCompareContextWithNative(compareContext);
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const flowToken = normalizeServertoolProgressFlowIdWithNative({ value: flowId });
    const compareResult = compareContext
      ? `${compareContext.decision}_${normalizeServertoolProgressTokenWithNative({ value: compareContext.reason })}`
      : 'unknown_no_context';
    appendServerToolProgressFileEvent({
      requestId: args.requestId,
      flowId: flowToken,
      tool: 'stop_message_auto',
      stage: 'compare',
      result: compareResult,
      message: summary,
      step: stage === 'entry' ? 1 : 3,
      entryEndpoint: args.entryEndpoint,
      providerProtocol
    });
    if (compareContext?.decision === 'trigger') {
      const compact = compactStopCompareSummary(summary);
      const entryBrief = stopEntryBrief ? [
        ['source', stopEntryBrief.source],
        ['finish_reason', stopEntryBrief.reason.replace(/^finish_reason_/, '')],
        ['eligible', stopEntryBrief.eligible]
      ] : [];
      const matchBrief = stopMatchBrief ? [
        ['match', stopMatchBrief.result],
        ['flow', flowToken || stopMatchBrief.flow]
      ] : [['flow', flowToken]];
      console.log(`${args.blue}[servertool] ${[
        field('requestId', args.requestId, args.blue, args.reset),
        'tool=stop_message_auto',
        'stage=summary',
        ...entryBrief.map(([key, value]) => field(key, value, args.blue, args.reset)),
        ...matchBrief.map(([key, value]) => field(key, value, args.blue, args.reset)),
        field('result', compareResult, args.blue, args.reset),
        ...compact.split(/\s+/).filter(Boolean).map((part) => {
          const index = part.indexOf('=');
          if (index <= 0) return part;
          return field(part.slice(0, index), part.slice(index + 1), args.blue, args.reset);
        })
      ].join(' ')}${args.reset}`);
    }
    args.stageRecorder?.record('servertool.stop_compare', {
      stage: viewStage,
      flowId: flowToken,
      summary,
      ...(compareContext ? { compare: compareContext } : {})
    });
  };

  return {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare
  };
}

import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { appendServerToolProgressFileEvent } from './log/progress-file.js';
import { resolveProgressToolName, shouldUseGoldProgressHighlight } from './flow-presentation-block.js';
import { formatStopMessageCompareContext, readStopMessageCompareContext } from './stop-message-compare-context.js';

function resolveStage(step: number, message: string): string {
  const normalized = message.trim().toLowerCase();
  if (normalized === 'matched' || step <= 1) return 'match';
  if (normalized.startsWith('completed') || step >= 5) return 'final';
  return 'followup';
}

function normalizeResult(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return 'unknown';
  const group = /^completed\s*\(([^)]+)\)/.exec(normalized);
  if (group && group[1]) {
    return 'completed_' + group[1].trim().replace(/[^a-z0-9]+/g, '_');
  }
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

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
  return [
    ['decision', fields.get('decision')],
    ['reason', fields.get('reason')],
    ['used', fields.get('used')],
    ['left', fields.get('left')],
    ['active', fields.get('active')]
  ]
    .filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function printServertoolLine(color: string, reset: string, parts: string[]): void {
  console.log(`${color}[servertool] ${parts.join(' ')}${reset}`);
}

type CommonArgs = {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
  blue: string;
  yellow: string;
  gold: string;
  reset: string;
  logNonBlocking: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
};

export function createServertoolProgressLogger(args: CommonArgs) {
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
    const brief =
      stage === 'entry'
        ? `source=${source} reason=${reason} eligible=${eligible}`
        : `result=${result} flow=${flowId || 'none'}`;
    try {
      const parts = [
        field('requestId', args.requestId, color, args.reset),
        'tool=stop_message_auto',
        `stage=${viewStage}`,
        ...brief.split(/\s+/).map((part) => {
          const index = part.indexOf('=');
          if (index <= 0) return part;
          return field(part.slice(0, index), part.slice(index + 1), color, args.reset);
        })
      ];
      printServertoolLine(color, args.reset, parts);
    } catch (error) {
      args.logNonBlocking('log_stop_entry_console', error, {
        requestId: args.requestId,
        stage: viewStage
      });
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
      providerProtocol: args.providerProtocol
    });
  };

  const logProgress = (step: number, _total: number, message: string, extra?: Record<string, unknown>): void => {
    const flowId = typeof extra?.flowId === 'string' ? extra.flowId.trim() : '';
    const tool = resolveProgressToolName(flowId);
    const stage = resolveStage(step, message);
    const result = normalizeResult(message);
    const color = shouldUseGoldProgressHighlight(flowId) ? args.gold : args.yellow;
    const shouldPrintConsole = true;
    if (shouldPrintConsole) {
      try {
        printServertoolLine(color, args.reset, [
          field('requestId', args.requestId, color, args.reset),
          `tool=${tool}`,
          `stage=${stage}`,
          field('result', result, color, args.reset)
        ]);
      } catch (error) {
        args.logNonBlocking('log_progress_console', error, {
          requestId: args.requestId,
          flowId: flowId || 'none'
        });
      }
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
      providerProtocol: args.providerProtocol
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
    const reasonToken =
      typeof event.reason === 'string' && event.reason.trim()
        ? event.reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        : 'unknown';
    appendServerToolProgressFileEvent({
      requestId: args.requestId,
      flowId: event.flowId || `hook:${event.hookId}`,
      tool: event.hookId,
      stage: 'hook',
      result: `${event.result}_${reasonToken || 'unknown'}`,
      message: `${event.result} (${event.reason}) queue=${event.queue}[${event.queueIndex}/${event.queueTotal}] phase=${event.phase} priority=${event.priority}`,
      step: 2,
      entryEndpoint: args.entryEndpoint,
      providerProtocol: args.providerProtocol
    });
    try {
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
    } catch (error) {
      args.logNonBlocking('log_auto_hook_trace_stage_recorder', error, {
        requestId: args.requestId,
        hookId: event.hookId
      });
    }

    if (event.hookId === 'stop_message_auto' && event.result === 'miss') {
      const compareContext = readStopMessageCompareContext(args.adapterContext);
      const summary = formatStopMessageCompareContext(compareContext);
      const compareResult = compareContext
        ? `${compareContext.decision}_${compareContext.reason.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown'}`
        : 'unknown_no_context';
      appendServerToolProgressFileEvent({
        requestId: args.requestId,
        flowId: 'none',
        tool: 'stop_message_auto',
        stage: 'compare',
        result: compareResult,
        message: summary,
        step: 2,
        entryEndpoint: args.entryEndpoint,
        providerProtocol: args.providerProtocol
      });
      try {
        const compact = compactStopCompareSummary(summary);
        printServertoolLine(args.blue, args.reset, [
          field('requestId', args.requestId, args.blue, args.reset),
          'tool=stop_message_auto',
          'stage=compare',
          field('result', compareResult, args.blue, args.reset),
          'flow=none',
          ...compact.split(/\s+/).filter(Boolean).map((part) => {
            const index = part.indexOf('=');
            if (index <= 0) return part;
            return field(part.slice(0, index), part.slice(index + 1), args.blue, args.reset);
          })
        ]);
      } catch (error) {
        args.logNonBlocking('log_auto_hook_trace_compare_console', error, {
          requestId: args.requestId,
          hookId: event.hookId
        });
      }
    }
  };

  const logStopCompare = (stage: 'entry' | 'trigger', flowId?: string): void => {
    const compareContext = readStopMessageCompareContext(args.adapterContext);
    const summary = formatStopMessageCompareContext(compareContext);
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const flowToken = flowId && flowId.trim() ? flowId.trim() : 'none';
    const compareResult = compareContext
      ? `${compareContext.decision}_${compareContext.reason.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown'}`
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
      providerProtocol: args.providerProtocol
    });
    try {
      const compact = compactStopCompareSummary(summary);
      printServertoolLine(args.blue, args.reset, [
        field('requestId', args.requestId, args.blue, args.reset),
        'tool=stop_message_auto',
        'stage=compare',
        field('result', compareResult, args.blue, args.reset),
        field('flow', flowToken, args.blue, args.reset),
        ...compact.split(/\s+/).filter(Boolean).map((part) => {
          const index = part.indexOf('=');
          if (index <= 0) return part;
          return field(part.slice(0, index), part.slice(index + 1), args.blue, args.reset);
        })
      ]);
    } catch (error) {
      args.logNonBlocking('log_stop_compare_console', error, {
        requestId: args.requestId
      });
    }
    try {
      args.stageRecorder?.record('servertool.stop_compare', {
        stage: viewStage,
        flowId: flowToken,
        summary,
        ...(compareContext ? { compare: compareContext } : {})
      });
    } catch (error) {
      args.logNonBlocking('log_stop_compare_stage_recorder', error, {
        requestId: args.requestId
      });
    }
  };

  return {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare
  };
}

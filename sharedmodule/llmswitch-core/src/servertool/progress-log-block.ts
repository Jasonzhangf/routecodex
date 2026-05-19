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
      console.log(
        `${color}[servertool][stop_watch] requestId=${args.requestId} stage=${viewStage} ${brief}${args.reset}`
      );
    } catch (error) {
      args.logNonBlocking('log_stop_entry_console', error, {
        requestId: args.requestId
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
    const isStopMessageFlow = tool === 'stop_message_auto';
    const isFailure = result.startsWith('failed') || result.includes('error');
    const shouldPrintConsole = !isStopMessageFlow || isFailure;
    if (shouldPrintConsole) {
      try {
        console.log(
          `${color}[servertool] requestId=${args.requestId} tool=${tool} stage=${stage} result=${result}${args.reset}`
        );
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
      try {
        console.log(
          `${args.blue}[servertool][stop_compare] requestId=${args.requestId} stage=miss flow=none ${summary}${args.reset}`
        );
      } catch (error) {
        args.logNonBlocking('log_auto_hook_stop_compare_console', error, {
          requestId: args.requestId
        });
      }
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
    }
  };

  const logStopCompare = (stage: 'entry' | 'trigger', flowId?: string): void => {
    const compareContext = readStopMessageCompareContext(args.adapterContext);
    const summary = formatStopMessageCompareContext(compareContext);
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const flowToken = flowId && flowId.trim() ? flowId.trim() : 'none';
    try {
      console.log(
        `${args.blue}[servertool][stop_compare] requestId=${args.requestId} stage=${viewStage} flow=${flowToken} ${summary}${args.reset}`
      );
    } catch (error) {
      args.logNonBlocking('log_stop_compare_console', error, {
        requestId: args.requestId
      });
    }
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

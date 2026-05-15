import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  persistStoplessGoalStateSnapshot,
  readStoplessGoalState
} from './stopless-goal-state.js';

const FLOW_ID = 'stopless_goal_continue_flow';
const HOOK_ID = 'stopless_goal_guard';
const FOLLOWUP_SOURCE = 'servertool.stopless_goal_continue';
const NO_PROGRESS_STOP_THRESHOLD = 3;
const REPEATED_NO_PROGRESS_ERROR_CLASS = 'repeated_no_progress';

function readFollowupSource(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const direct =
    typeof record.clientInjectSource === 'string' && record.clientInjectSource.trim().length
      ? record.clientInjectSource.trim()
      : '';
  if (direct) {
    return direct;
  }
  const rt = readRuntimeMetadata(record);
  return rt && typeof (rt as Record<string, unknown>).clientInjectSource === 'string'
    ? String((rt as Record<string, unknown>).clientInjectSource).trim()
    : '';
}

function shouldDeferToStopMessageAuto(adapterContext: unknown): boolean {
  const stopCompare = readStopMessageCompareContext(adapterContext);
  return stopCompare?.armed === true;
}

function buildStoplessGoalContinueText(adapterContext: unknown): string {
  const goal = readStoplessGoalState(adapterContext).state;
  if (!goal) {
    return '当前 goal 仍处于 active，但你没有提供合法的 goal control block。请改为调用 create_goal / update_goal，而不是直接停止。';
  }
  const objective = goal.objective.trim();
  const latestNote = typeof goal.latestNote === 'string' ? goal.latestNote.trim() : '';
  const lines = [
    '当前 goal 仍处于 active，但你这轮以普通 stop 结束，未提供合法的 goal control block。',
    '不要只口头声称“已完成”或“无法继续”。',
    '如果已完成：调用 update_goal(status="completed", completion_evidence, completion_summary, ssot_assessment)。',
    '如果无法继续：调用 update_goal(status="stopped", blocking_evidence, attempts_exhausted=true, error_class)。',
    '如果需要用户输入：调用 update_goal(status="paused", user_question, cannot_continue_reason)。',
    '如果还要继续：调用 update_goal(status="active", next_step)。'
  ];
  if (objective) {
    lines.push(`目标：${objective}`);
  }
  if (latestNote) {
    lines.push(`最新说明：${latestNote}`);
  }
  return lines.join('\n');
}

function persistNoProgressProgression(args: {
  adapterContext: unknown;
  objective: string;
  goalState: Record<string, unknown>;
}): { forcedStop: boolean } {
  const nowMs = Date.now();
  const previousCount =
    typeof args.goalState.consecutiveNoProgress === 'number' && Number.isFinite(args.goalState.consecutiveNoProgress)
      ? Math.max(0, Math.floor(args.goalState.consecutiveNoProgress))
      : 0;
  const nextCount = previousCount + 1;

  if (nextCount >= NO_PROGRESS_STOP_THRESHOLD) {
    const evidence = [
      'Goal stayed active but the assistant repeatedly ended with plain stop and never returned a valid goal control block.',
      `objective=${args.objective}`,
      `consecutive_missing_goal_control_block=${nextCount}`
    ].join('\n');
    persistStoplessGoalStateSnapshot(args.adapterContext, {
      ...(args.goalState as any),
      status: 'stopped',
      objective: args.objective,
      blockingEvidence: evidence,
      latestNote: evidence,
      attemptsExhausted: true,
      errorClass: REPEATED_NO_PROGRESS_ERROR_CLASS,
      consecutiveNoProgress: nextCount,
      updatedAt: nowMs,
      createdAt:
        typeof args.goalState.createdAt === 'number' && Number.isFinite(args.goalState.createdAt)
          ? args.goalState.createdAt
          : nowMs
    });
    return { forcedStop: true };
  }

  persistStoplessGoalStateSnapshot(args.adapterContext, {
    ...(args.goalState as any),
    status: 'active',
    objective: args.objective,
    consecutiveNoProgress: nextCount,
    updatedAt: nowMs,
    createdAt:
      typeof args.goalState.createdAt === 'number' && Number.isFinite(args.goalState.createdAt)
        ? args.goalState.createdAt
        : nowMs
  });
  return { forcedStop: false };
}

const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const followupSource = readFollowupSource(ctx.adapterContext);
  if ((rt as Record<string, unknown>)?.serverToolFollowup === true && followupSource !== FOLLOWUP_SOURCE) {
    return null;
  }
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldDeferToStopMessageAuto(ctx.adapterContext)) {
    return null;
  }
  const goalState = readStoplessGoalState(ctx.adapterContext).state;
  if (!goalState || goalState.status !== 'active') {
    return null;
  }
  if (ctx.toolCalls.length === 0) {
    const noProgress = persistNoProgressProgression({
      adapterContext: ctx.adapterContext,
      objective: goalState.objective.trim(),
      goalState: goalState as unknown as Record<string, unknown>
    });
    if (noProgress.forcedStop) {
      return null;
    }
  }

  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':stopless_goal_continue',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: [
              { op: 'append_assistant_message', required: false },
              { op: 'append_user_text', text: buildStoplessGoalContinueText(ctx.adapterContext) }
            ]
          },
          metadata: {
            clientInjectSource: FOLLOWUP_SOURCE
          }
        }
      }
    })
  };
};

registerServerToolHandler(HOOK_ID, handler, {
  trigger: 'auto',
  hook: {
    phase: 'post',
    priority: 150
  }
});

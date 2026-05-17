import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  persistStoplessGoalStateSnapshot,
  readStoplessGoalState
} from './stopless-goal-state.js';

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
  const hasManagedGoal = Boolean(goalState && goalState.status !== 'idle');
  const isGoalActive = goalState?.status === 'active';

  // /goal 场景：stopless 不执行 followup，只做 no-progress 计数并在阈值后 stopped。
  if (hasManagedGoal && !isGoalActive) {
    return null;
  }
  if (isGoalActive && ctx.toolCalls.length === 0) {
    persistNoProgressProgression({
      adapterContext: ctx.adapterContext,
      objective: goalState.objective.trim(),
      goalState: goalState as unknown as Record<string, unknown>
    });
    return null;
  }
  if (isGoalActive && ctx.toolCalls.length > 0) {
    if (
      typeof goalState.consecutiveNoProgress === 'number' &&
      goalState.consecutiveNoProgress > 0
    ) {
      persistStoplessGoalStateSnapshot(ctx.adapterContext, {
        ...(goalState as unknown as Record<string, unknown>),
        consecutiveNoProgress: 0,
      } as any);
    }
    return null;
  }

  // 非 /goal 场景：stopless 只负责 /goal active 的 no-progress 计数。
  // 不再注入 stopless followup，避免把普通 stop 改写成隐式 goal/续轮语义。
  if (!hasManagedGoal) {
    return null;
  }
  return null;
};

registerServerToolHandler(HOOK_ID, handler, {
  trigger: 'auto',
  hook: {
    phase: 'post',
    priority: 150
  }
});

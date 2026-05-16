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
const NON_GOAL_BOOTSTRAP_OBJECTIVE_MAX_CHARS = 1200;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      continue;
    }
    const row = asRecord(entry);
    const type = typeof row?.type === 'string' ? row.type.trim().toLowerCase() : '';
    if (type && type !== 'text' && type !== 'input_text') {
      continue;
    }
    const text = typeof row?.text === 'string' ? row.text.trim() : '';
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function readLatestUserInputText(adapterContext: unknown): string {
  const record = asRecord(adapterContext);
  const captured = asRecord(record?.capturedChatRequest);
  const messages = Array.isArray(captured?.messages) ? captured?.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = asRecord(messages[index]);
    const role = typeof row?.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    const text = extractTextFromContent(row?.content);
    if (text) {
      return text.length > NON_GOAL_BOOTSTRAP_OBJECTIVE_MAX_CHARS
        ? text.slice(0, NON_GOAL_BOOTSTRAP_OBJECTIVE_MAX_CHARS)
        : text;
    }
  }
  return '';
}

function buildStoplessNonGoalBootstrapText(adapterContext: unknown): string {
  const latestUserInput = readLatestUserInputText(adapterContext);
  const lines = [
    '你刚刚以普通 stop 结束，但当前任务尚未完成。',
    '这是非 /goal 场景：系统已将上一轮用户输入视为临时目标，请继续执行，不要只口头说明。',
    '必须调用工具并返回结构化 control block。',
    'control block 规则：',
    '- 继续执行：update_goal(status=\"active\", next_step=<non-empty string>)',
    '- 已完成：update_goal(status=\"completed\", completion_evidence, completion_summary, ssot_assessment)',
    '- 受阻停止：update_goal(status=\"stopped\", blocking_evidence, attempts_exhausted=true, error_class)',
    '- 需用户输入：update_goal(status=\"paused\", user_question, cannot_continue_reason)',
    '注意：必须使用完整工具列表执行，不接受只输出解释文本。'
  ];
  if (latestUserInput) {
    lines.push(`临时目标（来自上一轮用户输入）：${latestUserInput}`);
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

  // 非 /goal 场景：只走唯一 bootstrap 注入路径；若本轮已是该路径产物且仍无工具调用，直接停，避免自循环。
  if (!hasManagedGoal) {
    if (followupSource === FOLLOWUP_SOURCE) {
      return null;
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
                { op: 'preserve_tools' },
                { op: 'ensure_standard_tools' },
                { op: 'append_assistant_message', required: false },
                { op: 'append_user_text', text: buildStoplessNonGoalBootstrapText(ctx.adapterContext) }
              ]
            },
            metadata: {
              clientInjectSource: FOLLOWUP_SOURCE
            }
          }
        }
      })
    };
  }

  // Loop breaker:
  // when this turn is already produced by stopless_goal_continue itself and still no tool call,
  // do not enqueue another identical followup; otherwise it can self-loop indefinitely.
  if (followupSource === FOLLOWUP_SOURCE) {
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

import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import {
  armReasoningStopState,
  clearReasoningStopState,
  resetReasoningStopFailCount
} from './reasoning-stop-state.js';
import { appendReasoningStopSummaryToChatResponse } from './reasoning-stop-guard.js';

const FLOW_ID = 'reasoning_stop_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const TOOL_NAME = 'reasoning.stop';
const VALID_STOP_REASONS = new Set(['completed', 'blocked', 'user_input', 'simple_question', 'plan_mode']);

type ReasoningStopPayload = {
  taskGoal: string;
  completed: boolean;
  stopReason?: string;
  completionEvidence: string;
  cannotCompleteReason: string;
  blockingEvidence: string;
  attemptsExhausted?: boolean;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
  learning?: string;  // 可选。如果本轮任务有值得沉淀的经验（成功或反复失败的教训），用 2-3 句话总结。无则留空。
  isSimpleQuestion?: boolean;  // 可选。如果是简单事实性问题，可以直接回答，不需要进一步执行。
};

const CONTINUE_TEXT_PREFIX =
  '你在上一轮 reasoning.stop 自查中给出了下一步计划。';

function buildExecuteNextStepText(nextStep: string): string {
  return [
    CONTINUE_TEXT_PREFIX,
    `next_step: ${nextStep}`,
    '现在立即执行该 next_step，不要停止。',
    '如果你想停止，必须再次调用 reasoning.stop，并且只有在“任务已完成并给出 completion_evidence”或“已穷尽可行尝试且给出 cannot_complete_reason + blocking_evidence + attempts_exhausted=true”时才允许停止。'
  ].join('\n');
}

function buildInvalidReasoningStopPrompt(message: string): string {
  const reason = typeof message === 'string' && message.trim().length
    ? message.trim()
    : 'reasoning.stop 参数不合法。';
  return [
    '你刚刚调用的 reasoning.stop 未通过校验，不能据此停止。',
    `错误原因: ${reason}`,
    '请立即继续执行；如果后续仍要停止，必须重新调用 reasoning.stop，并补齐缺失字段。'
  ].join('\n');
}

function buildReasoningStopFollowupOps(promptText: string): Array<Record<string, unknown>> {
  return [
    { op: 'preserve_tools' },
    { op: 'ensure_standard_tools' },
    { op: 'append_assistant_message', required: true },
    { op: 'append_tool_messages_from_tool_outputs', required: true },
    { op: 'append_user_text', text: promptText }
  ];
}

function isIrrecoverablyBlockedStop(payload: ReasoningStopPayload): boolean {
  if (payload.completed) {
    return false;
  }
  if (payload.nextStep) {
    return false;
  }
  if (payload.attemptsExhausted !== true) {
    return false;
  }
  if (!payload.cannotCompleteReason || !payload.blockingEvidence) {
    return false;
  }
  if (payload.userInputRequired === true && !payload.userQuestion) {
    return false;
  }
  return true;
}

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function readBool(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
}

function readStopReason(record: Record<string, unknown>, keys: string[]): string | undefined {
  const raw = readText(record, keys).toLowerCase();
  if (!raw) {
    return undefined;
  }
  return VALID_STOP_REASONS.has(raw) ? raw : undefined;
}

function normalizeReasoningStopPayload(args: Record<string, unknown>): {
  ok: true;
  payload: ReasoningStopPayload;
} | {
  ok: false;
  code: string;
  message: string;
} {
  const taskGoal = readText(args, ['task_goal', 'taskGoal', 'goal']);
  if (!taskGoal) {
    return {
      ok: false,
      code: 'TASK_GOAL_REQUIRED',
      message: 'reasoning.stop requires task_goal.'
    };
  }
  const completed = readBool(args, ['is_completed', 'isCompleted', 'completed']);
  if (typeof completed !== 'boolean') {
    return {
      ok: false,
      code: 'IS_COMPLETED_REQUIRED',
      message: 'reasoning.stop requires is_completed(boolean).'
    };
  }
  const stopReason = readStopReason(args, ['stop_reason', 'stopReason', 'reason_type', 'reasonType']);
  const completionEvidence = readText(args, [
    'completion_evidence',
    'completionEvidence',
    'evidence'
  ]);
  const cannotCompleteReason = readText(args, [
    'cannot_complete_reason',
    'cannotCompleteReason',
    'reason'
  ]);
  const blockingEvidence = readText(args, [
    'blocking_evidence',
    'blockingEvidence',
    'block_evidence'
  ]);
  const attemptsExhausted = readBool(args, [
    'attempts_exhausted',
    'attemptsExhausted',
    'all_attempts_exhausted',
    'allAttemptsExhausted'
  ]);
  const nextStep = readText(args, [
    'next_step',
    'nextStep',
    'next_steps',
    'nextSteps',
    'plan_next_step',
    'next_plan'
  ]);
  const userInputRequired = readBool(args, [
    'user_input_required',
    'userInputRequired'
  ]);
  const userQuestion = readText(args, [
    'user_question',
    'userQuestion',
    'question_for_user',
    'questionForUser'
  ]);

  const learning = readText(args, [
    'learning',
    'experience',
    'insight',
    'lesson',
    'lesson_learned'
  ]);
  const isSimpleQuestion = readBool(args, [
    'is_simple_question',
    'isSimpleQuestion',
    'simple_question',
    'simpleQuestion'
  ]);

  if (completed && !completionEvidence) {
    return {
      ok: false,
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      message: 'reasoning.stop requires completion_evidence when is_completed=true.'
    };
  }
  if (completed && userInputRequired === true) {
    return {
      ok: false,
      code: 'USER_INPUT_CONFLICT_WITH_COMPLETED',
      message: 'reasoning.stop cannot set user_input_required=true when is_completed=true.'
    };
  }
  if (!completed && userInputRequired === true) {
    if (!cannotCompleteReason) {
      return {
        ok: false,
        code: 'CANNOT_COMPLETE_REASON_REQUIRED_FOR_USER_INPUT',
        message: 'reasoning.stop requires cannot_complete_reason when user_input_required=true.'
      };
    }
    if (!userQuestion) {
      return {
        ok: false,
        code: 'USER_QUESTION_REQUIRED',
        message: 'reasoning.stop requires user_question when user_input_required=true.'
      };
    }
  }
  if (!completed && userInputRequired !== true && !cannotCompleteReason && !nextStep) {
    return {
      ok: false,
      code: 'NEXT_STEP_OR_CANNOT_COMPLETE_REQUIRED',
      message: 'reasoning.stop requires next_step or cannot_complete_reason when is_completed=false.'
    };
  }
  if (!completed && cannotCompleteReason && !nextStep && attemptsExhausted !== true) {
    return {
      ok: false,
      code: 'ATTEMPTS_EXHAUSTED_REQUIRED',
      message: 'reasoning.stop requires attempts_exhausted=true when stopping with cannot_complete_reason.'
    };
  }
  if (!completed && cannotCompleteReason && !nextStep && !blockingEvidence) {
    return {
      ok: false,
      code: 'BLOCKING_EVIDENCE_REQUIRED',
      message: 'reasoning.stop requires blocking_evidence when stopping with cannot_complete_reason.'
    };
  }

  return {
    ok: true,
    payload: {
      taskGoal,
      completed,
      ...(stopReason ? { stopReason } : {}),
      completionEvidence,
      cannotCompleteReason,
      blockingEvidence,
      ...(typeof attemptsExhausted === 'boolean' ? { attemptsExhausted } : {}),
      nextStep,
      ...(typeof userInputRequired === 'boolean' ? { userInputRequired } : {}),
      userQuestion,
      ...(learning ? { learning } : {}),
      ...(typeof isSimpleQuestion === 'boolean' ? { isSimpleQuestion } : {})
    }
  };
}

function buildSummary(payload: ReasoningStopPayload): string {
  const lines = [
    `用户任务目标: ${payload.taskGoal}`,
    `是否完成: ${payload.completed ? '是' : '否'}`
  ];
  if (payload.stopReason) {
    lines.push(`停止原因: ${payload.stopReason}`);
  }
  if (payload.completed) {
    lines.push(`完成证据: ${payload.completionEvidence}`);
  } else {
    if (typeof payload.userInputRequired === 'boolean') {
      lines.push(`需用户参与: ${payload.userInputRequired ? '是' : '否'}`);
    }
    if (payload.userQuestion) {
      lines.push(`用户问题: ${payload.userQuestion}`);
    }
    if (payload.cannotCompleteReason) {
      if (typeof payload.attemptsExhausted === 'boolean') {
        lines.push(`已穷尽可行尝试: ${payload.attemptsExhausted ? '是' : '否'}`);
      }
      lines.push(`无法完成原因: ${payload.cannotCompleteReason}`);
      if (payload.blockingEvidence) {
        lines.push(`阻塞证据: ${payload.blockingEvidence}`);
      }
    }
    if (payload.nextStep) {
      lines.push(`下一步: ${payload.nextStep}`);
    }
  }
  if (payload.learning) {
    lines.push(`经验沉淀: ${payload.learning}`);
  }
  if (typeof payload.isSimpleQuestion === 'boolean') {
    lines.push(`是否简单问题: ${payload.isSimpleQuestion ? '是' : '否'}`);
  }
  return lines.join('\n');
}

function appendToolOutput(
  base: JsonObject,
  toolCall: ToolCall,
  content: JsonValue
): JsonObject {
  const cloned = cloneJson(base) as JsonObject;
  const existingOutputs = Array.isArray((cloned as any).tool_outputs)
    ? ((cloned as any).tool_outputs as JsonValue[])
    : [];
  let payloadText = '';
  try {
    payloadText = JSON.stringify(content);
  } catch {
    payloadText = String(content ?? '');
  }
  (cloned as any).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: TOOL_NAME,
      content: payloadText
    }
  ];
  return cloned;
}

const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== TOOL_NAME) {
    return null;
  }

  const parsed = parseToolArguments(toolCall);
  const normalized = normalizeReasoningStopPayload(parsed);

  if (normalized.ok === false) {
    return {
      flowId: FLOW_ID_CONTINUE,
      finalize: async () => ({
        chatResponse: appendToolOutput(ctx.base, toolCall, {
          ok: false,
          code: normalized.code,
          message: normalized.message
        }),
        execution: {
          flowId: FLOW_ID_CONTINUE,
          followup: {
            requestIdSuffix: ':reasoning_stop_continue',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: buildReasoningStopFollowupOps(buildInvalidReasoningStopPrompt(normalized.message))
            },
            metadata: {
              clientInjectSource: 'servertool.reasoning_stop_continue'
            }
          }
        }
      })
    };
  }

  const payload = normalized.payload;
  const summary = buildSummary(payload);
  const blockedStop = isIrrecoverablyBlockedStop(payload);

  if (payload.completed === true || blockedStop || payload.isSimpleQuestion === true) {
    return {
      flowId: FLOW_ID_FINALIZE,
      finalize: async () => {
        clearReasoningStopState(ctx.adapterContext);
        resetReasoningStopFailCount(ctx.adapterContext);
        return {
          chatResponse: appendReasoningStopSummaryToChatResponse(ctx.base, summary),
          execution: {
            flowId: FLOW_ID_FINALIZE,
            context: {
              reasoning_stop: {
                finalized: true,
                completed: payload.completed === true,
                ...(blockedStop ? { blocked: true, attempts_exhausted: true } : {}),
                ...(payload.userInputRequired === true ? { user_input_required: true } : {}),
                ...(payload.isSimpleQuestion === true ? { simple_question: true } : {})
              }
            }
          }
        };
      }
    };
  }

  const armed = armReasoningStopState(ctx.adapterContext, summary);
  const continuePrompt = payload.nextStep
    ? buildExecuteNextStepText(payload.nextStep)
    : buildInvalidReasoningStopPrompt(
        'reasoning.stop 尚未满足允许停止的条件；请继续执行，或在满足条件后再调用 reasoning.stop。'
      );
  return {
    flowId: FLOW_ID_CONTINUE,
    finalize: async () => ({
      chatResponse: appendToolOutput(ctx.base, toolCall, {
        ok: true,
        armed,
        summary
      }),
      execution: {
        flowId: FLOW_ID_CONTINUE,
        followup: {
          requestIdSuffix: ':reasoning_stop_continue',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: buildReasoningStopFollowupOps(continuePrompt)
          },
          metadata: {
            clientInjectSource: 'servertool.reasoning_stop_continue'
          }
        }
      }
    })
  };
};

registerServerToolHandler(TOOL_NAME, handler);

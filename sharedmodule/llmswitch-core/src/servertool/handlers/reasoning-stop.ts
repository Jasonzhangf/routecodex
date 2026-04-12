import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { armReasoningStopState, readReasoningStopMode, type ReasoningStopMode } from './reasoning-stop-state.js';

const FLOW_ID = 'reasoning_stop_flow';
const TOOL_NAME = 'reasoning.stop';

type ReasoningStopPayload = {
  taskGoal: string;
  completed: boolean;
  completionEvidence: string;
  cannotCompleteReason: string;
  blockingEvidence: string;
  attemptsExhausted?: boolean;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
  learning?: string;  // 可选。如果本轮任务有值得沉淀的经验（成功或反复失败的教训），用 2-3 句话总结。无则留空。
};

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

function normalizeReasoningStopPayload(args: Record<string, unknown>, mode: ReasoningStopMode): {
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
    if (mode === 'endless') {
      return {
        ok: false,
        code: 'USER_INPUT_NOT_ALLOWED_IN_ENDLESS',
        message: 'reasoning.stop in stopless:endless mode cannot stop for user_input_required=true.'
      };
    }
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
  if (!completed && userInputRequired !== true && cannotCompleteReason && !nextStep && attemptsExhausted !== true) {
    return {
      ok: false,
      code: 'ATTEMPTS_EXHAUSTED_REQUIRED',
      message: 'reasoning.stop requires attempts_exhausted=true when stopping with cannot_complete_reason.'
    };
  }
  if (!completed && userInputRequired !== true && cannotCompleteReason && !nextStep && !blockingEvidence) {
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
      completionEvidence,
      cannotCompleteReason,
      blockingEvidence,
      ...(typeof attemptsExhausted === 'boolean' ? { attemptsExhausted } : {}),
      nextStep,
      ...(typeof userInputRequired === 'boolean' ? { userInputRequired } : {}),
      userQuestion,
      ...(learning ? { learning } : {})
    }
  };
}

function buildSummary(payload: ReasoningStopPayload): string {
  const lines = [
    `用户任务目标: ${payload.taskGoal}`,
    `是否完成: ${payload.completed ? '是' : '否'}`
  ];
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
  const mode = readReasoningStopMode(ctx.adapterContext, 'on');
  const normalized = normalizeReasoningStopPayload(parsed, mode);

  if (normalized.ok === false) {
    return {
      flowId: FLOW_ID,
      finalize: async () => ({
        chatResponse: appendToolOutput(ctx.base, toolCall, {
          ok: false,
          code: normalized.code,
          message: normalized.message
        }),
        execution: {
          flowId: FLOW_ID
        }
      })
    };
  }

  const summary = buildSummary(normalized.payload);
  const armed = armReasoningStopState(ctx.adapterContext, summary);
  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: appendToolOutput(ctx.base, toolCall, {
        ok: true,
        armed,
        summary
      }),
      execution: {
        flowId: FLOW_ID
      }
    })
  };
};

registerServerToolHandler(TOOL_NAME, handler);

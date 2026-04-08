import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { armReasoningStopState } from './reasoning-stop-state.js';

const FLOW_ID = 'reasoning_stop_flow';
const TOOL_NAME = 'reasoning.stop';

type ReasoningStopPayload = {
  taskGoal: string;
  completed: boolean;
  completionEvidence: string;
  cannotCompleteReason: string;
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

  if (completed && !completionEvidence) {
    return {
      ok: false,
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      message: 'reasoning.stop requires completion_evidence when is_completed=true.'
    };
  }
  if (!completed && !cannotCompleteReason) {
    return {
      ok: false,
      code: 'CANNOT_COMPLETE_REASON_REQUIRED',
      message: 'reasoning.stop requires cannot_complete_reason when is_completed=false.'
    };
  }

  return {
    ok: true,
    payload: {
      taskGoal,
      completed,
      completionEvidence,
      cannotCompleteReason
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
    lines.push(`无法完成原因: ${payload.cannotCompleteReason}`);
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

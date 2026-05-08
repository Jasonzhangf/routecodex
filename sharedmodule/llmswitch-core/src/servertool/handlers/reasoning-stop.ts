import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { appendToolOutput as coreAppendToolOutput } from '../orchestration-blocks.js';
import {
  armReasoningStopState,
  clearReasoningStopState,
  resetReasoningStopFailCount
} from './reasoning-stop-state.js';
import { appendReasoningStopSummaryToChatResponse } from './reasoning-stop-guard-blocks.js';
import {
  normalizeReasoningStopPayload
} from './reasoning-stop-payload-normalizer.js';
import {
  buildReasoningStopSummary
} from './reasoning-stop-summary-codec.js';
import {
  isIrrecoverablyBlockedStop
} from './reasoning-stop-validator.js';
import {
  buildExecuteNextStepText,
  buildInvalidReasoningStopPrompt,
  buildReasoningStopFollowupOps
} from './reasoning-stop-followup-block.js';

const FLOW_ID = 'reasoning_stop_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const TOOL_NAME = 'reasoning.stop';

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function appendToolOutput(
  base: JsonObject,
  toolCall: ToolCall,
  content: JsonValue
): JsonObject {
  const cloned = cloneJson(base) as JsonObject;
  coreAppendToolOutput(cloned, toolCall.id, TOOL_NAME, JSON.stringify(content));
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
  const summary = buildReasoningStopSummary(payload);
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

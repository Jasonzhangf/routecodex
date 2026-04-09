import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { cloneJson } from '../server-side-tools.js';
import {
  type ReasoningStopMode,
  clearReasoningStopState,
  readReasoningStopState,
  syncReasoningStopModeFromRequest
} from './reasoning-stop-state.js';
import { extractStopMessageAutoResponseSnapshot } from './stop-message-auto/ai-followup.js';
import { stripReasoningTransportNoise } from '../../conversion/shared/reasoning-normalizer.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';

const FLOW_ID_GUARD = 'reasoning_stop_guard_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const HOOK_ID = 'reasoning_stop_guard';

const ENDLESS_CONTINUE_TEXT =
  '你当前处于 stopless:endless 模式。当前任务未完成，禁止直接停止。你必须先调用 reasoning.stop 做停止自检。只允许两种真实停止条件：1) 已完成用户任务，并给出 completion_evidence；2) 已尝试完所有可行路径且仍被阻塞，并给出 cannot_complete_reason + blocking_evidence（并声明 attempts_exhausted=true）。若仍有任何可执行下一步，必须填写 next_step 并继续执行，不得停止。';

const ON_CONTINUE_TEXT =
  '请尽量自行继续完成当前任务。若仍有可执行下一步，请先执行，不要直接停止。仅当你明确需要用户参与（例如高风险选择、关键信息缺失且无法自行确认）时，才调用 reasoning.stop，并在参数中提供 user_input_required=true 与 user_question。';

function parseReasoningStopSummary(summary: string): {
  completed?: boolean;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
} {
  const normalized = typeof summary === 'string' ? summary.trim() : '';
  if (!normalized) {
    return { nextStep: '', userQuestion: '' };
  }
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  let completed: boolean | undefined;
  let nextStep = '';
  let userInputRequired: boolean | undefined;
  let userQuestion = '';
  for (const line of lines) {
    if (line.startsWith('是否完成:')) {
      const value = line.slice('是否完成:'.length).trim();
      if (value === '是') {
        completed = true;
      } else if (value === '否') {
        completed = false;
      }
      continue;
    }
    if (line.startsWith('下一步:')) {
      nextStep = line.slice('下一步:'.length).trim();
      continue;
    }
    if (line.startsWith('需用户参与:')) {
      const value = line.slice('需用户参与:'.length).trim();
      if (value === '是') {
        userInputRequired = true;
      } else if (value === '否') {
        userInputRequired = false;
      }
      continue;
    }
    if (line.startsWith('用户问题:')) {
      userQuestion = line.slice('用户问题:'.length).trim();
      continue;
    }
  }
  return { completed, nextStep, userInputRequired, userQuestion };
}

function buildExecuteNextStepText(nextStep: string): string {
  return [
    '你在上一轮 reasoning.stop 自查中给出了下一步计划。',
    `next_step: ${nextStep}`,
    '现在立即执行该 next_step，不要停止。',
    '只有满足以下任一条件才允许停止：A) 已完成任务并提供 completion_evidence；B) 已尝试完所有可行路径且阻塞，并提供 cannot_complete_reason + blocking_evidence（attempts_exhausted=true）。'
  ].join('\n');
}

function resolveGuardPromptByMode(mode: ReasoningStopMode): string {
  return mode === 'endless' ? ENDLESS_CONTINUE_TEXT : ON_CONTINUE_TEXT;
}

function isReasoningStopGuardEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED ?? '').trim().toLowerCase();
  if (!raw) {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return true;
}

function shouldSkipGuardForReasoningOnlyResponse(base: JsonObject, adapterContext: unknown): boolean {
  const snapshot = extractStopMessageAutoResponseSnapshot(base, adapterContext);
  const assistantText = typeof snapshot.assistantText === 'string' ? snapshot.assistantText : '';
  const reasoningText = typeof snapshot.reasoningText === 'string' ? snapshot.reasoningText : '';
  const normalizedAssistant = stripReasoningTransportNoise(assistantText);
  return normalizedAssistant.trim().length === 0 && reasoningText.trim().length > 0;
}

function shouldDeferToStopMessageAuto(adapterContext: unknown): boolean {
  const stopCompare = readStopMessageCompareContext(adapterContext);
  if (!stopCompare) {
    return false;
  }
  // stop_message_auto owns all armed sessions (including mode=off and transitional skip states),
  // so reasoning.stop guard must not override its legacy semantics.
  return stopCompare.armed === true;
}

function appendReasoningStopSummaryToChatResponse(base: JsonObject, summary: string): JsonObject {
  const normalizedSummary = typeof summary === 'string' ? summary.trim() : '';
  if (!normalizedSummary) {
    return base;
  }
  const cloned = cloneJson(base) as JsonObject;
  const block = `[reasoning.stop]\n${normalizedSummary}`;
  const choices = Array.isArray((cloned as any).choices) ? ((cloned as any).choices as unknown[]) : [];
  if (choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const message =
        (first as Record<string, unknown>).message &&
        typeof (first as Record<string, unknown>).message === 'object' &&
        !Array.isArray((first as Record<string, unknown>).message)
          ? ((first as Record<string, unknown>).message as Record<string, unknown>)
          : null;
      if (message) {
        const rawContent = typeof message.content === 'string' ? message.content.trim() : '';
        message.content = rawContent ? `${rawContent}\n\n${block}` : block;
        return cloned;
      }
    }
  }
  const outputText = typeof (cloned as any).output_text === 'string' ? String((cloned as any).output_text).trim() : '';
  (cloned as any).output_text = outputText ? `${outputText}\n\n${block}` : block;
  return cloned;
}

const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  if (!isReasoningStopGuardEnabled()) {
    return null;
  }
  const stoplessMode = syncReasoningStopModeFromRequest(ctx.adapterContext);
  if (stoplessMode === 'off') {
    return null;
  }
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldSkipGuardForReasoningOnlyResponse(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldDeferToStopMessageAuto(ctx.adapterContext)) {
    return null;
  }
  const stopState = readReasoningStopState(ctx.adapterContext);
  if (!stopState.armed) {
    return {
      flowId: FLOW_ID_GUARD,
      finalize: async () => ({
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID_GUARD,
          followup: {
            requestIdSuffix: ':reasoning_stop_guard',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: [
                { op: 'preserve_tools' },
                { op: 'ensure_standard_tools' },
                { op: 'append_assistant_message', required: false },
                { op: 'append_user_text', text: resolveGuardPromptByMode(stoplessMode) }
              ]
            },
            metadata: {
              clientInjectSource: 'servertool.reasoning_stop_guard'
            }
          }
        }
      })
    };
  }

  return {
    flowId: FLOW_ID_FINALIZE,
    finalize: async () => {
      const parsed = parseReasoningStopSummary(stopState.summary);
      if (
        stoplessMode === 'on' &&
        parsed.completed === false &&
        parsed.userInputRequired === true &&
        parsed.userQuestion
      ) {
        const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
        clearReasoningStopState(ctx.adapterContext);
        return {
          chatResponse: patched,
          execution: {
            flowId: FLOW_ID_FINALIZE,
            context: {
              reasoning_stop: {
                finalized: true,
                user_input_required: true
              }
            }
          }
        };
      }
      if (parsed.completed === false && parsed.nextStep) {
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_CONTINUE,
            followup: {
              requestIdSuffix: ':reasoning_stop_continue',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: [
                  { op: 'preserve_tools' },
                  { op: 'ensure_standard_tools' },
                  { op: 'append_assistant_message', required: false },
                  { op: 'append_user_text', text: buildExecuteNextStepText(parsed.nextStep) }
                ]
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_continue'
              }
            }
          }
        };
      }
      const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
      clearReasoningStopState(ctx.adapterContext);
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID_FINALIZE,
          context: {
            reasoning_stop: {
              finalized: true
            }
          }
        }
      };
    }
  };
};

registerServerToolHandler(HOOK_ID, handler, {
  trigger: 'auto',
  hook: {
    phase: 'post',
    priority: 160
  }
});

import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { cloneJson } from '../server-side-tools.js';
import {
  type ReasoningStopMode,
  clearReasoningStopState,
  readReasoningStopState,
  readReasoningStopFailCount,
  incrementReasoningStopFailCount,
  resetReasoningStopFailCount,
  readReasoningStopGuardTriggerCount,
  incrementReasoningStopGuardTriggerCount,
  resetReasoningStopGuardTriggerCount,
  syncReasoningStopModeFromRequest
} from './reasoning-stop-state.js';
import { appendLearningToMemory } from './memory-appender.js';
import { extractStopMessageAutoResponseSnapshot } from './stop-message-auto/ai-followup.js';
import { stripReasoningTransportNoise } from '../../conversion/shared/reasoning-normalizer.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';

const FLOW_ID_GUARD = 'reasoning_stop_guard_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const HOOK_ID = 'reasoning_stop_guard';
const ON_MODE_MAX_FAIL_COUNT = 5;
const GUARD_MAX_TRIGGER_COUNT = 3; // Storm protection: max guard triggers before auto-pass
const GUARD_TRIGGER_WINDOW_MS = 10000; // 10 seconds window for storm detection

const ON_CONTINUE_TEXT =
  '禁止直接停止。你当前处于 reasoning.stop 模式。每次停止前必须调用 reasoning.stop 工具并提供以下信息：\n' +
  '- 是否完成: 是/否\n' +
  '- 完成证据(completion_evidence): 如果任务完成，提供具体证据\n' +
  '- 未完成原因(cannot_complete_reason): 如果未完成，说明为什么\n' +
  '- 阻塞证据(blocking_evidence): 如果被阻塞，提供具体阻塞点\n' +
  '- 下一步(next_step): 你计划的下一步行动（如果有）\n' +
  '- 需用户参与(user_input_required): 是否需要用户参与才能继续\n' +
  '- 用户问题(user_question): 如果需要用户参与，具体问什么\n' +
  '你现在立即继续执行，不要停止。';

const ENDLESS_CONTINUE_TEXT =
  '绝对禁止停止。你当前处于 stopless:endless 模式。在任何情况下都不允许停止，除非满足以下唯一条件：\n' +
  '你已经穷尽所有可能的尝试路径，仍然无法解决阻塞问题，并且确定必须用户参与才能继续。\n' +
  '你必须满足以下全部条件才能停止：\n' +
  '1. next_step 必须为空——你已经没有任何可执行的下一步\n' +
  '2. attempts_exhausted=true——你已经尝试了所有可行路径\n' +
  '3. cannot_complete_reason——明确说明为什么无法完成\n' +
  '4. blocking_evidence——提供具体的阻塞证据\n' +
  '5. user_input_required=true——必须用户参与\n' +
  '6. user_question——向用户提出具体问题\n' +
  '只要还有任何可执行的 next_step，你就必须继续执行，不得停止。\n' +
  '你现在立即继续执行，绝对不要停止。';

function parseReasoningStopSummary(summary: string): {
  completed?: boolean;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
  attemptsExhausted?: boolean;
  learning?: string;
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
  let attemptsExhausted: boolean | undefined;
  let learning = '';
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
    if (line.startsWith('穷尽所有尝试:')) {
      const value = line.slice('穷尽所有尝试:'.length).trim();
      if (value === '是') {
        attemptsExhausted = true;
      } else if (value === '否') {
        attemptsExhausted = false;
      }
      continue;
    if (line.startsWith('经验沉淀:')) {
      learning = line.slice('经验沉淀:'.length).trim();
      continue;
    }
    }
  }
  return { completed, nextStep, userInputRequired, userQuestion, attemptsExhausted, learning };
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

const REASONING_STOP_TOOL_DEF: JsonObject = {
  type: 'function',
  function: {
    name: 'reasoning.stop',
    description:
      'Structured stop self-check gate. Stop is allowed only when either: (A) task is completed with completion_evidence; or (B) all feasible attempts are exhausted and blocked, with cannot_complete_reason + blocking_evidence + attempts_exhausted=true. Required: task_goal, is_completed. If not completed but a concrete next action exists, fill next_step and continue instead of stopping.',
    parameters: {
      type: 'object',
      properties: {
        task_goal: { type: 'string' },
        is_completed: { type: 'boolean' },
        completion_evidence: { type: 'string' },
        cannot_complete_reason: { type: 'string' },
        blocking_evidence: { type: 'string' },
        attempts_exhausted: { type: 'boolean' },
        next_step: { type: 'string' }
      },
      required: ['task_goal', 'is_completed'],
      additionalProperties: false
    }
  }
} as unknown as JsonObject;

function isReasoningStopGuardEnabled(): boolean {
  const envValue = process.env.LLMSWITCHCORE_REASONING_STOP_GUARD_ENABLED;
  if (envValue === '0' || envValue === 'false') {
    return false;
  }
  return true;
}

function shouldSkipGuardForReasoningOnlyResponse(base: JsonObject, adapterContext: unknown): boolean {
  const choices = Array.isArray((base as any).choices) ? ((base as any).choices as unknown[]) : [];
  if (choices.length === 0) {
    return false;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return false;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string' && content.trim() === '') {
    return true;
  }
  return false;
}

function shouldDeferToStopMessageAuto(adapterContext: unknown): boolean {
  const stopCompare = readStopMessageCompareContext(adapterContext);
  if (!stopCompare) {
    return false;
  }
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
  // Storm protection: check if guard triggered too many times within window
  const { count: guardTriggerCount, lastTriggerAt: lastGuardTriggerAt } = readReasoningStopGuardTriggerCount(ctx.adapterContext);
  const now = Date.now();
  if (guardTriggerCount >= GUARD_MAX_TRIGGER_COUNT) {
    if (lastGuardTriggerAt && (now - lastGuardTriggerAt) < GUARD_TRIGGER_WINDOW_MS) {
      // Storm detected: reset counter and pass through to prevent infinite loop
      resetReasoningStopGuardTriggerCount(ctx.adapterContext);
      return null;
    }
    // Outside window: reset counter
    resetReasoningStopGuardTriggerCount(ctx.adapterContext);
  }
  // Increment guard trigger count
  incrementReasoningStopGuardTriggerCount(ctx.adapterContext);
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
      
      if (stoplessMode === 'on') {
        const failCount = readReasoningStopFailCount(ctx.adapterContext);
        if (failCount >= ON_MODE_MAX_FAIL_COUNT) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  fail_count_exceeded: true
                }
              }
            }
          };
        }
        
        if (parsed.completed === true) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);

          if (parsed.learning) {
            try {
              appendLearningToMemory({ learning: parsed.learning, cwd: process.cwd() });
            } catch (e) {
              console.error("[reasoning-stop-guard] failed to append learning:", e);
            }
          }
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  completed: true
                }
              }
            }
          };
        }
        
        if (parsed.completed === false && parsed.userInputRequired === true && parsed.userQuestion) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);
          resetReasoningStopFailCount(ctx.adapterContext);
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
          incrementReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: ctx.base,
            execution: {
              flowId: FLOW_ID_CONTINUE,
              followup: {
                requestIdSuffix: ':reasoning_stop_continue',
                entryEndpoint: ctx.entryEndpoint,
                injection: {
                  ops: [
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
        
        incrementReasoningStopFailCount(ctx.adapterContext);
        const newFailCount = readReasoningStopFailCount(ctx.adapterContext);
        if (newFailCount >= ON_MODE_MAX_FAIL_COUNT) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  fail_count_exceeded: true
                }
              }
            }
          };
        }
        
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_GUARD,
            followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: [
                  { op: 'append_assistant_message', required: false },
                  { op: 'append_user_text', text: ON_CONTINUE_TEXT }
                ]
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
            }
          }
        };
      }
      
      if (stoplessMode === 'endless') {
        if (parsed.completed === true) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  completed: true
                }
              }
            }
          };
        }
        
        if (!parsed.nextStep && parsed.attemptsExhausted === true && parsed.userInputRequired === true && parsed.userQuestion) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, stopState.summary);
          clearReasoningStopState(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  attempts_exhausted: true,
                  user_input_required: true
                }
              }
            }
          };
        }
        
        if (parsed.nextStep) {
          return {
            chatResponse: ctx.base,
            execution: {
              flowId: FLOW_ID_CONTINUE,
              followup: {
                requestIdSuffix: ':reasoning_stop_continue',
                entryEndpoint: ctx.entryEndpoint,
                injection: {
                  ops: [
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
        
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_GUARD,
            followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: [
                  { op: 'append_assistant_message', required: false },
                  { op: 'append_user_text', text: ENDLESS_CONTINUE_TEXT }
                ]
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
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

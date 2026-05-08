import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
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
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { appendLearningToMemory } from './memory-appender.js';
import { extractStopMessageAutoResponseSnapshot } from './stop-message-auto/ai-followup.js';
import { stripReasoningTransportNoise } from '../../conversion/shared/reasoning-normalizer.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  isIrrecoverablyBlockedStop,
  isValidCompletedStop,
} from './reasoning-stop-validator.js';
import {
  parseReasoningStopSummary
} from './reasoning-stop-summary-codec.js';
import {
  buildExecuteNextStepText,
  buildReasoningStopFollowupOps,
  ENDLESS_CONTINUE_TEXT,
  ON_CONTINUE_TEXT,
  resolveGuardPromptByMode
} from './reasoning-stop-followup-block.js';
import {
  appendReasoningStopSummaryToChatResponse,
  extractEmbeddedReasoningStopSummary,
  isReasoningStopGuardEnabled,
  logReasoningStopFinalizedMarker,
  readFollowupClientInjectSource,
  shouldDeferToStopMessageAuto,
  shouldSkipGuardForReasoningOnlyResponse
} from './reasoning-stop-guard-blocks.js';
export { appendReasoningStopSummaryToChatResponse } from './reasoning-stop-guard-blocks.js';

const FLOW_ID_GUARD = 'reasoning_stop_guard_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const HOOK_ID = 'reasoning_stop_guard';
const ON_MODE_MAX_FAIL_COUNT = 5;
const GUARD_MAX_TRIGGER_COUNT = 3; // Storm protection: max guard triggers before auto-pass
const GUARD_TRIGGER_WINDOW_MS = 10000; // 10 seconds window for storm detection
  const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  if (!isReasoningStopGuardEnabled()) {
    return null;
  }
  // Most servertool followups should bypass this guard to avoid recursion.
  // But reasoning_stop_guard / reasoning_stop_continue followups must re-enter
  // the guard/finalize logic; otherwise a second plain stop on the followup hop
  // is silently accepted as success.
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const followupSource = readFollowupClientInjectSource(ctx.adapterContext);
  const allowReasoningStopFollowupReentry =
    followupSource === 'servertool.reasoning_stop_guard'
    || followupSource === 'servertool.reasoning_stop_continue';
  if ((rt as Record<string, unknown>)?.serverToolFollowup === true && !allowReasoningStopFollowupReentry) {
    return null;
  }

  const stoplessMode = syncReasoningStopModeFromRequest(ctx.adapterContext);
  if (stoplessMode === 'off') {
    return null;
  }
  // Storm protection: check if guard triggered too many times within GUARD_TRIGGER_WINDOW_MS
  const { count: guardTriggerCount, lastTriggerAt: lastGuardTriggerAt } = readReasoningStopGuardTriggerCount(ctx.adapterContext);
  const now = Date.now();
  const isWithinWindow = typeof lastGuardTriggerAt === 'number'
    && now - lastGuardTriggerAt <= GUARD_TRIGGER_WINDOW_MS;

  if (isWithinWindow && guardTriggerCount >= GUARD_MAX_TRIGGER_COUNT) {
    // Storm detected: reset counters and skip guard to avoid endless re-trigger
    resetReasoningStopGuardTriggerCount(ctx.adapterContext);
    return null;
  }
  // Outside window: reset count before incrementing to implement natural decay.
  // Without this, consecutive triggers outside the window accumulate (e.g., 2 outside + 1 inside = 3)
  // and falsely trigger the storm guard on the first eligible call within the window.
  if (!isWithinWindow && guardTriggerCount > 0) {
    resetReasoningStopGuardTriggerCount(ctx.adapterContext);
  }
  incrementReasoningStopGuardTriggerCount(ctx.adapterContext);
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldSkipGuardForReasoningOnlyResponse(ctx.base)) {
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
              ops: buildReasoningStopFollowupOps(resolveGuardPromptByMode(stoplessMode))
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
      const freshSummary = extractEmbeddedReasoningStopSummary(ctx.base);
      const summary = freshSummary || stopState.summary;
      const parsed = parseReasoningStopSummary(summary);
      const canFinalizeCurrentTurn =
        !allowReasoningStopFollowupReentry || freshSummary.length > 0;
      
      if (stoplessMode === 'on') {
       if (canFinalizeCurrentTurn && isValidCompletedStop(parsed)) {
          // Allow stop for simple questions
          if (parsed.isSimpleQuestion === true) {
            const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
            logReasoningStopFinalizedMarker({
              requestId: ctx.requestId,
              mode: stoplessMode,
              summary,
              reason: 'simple_question'
            });
            clearReasoningStopState(ctx.adapterContext);
            resetReasoningStopFailCount(ctx.adapterContext);
            return {
              chatResponse: patched,
              execution: {
                flowId: FLOW_ID_FINALIZE,
                context: {
                  reasoning_stop: {
                    finalized: true,
                    simple_question: true
                  }
                }
              }
            };
          }
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'completed'
          });
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
        
        if (canFinalizeCurrentTurn && parsed.completed === false && isIrrecoverablyBlockedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'blocked'
          });
          clearReasoningStopState(ctx.adapterContext);
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  attempts_exhausted: true,
                  blocked: true,
                  ...(parsed.userInputRequired === true ? { user_input_required: true } : {})
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
                  ops: buildReasoningStopFollowupOps(buildExecuteNextStepText(parsed.nextStep))
                },
                metadata: {
                  clientInjectSource: 'servertool.reasoning_stop_continue'
                }
              }
            }
          };
        }
        
        incrementReasoningStopFailCount(ctx.adapterContext);
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_GUARD,
            followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: buildReasoningStopFollowupOps(ON_CONTINUE_TEXT)
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
            }
          }
        };
      }
      
      if (stoplessMode === 'endless') {
        if (canFinalizeCurrentTurn && isValidCompletedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'completed'
          });
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
        
        if (canFinalizeCurrentTurn && isIrrecoverablyBlockedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'blocked'
          });
          clearReasoningStopState(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  attempts_exhausted: true,
                  blocked: true,
                  ...(parsed.userInputRequired === true ? { user_input_required: true } : {})
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
                  ops: buildReasoningStopFollowupOps(buildExecuteNextStepText(parsed.nextStep))
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
                ops: buildReasoningStopFollowupOps(ENDLESS_CONTINUE_TEXT)
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
            }
          }
        };
      }
      
      const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
      logReasoningStopFinalizedMarker({
        requestId: ctx.requestId,
        mode: stoplessMode,
        summary,
        reason: 'finalized_fallback'
      });
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

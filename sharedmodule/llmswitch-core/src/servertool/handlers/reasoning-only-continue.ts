import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { extractStopMessageAutoResponseSnapshot } from './stop-message-auto/iflow-followup.js';
import { stripReasoningTransportNoise } from '../../conversion/shared/reasoning-normalizer.js';

const FLOW_ID = 'reasoning_only_continue_flow';
const HOOK_ID = 'reasoning_only_continue';

const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }
  const snapshot = extractStopMessageAutoResponseSnapshot(ctx.base, ctx.adapterContext);
  const assistantText = typeof snapshot.assistantText === 'string' ? snapshot.assistantText : '';
  const reasoningText = typeof snapshot.reasoningText === 'string' ? snapshot.reasoningText : '';
  const normalizedAssistant = stripReasoningTransportNoise(assistantText);
  if (normalizedAssistant.trim().length > 0) {
    return null;
  }
  if (!reasoningText.trim()) {
    return null;
  }

  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        context: {
          reasoning_only_continue: {
            assistantEmpty: true
          }
        },
        followup: {
          requestIdSuffix: ':reasoning_only_continue',
          entryEndpoint: ctx.entryEndpoint,
          metadata: {
            clientInjectOnly: true,
            clientInjectText: '继续执行',
            clientInjectSource: 'servertool.reasoning_only_continue'
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
    priority: 200
  }
});


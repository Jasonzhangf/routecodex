import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';
import { readStoplessGoalState } from './stopless-goal-state.js';

const FLOW_ID = 'stopless_goal_continue_flow';
const HOOK_ID = 'stopless_goal_guard';
const FOLLOWUP_SOURCE = 'servertool.stopless_goal_continue';

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
    return '继续执行当前目标。';
  }
  const objective = goal.objective.trim();
  const latestNote = typeof goal.latestNote === 'string' ? goal.latestNote.trim() : '';
  const lines = ['继续执行当前目标，不要在这里停止。'];
  if (objective) {
    lines.push(`目标：${objective}`);
  }
  if (latestNote) {
    lines.push(`最新说明：${latestNote}`);
  }
  return lines.join('\n');
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
  if (!goalState || goalState.status !== 'active') {
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
              { op: 'append_assistant_message', required: false },
              { op: 'append_user_text', text: buildStoplessGoalContinueText(ctx.adapterContext) }
            ]
          },
          metadata: {
            clientInjectSource: FOLLOWUP_SOURCE
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
    priority: 150
  }
});

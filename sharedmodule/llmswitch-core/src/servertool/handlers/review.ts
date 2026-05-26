import type { JsonObject, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import {
  renderStopMessageAutoFollowupViaAiAsync,
  resolveStopMessageAiApprovedMarker
} from './stop-message-auto/ai-followup.js';
import {
  buildReviewFollowupPayload,
  buildReviewFollowupText,
  extractLatestUserRequestText,
  injectReviewToolOutput,
  parseReviewToolArguments,
  resolveReviewWorkingDirectory
} from './review-pure-blocks.js';
import { sanitizeFollowupText } from './followup-sanitize.js';

const FLOW_ID = 'review_flow';
const TOOL_NAME = 'review';

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function shouldRunReviewAiFollowup(): boolean {
  return isTruthyFlag(process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED);
}

async function maybeRenderReviewAiFollowup(args: {
  goal?: string;
  focus?: string;
  requestText?: string;
  requestId: string;
  sessionId?: string;
  providerKey?: string;
  model?: string;
  workingDirectory?: string;
}): Promise<string | null> {
  if (!shouldRunReviewAiFollowup()) {
    return null;
  }
  const text = await renderStopMessageAutoFollowupViaAiAsync({
    baseStopMessageText: args.goal ?? args.requestText ?? '执行 review',
    candidateFollowupText: [
      '请先做严格代码 review。',
      args.focus ? `重点检查：${args.focus}` : '',
      args.requestText ? `原始请求：${args.requestText}` : ''
    ].filter(Boolean).join('\n'),
    responseSnapshot: {
      providerProtocol: 'review-followup',
      finishReason: 'tool_calls',
      assistantText: args.requestText ?? args.goal ?? '执行 review',
      responseExcerpt: args.focus ?? ''
    },
    requestId: args.requestId,
    sessionId: args.sessionId,
    providerKey: args.providerKey,
    model: args.model,
    workingDirectory: args.workingDirectory,
    usedRepeats: 0,
    maxRepeats: 1,
    approvedMarker: resolveStopMessageAiApprovedMarker(),
    completionClaimed: false,
    isFirstPrompt: true
  });
  return sanitizeFollowupText(text);
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== TOOL_NAME) {
    return null;
  }

  return {
    flowId: FLOW_ID,
    finalize: async () => {
      const parsedArgs = parseReviewToolArguments(toolCall);
      const workdir = resolveReviewWorkingDirectory(parsedArgs, ctx.adapterContext);
      const seed = extractCapturedChatSeed((ctx.adapterContext as Record<string, unknown>)?.capturedChatRequest);
      const requestText = extractLatestUserRequestText(seed);
      const aiSuggestion = await maybeRenderReviewAiFollowup({
        goal: parsedArgs.goal,
        focus: parsedArgs.focus,
        requestText,
        requestId: ctx.requestId,
        sessionId: typeof (ctx.adapterContext as Record<string, unknown>)?.sessionId === 'string'
          ? String((ctx.adapterContext as Record<string, unknown>).sessionId)
          : undefined,
        providerKey: typeof (ctx.adapterContext as Record<string, unknown>)?.providerKey === 'string'
          ? String((ctx.adapterContext as Record<string, unknown>).providerKey)
          : undefined,
        model: typeof seed?.model === 'string'
          ? seed.model
          : typeof (ctx.base as Record<string, unknown>)?.model === 'string'
            ? String((ctx.base as Record<string, unknown>).model)
            : undefined,
        workingDirectory: workdir
      });
      const followupText = buildReviewFollowupText({
        goal: parsedArgs.goal,
        focus: parsedArgs.focus,
        requestText,
        aiSuggestion
      });
      const payload = buildReviewFollowupPayload({
        seed,
        followupText
      });
      const patched = injectReviewToolOutput({
        base: ctx.base,
        toolCall,
        workdir
      });
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':review_followup',
            entryEndpoint: ctx.entryEndpoint,
            payload,
            metadata: {
              clientInjectSource: 'servertool.review',
              ...(workdir ? { workdir, cwd: workdir, workingDirectory: workdir } : {})
            } as JsonObject
          }
        }
      };
    }
  };
};

registerServerToolHandler(TOOL_NAME, handler);

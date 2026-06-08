import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ServerToolBackendPlan, ServerToolBackendResult, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { bindServertoolContractWithNative, cloneJson, extractTextFromChatLike } from '../server-side-tools.js';
import { extractCapturedChatSeed } from '../backend-route-seed.js';
import { reenterServerToolBackend } from '../backend-route-backend.js';
import { shouldRunVisionFlowForAdapterContext } from './vision-eligibility.js';
import {
  visionBuildAnalysisPayloadWithNative,
  visionBuildPinnedMetadataWithNative,
  visionExtractOriginalUserPromptWithNative
} from '../../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { planServertoolBackendRoutePolicyWithNative } from '../../native/router-hotpath/native-servertool-core-semantics.js';

const FLOW_ID = 'vision_flow';
const VISION_SYSTEM_PROMPT = bindServertoolContractWithNative(
  '你现在的任务只是描述图片内容，不要回答用户问题，不要提供建议，不要推理求解，不要做工具规划。用户提示词只用于帮助你理解关注重点；你只能描述图片中可见的信息。若有文字、数字、时间、版本号、路径、报错、界面结构，请尽量详细描述。看不清的内容明确说明无法辨认。若有多张图片，请按输入顺序分别输出，格式使用 [Image 1]、[Image 2]。'
);

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  if (!ctx.capabilities.reenterPipeline) {
    return null;
  }
  const backendRoutePolicy = planServertoolBackendRoutePolicyWithNative({
    toolName: 'vision_auto',
    flowId: FLOW_ID,
    input: {
      adapterContext: ctx.adapterContext,
      capturedChatRequest: getCapturedRequest(ctx.adapterContext)
    },
    entryEndpoint: ctx.entryEndpoint
  });
  if (backendRoutePolicy.eligible === false) {
    return null;
  }
  if (!shouldRunVisionFlow(ctx)) {
    return null;
  }
  const captured = getCapturedRequest(ctx.adapterContext);
  if (!captured) {
    return null;
  }

  // Native: build analysis payload
  const payloadJson = visionBuildAnalysisPayloadWithNative(JSON.stringify(captured));
  if (!payloadJson || payloadJson === 'null') {
    return null;
  }
  const analysisPayload = JSON.parse(payloadJson) as JsonObject;

  const backend: ServerToolBackendPlan = {
    kind: 'vision_analysis',
    requestIdSuffix: ':vision',
    entryEndpoint: '/v1/chat/completions',
    payload: analysisPayload
  };

  return {
    flowId: backendRoutePolicy.flowId || FLOW_ID,
    backend,
    finalize: async ({ backendResult }) => {
      if (!backendResult || backendResult.kind !== 'vision_analysis') {
        return null;
      }
      const body = backendResult.response.body && typeof backendResult.response.body === 'object'
        ? (backendResult.response.body as JsonObject)
        : null;
      if (!body) {
        return null;
      }
      const visionSummary = extractTextFromChatLike(body);
      if (!visionSummary) {
        return null;
      }
      const seed = extractCapturedChatSeed(captured);
      if (!seed) {
        return null;
      }
      const originalPrompt = visionExtractOriginalUserPromptWithNative(JSON.stringify(seed.messages));
      const followupText = buildVisionFollowupUserText({
        visionSummary,
        originalPrompt
      });
      const followupModel = resolveFollowupModel(captured, body);
      return {
        chatResponse: ctx.base,
        execution: {
          flowId: backendRoutePolicy.flowId || FLOW_ID,
          followup: {
            requestIdSuffix: ':vision_followup',
            entryEndpoint: '/v1/chat/completions',
            metadata: {
              stream: false
            } as JsonObject,
            payload: {
              model: followupModel,
              messages: [
                {
                  role: 'user',
                  content: followupText
                }
              ],
              stream: false
            } as JsonObject
          }
        }
      };
    }
  };
};

registerServerToolHandler('vision_auto', handler, { trigger: 'auto', hook: { phase: 'default', priority: 20 } });

export async function executeVisionBackendPlan(args: {
  plan: Extract<ServerToolBackendPlan, { kind: 'vision_analysis' }>;
  options: ServerSideToolEngineOptions;
}): Promise<ServerToolBackendResult> {
  const plan = args.plan;
  const options = args.options;
  if (!options.reenterPipeline) {
    return { kind: 'vision_analysis', response: {} };
  }
  const metadataJson = visionBuildPinnedMetadataWithNative(JSON.stringify(options.adapterContext), JSON.stringify(plan.payload));
  let pinnedMetadata: JsonObject | undefined;
  if (metadataJson && metadataJson !== 'null') {
    try { pinnedMetadata = JSON.parse(metadataJson) as JsonObject; } catch { /* ignore */ }
  }
  const pinnedModelId = readNonEmptyString((pinnedMetadata as Record<string, unknown> | undefined)?.assignedModelId)
    ?? readNonEmptyString((pinnedMetadata as Record<string, unknown> | undefined)?.modelId);
  if (pinnedModelId) {
    (plan.payload as Record<string, unknown>).model = pinnedModelId;
  }
  const response = await reenterServerToolBackend({
    reenterPipeline: options.reenterPipeline,
    entryEndpoint: plan.entryEndpoint,
    requestId: `${options.requestId}${plan.requestIdSuffix}`,
    body: plan.payload,
    providerProtocol: 'openai-chat',
    routeHint: 'vision',
    ...(pinnedMetadata ? { metadata: pinnedMetadata } : {})
  });
  return { kind: 'vision_analysis', response };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildVisionFollowupUserText(args: {
  visionSummary: string;
  originalPrompt?: string;
}): string {
  const summary = normalizeVisionSummaryForFollowup(String(args.visionSummary || '').trim());
  const prompt = readNonEmptyString(args.originalPrompt) ?? '';
  return `图片内容为：\n${summary}\n\n用户请求：\n${prompt}`.trim();
}

function normalizeVisionSummaryForFollowup(summary: string): string {
  const hasIndexedImages = /\[Image \d+\]:/m.test(summary);
  const normalized = summary
    .replace(/^\s*-\s*(\[Image(?: \d+)?\]:)/gm, '$1')
    .replace(/^(\[Image(?: \d+)?\]:)\s*\n-\s+/gm, hasIndexedImages ? '$1\n- ' : '$1\n');
  if (/^\[Image(?: \d+)?\]:/m.test(normalized)) {
    return normalized;
  }
  return `[Image]:\n${normalized}`;
}

function resolveFollowupModel(captured: JsonObject, analysisBody: JsonObject): string {
  const capturedModel = readNonEmptyString((captured as Record<string, unknown>).model);
  if (capturedModel) {
    return capturedModel;
  }
  const analysisModel = readNonEmptyString((analysisBody as Record<string, unknown>).model);
  return analysisModel ?? 'gpt-test';
}

function shouldRunVisionFlow(ctx: ServerToolHandlerContext): boolean {
  return shouldRunVisionFlowForAdapterContext(ctx.adapterContext);
}

function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') return null;
  const captured = (adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null;
  return captured as JsonObject;
}

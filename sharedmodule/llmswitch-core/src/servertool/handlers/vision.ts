import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ServerToolBackendPlan, ServerToolBackendResult, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { bindServertoolContractWithNative, cloneJson, extractTextFromChatLike } from '../server-side-tools.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import { containsImageAttachment } from '../../conversion/hub/process/chat-process-media.js';
import { reenterServerToolBackend } from '../reenter-backend.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import {
  visionBuildAnalysisPayloadWithNative,
  visionBuildPinnedMetadataWithNative,
  visionExtractOriginalUserPromptWithNative
} from '../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

const FLOW_ID = 'vision_flow';
const VISION_SYSTEM_PROMPT = bindServertoolContractWithNative(
  '你现在的任务只是描述图片内容，不要回答用户问题，不要提供建议，不要推理求解，不要做工具规划。用户提示词只用于帮助你理解关注重点；你只能描述图片中可见的信息。若有文字、数字、时间、版本号、路径、报错、界面结构，请尽量详细描述。看不清的内容明确说明无法辨认。若有多张图片，请按输入顺序分别输出，格式使用 [Image 1]、[Image 2]。'
);

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  if (!ctx.capabilities.reenterPipeline) {
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
    flowId: FLOW_ID,
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
      return {
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':vision_followup',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: [
                {
                  op: 'rebuild_vision_followup',
                  summary: visionSummary,
                  ...(originalPrompt ? { originalPrompt } : {})
                }
              ]
            }
          }
        }
      };
    }
  };
};

registerServerToolHandler('vision_auto', handler, { trigger: 'auto', hook: { phase: 'post', priority: 60 } });

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

function shouldRunVisionFlow(ctx: ServerToolHandlerContext): boolean {
  const record = ctx.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  const routeId = typeof (ctx.adapterContext as { routeId?: unknown }).routeId === 'string' ? String((ctx.adapterContext as { routeId?: unknown }).routeId).trim().toLowerCase() : '';
  const routeHintFromRt = typeof (rt as any)?.routeHint === 'string' ? String((rt as any).routeHint).trim().toLowerCase() : '';
  const routeHintFromRecord = typeof (record as any).routeHint === 'string' ? String((record as any).routeHint).trim().toLowerCase() : '';
  const routeNameFromRt = typeof (rt as any)?.routeName === 'string' ? String((rt as any).routeName).trim().toLowerCase() : '';
  const resolvedRoute = routeId || routeHintFromRt || routeHintFromRecord || routeNameFromRt;
  if (resolvedRoute === 'multimodal') {
    return false;
  }
  const followupRaw = (rt as any)?.serverToolFollowup;
  const followupFlag = followupRaw === true || followupRaw === 'true';
  if (followupFlag) {
    return false;
  }
  const captured = getCapturedRequest(ctx.adapterContext);
  if (isImageGenerationRequest(record, rt, captured)) {
    return false;
  }
  const seed = captured ? extractCapturedChatSeed(captured) : null;
  const hasImageAttachment = Boolean(seed && Array.isArray(seed.messages) && containsImageAttachment(seed.messages as any));
  if (!hasImageAttachment) {
    return false;
  }
  const hasVideoAttachment = latestUserTurnContainsVideo(seed && Array.isArray(seed.messages) ? (seed.messages as unknown[]) : []) || record.hasVideoAttachment === true || (rt as any)?.hasVideoAttachment === true;
  if (hasVideoAttachment) {
    return false;
  }
  const forceVision = record.forceVision === true || record.forceVision === 'true';
  if (forceVision) {
    return true;
  }
  if (resolveInlineMultimodalSupport(record, rt)) {
    return false;
  }
  const providerType = typeof record.providerType === 'string' ? record.providerType.toLowerCase() : '';
  const providerProtocol = typeof record.providerProtocol === 'string' ? record.providerProtocol.toLowerCase() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim().toLowerCase() : typeof record.assignedModelId === 'string' ? record.assignedModelId.trim().toLowerCase() : '';
  return true;
}

function resolveInlineMultimodalSupport(record: Record<string, unknown>, rt: Record<string, unknown> | undefined): boolean {
  const protocol = typeof record.providerProtocol === 'string' ? record.providerProtocol.toLowerCase() : '';
  if (protocol === 'gemini-chat' || protocol === 'gemini') {
    return true;
  }
  const providerType = typeof record.providerType === 'string' ? record.providerType.toLowerCase() : '';
  if (providerType === 'gemini') {
    return true;
  }
  const multimodalProvider = typeof (rt as any)?.multimodalProvider === 'string' ? String((rt as any).multimodalProvider).toLowerCase() : '';
  return multimodalProvider === 'native';
}

function isImageGenerationRequest(record: Record<string, unknown>, rt: Record<string, unknown> | undefined, captured: unknown): boolean {
  const recordFlag = hasImageGenerationFlag(record);
  if (recordFlag) {
    return true;
  }
  if (rt && hasImageGenerationFlag(rt)) {
    return true;
  }
  if (!captured || typeof captured !== 'object') {
    return false;
  }
  if (hasImageGenerationFlag(captured as Record<string, unknown>)) {
    return true;
  }
  return false;
}

function hasImageGenerationFlag(node: Record<string, unknown>): boolean {
  const tool = typeof node.tool === 'string' ? node.tool.trim().toLowerCase() : '';
  if (tool === 'image_generation' || tool === 'text-to-image') {
    return true;
  }
  const rawFlag = node.isImageGeneration;
  return rawFlag === true || rawFlag === 'true' || rawFlag === '1';
}

const VIDEO_URL_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;

function readMediaUrlCandidate(record: Record<string, unknown>, key: 'image_url' | 'video_url'): string {
  const raw = record[key];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const url = (raw as Record<string, unknown>).url;
    return typeof url === 'string' ? url.trim() : '';
  }
  return '';
}

function latestUserTurnContainsVideo(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const role = (msg as { role?: unknown }).role;
    if (typeof role !== 'string' || role.trim().toLowerCase() !== 'user') continue;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
        const type = (part as { type?: unknown }).type;
        if (typeof type === 'string' && type.trim().toLowerCase().includes('video')) return true;
        const videoUrl = readMediaUrlCandidate(part as Record<string, unknown>, 'video_url');
        if (videoUrl && VIDEO_URL_HINT_RE.test(videoUrl)) return true;
      }
    }
    return false;
  }
  return false;
}

function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') return null;
  const captured = (adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null;
  return captured as JsonObject;
}

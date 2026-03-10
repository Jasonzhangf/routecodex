import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ServerToolBackendPlan, ServerToolBackendResult, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson, extractTextFromChatLike } from '../server-side-tools.js';
import {
  extractCapturedChatSeed
} from './followup-request-builder.js';
import { containsImageAttachment } from '../../conversion/hub/process/chat-process-media.js';
import { reenterServerToolBackend } from '../reenter-backend.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';

const FLOW_ID = 'vision_flow';

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

  const analysisPayload = buildVisionAnalysisPayload(captured);
  if (!analysisPayload) {
    return null;
  }

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
      // Fail-closed: if we cannot build followup seed, do not intercept.
      const seed = extractCapturedChatSeed(captured);
      if (!seed) {
        return null;
      }
      return {
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':vision_followup',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: [
                { op: 'inject_vision_summary', summary: visionSummary },
                { op: 'drop_tool_by_name', name: 'vision' }
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
  const response = await reenterServerToolBackend({
    reenterPipeline: options.reenterPipeline,
    entryEndpoint: plan.entryEndpoint,
    requestId: `${options.requestId}${plan.requestIdSuffix}`,
    body: plan.payload,
    providerProtocol: 'openai-chat',
    routeHint: 'vision'
  });
  return { kind: 'vision_analysis', response };
}

function shouldRunVisionFlow(ctx: ServerToolHandlerContext): boolean {
  const record = ctx.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  const followupRaw = (rt as any)?.serverToolFollowup;
  const followupFlag = followupRaw === true || followupRaw === 'true';
  if (followupFlag) {
    return false;
  }

  const captured = getCapturedRequest(ctx.adapterContext);
  const seed = captured ? extractCapturedChatSeed(captured) : null;
  const hasImageAttachment = Boolean(
    seed && Array.isArray(seed.messages) && containsImageAttachment(seed.messages as any)
  );
  if (!hasImageAttachment) {
    return false;
  }

  // 若当前已经使用具备内建多模态能力的 Provider（例如 Gemini/Claude/ChatGPT 路径），
  // 且未显式 forceVision，则不再触发额外的 vision 二跳，避免同一轮请求跑两次。
  const forceVision = record.forceVision === true || record.forceVision === 'true';
  if (forceVision) {
    return true;
  }

  const providerType =
    typeof record.providerType === 'string' ? record.providerType.toLowerCase() : '';
  const providerProtocol =
    typeof record.providerProtocol === 'string' ? record.providerProtocol.toLowerCase() : '';
  const modelId =
    typeof record.modelId === 'string'
      ? record.modelId.trim().toLowerCase()
      : typeof record.assignedModelId === 'string'
        ? record.assignedModelId.trim().toLowerCase()
        : '';

  const inlineMultimodal =
    providerType === 'gemini' ||
    providerType === 'responses' ||
    providerProtocol === 'gemini-chat' ||
    providerProtocol === 'openai-responses';

  if (inlineMultimodal) {
    return false;
  }

  // Kimi K2.5 supports inline multimodal natively (image_url/video_url).
  // When the routed model is kimi-k2.5, do not trigger the legacy vision detour.
  if (modelId === 'kimi-k2.5') {
    return false;
  }

  return true;
}

function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const captured = (adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    return null;
  }
  return captured as JsonObject;
}

function buildVisionAnalysisPayload(source: JsonObject): JsonObject | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const payload: Record<string, unknown> = {};
  if (typeof source.model === 'string' && source.model.trim()) {
    payload.model = source.model.trim();
  }

  const rawMessages = (source as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    return null;
  }

  const visionMessages = buildVisionAnalysisMessages(rawMessages);
  if (!visionMessages.length) {
    return null;
  }
  payload.messages = visionMessages;

  const parameters = (source as { parameters?: unknown }).parameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const params = cloneJson(parameters as Record<string, unknown>);
    Object.assign(payload, params);
  }
  return payload as JsonObject;
}

function buildVisionAnalysisMessages(sourceMessages: unknown[]): JsonObject[] {
  const latestUser = extractLatestUserMessageForVision(sourceMessages);
  if (!latestUser) {
    return [];
  }

  const userMessage = buildVisionUserMessage(latestUser);
  if (!userMessage) {
    return [];
  }

  const messages: JsonObject[] = [];
  const systemMessage = buildVisionSystemMessage();
  if (systemMessage) {
    messages.push(systemMessage);
  }
  messages.push(userMessage);
  return messages;
}

function extractLatestUserMessageForVision(sourceMessages: unknown[]): JsonObject | null {
  for (let idx = sourceMessages.length - 1; idx >= 0; idx -= 1) {
    const msg = sourceMessages[idx];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (typeof role === 'string' && role.trim().toLowerCase() === 'user') {
      return cloneJson(msg as JsonObject);
    }
  }
  return null;
}

function buildVisionSystemMessage(): JsonObject | null {
  const content =
    '你是一名专业的图像分析助手。无论输入是界面截图、文档、图表、代码编辑器、应用窗口还是普通照片，都需要先用结构化、详细的自然语言完整描述画面内容（关键区域、文字信息、布局层次、颜色与对比度、元素之间的关系等），然后总结出与用户任务最相关的关键信息和潜在问题，最后给出具体、可执行的改进建议或结论，避免泛泛而谈。';
  return {
    role: 'system',
    content
  } as JsonObject;
}

function buildVisionUserMessage(source: JsonObject): JsonObject | null {
  const roleRaw = (source as { role?: unknown }).role;
  const role =
    typeof roleRaw === 'string' && roleRaw.trim().length
      ? roleRaw.trim()
      : 'user';

  const rawContent = (source as { content?: unknown }).content;
  const message: Record<string, unknown> = { role };

  if (Array.isArray(rawContent)) {
    const textParts: unknown[] = [];
    const imageParts: unknown[] = [];

    for (const part of rawContent) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        textParts.push(part);
        continue;
      }
      const record = part as { type?: unknown };
      const typeValue = typeof record.type === 'string' ? record.type.toLowerCase() : '';
      if (typeValue.includes('image')) {
        imageParts.push(part);
      } else {
        textParts.push(part);
      }
    }

    const combined: unknown[] = [];
    if (textParts.length) combined.push(...textParts);
    if (imageParts.length) combined.push(...imageParts);

    if (!combined.length) {
      return null;
    }

    message.content = combined;
  } else if (typeof rawContent === 'string' && rawContent.trim().length) {
    message.content = rawContent.trim();
  } else {
    return null;
  }

  return message as JsonObject;
}

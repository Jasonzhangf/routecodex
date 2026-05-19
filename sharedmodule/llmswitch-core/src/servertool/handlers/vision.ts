import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ServerToolBackendPlan, ServerToolBackendResult, ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { bindServertoolContractWithNative, cloneJson, extractTextFromChatLike } from '../server-side-tools.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import { containsImageAttachment } from '../../conversion/hub/process/chat-process-media.js';
import { reenterServerToolBackend } from '../reenter-backend.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
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
      const originalPrompt = extractOriginalUserPrompt(seed.messages);
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
                },
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
  const pinnedMetadata = buildPinnedVisionBackendMetadata(options.adapterContext, plan.payload);
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

function buildPinnedVisionBackendMetadata(
  adapterContext: unknown,
  payload: JsonObject
): JsonObject | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const target =
    record.target && typeof record.target === 'object' && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : undefined;
  const providerKey =
    readNonEmptyString(target?.providerKey)
    ?? readNonEmptyString(target?.providerId)
    ?? readNonEmptyString(record.targetProviderKey)
    ?? readNonEmptyString(record.providerKey);
  const modelId =
    readNonEmptyString(target?.modelId)
    ?? readNonEmptyString(record.assignedModelId)
    ?? readNonEmptyString(record.modelId)
    ?? readNonEmptyString(record.originalModelId)
    ?? (typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined);
  const routecodexPortMode = readNonEmptyString(record.routecodexPortMode);

  if (!providerKey && !modelId && !routecodexPortMode) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  if (providerKey) {
    metadata.__shadowCompareForcedProviderKey = providerKey;
    metadata.providerKey = providerKey;
    metadata.targetProviderKey = providerKey;
  }
  if (modelId) {
    metadata.assignedModelId = modelId;
    metadata.modelId = modelId;
    metadata.target = {
      ...(providerKey ? { providerKey } : {}),
      modelId
    };
    payload.model = modelId;
  }
  if (routecodexPortMode) {
    metadata.routecodexPortMode = routecodexPortMode;
  }
  return metadata as JsonObject;
}
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
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
  const inlineMultimodal = providerType === 'gemini' || providerType === 'responses' || providerProtocol === 'gemini-chat' || providerProtocol === 'openai-responses';
  if (inlineMultimodal) {
    return false;
  }
  if (modelId === 'kimi-k2.5') {
    return false;
  }
  return true;
}
function resolveInlineMultimodalSupport(record: Record<string, unknown>, rt: Record<string, unknown> | undefined): boolean {
  const target =
    record.target && typeof record.target === 'object' && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : undefined;
  for (const value of [target?.supportsMultimodal, (rt as any)?.supportsMultimodal]) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
  }
  return false;
}

function isImageGenerationRequest(
  record: Record<string, unknown>,
  rt: Record<string, unknown> | undefined,
  captured: JsonObject | null
): boolean {
  if (hasImageGenerationFlag(record)) {
    return true;
  }
  if (rt && hasImageGenerationFlag(rt as Record<string, unknown>)) {
    return true;
  }
  if (captured && hasImageGenerationFlag(captured as Record<string, unknown>)) {
    return true;
  }
  const capturedMetadata =
    captured && typeof (captured as { metadata?: unknown }).metadata === 'object' && !Array.isArray((captured as { metadata?: unknown }).metadata)
      ? ((captured as { metadata?: Record<string, unknown> }).metadata as Record<string, unknown>)
      : undefined;
  if (capturedMetadata && hasImageGenerationFlag(capturedMetadata)) {
    return true;
  }
  return false;
}

function hasImageGenerationFlag(node: Record<string, unknown>): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return false;
  }
  if (node.imageGeneration === true || node.qwenImageGeneration === true) {
    return true;
  }
  const generationMode =
    typeof node.generationMode === 'string'
      ? node.generationMode.trim().toLowerCase()
      : typeof node.generation_mode === 'string'
        ? node.generation_mode.trim().toLowerCase()
        : '';
  if (generationMode === 'image' || generationMode === 't2i' || generationMode === 'edit') {
    return true;
  }
  const qwenImageGeneration =
    node.qwenImageGeneration && typeof node.qwenImageGeneration === 'object' && !Array.isArray(node.qwenImageGeneration)
      ? (node.qwenImageGeneration as Record<string, unknown>)
      : undefined;
  if (qwenImageGeneration) {
    if (!Object.prototype.hasOwnProperty.call(qwenImageGeneration, 'enabled')) {
      return true;
    }
    if (qwenImageGeneration.enabled === true) {
      return true;
    }
  }
  return false;
}

const VIDEO_URL_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;

function readMediaUrlCandidate(record: Record<string, unknown>, key: 'image_url' | 'video_url'): string {
  const direct = record[key];
  if (typeof direct === 'string') {
    return direct.trim();
  }
  if (!direct || typeof direct !== 'object' || Array.isArray(direct)) {
    return '';
  }
  const nested = direct as Record<string, unknown>;
  for (const nestedKey of ['url', 'uri', 'data', 'base64']) {
    const value = nested[nestedKey];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function latestUserTurnContainsVideo(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  let latestUser: Record<string, unknown> | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (typeof role === 'string' && role.trim().toLowerCase() === 'user') {
      latestUser = msg as Record<string, unknown>;
      break;
    }
  }
  if (!latestUser) {
    return false;
  }
  const rawContent = latestUser.content;
  if (!Array.isArray(rawContent)) {
    return false;
  }
  for (const part of rawContent) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as Record<string, unknown>;
    const typeValue = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    if (typeValue.includes('video') || record.video_url !== undefined) {
      return true;
    }
    if (typeValue.includes('image') || record.image_url !== undefined) {
      const imageCandidate = readMediaUrlCandidate(record, 'image_url');
      if (imageCandidate && VIDEO_URL_HINT_RE.test(imageCandidate)) {
        return true;
      }
    }
  }
  return false;
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
  return {
    role: 'system',
    content: VISION_SYSTEM_PROMPT
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
    const imageParts = extractImageParts(rawContent);
    if (!imageParts.length) {
      return null;
    }
    message.content = [
      {
        type: 'input_text',
        text: buildVisionPromptHint(rawContent)
      },
      ...imageParts
    ];
  } else if (typeof rawContent === 'string' && rawContent.trim().length) {
    return null;
  } else {
    return null;
  }

  return message as JsonObject;
}

function extractImageParts(rawContent: unknown[]): JsonObject[] {
  const imageParts: JsonObject[] = [];
  for (const part of rawContent) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as { type?: unknown };
    const typeValue = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (!typeValue.includes('image')) {
      continue;
    }
    imageParts.push(cloneJson(part as JsonObject));
  }
  return imageParts;
}

function buildVisionPromptHint(rawContent: unknown): string {
  const prompt = extractUserPromptFromContent(rawContent);
  return [
    '用户原始提示词如下，它只用于帮助你理解关注重点：',
    prompt || '（无文本提示词）',
    '',
    '请根据这个提示词理解用户想关注什么，但不要回答该问题，不要做任何处理，只描述图片中可见内容。',
    '若有多张图片，请按顺序分别输出，格式为 [Image 1]、[Image 2]。'
  ].join('\n');
}

function extractUserPromptFromContent(rawContent: unknown): string {
  if (typeof rawContent === 'string') {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return '';
  }
  const textParts: string[] = [];
  for (const part of rawContent) {
    if (typeof part === 'string') {
      const text = part.trim();
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const typeValue =
      typeof (part as { type?: unknown }).type === 'string'
        ? String((part as { type?: unknown }).type).trim().toLowerCase()
        : '';
    if (typeValue.includes('image')) {
      continue;
    }
    const record = part as Record<string, unknown>;
    for (const key of ['text', 'input_text', 'output_text', 'content']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        textParts.push(value.trim());
        break;
      }
    }
  }
  return textParts.join('\n').trim();
}

function extractOriginalUserPrompt(messages: JsonObject[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (typeof role === 'string' && role.trim().toLowerCase() === 'user') {
      return extractUserPromptFromContent((msg as { content?: unknown }).content);
    }
  }
  return '';
}

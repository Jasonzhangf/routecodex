import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGlmRequestCompatInput } from './glm-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function extractImageUrlFromPart(part: UnknownRecord): string | null {
  const imageUrlBlock = isRecord((part as { image_url?: unknown }).image_url)
    ? ((part as { image_url?: UnknownRecord }).image_url as UnknownRecord)
    : undefined;

  let url: string | undefined;
  if (imageUrlBlock && typeof imageUrlBlock.url === 'string') {
    url = imageUrlBlock.url;
  } else if (typeof (part as { image_url?: unknown }).image_url === 'string') {
    url = (part as { image_url?: string }).image_url;
  } else if (typeof (part as { url?: unknown }).url === 'string') {
    url = (part as { url?: string }).url;
  } else if (typeof (part as { uri?: unknown }).uri === 'string') {
    url = (part as { uri?: string }).uri;
  } else if (typeof (part as { data?: unknown }).data === 'string') {
    url = (part as { data?: string }).data;
  }

  const trimmed = (url ?? '').trim();
  return trimmed.length ? trimmed : null;
}

function collectUserTextFromMessage(msg: UnknownRecord): string {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    if (typeof content === 'string') {
      return content;
    }
    return '';
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const text = (entry as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length) {
      parts.push(text.trim());
    }
  }
  return parts.join('\n');
}

/**
 * GLM 4.6V 专用视觉提示裁剪：
 * - 仅在 model 为 glm-4.6v 且存在携带图片的 user 消息时生效；
 * - 丢弃原有 system 与历史对话，只保留一条新的 system + 一条 user；
 * - system：要求模型以结构化 JSON 描述截图内容、标记（圈/箭头等）及其大致 bbox；
 * - user：保留原始用户文字（如果有）+ 单一 image_url 块。
 *
 * 其他模型（包括 glm-4.7、Gemini 等）不受影响。
 */
export function applyGlmVisionPromptTransform(payload: JsonObject): JsonObject {
  const root = structuredClone(payload) as UnknownRecord;
  const modelRaw = (root as { model?: unknown }).model;
  const model = typeof modelRaw === 'string' ? modelRaw.trim() : '';
  if (!model.startsWith('glm-4.6v')) {
    return root as JsonObject;
  }

  const messagesValue = (root as { messages?: unknown }).messages;
  if (!Array.isArray(messagesValue)) {
    return root as JsonObject;
  }

  const messages = messagesValue.filter((msg): msg is UnknownRecord => isRecord(msg));
  if (!messages.length) {
    return root as JsonObject;
  }

  // 从末尾开始查找最近一条带图片的 user 消息。
  let latestUserWithImage: UnknownRecord | null = null;
  let imageUrl: string | null = null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part)) continue;
      const typeValue = typeof part.type === 'string' ? part.type.toLowerCase() : '';
      if (typeValue === 'image' || typeValue === 'image_url' || typeValue === 'input_image') {
        const candidateUrl = extractImageUrlFromPart(part);
        if (candidateUrl) {
          latestUserWithImage = msg;
          imageUrl = candidateUrl;
          break;
        }
      }
    }
    if (latestUserWithImage && imageUrl) {
      break;
    }
  }

  if (!latestUserWithImage || !imageUrl) {
    return root as JsonObject;
  }
  return runReqOutboundStage3CompatWithNative(buildGlmRequestCompatInput(payload)).payload;
}

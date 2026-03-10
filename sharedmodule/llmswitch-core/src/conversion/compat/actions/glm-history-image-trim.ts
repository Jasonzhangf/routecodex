import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGlmRequestCompatInput } from './glm-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function shouldDropInlineImagePart(part: UnknownRecord): boolean {
  const rawType = typeof part.type === 'string' ? part.type.toLowerCase() : '';
  if (rawType !== 'image' && rawType !== 'image_url' && rawType !== 'input_image') {
    return false;
  }

  const imageUrlBlock = isRecord((part as { image_url?: unknown }).image_url)
    ? ((part as { image_url?: UnknownRecord }).image_url as UnknownRecord)
    : (part as UnknownRecord);

  const urlRaw =
    typeof (imageUrlBlock as { url?: unknown }).url === 'string'
      ? (imageUrlBlock as { url?: string }).url
      : typeof (imageUrlBlock as { data?: unknown }).data === 'string'
        ? (imageUrlBlock as { data?: string }).data
        : '';

  const url = urlRaw.trim();
  if (!url) {
    return false;
  }

  // GLM 4.7 在历史消息中携带 data:image/base64 时会返回 1210，
  // 因此仅在历史中丢弃这类 inline image 片段。
  return url.startsWith('data:image');
}

export function applyGlmHistoryImageTrim(payload: JsonObject): JsonObject {
  const root = structuredClone(payload) as UnknownRecord;

  const modelRaw = (root as { model?: unknown }).model;
  const modelId = typeof modelRaw === 'string' ? modelRaw.trim().toLowerCase() : '';
  if (!modelId || !modelId.startsWith('glm-4.7')) {
    return root as JsonObject;
  }

  const messagesValue = (root as { messages?: unknown }).messages;
  if (!Array.isArray(messagesValue)) {
    return root as JsonObject;
  }

  const messages = messagesValue.filter(msg => isRecord(msg));
  if (!messages.length) {
    return root as JsonObject;
  }

  // 仅在历史消息中进行裁剪：保留最后一条 user 完整内容。
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as UnknownRecord;
    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
    if (role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return root as JsonObject;
  }
  return runReqOutboundStage3CompatWithNative(buildGlmRequestCompatInput(payload)).payload;
}

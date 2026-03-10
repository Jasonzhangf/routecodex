import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGlmRequestCompatInput } from './glm-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeImagePart(part: UnknownRecord): UnknownRecord | null {
  const rawType = typeof part.type === 'string' ? part.type.toLowerCase() : '';
  if (rawType !== 'image' && rawType !== 'image_url') {
    return null;
  }

  // Try multiple locations for the URL, since different inbound
  // protocols may populate different keys.
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
    // If caller passed a raw base64/data URI string, forward as-is.
    url = (part as { data?: string }).data;
  }

  if (!url || !url.trim().length) {
    return null;
  }

  const normalized: UnknownRecord = {
    type: 'image_url',
    image_url: {
      url: url.trim()
    }
  };

  // Preserve a best-effort "detail" field when present.
  const detailValue = (imageUrlBlock && imageUrlBlock.detail) ?? (part as { detail?: unknown }).detail;
  if (typeof detailValue === 'string' && detailValue.trim().length) {
    (normalized.image_url as UnknownRecord).detail = detailValue.trim();
  }

  return normalized;
}

export function applyGlmImageContentTransform(payload: JsonObject): JsonObject {
  const root = structuredClone(payload) as UnknownRecord;
  const messagesValue = (root as { messages?: unknown }).messages;
  if (!Array.isArray(messagesValue)) {
    return root as JsonObject;
  }
  return runReqOutboundStage3CompatWithNative(buildGlmRequestCompatInput(payload)).payload;
}

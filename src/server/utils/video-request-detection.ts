const VIDEO_SOURCE_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;
const VIDEO_MIME_HINT_RE = /^video\//i;

const EXPLICIT_VIDEO_TYPE_SET = new Set([
  'video',
  'input_video',
  'video_url'
]);

const EXPLICIT_VIDEO_KEY_SET = new Set([
  'video',
  'video_url',
  'input_video'
]);

const VIDEO_SOURCE_KEY_SET = new Set([
  'url',
  'image_url',
  'media_url',
  'file_url',
  'source',
  'src'
]);

function normalizeInputString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringLooksLikeVideoSource(value: string): boolean {
  return VIDEO_SOURCE_HINT_RE.test(value);
}

function scanNodeForVideo(
  node: unknown,
  parentKey: string | undefined,
  visited: WeakSet<object>
): boolean {
  if (typeof node === 'string') {
    const normalized = node.trim();
    if (!normalized) {
      return false;
    }
    if (parentKey && EXPLICIT_VIDEO_KEY_SET.has(parentKey)) {
      return true;
    }
    if (parentKey && VIDEO_SOURCE_KEY_SET.has(parentKey)) {
      return stringLooksLikeVideoSource(normalized);
    }
    return false;
  }

  if (!node || typeof node !== 'object') {
    return false;
  }

  if (visited.has(node)) {
    return false;
  }
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      if (scanNodeForVideo(item, parentKey, visited)) {
        return true;
      }
    }
    return false;
  }

  const record = node as Record<string, unknown>;
  const rawType = normalizeInputString(record.type).toLowerCase();
  if (EXPLICIT_VIDEO_TYPE_SET.has(rawType)) {
    return true;
  }

  const mimeHint = normalizeInputString(
    record.mime_type ??
    record.content_type ??
    record.mimeType ??
    record.contentType
  ).toLowerCase();
  if (mimeHint && VIDEO_MIME_HINT_RE.test(mimeHint)) {
    return true;
  }

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.trim().toLowerCase();
    if (scanNodeForVideo(value, normalizedKey, visited)) {
      return true;
    }
  }
  return false;
}

export function payloadContainsVideoInput(payload: unknown): boolean {
  return scanNodeForVideo(payload, undefined, new WeakSet<object>());
}

export const VIDEO_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

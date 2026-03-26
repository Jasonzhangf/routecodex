import type { ProviderContext } from '../../api/provider-types.js';
import {
  asArray,
  asRecord,
  pickPositiveInt,
  pickString,
  type RemoteImageInlineError,
  type UnknownRecord
} from './anthropic-sdk-transport-shared.js';

const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const REMOTE_IMAGE_POLICY_VALUES = ['direct', 'inline', 'direct_then_inline'] as const;

export type InlineRemoteAnthropicImageOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};
export type RemoteImagePolicy = typeof REMOTE_IMAGE_POLICY_VALUES[number];

function normalizeRemoteImagePolicy(value: unknown): RemoteImagePolicy | undefined {
  const token = pickString(value)?.toLowerCase();
  if (!token) {
    return undefined;
  }
  if ((REMOTE_IMAGE_POLICY_VALUES as readonly string[]).includes(token)) {
    return token as RemoteImagePolicy;
  }
  return undefined;
}

function parseRemoteImagePolicyOverrideMap(value: string | undefined): Record<string, RemoteImagePolicy> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const output: Record<string, RemoteImagePolicy> = {};
    for (const [key, policyRaw] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedKey = key.trim().toLowerCase();
      const normalizedPolicy = normalizeRemoteImagePolicy(policyRaw);
      if (!normalizedKey || !normalizedPolicy) {
        continue;
      }
      output[normalizedKey] = normalizedPolicy;
    }
    return output;
  } catch {
    return {};
  }
}

function normalizeImageMediaType(mediaType?: string): string | undefined {
  if (!mediaType) {
    return undefined;
  }
  const token = mediaType.split(';')[0]?.trim().toLowerCase();
  if (!token) {
    return undefined;
  }
  if (token === 'image/jpg') {
    return 'image/jpeg';
  }
  if (token.startsWith('image/')) {
    return token;
  }
  return undefined;
}

function detectImageMediaTypeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'image/png';
    }
  }
  if (bytes.length >= 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
  }
  if (bytes.length >= 6) {
    const gif = Buffer.from(bytes.slice(0, 6)).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.slice(0, 4)).toString('ascii');
    const webp = Buffer.from(bytes.slice(8, 12)).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return 'image/bmp';
    }
  }
  if (bytes.length >= 4) {
    const leTiff = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const beTiff = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    if (leTiff || beTiff) {
      return 'image/tiff';
    }
  }
  return undefined;
}

function detectImageMediaTypeFromPath(urlValue: string): string | undefined {
  const normalized = urlValue.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  if (normalized.endsWith('.tif') || normalized.endsWith('.tiff')) return 'image/tiff';
  return undefined;
}

export function buildRemoteImageInlineError(
  code: string,
  message: string,
  status = 400,
  details?: Record<string, unknown>
): RemoteImageInlineError {
  const error = new Error(message) as RemoteImageInlineError;
  error.code = code;
  error.statusCode = status;
  error.status = status;
  error.response = {
    status,
    data: {
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    }
  };
  return error;
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  sourceUrl: string
): Promise<Uint8Array> {
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw buildRemoteImageInlineError(
      'REMOTE_IMAGE_TOO_LARGE',
      `remote image content-length exceeds limit: ${contentLength} > ${maxBytes}`,
      413,
      { sourceUrl, contentLength, maxBytes }
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_TOO_LARGE',
        `remote image payload exceeds limit: ${bytes.byteLength} > ${maxBytes}`,
        413,
        { sourceUrl, size: bytes.byteLength, maxBytes }
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_TOO_LARGE',
        `remote image payload exceeds limit: ${total} > ${maxBytes}`,
        413,
        { sourceUrl, size: total, maxBytes }
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function fetchRemoteImageAsBase64(
  sourceUrl: string,
  options: InlineRemoteAnthropicImageOptions = {}
): Promise<{ data: string; mediaType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw buildRemoteImageInlineError(
      'REMOTE_IMAGE_INVALID_URL',
      `invalid remote image url: ${sourceUrl}`,
      400,
      { sourceUrl }
    );
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw buildRemoteImageInlineError(
      'REMOTE_IMAGE_UNSUPPORTED_SCHEME',
      `unsupported remote image url scheme: ${protocol}`,
      400,
      { sourceUrl }
    );
  }

  const timeoutMs = pickPositiveInt(
    options.timeoutMs ?? process.env.ROUTECODEX_REMOTE_IMAGE_TIMEOUT_MS ?? process.env.RCC_REMOTE_IMAGE_TIMEOUT_MS,
    DEFAULT_REMOTE_IMAGE_TIMEOUT_MS
  );
  const maxBytes = pickPositiveInt(
    options.maxBytes ?? process.env.ROUTECODEX_REMOTE_IMAGE_MAX_BYTES ?? process.env.RCC_REMOTE_IMAGE_MAX_BYTES,
    DEFAULT_REMOTE_IMAGE_MAX_BYTES
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: abortController.signal
    });
    if (!response.ok) {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_FETCH_HTTP_ERROR',
        `remote image fetch failed with HTTP ${response.status}: ${parsed.toString()}`,
        response.status,
        { sourceUrl: parsed.toString(), status: response.status }
      );
    }

    const bytes = await readResponseBytesWithLimit(response, maxBytes, parsed.toString());
    const detectedMediaType =
      normalizeImageMediaType(response.headers.get('content-type') ?? undefined) ||
      detectImageMediaTypeFromBytes(bytes) ||
      detectImageMediaTypeFromPath(parsed.pathname);

    if (!detectedMediaType) {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_UNSUPPORTED_MEDIA_TYPE',
        `remote image media type is unsupported or undetectable: ${parsed.toString()}`,
        415,
        {
          sourceUrl: parsed.toString(),
          contentType: response.headers.get('content-type') ?? null
        }
      );
    }

    return {
      mediaType: detectedMediaType,
      data: Buffer.from(bytes).toString('base64')
    };
  } catch (error) {
    if (error instanceof Error && (error as { name?: string }).name === 'AbortError') {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_FETCH_TIMEOUT',
        `remote image fetch timed out after ${timeoutMs}ms: ${sourceUrl}`,
        504,
        { sourceUrl, timeoutMs }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function deepCloneRecord<T extends UnknownRecord>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value) as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function inlineRemoteAnthropicImageUrls(
  rawBody: UnknownRecord,
  options: InlineRemoteAnthropicImageOptions = {}
): Promise<{ body: UnknownRecord; rewrites: number }> {
  const nextBody = deepCloneRecord(rawBody);
  let rewrites = 0;

  const messages = asArray(nextBody.messages);
  for (const message of messages) {
    const messageRow = asRecord(message);
    const content = asArray(messageRow.content);
    for (const block of content) {
      const item = asRecord(block);
      const type = pickString(item.type)?.toLowerCase();
      if (type !== 'image') {
        continue;
      }
      const source = asRecord(item.source);
      const sourceType = pickString(source.type)?.toLowerCase();
      if (sourceType !== 'url') {
        continue;
      }
      const sourceUrl = pickString(source.url);
      if (!sourceUrl) {
        continue;
      }
      const { data, mediaType } = await fetchRemoteImageAsBase64(sourceUrl, options);
      source.type = 'base64';
      source.data = data;
      source.media_type = mediaType;
      delete source.url;
      delete source.mediaType;
      rewrites += 1;
    }
  }

  return { body: nextBody, rewrites };
}

export function hasRemoteAnthropicImageUrls(rawBody: UnknownRecord): boolean {
  const messages = asArray(rawBody.messages);
  for (const message of messages) {
    const messageRow = asRecord(message);
    const content = asArray(messageRow.content);
    for (const block of content) {
      const item = asRecord(block);
      if (pickString(item.type)?.toLowerCase() !== 'image') {
        continue;
      }
      const source = asRecord(item.source);
      if (pickString(source.type)?.toLowerCase() !== 'url') {
        continue;
      }
      const sourceUrl = pickString(source.url)?.toLowerCase();
      if (sourceUrl && (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://'))) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAnthropicRemoteImagePolicy(context: ProviderContext, rawBody: UnknownRecord): RemoteImagePolicy {
  const metadata = asRecord(rawBody.metadata);
  const metadataMultimodal = asRecord(metadata.multimodal);
  const requestPolicy =
    normalizeRemoteImagePolicy(metadata.remoteImagePolicy) ||
    normalizeRemoteImagePolicy(metadataMultimodal.remoteImagePolicy);
  if (requestPolicy) {
    return requestPolicy;
  }

  const providerHint = pickString(context.providerId ?? context.providerKey)?.toLowerCase() ?? '';
  const providerId = providerHint.includes('.') ? providerHint.split('.')[0] : providerHint;
  const modelHint = pickString(rawBody.model)?.toLowerCase() ?? '';

  const envOverrides = parseRemoteImagePolicyOverrideMap(
    pickString(process.env.ROUTECODEX_REMOTE_IMAGE_POLICY_OVERRIDES ?? process.env.RCC_REMOTE_IMAGE_POLICY_OVERRIDES)
  );
  for (const candidate of [providerHint, providerId, modelHint]) {
    if (!candidate) {
      continue;
    }
    const exact = envOverrides[candidate];
    if (exact) {
      return exact;
    }
    const prefixHit = Object.entries(envOverrides).find(([key]) => key.endsWith('*') && candidate.startsWith(key.slice(0, -1)));
    if (prefixHit) {
      return prefixHit[1];
    }
  }

  const envDefault = normalizeRemoteImagePolicy(
    process.env.ROUTECODEX_REMOTE_IMAGE_POLICY ?? process.env.RCC_REMOTE_IMAGE_POLICY
  );
  if (envDefault) {
    return envDefault;
  }

  if (providerHint.includes('ali-coding-plan') || modelHint.startsWith('kimi-k2.5')) {
    return 'inline';
  }
  if (providerHint.startsWith('qwen') || modelHint.includes('qwen3-vl')) {
    return 'direct_then_inline';
  }
  return 'direct';
}

export function shouldRetryWithInlineRemoteImage(error: unknown): boolean {
  const record = error as { code?: unknown; statusCode?: unknown; status?: unknown; message?: unknown; response?: unknown };
  const code = pickString(record.code)?.toLowerCase() ?? '';
  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;
  const response = asRecord(record.response);
  const data = asRecord(response.data);
  const errorNode = asRecord(data.error);
  const message = [
    pickString(record.message),
    pickString(errorNode.message),
    pickString(errorNode.code)
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();

  if (code === 'remote_image_fetch_timeout' || code === 'remote_image_fetch_http_error') {
    return true;
  }
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return true;
  }
  const retryableMessageTokens = [
    'application/octet-stream',
    'media type',
    'download multimodal file timed out',
    'download the media resource timed out',
    'invalidparameter.datainspection',
    'invalid_parameter_error',
    'provided url does not appear to be valid'
  ];
  return retryableMessageTokens.some((token) => message.includes(token));
}

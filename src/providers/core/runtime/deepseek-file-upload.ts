import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';

import { DEEPSEEK_ERROR_CODES } from '../contracts/deepseek-provider-contract.js';
import type { HttpClient, HttpResponse } from '../utils/http-client.js';
import type { DeepSeekSessionPowManager } from './deepseek-session-pow.js';
import {
  createProviderError,
  isRecord,
  normalizeString,
  type DeepSeekContextFileContract
} from './deepseek-http-provider-helpers.js';

const DEFAULT_UPLOAD_ENDPOINT = '/api/v0/file/upload_file';
const DEFAULT_UPLOAD_TARGET_PATH = '/api/v0/file/upload_file';
const DEFAULT_FETCH_FILES_ENDPOINT = '/api/v0/file/fetch_files';
const DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const DEFAULT_CONTEXT_FILENAME = 'context.txt';
const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_READY_MAX_ATTEMPTS = 60;
const FILE_READY_INTERVAL_MS = 1000;

type DeepSeekUploadDeps = {
  httpClient: HttpClient;
  powManager: Pick<DeepSeekSessionPowManager, 'createPowResponse'>;
  baseUrl: string;
};

type UploadedFileResult = {
  id: string;
};

type DeepSeekFetchedFileStatus = {
  id?: string;
  status?: string;
};

type DeepSeekUploadFileContract = {
  filename?: string;
  content?: string;
  contentType?: string;
  bytes?: Uint8Array;
};

function buildMultipartBody(file: DeepSeekUploadFileContract): { body: Uint8Array; contentType: string; size: number } {
  const filename = normalizeTextContextFilename(file.filename);
  const contentType = normalizeString(file.contentType) || DEFAULT_CONTENT_TYPE;
  const payloadBytes = file.bytes ?? Buffer.from(normalizeString(file.content) || '', 'utf8');
  const boundary = `----routecodex-deepseek-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '_')}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([prefix, Buffer.from(payloadBytes), suffix]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    size: body.byteLength
  };
}

function readApiCode(payload: Record<string, unknown>): number {
  return typeof payload.code === 'number' ? payload.code : 0;
}

function readBizCode(payload: Record<string, unknown>): number {
  const data = isRecord(payload.data) ? payload.data : undefined;
  return typeof data?.biz_code === 'number' ? data.biz_code : 0;
}

function readBizMessage(payload: Record<string, unknown>): string | undefined {
  const data = isRecord(payload.data) ? payload.data : undefined;
  return normalizeString(data?.biz_msg) || normalizeString(payload.msg);
}

function normalizeTextContextFilename(filename: string | undefined): string {
  const normalized = normalizeString(filename);
  if (!normalized) {
    return DEFAULT_CONTEXT_FILENAME;
  }
  const basename = normalized.split(/[\\/]/).pop() || normalized;
  if (basename.includes('.')) {
    return normalized;
  }
  return `${normalized}.txt`;
}

function previewUploadPayload(value: unknown, maxLength = 1200): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') {
      return String(value);
    }
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return String(value);
  }
}

function extractFileId(payload: Record<string, unknown>): string | undefined {
  const visited = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || visited.has(value)) {
      return undefined;
    }
    visited.add(value);
    if (isRecord(value)) {
      const direct = normalizeString(value.id) || normalizeString(value.file_id);
      if (direct) {
        return direct;
      }
      for (const nested of Object.values(value)) {
        const found = walk(nested);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(payload);
}

function extractFetchedFileStatus(
  payload: Record<string, unknown>,
  targetFileId: string
): DeepSeekFetchedFileStatus | undefined {
  const normalizedTarget = normalizeString(targetFileId);
  if (!normalizedTarget) {
    return undefined;
  }
  const queue: Record<string, unknown>[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentId = normalizeString(current.id) || normalizeString(current.file_id);
    if (currentId && currentId.toLowerCase() === normalizedTarget.toLowerCase()) {
      return {
        id: currentId,
        status: normalizeString(current.status) || normalizeString(current.file_status) || 'uploaded'
      };
    }
    for (const value of Object.values(current)) {
      if (isRecord(value)) {
        queue.push(value);
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isRecord(entry)) {
            queue.push(entry);
          }
        }
      }
    }
  }
  return undefined;
}

function isReadyFileStatus(status: string | undefined): boolean {
  const normalized = normalizeString(status)?.toLowerCase() || '';
  return [
    'processed',
    'ready',
    'done',
    'available',
    'success',
    'completed',
    'finished'
  ].includes(normalized);
}

async function parseJsonResponse(response: HttpResponse): Promise<Record<string, unknown>> {
  if (isRecord(response.data)) {
    return response.data;
  }
  if (typeof response.data === 'string') {
    try {
      const parsed = JSON.parse(response.data);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // handled below
    }
  }
  throw createProviderError(
    DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
    'DeepSeek file upload returned non-JSON payload',
    502
  );
}

async function waitForUploadedFileReady(
  fileId: string,
  authHeaders: Record<string, string>,
  deps: DeepSeekUploadDeps
): Promise<void> {
  let lastStatus: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < FILE_READY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const fetchResponse = await deps.httpClient.get(
        `${deps.baseUrl.replace(/\/+$/, '')}${DEFAULT_FETCH_FILES_ENDPOINT}?file_ids=${encodeURIComponent(fileId)}`,
        {
          ...authHeaders,
          Accept: 'application/json'
        }
      );
      const fetchPayload = await parseJsonResponse(fetchResponse);
      const fetchCode = readApiCode(fetchPayload);
      if (fetchResponse.status !== 200 || fetchCode !== 0) {
        throw createProviderError(
          DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
          `DeepSeek fetch uploaded file failed with status=${fetchResponse.status} code=${fetchCode}`,
          fetchResponse.status || 502,
          { payload: fetchPayload, fileId }
        );
      }
      const fetched = extractFetchedFileStatus(fetchPayload, fileId);
      lastStatus = fetched?.status || lastStatus;
      if (fetched && isReadyFileStatus(fetched.status)) {
        return;
      }
      lastError = new Error(`status=${lastStatus || 'unknown'}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < FILE_READY_MAX_ATTEMPTS - 1) {
      await sleep(FILE_READY_INTERVAL_MS);
    }
  }

  const suffix =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === 'string'
        ? lastError
        : `status=${lastStatus || 'unknown'}`;
  throw createProviderError(
    DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
    `DeepSeek uploaded file did not become ready: ${suffix}`,
    502,
    { fileId, lastStatus }
  );
}

export async function uploadDeepSeekContextFile(
  file: DeepSeekContextFileContract,
  authHeaders: Record<string, string>,
  deps: DeepSeekUploadDeps,
  options?: { modelType?: string }
): Promise<UploadedFileResult> {
  const filename = normalizeTextContextFilename(file.filename);
  const content = normalizeString(file.content);
  if (!content) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      'DeepSeek context file content is empty',
      400,
      { filename }
    );
  }

  const multipart = buildMultipartBody({
    ...file,
    filename
  });
  const powResponse = await deps.powManager.createPowResponse(authHeaders, DEFAULT_UPLOAD_TARGET_PATH as never);
  const modelType = normalizeString(options?.modelType);
  const response = await deps.httpClient.post(
    `${deps.baseUrl.replace(/\/+$/, '')}${DEFAULT_UPLOAD_ENDPOINT}`,
    multipart.body,
    {
      ...authHeaders,
      Accept: 'application/json',
      'Content-Type': multipart.contentType,
      'x-ds-pow-response': String(powResponse),
      'x-file-size': String(Buffer.byteLength(content, 'utf8')),
      ...(modelType ? { 'x-model-type': modelType } : {})
    }
  );
  const payload = await parseJsonResponse(response);
  const apiCode = readApiCode(payload);
  const bizCode = readBizCode(payload);
  const bizMessage = readBizMessage(payload);
  if (response.status !== 200 || apiCode !== 0 || bizCode !== 0) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek file upload failed with status=${response.status} code=${apiCode} biz_code=${bizCode}${bizMessage ? ` (${bizMessage})` : ''}`,
      response.status || 502,
      { payload, filename, bizCode, bizMessage }
    );
  }
  const fileId = extractFileId(payload);
  if (!fileId) {
    try {
      console.warn(
        `[deepseek-file-upload] upload succeeded without file id: filename=${filename} payload=${previewUploadPayload(payload)}`
      );
    } catch {
      // non-blocking debug logging only
    }
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      'DeepSeek file upload succeeded without file id',
      502,
      { payload, filename }
    );
  }

  await waitForUploadedFileReady(fileId, authHeaders, deps);

  return { id: fileId };
}

function decodeDataUrl(input: string): { bytes: Uint8Array; contentType: string } | null {
  const trimmed = normalizeString(input) || '';
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(trimmed);
  if (!match) {
    return null;
  }
  const contentType = (match[1] || 'application/octet-stream').trim() || 'application/octet-stream';
  const payload = match[2] || '';
  return { bytes: Buffer.from(payload, 'base64'), contentType };
}

function pickPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
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
  if (
    bytes.length >= 8 &&
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
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
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
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
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

async function readResponseBytesWithLimit(response: Response, maxBytes: number, sourceUrl: string): Promise<Uint8Array> {
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek remote image content-length exceeds limit: ${contentLength} > ${maxBytes}`,
      413,
      { sourceUrl, contentLength, maxBytes }
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
        `DeepSeek remote image payload exceeds limit: ${bytes.byteLength} > ${maxBytes}`,
        413,
        { sourceUrl, size: bytes.byteLength, maxBytes }
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  try {
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
        throw createProviderError(
          DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
          `DeepSeek remote image payload exceeds limit: ${total} > ${maxBytes}`,
          413,
          { sourceUrl, size: total, maxBytes }
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } finally {
    try { reader.releaseLock(); } catch { /* lock already released */ }
  }
}

async function fetchRemoteImageBytes(sourceUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek remote image url is invalid: ${sourceUrl}`,
      400,
      { sourceUrl }
    );
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek remote image url scheme is unsupported: ${protocol}`,
      400,
      { sourceUrl }
    );
  }

  const timeoutMs = pickPositiveInt(
    process.env.ROUTECODEX_REMOTE_IMAGE_TIMEOUT_MS ?? process.env.RCC_REMOTE_IMAGE_TIMEOUT_MS,
    DEFAULT_REMOTE_IMAGE_TIMEOUT_MS
  );
  const maxBytes = pickPositiveInt(
    process.env.ROUTECODEX_REMOTE_IMAGE_MAX_BYTES ?? process.env.RCC_REMOTE_IMAGE_MAX_BYTES,
    DEFAULT_REMOTE_IMAGE_MAX_BYTES
  );

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: abortController.signal
    });
    if (!response.ok) {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
        `DeepSeek remote image fetch failed with HTTP ${response.status}: ${parsed.toString()}`,
        response.status || 502,
        { sourceUrl: parsed.toString(), status: response.status }
      );
    }

    const bytes = await readResponseBytesWithLimit(response, maxBytes, parsed.toString());
    const contentType =
      normalizeImageMediaType(response.headers.get('content-type') ?? undefined) ||
      detectImageMediaTypeFromBytes(bytes) ||
      detectImageMediaTypeFromPath(parsed.pathname);
    if (!contentType) {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
        `DeepSeek remote image media type is unsupported or undetectable: ${parsed.toString()}`,
        415,
        { sourceUrl: parsed.toString(), contentType: response.headers.get('content-type') ?? null }
      );
    }

    return { bytes, contentType };
  } catch (error) {
    if (error instanceof Error && (error as { name?: string }).name === 'AbortError') {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
        `DeepSeek remote image fetch timed out after ${timeoutMs}ms: ${sourceUrl}`,
        504,
        { sourceUrl, timeoutMs }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveInlineImagePayload(imageUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const decoded = decodeDataUrl(imageUrl);
  if (decoded) {
    return decoded;
  }
  return fetchRemoteImageBytes(imageUrl);
}

export async function uploadDeepSeekInlineFile(
  file: { imageUrl: string; filename?: string; contentType?: string },
  authHeaders: Record<string, string>,
  deps: DeepSeekUploadDeps,
  options?: { modelType?: string }
): Promise<UploadedFileResult> {
  const decoded = await resolveInlineImagePayload(file.imageUrl);
  const uploadFile: DeepSeekUploadFileContract = {
    filename: normalizeString(file.filename) || 'inline-image.png',
    contentType: normalizeString(file.contentType) || decoded.contentType,
    bytes: decoded.bytes
  };
  const multipart = buildMultipartBody(uploadFile);
  const powResponse = await deps.powManager.createPowResponse(authHeaders, DEFAULT_UPLOAD_TARGET_PATH as never);
  const modelType = normalizeString(options?.modelType);
  const response = await deps.httpClient.post(
    `${deps.baseUrl.replace(/\/+$/, '')}${DEFAULT_UPLOAD_ENDPOINT}`,
    multipart.body,
    {
      ...authHeaders,
      Accept: 'application/json',
      'Content-Type': multipart.contentType,
      'x-ds-pow-response': String(powResponse),
      'x-file-size': String(decoded.bytes.byteLength),
      ...(modelType ? { 'x-model-type': modelType } : {})
    }
  );
  const payload = await parseJsonResponse(response);
  const apiCode = readApiCode(payload);
  if (response.status !== 200 || apiCode !== 0) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek inline image upload failed with status=${response.status} code=${apiCode}`,
      response.status || 502,
      { payload, filename: uploadFile.filename }
    );
  }
  const fileId = extractFileId(payload);
  if (!fileId) {
    try {
      console.warn(
        `[deepseek-file-upload] inline upload succeeded without file id: filename=${uploadFile.filename} payload=${previewUploadPayload(payload)}`
      );
    } catch {
      // non-blocking debug logging only
    }
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      'DeepSeek inline image upload succeeded without file id',
      502,
      { payload, filename: uploadFile.filename }
    );
  }
  await waitForUploadedFileReady(fileId, authHeaders, deps);
  return { id: fileId };
}

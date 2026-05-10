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
  const filename = normalizeString(file.filename) || 'RCC_HISTORY.txt';
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

function extractFileId(payload: Record<string, unknown>): string | undefined {
  const queue: Record<string, unknown>[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const direct = normalizeString(current.id) || normalizeString(current.file_id);
    if (direct) {
      return direct;
    }
    for (const value of Object.values(current)) {
      if (isRecord(value)) {
        queue.push(value);
      }
    }
  }
  return undefined;
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
  const filename = normalizeString(file.filename) || 'RCC_HISTORY.txt';
  const content = normalizeString(file.content);
  if (!content) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      'DeepSeek context file content is empty',
      400,
      { filename }
    );
  }

  const multipart = buildMultipartBody(file);
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
  if (response.status !== 200 || apiCode !== 0) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      `DeepSeek file upload failed with status=${response.status} code=${apiCode}`,
      response.status || 502,
      { payload, filename }
    );
  }
  const fileId = extractFileId(payload);
  if (!fileId) {
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

export async function uploadDeepSeekInlineFile(
  file: { imageUrl: string; filename?: string; contentType?: string },
  authHeaders: Record<string, string>,
  deps: DeepSeekUploadDeps,
  options?: { modelType?: string }
): Promise<UploadedFileResult> {
  const decoded = decodeDataUrl(file.imageUrl);
  if (!decoded) {
    throw createProviderError(
      DEEPSEEK_ERROR_CODES.FILE_UPLOAD_FAILED,
      'DeepSeek inline image upload currently requires data URL payload',
      400,
      { filename: file.filename }
    );
  }
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

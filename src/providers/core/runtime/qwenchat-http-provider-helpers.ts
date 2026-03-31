import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import type { UnknownObject } from '../../../types/common-types.js';
import { processChatResponseTools } from '@jsonstudio/llms/conversion';
import { applyStandardToolTextRequestTransform } from './standard-tool-text-request-transform.js';

export const DEFAULT_QWENCHAT_BASE_URL = 'https://chat.qwen.ai';
export const DEFAULT_QWENCHAT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export const DEFAULT_QWENCHAT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
export const DEFAULT_QWENCHAT_COMPLETION_ENDPOINT = '/api/v2/chat/completions';
export const DEFAULT_QWENCHAT_CHAT_CREATE_ENDPOINT = '/api/v2/chats/new';

type QwenUploadTokenData = {
  file_url: string;
  file_id?: string;
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
};

type QwenBaxiaTokens = {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
};

type QwenMessageAttachment = {
  source: string;
  filename?: string;
  mimeType?: string;
  explicitType?: 'image' | 'audio' | 'video' | 'document';
};

type LoadedAttachment = {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  explicitType?: 'image' | 'audio' | 'video' | 'document';
};

type ParsedIncomingMessages = {
  content: string;
  attachments: QwenMessageAttachment[];
};

type ParsedQwenSse = {
  content: string;
  reasoningContent: string;
  usage?: Record<string, unknown>;
};

type QwenChatPayload = {
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown;
  metadata?: Record<string, unknown>;
};

type QwenChatSendInput = {
  baseUrl: string;
  payload: QwenChatPayload;
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
};

type JsonResponseOk = {
  ok: true;
  status: number;
  data: Record<string, unknown>;
  rawText: string;
};

type JsonResponseErr = {
  ok: false;
  status: number;
  data: null;
  rawText: string;
  parseError: Error;
};

type QwenFilePayload = Record<string, unknown>;

type ParsedContentPart = {
  text: string;
  attachments: QwenMessageAttachment[];
};

type QwenUploadResult = {
  files: QwenFilePayload[];
};

type DeltaRecord = Record<string, unknown>;

type QwenSseChunkWriterInput = {
  upstreamStream: NodeJS.ReadableStream;
  model: string;
};

type BxCacheState = {
  tokenCache: QwenBaxiaTokens | null;
  tokenCacheTime: number;
};

const BAXIA_VERSION = '2.5.36';
const BAXIA_CACHE_TTL_MS = 4 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInputString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'undefined' || lowered === '[undefined]' || lowered === 'null' || lowered === '[null]') {
    return '';
  }
  return trimmed;
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function cryptoHashBase64Md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('base64').substring(0, 32);
}

function encodeBaxiaToken(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return `${BAXIA_VERSION.replace(/\./g, '')}!${encoded}`;
}

async function collectFingerprintData(): Promise<Record<string, unknown>> {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  const canvas = cryptoHashBase64Md5(randomBytes(32));
  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)'.substring(0, 20),
    cf: canvas,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random()
  };
}

export async function getQwenBaxiaTokens(cache: BxCacheState): Promise<QwenBaxiaTokens> {
  const now = Date.now();
  if (cache.tokenCache && now - cache.tokenCacheTime < BAXIA_CACHE_TTL_MS) {
    return cache.tokenCache;
  }
  const bxUa = encodeBaxiaToken(await collectFingerprintData());
  let bxUmidToken = `T2gA${randomString(40)}`;
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': DEFAULT_QWENCHAT_USER_AGENT }
    });
    const etag = normalizeInputString(resp.headers.get('etag'));
    if (etag) {
      bxUmidToken = etag;
    }
  } catch {
    // keep generated fallback token
  }
  const next: QwenBaxiaTokens = { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
  cache.tokenCache = next;
  cache.tokenCacheTime = now;
  return next;
}

async function safeReadJsonResponse(response: Response): Promise<JsonResponseOk | JsonResponseErr> {
  const rawText = await response.text().catch(() => '');
  if (!rawText) {
    return {
      ok: false,
      status: response.status,
      data: null,
      rawText: '',
      parseError: new Error('Empty response body')
    };
  }
  try {
    const parsed = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        status: response.status,
        data: null,
        rawText,
        parseError: new Error('Response is not a JSON object')
      };
    }
    return {
      ok: true,
      status: response.status,
      data: parsed,
      rawText
    };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      data: null,
      rawText,
      parseError: error instanceof Error ? error : new Error(String(error))
    };
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function normalizeMimeType(raw: unknown): string {
  const value = normalizeInputString(raw).toLowerCase();
  return value || 'application/octet-stream';
}

function inferFileCategory(
  mimeType: string,
  explicitType?: 'image' | 'audio' | 'video' | 'document'
): 'image' | 'audio' | 'video' | 'document' {
  if (explicitType) {
    return explicitType;
  }
  const mime = normalizeMimeType(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function fileExtensionFromMime(mimeType: string): string {
  const mime = normalizeMimeType(mimeType);
  const mapping: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/avi': 'avi'
  };
  return mapping[mime] || 'bin';
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } | null {
  const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!matched) {
    return null;
  }
  return {
    mimeType: normalizeMimeType(matched[1] || 'application/octet-stream'),
    bytes: decodeBase64ToBytes(matched[2])
  };
}

function inferFilename(rawFilename: unknown, mimeType: string): string {
  const normalized = normalizeInputString(rawFilename);
  if (normalized) {
    return normalized;
  }
  return `attachment-${randomUUID()}.${fileExtensionFromMime(mimeType)}`;
}

function normalizeLegacyFiles(message: Record<string, unknown>): QwenMessageAttachment[] {
  const out: QwenMessageAttachment[] = [];
  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const rawFiles = Array.isArray(message.files) ? message.files : [];
  for (const item of [...rawAttachments, ...rawFiles]) {
    if (!isRecord(item)) continue;
    const source = normalizeInputString(item.data || item.file_data || item.url || item.file_url);
    if (!source) continue;
    const explicitRaw = normalizeInputString(item.type).toLowerCase();
    const explicitType =
      explicitRaw === 'image' || explicitRaw === 'audio' || explicitRaw === 'video' || explicitRaw === 'document'
        ? explicitRaw
        : undefined;
    out.push({
      source,
      filename: normalizeInputString(item.filename || item.name) || undefined,
      mimeType: normalizeInputString(item.mime_type || item.content_type || item.type) || undefined,
      explicitType: explicitType as QwenMessageAttachment['explicitType'] | undefined
    });
  }
  return out;
}

const VIDEO_SOURCE_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;

function sourceLooksLikeVideo(source: string, mimeType?: string): boolean {
  const normalizedSource = normalizeInputString(source);
  if (normalizedSource && VIDEO_SOURCE_HINT_RE.test(normalizedSource)) {
    return true;
  }
  const normalizedMime = normalizeMimeType(mimeType).toLowerCase();
  return normalizedMime.startsWith('video/');
}

function normalizeContentParts(content: unknown): ParsedContentPart {
  if (typeof content === 'string') {
    return { text: normalizeInputString(content), attachments: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }
  const textParts: string[] = [];
  const attachments: QwenMessageAttachment[] = [];
  for (const partRaw of content) {
    if (!isRecord(partRaw)) {
      if (typeof partRaw === 'string') {
        const text = normalizeInputString(partRaw);
        if (text) textParts.push(text);
      }
      continue;
    }
    const type = normalizeInputString(partRaw.type).toLowerCase();
    if (type === 'text' || type === 'input_text') {
      const text = normalizeInputString(partRaw.text || partRaw.input_text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const rawImage = isRecord(partRaw.image_url) ? partRaw.image_url.url : partRaw.image_url;
      const source = normalizeInputString(rawImage || partRaw.url || partRaw.file_url || partRaw.file_data);
      if (!source) continue;
      const mimeHint = normalizeInputString(partRaw.mime_type || partRaw.content_type);
      attachments.push({
        source,
        filename: normalizeInputString(partRaw.filename || partRaw.name) || undefined,
        mimeType: mimeHint || undefined,
        // Some clients put video URLs in image_url blocks; preserve shape, only fix type.
        explicitType: sourceLooksLikeVideo(source, mimeHint) ? 'video' : 'image'
      });
      continue;
    }
    if (
      type === 'file' ||
      type === 'input_file' ||
      type === 'audio' ||
      type === 'input_audio' ||
      type === 'video' ||
      type === 'input_video' ||
      type === 'video_url'
    ) {
      const rawVideo = isRecord(partRaw.video_url) ? partRaw.video_url.url : partRaw.video_url;
      const source = normalizeInputString(rawVideo || partRaw.file_data || partRaw.url || partRaw.file_url || partRaw.data);
      if (!source) continue;
      const explicitType =
        type.includes('audio') ? 'audio' : (type.includes('video') || sourceLooksLikeVideo(source, normalizeInputString(partRaw.mime_type || partRaw.content_type))) ? 'video' : undefined;
      attachments.push({
        source,
        filename: normalizeInputString(partRaw.filename || partRaw.name) || undefined,
        mimeType: normalizeInputString(partRaw.mime_type || partRaw.content_type) || undefined,
        explicitType
      });
      continue;
    }
    const fallbackText = normalizeInputString(partRaw.text || partRaw.content);
    if (fallbackText) {
      textParts.push(fallbackText);
    }
  }
  return {
    text: textParts.join('\n'),
    attachments
  };
}

export function parseIncomingMessages(messages: unknown): ParsedIncomingMessages {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const normalized = safeMessages.map((messageRaw) => {
    const message = isRecord(messageRaw) ? messageRaw : {};
    const parsed = normalizeContentParts(message.content);
    return {
      role: normalizeInputString(message.role) || 'user',
      text: parsed.text,
      attachments: [...parsed.attachments, ...normalizeLegacyFiles(message)]
    };
  });

  if (normalized.length === 0) {
    return { content: '', attachments: [] };
  }

  const last = normalized[normalized.length - 1];
  const history = normalized
    .slice(0, -1)
    .map((item) => {
      if (!item.text) return '';
      const role = item.role === 'assistant' ? 'Assistant' : item.role === 'system' ? 'System' : 'User';
      return `[${role}]: ${item.text}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const lastText = last.text || (last.attachments.length > 0 ? '请结合附件内容回答。' : '');
  const merged = history ? `${history}\n\n[User]: ${lastText}` : lastText;
  return {
    content: merged,
    attachments: last.attachments
  };
}

async function loadAttachmentBytes(attachment: QwenMessageAttachment): Promise<LoadedAttachment> {
  const parsedDataUrl = parseDataUrl(attachment.source);
  if (parsedDataUrl) {
    const mimeType = normalizeMimeType(attachment.mimeType || parsedDataUrl.mimeType);
    return {
      bytes: parsedDataUrl.bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  if (/^https?:\/\//i.test(attachment.source)) {
    const resp = await fetch(attachment.source);
    if (!resp.ok) {
      throw new Error(`Failed to fetch attachment URL: HTTP ${resp.status}`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const mimeType = normalizeMimeType(attachment.mimeType || resp.headers.get('content-type'));
    return {
      bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  const normalizedBase64 = attachment.source.replace(/\s+/g, '');
  const bytes = decodeBase64ToBytes(normalizedBase64);
  const mimeType = normalizeMimeType(attachment.mimeType);
  return {
    bytes,
    mimeType,
    filename: inferFilename(attachment.filename, mimeType),
    explicitType: attachment.explicitType
  };
}

function qwenCommonHeaders(
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'bx-ua': baxiaTokens.bxUa,
    'bx-umidtoken': baxiaTokens.bxUmidToken,
    'bx-v': baxiaTokens.bxV,
    'source': 'web',
    'timezone': new Date().toUTCString(),
    'Referer': `${DEFAULT_QWENCHAT_BASE_URL}/`,
    'User-Agent': DEFAULT_QWENCHAT_USER_AGENT,
    'Accept-Language': DEFAULT_QWENCHAT_ACCEPT_LANGUAGE,
    'x-request-id': randomUUID(),
    ...(authHeaders || {})
  };
}

function extractQwenErrorMessage(payload: Record<string, unknown>): string {
  const readNode = (node: Record<string, unknown> | undefined): string => {
    if (!node) return '';
    const direct = [
      normalizeInputString(node.msg),
      normalizeInputString(node.message),
      normalizeInputString(node.error),
      normalizeInputString(node.err_msg)
    ].filter(Boolean);
    if (direct.length > 0) {
      return direct[0];
    }
    if (isRecord(node.error)) {
      const nested = [
        normalizeInputString(node.error.message),
        normalizeInputString(node.error.msg),
        normalizeInputString(node.error.code)
      ].filter(Boolean);
      if (nested.length > 0) {
        return nested[0];
      }
    }
    return '';
  };

  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  return readNode(payload) || readNode(dataNode) || '';
}

function extractQwenUploadTokenData(payload: Record<string, unknown>): QwenUploadTokenData | null {
  const tryReadNode = (node: unknown): QwenUploadTokenData | null => {
    if (!isRecord(node)) {
      return null;
    }

    const fileUrl =
      normalizeInputString(node.file_url) ||
      normalizeInputString(node.fileUrl) ||
      normalizeInputString(node.upload_url) ||
      normalizeInputString(node.uploadUrl) ||
      normalizeInputString(node.url);

    const accessKeyId =
      normalizeInputString(node.access_key_id) ||
      normalizeInputString(node.accessKeyId);
    const accessKeySecret =
      normalizeInputString(node.access_key_secret) ||
      normalizeInputString(node.accessKeySecret);
    const securityToken =
      normalizeInputString(node.security_token) ||
      normalizeInputString(node.securityToken);

    if (!fileUrl || !accessKeyId || !accessKeySecret || !securityToken) {
      return null;
    }

    return {
      file_url: fileUrl,
      file_id: normalizeInputString(node.file_id) || normalizeInputString(node.fileId) || undefined,
      access_key_id: accessKeyId,
      access_key_secret: accessKeySecret,
      security_token: securityToken
    };
  };

  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  const resultNode = isRecord(payload.result) ? payload.result : undefined;
  const candidateNodes: unknown[] = [
    dataNode,
    isRecord(dataNode?.data) ? dataNode.data : undefined,
    isRecord(dataNode?.result) ? dataNode.result : undefined,
    resultNode,
    isRecord(resultNode?.data) ? resultNode.data : undefined,
    payload
  ];

  for (const node of candidateNodes) {
    const hit = tryReadNode(node);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function throwQwenUploadTokenError(
  message: string,
  opts?: { statusCode?: number; code?: string }
): never {
  const err = new Error(message);
  (err as Error & { statusCode?: number; code?: string }).statusCode = opts?.statusCode ?? 502;
  (err as Error & { statusCode?: number; code?: string }).code = opts?.code || 'QWENCHAT_UPLOAD_TOKEN_FAILED';
  throw err;
}

async function requestUploadToken(
  baseUrl: string,
  file: LoadedAttachment,
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<{ tokenData: QwenUploadTokenData; filetype: 'image' | 'audio' | 'video' | 'document' }> {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  const resp = await fetch(joinUrl(baseUrl, '/api/v2/files/getstsToken'), {
    method: 'POST',
    headers: qwenCommonHeaders(baxiaTokens, authHeaders),
    body: JSON.stringify({
      filename: file.filename,
      filesize: file.bytes.length,
      filetype
    })
  });
  const parsed = await safeReadJsonResponse(resp);
  if (!parsed.ok || !resp.ok) {
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const suffix = preview ? ` body=${preview}` : '';
    throwQwenUploadTokenError(`Failed to get qwen upload token: HTTP ${resp.status}${suffix}`, {
      statusCode: resp.ok ? 502 : resp.status,
      code: 'QWENCHAT_UPLOAD_TOKEN_HTTP_ERROR'
    });
  }

  const payload = parsed.data;
  if (payload.success === false) {
    const reason = extractQwenErrorMessage(payload);
    const dataNode = isRecord(payload.data) ? payload.data : undefined;
    const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const detail = [reason, dataKeys ? `keys=${dataKeys}` : '', preview ? `body=${preview}` : '']
      .filter(Boolean)
      .join(' ');
    throwQwenUploadTokenError(`Failed to get qwen upload token: ${detail || 'upstream rejected request'}`, {
      statusCode: 502,
      code: 'QWENCHAT_UPLOAD_TOKEN_REJECTED'
    });
  }

  const tokenData = extractQwenUploadTokenData(payload);
  if (!tokenData) {
    const dataNode = isRecord(payload.data) ? payload.data : undefined;
    const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const detail = [dataKeys ? `keys=${dataKeys}` : '', preview ? `body=${preview}` : '']
      .filter(Boolean)
      .join(' ');
    const suffix = detail ? ` (${detail})` : '';
    throwQwenUploadTokenError(`Failed to get qwen upload token: malformed response${suffix}`, {
      statusCode: 502,
      code: 'QWENCHAT_UPLOAD_TOKEN_MALFORMED'
    });
  }

  return {
    tokenData,
    filetype
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatOssDate(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function hmacSha256(key: Uint8Array, content: string | Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', Buffer.from(key));
  hmac.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
  return new Uint8Array(hmac.digest());
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildOssSignedHeaders(uploadUrl: string, tokenData: QwenUploadTokenData, file: LoadedAttachment): Record<string, string> {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');
  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders =
    [
      `content-type:${file.mimeType}`,
      'x-oss-content-sha256:UNSIGNED-PAYLOAD',
      `x-oss-date:${xOssDate}`,
      `x-oss-security-token:${tokenData.security_token}`,
      `x-oss-user-agent:${xOssUserAgent}`
    ].join('\n') + '\n';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = ['OSS4-HMAC-SHA256', xOssDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(Buffer.from(`aliyun_v4${tokenData.access_key_secret}`, 'utf8'), dateScope);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 'oss');
  const kSigning = hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(hmacSha256(kSigning, stringToSign));

  return {
    'Accept': '*/*',
    'Content-Type': file.mimeType,
    'authorization': `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    'Referer': `${DEFAULT_QWENCHAT_BASE_URL}/`
  };
}

async function uploadFileToQwenOss(file: LoadedAttachment, tokenData: QwenUploadTokenData): Promise<void> {
  const uploadUrl = normalizeInputString(tokenData.file_url).split('?')[0];
  if (!uploadUrl) {
    throw new Error('Upload failed: missing qwen oss upload url');
  }
  const signedHeaders = buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: Buffer.from(file.bytes)
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Upload failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
}

function extractUploadedFileId(fileUrl: string): string {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0];
    }
  } catch {
    // fallback uuid
  }
  return randomUUID();
}

function buildQwenFilePayload(
  file: LoadedAttachment,
  tokenData: QwenUploadTokenData,
  filetype: 'image' | 'audio' | 'video' | 'document'
): QwenFilePayload {
  const now = Date.now();
  const id = normalizeInputString(tokenData.file_id) || extractUploadedFileId(tokenData.file_url);
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : filetype === 'image' ? 'vision' : filetype;
  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: {
        name: file.filename,
        size: file.bytes.length,
        content_type: file.mimeType
      },
      update_at: now
    },
    id,
    url: tokenData.file_url,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: randomUUID(),
    greenNet: 'success',
    size: file.bytes.length,
    file_type: file.mimeType,
    uploadTaskId: randomUUID()
  };
}

async function ensureUploadStatusForNonVideo(
  baseUrl: string,
  filetype: 'image' | 'audio' | 'video' | 'document',
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<void> {
  if (filetype === 'video') {
    return;
  }
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(joinUrl(baseUrl, '/api/v2/users/status'), {
      method: 'POST',
      headers: qwenCommonHeaders(baxiaTokens, authHeaders),
      body: JSON.stringify({
        typarms: {
          typarm1: 'web',
          typarm2: '',
          typarm3: 'prod',
          typarm4: 'qwen_chat',
          typarm5: 'product',
          orgid: 'tongyi'
        }
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Upload status check failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (payload.data === true) {
      return;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error('Upload status not ready for non-video file');
}

async function parseDocumentIfNeeded(
  baseUrl: string,
  qwenFilePayload: QwenFilePayload,
  filetype: 'image' | 'audio' | 'video' | 'document',
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<void> {
  if (filetype !== 'document') {
    return;
  }
  const fileId = normalizeInputString(qwenFilePayload.id);
  if (!fileId) {
    return;
  }
  const resp = await fetch(joinUrl(baseUrl, '/api/v2/files/parse'), {
    method: 'POST',
    headers: qwenCommonHeaders(baxiaTokens, authHeaders),
    body: JSON.stringify({ file_id: fileId })
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Document parse failed with status ${resp.status}${text ? `: ${text}` : ''}`);
  }
  if (text) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.success === false) {
        const message = normalizeInputString(payload.msg) || 'Document parse rejected';
        throw new Error(message);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
    }
  }
}

export async function uploadAttachments(args: {
  baseUrl: string;
  attachments: QwenMessageAttachment[];
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
}): Promise<QwenUploadResult> {
  const files: QwenFilePayload[] = [];
  for (const rawAttachment of args.attachments) {
    const loaded = await loadAttachmentBytes(rawAttachment);
    const { tokenData, filetype } = await requestUploadToken(args.baseUrl, loaded, args.baxiaTokens, args.authHeaders);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
    await ensureUploadStatusForNonVideo(args.baseUrl, filetype, args.baxiaTokens, args.authHeaders);
    await parseDocumentIfNeeded(args.baseUrl, qwenFilePayload, filetype, args.baxiaTokens, args.authHeaders);
    if (filetype === 'document') {
      await ensureUploadStatusForNonVideo(args.baseUrl, filetype, args.baxiaTokens, args.authHeaders);
    }
    files.push(qwenFilePayload);
  }
  return { files };
}

export function extractQwenChatPayload(request: UnknownObject): QwenChatPayload {
  const container = isRecord(request) ? request : {};
  const payload = isRecord(container.data) ? container.data : container;
  const model = normalizeInputString(payload.model) || 'qwen3.5-plus';
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const streamFlag = payload.stream;
  const stream = streamFlag === undefined ? true : streamFlag === true;
  const metadata = isRecord(payload.metadata)
    ? (payload.metadata as Record<string, unknown>)
    : isRecord(container.metadata)
      ? (container.metadata as Record<string, unknown>)
      : undefined;
  return {
    model,
    messages,
    stream,
    tools: payload.tools,
    metadata
  };
}

export function shouldUseSearchMode(payload: QwenChatPayload): boolean {
  if (payload.metadata?.qwenWebSearch === true || payload.metadata?.webSearch === true) {
    return true;
  }
  return false;
}

function extractChatIdFromCreatePayload(payload: Record<string, unknown>): string {
  const readDirect = (node: Record<string, unknown> | undefined): string => {
    if (!node) {
      return '';
    }
    return (
      normalizeInputString(node.id) ||
      normalizeInputString(node.chat_id) ||
      normalizeInputString(node.chatId) ||
      normalizeInputString(node.session_id) ||
      normalizeInputString(node.sessionId) ||
      normalizeInputString(node.conversation_id) ||
      normalizeInputString(node.conversationId)
    );
  };

  const root = payload;
  const dataNode = isRecord(root.data) ? root.data : undefined;
  const resultNode = isRecord(root.result) ? root.result : undefined;
  const chatNode = isRecord(dataNode?.chat) ? dataNode.chat : undefined;

  return readDirect(dataNode) || readDirect(chatNode) || readDirect(resultNode) || readDirect(root);
}

function extractCreateErrorMessage(payload: Record<string, unknown>): string {
  const parts = [
    normalizeInputString(payload.msg),
    normalizeInputString(payload.message),
    normalizeInputString(payload.error),
    isRecord(payload.error) ? normalizeInputString(payload.error.message) : ''
  ].filter(Boolean);
  return parts[0] || '';
}

export async function createQwenChatSession(args: {
  baseUrl: string;
  model: string;
  chatType: 't2t' | 'search';
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
}): Promise<string> {
  const resp = await fetch(joinUrl(args.baseUrl, DEFAULT_QWENCHAT_CHAT_CREATE_ENDPOINT), {
    method: 'POST',
    headers: qwenCommonHeaders(args.baxiaTokens, args.authHeaders),
    body: JSON.stringify({
      title: '新建对话',
      models: [args.model],
      chat_mode: 'guest',
      chat_type: args.chatType,
      timestamp: Date.now(),
      project_id: ''
    })
  });
  const parsed = await safeReadJsonResponse(resp);
  if (!parsed.ok || !resp.ok) {
    const bodyPreview = parsed.rawText.slice(0, 280).replace(/\s+/g, ' ').trim();
    const suffix = bodyPreview ? ` body=${bodyPreview}` : '';
    const err = new Error(`Failed to create qwenchat session: HTTP ${resp.status}${suffix}`);
    (err as Error & { statusCode?: number; code?: string }).statusCode = resp.ok ? 502 : resp.status;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_CREATE_SESSION_FAILED';
    throw err;
  }
  const success = parsed.data.success === true;
  const chatId = success ? extractChatIdFromCreatePayload(parsed.data) : '';
  if (!chatId) {
    const reason = extractCreateErrorMessage(parsed.data);
    const dataNode = isRecord(parsed.data.data) ? parsed.data.data : undefined;
    const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
    const detail = reason || (dataKeys ? `keys=${dataKeys}` : '');
    const suffix = detail ? ` (${detail})` : '';
    const err = new Error(`Failed to create qwenchat session: missing chat id${suffix}`);
    (err as Error & { statusCode?: number; code?: string }).statusCode = 502;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_CREATE_SESSION_FAILED';
    throw err;
  }
  return chatId;
}

export function buildQwenChatCompletionRequest(args: {
  chatId: string;
  model: string;
  content: string;
  uploadedFiles: QwenFilePayload[];
  chatType: 't2t' | 'search';
}): Record<string, unknown> {
  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: args.chatId,
    chat_mode: 'guest',
    model: args.model,
    parent_id: null,
    messages: [
      {
        fid: randomUUID(),
        parentId: null,
        childrenIds: [randomUUID()],
        role: 'user',
        content: args.content,
        user_action: 'chat',
        files: args.uploadedFiles,
        timestamp: Date.now(),
        models: [args.model],
        chat_type: args.chatType,
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: args.chatType === 'search'
        },
        extra: { meta: { subChatType: args.chatType } },
        sub_chat_type: args.chatType,
        parent_id: null
      }
    ],
    timestamp: Date.now()
  };
}

function extractReasoningContentFromDelta(delta: Record<string, unknown>): string {
  const direct = normalizeInputString(delta.reasoning_content || delta.reasoning);
  if (direct) {
    return direct;
  }
  const phase = normalizeInputString(delta.phase);
  if (phase !== 'thinking_summary') {
    return '';
  }
  const extra = isRecord(delta.extra) ? delta.extra : undefined;
  const summaryThought = extra && isRecord(extra.summary_thought) ? extra.summary_thought : undefined;
  const content = summaryThought?.content;
  if (typeof content === 'string') {
    return normalizeInputString(content);
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return normalizeInputString(item);
        if (isRecord(item)) return normalizeInputString(item.text || item.content || item.value);
        return '';
      })
      .filter(Boolean);
    return parts.join('\n');
  }
  return '';
}

function mapUpstreamDeltaToOpenAi(deltaRaw: unknown): DeltaRecord | null {
  if (!isRecord(deltaRaw)) {
    return null;
  }
  const mapped: DeltaRecord = {};
  if (normalizeInputString(deltaRaw.role) === 'assistant') {
    mapped.role = 'assistant';
  }
  const content = normalizeInputString(deltaRaw.content);
  if (content) {
    mapped.content = content;
  }
  const reasoning = extractReasoningContentFromDelta(deltaRaw);
  if (reasoning) {
    mapped.reasoning_content = reasoning;
  }
  return Object.keys(mapped).length > 0 ? mapped : null;
}

function mapUsageToOpenAi(usageRaw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usageRaw)) {
    return undefined;
  }
  const inputTokens = Number(usageRaw.input_tokens || 0);
  const outputTokens = Number(usageRaw.output_tokens || 0);
  const totalTokens = Number(usageRaw.total_tokens || inputTokens + outputTokens);
  const usage: Record<string, unknown> = {
    prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
  if (isRecord(usageRaw.input_tokens_details) && Object.keys(usageRaw.input_tokens_details).length > 0) {
    usage.prompt_tokens_details = usageRaw.input_tokens_details;
  }
  if (isRecord(usageRaw.output_tokens_details) && Object.keys(usageRaw.output_tokens_details).length > 0) {
    usage.completion_tokens_details = usageRaw.output_tokens_details;
  }
  return usage;
}

function createOpenAiChunk(args: {
  id: string;
  created: number;
  model: string;
  delta: DeltaRecord;
  finishReason: string | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finishReason
      }
    ]
  };
  if (args.usage) {
    chunk.usage = args.usage;
  }
  return chunk;
}

function looksLikeToolMarkupNoise(text: string): boolean {
  const normalized = normalizeInputString(text);
  if (!normalized) {
    return false;
  }
  return (
    /<\s*\/?\s*function_calls\b/i.test(normalized) ||
    /<\s*\/?\s*tool_call\b/i.test(normalized) ||
    /<\s*\/?\s*tool_name\b/i.test(normalized) ||
    /<\s*\/?\s*arg_key\b/i.test(normalized) ||
    /<\s*\/?\s*arg_value\b/i.test(normalized) ||
    /"tool_calls"\s*:/i.test(normalized)
  );
}

function sanitizeDeltaForStreamEmit(delta: DeltaRecord): DeltaRecord {
  const next: DeltaRecord = { ...delta };
  const content = normalizeInputString(next.content);
  if (content && looksLikeToolMarkupNoise(content)) {
    delete next.content;
  }
  const reasoning = normalizeInputString(next.reasoning_content);
  if (reasoning && looksLikeToolMarkupNoise(reasoning)) {
    delete next.reasoning_content;
  }
  return next;
}

function processQwenSsePayloadLines(args: {
  payload: string;
  onChunk: (chunk: Record<string, unknown>) => void;
  onDone: () => void;
  onFinishReason?: (reason: string) => void;
  includeFinishReason?: boolean;
  collect?: {
    contentParts: string[];
    reasoningParts: string[];
    usageRef: { usage?: Record<string, unknown> };
  };
  responseId: string;
  created: number;
  model: string;
}): void {
  for (const line of args.payload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      args.onDone();
      continue;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const choiceNode = Array.isArray(parsed.choices) && parsed.choices.length > 0 && isRecord(parsed.choices[0])
        ? (parsed.choices[0] as Record<string, unknown>)
        : undefined;
      const deltaNode = choiceNode && isRecord(choiceNode.delta) ? choiceNode.delta : undefined;
      const delta = mapUpstreamDeltaToOpenAi(deltaNode);
      const finishReason = normalizeInputString(choiceNode?.finish_reason) || null;
      if (finishReason && args.onFinishReason) {
        args.onFinishReason(finishReason);
      }
      const usage = mapUsageToOpenAi(parsed.usage);
      if (usage && args.collect) {
        args.collect.usageRef.usage = usage;
      }
      if (delta && args.collect) {
        const content = normalizeInputString(delta.content);
        if (content) args.collect.contentParts.push(content);
        const reasoning = normalizeInputString(delta.reasoning_content);
        if (reasoning) args.collect.reasoningParts.push(reasoning);
      }
      if (delta || finishReason || usage) {
        const deltaForEmit = delta ? sanitizeDeltaForStreamEmit(delta) : {};
        args.onChunk(
          createOpenAiChunk({
            id: args.responseId,
            created: args.created,
            model: args.model,
            delta: deltaForEmit,
            finishReason: args.includeFinishReason === false ? null : finishReason,
            usage
          })
        );
      }
    } catch {
      // ignore malformed data line
    }
  }
}

export function createOpenAiMappedSseStream(input: QwenSseChunkWriterInput): NodeJS.ReadableStream {
  const output = new PassThrough();
  const responseId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let doneWritten = false;
  let buffer = '';
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const usageRef: { usage?: Record<string, unknown> } = {};
  let lastUpstreamFinishReason: string | null = null;

  const writeDone = () => {
    if (doneWritten) return;
    doneWritten = true;
    output.write('data: [DONE]\n\n');
  };

  input.upstreamStream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      processQwenSsePayloadLines({
        payload: `${line}\n`,
        onChunk: (mappedChunk) => {
          output.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
        },
        onDone: () => {
          // defer done to stream end, so harvest-produced final tool_calls can be emitted first.
        },
        onFinishReason: (reason) => {
          lastUpstreamFinishReason = reason;
        },
        includeFinishReason: false,
        collect: { contentParts, reasoningParts, usageRef },
        responseId,
        created,
        model: input.model
      });
    }
  });

  input.upstreamStream.on('end', () => {
    if (buffer.trim()) {
      processQwenSsePayloadLines({
        payload: buffer,
        onChunk: (mappedChunk) => {
          output.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
        },
        onDone: () => {
          // defer done to stream end, so harvest-produced final tool_calls can be emitted first.
        },
        onFinishReason: (reason) => {
          lastUpstreamFinishReason = reason;
        },
        includeFinishReason: false,
        collect: { contentParts, reasoningParts, usageRef },
        responseId,
        created,
        model: input.model
      });
    }
    const harvested = applyStandardizedTextHarvestToChatPayload({
      id: responseId,
      object: 'chat.completion',
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: contentParts.join(''),
            ...(reasoningParts.length ? { reasoning_content: reasoningParts.join('') } : {})
          }
        }
      ],
      ...(usageRef.usage ? { usage: usageRef.usage } : {})
    });
    const harvestedChoice = Array.isArray(harvested.choices) && harvested.choices.length > 0 && isRecord(harvested.choices[0])
      ? (harvested.choices[0] as Record<string, unknown>)
      : undefined;
    const harvestedMessage = harvestedChoice && isRecord(harvestedChoice.message)
      ? (harvestedChoice.message as Record<string, unknown>)
      : undefined;
    const harvestedToolCalls = harvestedMessage && Array.isArray(harvestedMessage.tool_calls)
      ? harvestedMessage.tool_calls
      : [];
    const finalFinishReason =
      harvestedToolCalls.length > 0
        ? 'tool_calls'
        : lastUpstreamFinishReason || 'stop';
    const finalDelta: Record<string, unknown> =
      harvestedToolCalls.length > 0
        ? { tool_calls: harvestedToolCalls }
        : {};
    output.write(
      `data: ${JSON.stringify(
        createOpenAiChunk({
          id: responseId,
          created,
          model: input.model,
          delta: finalDelta,
          finishReason: finalFinishReason,
          usage: usageRef.usage
        })
      )}\n\n`
    );
    writeDone();
    output.end();
  });

  input.upstreamStream.on('error', (error) => {
    output.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })}\n\n`);
    writeDone();
    output.end();
  });

  return output;
}

export async function collectQwenSseAsOpenAiResult(args: {
  upstreamStream: NodeJS.ReadableStream;
  model: string;
}): Promise<Record<string, unknown>> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const usageRef: { usage?: Record<string, unknown> } = {};
  let buffer = '';

  await new Promise<void>((resolve, reject) => {
    args.upstreamStream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    args.upstreamStream.on('end', resolve);
    args.upstreamStream.on('error', reject);
  });

  processQwenSsePayloadLines({
    payload: buffer,
    onChunk: () => {
      // no-op in aggregate mode
    },
    onDone: () => {
      // no-op in aggregate mode
    },
    collect: { contentParts, reasoningParts, usageRef },
    responseId: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: args.model
  });

  const result: Record<string, unknown> = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: contentParts.join(''),
          ...(reasoningParts.length ? { reasoning_content: reasoningParts.join('') } : {})
        },
        finish_reason: 'stop'
      }
    ]
  };
  if (usageRef.usage) {
    result.usage = usageRef.usage;
  }
  return applyStandardizedTextHarvestToChatPayload(result);
}

export async function buildQwenChatSendPlan(input: QwenChatSendInput): Promise<{
  completionUrl: string;
  completionHeaders: Record<string, string>;
  completionBody: Record<string, unknown>;
}> {
  const normalizedPayload = applyStandardToolTextRequest(input.payload);
  if (!Array.isArray(normalizedPayload.messages) || normalizedPayload.messages.length === 0) {
    const err = new Error('Messages are required');
    (err as Error & { statusCode?: number; code?: string }).statusCode = 400;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_INVALID_REQUEST';
    throw err;
  }

  const chatType: 't2t' | 'search' = shouldUseSearchMode(normalizedPayload) ? 'search' : 't2t';
  const chatId = await createQwenChatSession({
    baseUrl: input.baseUrl,
    model: normalizedPayload.model,
    chatType,
    baxiaTokens: input.baxiaTokens,
    authHeaders: input.authHeaders
  });
  const parsedMessages = parseIncomingMessages(normalizedPayload.messages);
  const uploaded = parsedMessages.attachments.length
    ? await uploadAttachments({
        baseUrl: input.baseUrl,
        attachments: parsedMessages.attachments,
        baxiaTokens: input.baxiaTokens,
        authHeaders: input.authHeaders
      })
    : { files: [] };

  const completionBody = buildQwenChatCompletionRequest({
    chatId,
    model: normalizedPayload.model,
    content: parsedMessages.content,
    uploadedFiles: uploaded.files,
    chatType
  });

  const completionHeaders = {
    ...qwenCommonHeaders(input.baxiaTokens, input.authHeaders),
    version: '0.2.9',
    Referer: `${input.baseUrl.replace(/\/$/, '')}/c/guest`
  };

  return {
    completionUrl: `${joinUrl(input.baseUrl, DEFAULT_QWENCHAT_COMPLETION_ENDPOINT)}?chat_id=${encodeURIComponent(chatId)}`,
    completionHeaders,
    completionBody
  };
}

function applyStandardToolTextRequest(payload: QwenChatPayload): QwenChatPayload {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  try {
    const transformed = applyStandardToolTextRequestTransform(
      {
        model: payload.model,
        messages: payload.messages,
        tools: payload.tools,
        metadata: payload.metadata
      } as any,
      {
        providerProtocol: 'openai-chat',
        entryEndpoint: '/v1/chat/completions'
      } as any
    ) as Record<string, unknown>;
    const prompt = normalizeInputString(transformed.prompt);
    if (!prompt) {
      return payload;
    }
    return {
      ...payload,
      messages: [{ role: 'user', content: prompt }],
      tools: undefined
    };
  } catch {
    return payload;
  }
}

export function extractForwardAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lowered = key.toLowerCase();
    if (lowered === 'authorization' || lowered === 'cookie') {
      out[key] = value;
    }
  }
  return out;
}

export function classifyQwenChatProviderIdentity(input: {
  providerFamily?: string;
  providerId?: string;
  providerKey?: string;
  compatibilityProfile?: string;
}): boolean {
  const candidates = [
    normalizeInputString(input.providerFamily).toLowerCase(),
    normalizeInputString(input.providerId).toLowerCase(),
    normalizeInputString(input.providerKey).toLowerCase(),
    normalizeInputString(input.compatibilityProfile).toLowerCase()
  ].filter(Boolean);
  return candidates.some(
    (value) =>
      value === 'qwenchat' ||
      value.startsWith('qwenchat.') ||
      value.includes('qwenchat') ||
      value === 'chat:qwenchat-web'
  );
}

function applyStandardizedTextHarvestToChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const harvested = processChatResponseTools(payload as any);
    return isRecord(harvested) ? harvested : payload;
  } catch {
    return payload;
  }
}

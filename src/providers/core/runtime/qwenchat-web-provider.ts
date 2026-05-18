import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderContext, ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import {
  createQwenChatProviderError,
  isQwenWafHtmlPayload,
  parseIncomingMessagesForQwenChat,
} from './qwenchat-web-payload.js';

type QwenChatCreateResponse = {
  success?: boolean;
  data?: {
    id?: string;
  };
  [key: string]: unknown;
};

type QwenAttachment = {
  source: string;
  filename?: string;
  mimeType?: string;
  explicitType?: string;
};

type LoadedQwenAttachment = {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  explicitType?: string;
};

type QwenUploadTokenData = {
  file_url?: string;
  file_id?: string;
  access_key_id?: string;
  access_key_secret?: string;
  security_token?: string;
  [key: string]: unknown;
};

type QwenUpstreamJsonError = {
  success?: boolean;
  request_id?: string;
  data?: {
    code?: string;
    details?: string;
    [key: string]: unknown;
  };
  msg?: string;
  [key: string]: unknown;
};

const QWENCHAT_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const QWENCHAT_WEB_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeBase64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function parseDataUrl(value: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/i.exec(value);
  if (!match) {
    return null;
  }
  const mimeType = readString(match[1]) || 'application/octet-stream';
  const encoded = match[2] || '';
  return {
    mimeType,
    bytes: decodeBase64ToBytes(encoded)
  };
}

function inferFilename(filename: string | undefined, mimeType: string): string {
  const normalized = readString(filename);
  if (normalized) {
    return normalized;
  }
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) {
    return `image.${mime.split('/')[1] || 'bin'}`;
  }
  if (mime.startsWith('audio/')) {
    return `audio.${mime.split('/')[1] || 'bin'}`;
  }
  if (mime.startsWith('video/')) {
    return `video.${mime.split('/')[1] || 'bin'}`;
  }
  return 'attachment.bin';
}

function inferFileCategory(mimeType: string, explicitType?: string): 'image' | 'audio' | 'video' | 'document' {
  const explicit = readString(explicitType).toLowerCase();
  if (explicit === 'image') {
    return 'image';
  }
  if (explicit === 'audio') {
    return 'audio';
  }
  if (explicit === 'video') {
    return 'video';
  }
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  return 'document';
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return createHash('sha256').update(input).digest('hex');
}

function hmacSha256(key: Buffer | string, input: string): Buffer {
  return createHmac('sha256', key).update(input).digest();
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

function extractUploadedFileId(fileUrl: string): string {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0] || randomUUID();
    }
  } catch {
    // ignore
  }
  return randomUUID();
}

function buildQwenFilePayload(file: LoadedQwenAttachment, tokenData: QwenUploadTokenData, filetype: string): Record<string, unknown> {
  const now = Date.now();
  const id = readString(tokenData.file_id) || extractUploadedFileId(readString(tokenData.file_url));
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : (filetype === 'image' ? 'vision' : filetype);
  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: { name: file.filename, size: file.bytes.length, content_type: file.mimeType },
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

function createProviderError(
  code: string,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>
): Error {
  return createQwenChatProviderError(code, message, statusCode, details);
}

type ParsedQwenSse = {
  content: string;
  reasoningContent: string;
  usage?: Record<string, unknown>;
};

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const type = readString(item.type).toLowerCase();
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = readString(item.text);
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts.join('\n').trim();
}

function parseQwenSsePayload(rawPayload: string): ParsedQwenSse {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let usage: Record<string, unknown> | undefined;

  for (const line of rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (isRecord(parsed.usage)) {
        usage = parsed.usage;
      }
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const firstChoice = choices[0];
      if (!isRecord(firstChoice)) {
        continue;
      }
      const delta = isRecord(firstChoice.delta) ? firstChoice.delta : undefined;
      const content = readString(delta?.content);
      if (content) {
        contentParts.push(content);
      }
      const directReasoning = readString(delta?.reasoning_content) || readString(delta?.reasoning);
      if (directReasoning) {
        reasoningParts.push(directReasoning);
        continue;
      }
      const phase = readString(delta?.phase);
      if (phase === 'thinking_summary') {
        const extra = isRecord(delta?.extra) ? delta.extra : undefined;
        const summaryThought = isRecord(extra?.summary_thought) ? extra.summary_thought : undefined;
        const summaryContent = Array.isArray(summaryThought?.content) ? summaryThought.content : [];
        const fragments = summaryContent
          .map((item) => {
            if (typeof item === 'string') {
              return item.trim();
            }
            if (isRecord(item)) {
              return readString(item.text) || readString(item.content) || readString(item.value);
            }
            return '';
          })
          .filter(Boolean);
        if (fragments.length > 0) {
          reasoningParts.push(fragments.join('\n'));
        }
      }
    } catch {
      continue;
    }
  }

  const content = contentParts.join('').trim();
  const reasoningContent = reasoningParts.join('\n').trim();
  return {
    content: content || reasoningContent,
    reasoningContent,
    usage
  };
}

function parseQwenSseEmbeddedError(rawPayload: string): QwenUpstreamJsonError | null {
  for (const line of rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const error = isRecord(parsed.error) ? parsed.error : undefined;
      if (error) {
        const code = readString(error.code) || 'unknown_error';
        const details = readString(error.details) || readString(error.message);
        return {
          success: false,
          data: {
            code,
            details,
          },
        };
      }
      if (parsed.success === false) {
        return parsed as QwenUpstreamJsonError;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function mapUsageToOpenAi(usage?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function resolveRequestedModel(request: UnknownObject): string {
  const model = readString((request as { model?: unknown }).model);
  if (!model) {
    throw createProviderError('QWENCHAT_GUEST_MODEL_MISSING', 'QwenChat guest runtime missing model', 400);
  }
  return model;
}

function buildBaxiaPayload(): Record<string, unknown> {
  return {
    p: 'MacIntel',
    l: 'zh-CN',
    hc: 8,
    dm: 8,
    to: -480,
    sw: 1728,
    sh: 1117,
    cd: 24,
    pr: 2,
    wf: 'ANGLE (Intel, Intel',
    cf: randomUUID().replace(/-/g, '').slice(0, 32),
    af: '124.04347527516074',
    ts: Date.now(),
    r: Math.random()
  };
}

async function resolveGuestBaxiaHeaders(baseHeaders: Record<string, string>): Promise<Record<string, string>> {
  const next = { ...baseHeaders };
  for (const key of [
    'Authorization',
    'authorization',
    'X-DashScope-CacheControl',
    'x-dashscope-cachecontrol',
    'X-DashScope-UserAgent',
    'x-dashscope-useragent',
    'X-DashScope-AuthType',
    'x-dashscope-authtype',
    'X-Stainless-Timeout',
    'x-stainless-timeout',
    'X-Stainless-Runtime-Version',
    'x-stainless-runtime-version',
    'X-Stainless-Lang',
    'x-stainless-lang',
    'X-Stainless-Arch',
    'x-stainless-arch',
    'X-Stainless-Package-Version',
    'x-stainless-package-version',
    'X-Stainless-Retry-Count',
    'x-stainless-retry-count',
    'X-Stainless-OS',
    'x-stainless-os',
    'X-Stainless-Runtime',
    'x-stainless-runtime',
    'originator',
    'Originator',
    'session_id',
    'conversation_id',
    'Origin'
  ]) {
    delete next[key];
  }
  next['User-Agent'] = QWENCHAT_WEB_USER_AGENT;
  next['Accept-Language'] = QWENCHAT_WEB_ACCEPT_LANGUAGE;
  if (!readString(next['bx-v'])) {
    next['bx-v'] = '2.5.36';
  }
  if (!readString(next['bx-ua'])) {
    const token = Buffer.from(JSON.stringify(buildBaxiaPayload()), 'utf8').toString('base64');
    next['bx-ua'] = `${next['bx-v'].replace(/\./g, '')}!${token}`;
  }
  if (!readString(next['bx-umidtoken'])) {
    try {
      const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
        headers: {
          'User-Agent': QWENCHAT_WEB_USER_AGENT
        }
      });
      const etag = readString(resp.headers.get('etag'));
      next['bx-umidtoken'] = etag || `T2gA${randomUUID().replace(/-/g, '')}`;
    } catch {
      next['bx-umidtoken'] = `T2gA${randomUUID().replace(/-/g, '')}`;
    }
  }
  next.Referer = 'https://chat.qwen.ai/c/guest';
  next.source = 'web';
  return next;
}

async function getAttachmentBytes(attachment: QwenAttachment): Promise<LoadedQwenAttachment> {
  const parsed = parseDataUrl(attachment.source);
  if (parsed) {
    const mimeType = readString(attachment.mimeType) || parsed.mimeType;
    return {
      bytes: parsed.bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  if (/^https?:\/\//i.test(attachment.source)) {
    const resp = await fetch(attachment.source);
    if (!resp.ok) {
      throw createProviderError('QWENCHAT_GUEST_ATTACHMENT_FETCH_FAILED', `Failed to fetch attachment URL: ${resp.status}`, 502);
    }
    const mimeType = readString(attachment.mimeType) || readString(resp.headers.get('content-type')) || 'application/octet-stream';
    return {
      bytes: new Uint8Array(await resp.arrayBuffer()),
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  const mimeType = readString(attachment.mimeType) || 'application/octet-stream';
  return {
    bytes: decodeBase64ToBytes(attachment.source.replace(/\s+/g, '')),
    mimeType,
    filename: inferFilename(attachment.filename, mimeType),
    explicitType: attachment.explicitType
  };
}

async function requestUploadToken(file: LoadedQwenAttachment, headers: Record<string, string>): Promise<{ tokenData: QwenUploadTokenData; filetype: string }> {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  const resp = await fetch('https://chat.qwen.ai/api/v2/files/getstsToken', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': QWENCHAT_WEB_USER_AGENT,
      'Accept-Language': QWENCHAT_WEB_ACCEPT_LANGUAGE,
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v'],
      source: 'web',
      timezone: new Date().toUTCString(),
      Referer: 'https://chat.qwen.ai/',
      'x-request-id': randomUUID()
    },
    body: JSON.stringify({ filename: file.filename, filesize: file.bytes.length, filetype })
  });
  const raw = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    throw createProviderError('QWENCHAT_GUEST_UPLOAD_TOKEN_PARSE_FAILED', 'QwenChat guest upload token response was not valid JSON', 502, { raw: raw.slice(0, 2000) });
  }
  const tokenData = isRecord(data.data) ? data.data as QwenUploadTokenData : undefined;
  if (!resp.ok || data.success !== true || !tokenData?.file_url) {
    throw createProviderError('QWENCHAT_GUEST_UPLOAD_TOKEN_FAILED', 'QwenChat guest failed to get upload token', resp.status || 502, { response: data });
  }
  return { tokenData, filetype };
}

async function buildOssSignedHeaders(uploadUrlWithQuery: string, tokenData: QwenUploadTokenData, file: LoadedQwenAttachment): Promise<Record<string, string>> {
  const parsedUrl = new URL(uploadUrlWithQuery);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');
  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();
  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts[0] || '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders = [
    `content-type:${file.mimeType}`,
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    `x-oss-date:${xOssDate}`,
    `x-oss-security-token:${readString(tokenData.security_token)}`,
    `x-oss-user-agent:${xOssUserAgent}`
  ].join('\n') + '\n';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = ['OSS4-HMAC-SHA256', xOssDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacSha256(`aliyun_v4${readString(tokenData.access_key_secret)}`, dateScope);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 'oss');
  const kSigning = hmacSha256(kService, 'aliyun_v4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    Accept: '*/*',
    'Content-Type': file.mimeType,
    authorization: `OSS4-HMAC-SHA256 Credential=${readString(tokenData.access_key_id)}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': readString(tokenData.security_token),
    'x-oss-user-agent': xOssUserAgent,
    Referer: 'https://chat.qwen.ai/'
  };
}

async function uploadFileToQwenOss(file: LoadedQwenAttachment, tokenData: QwenUploadTokenData): Promise<void> {
  const uploadUrl = readString(tokenData.file_url).split('?')[0];
  if (!uploadUrl) {
    throw createProviderError('QWENCHAT_GUEST_UPLOAD_URL_MISSING', 'QwenChat guest upload token missing file_url', 502);
  }
  const signedHeaders = await buildOssSignedHeaders(readString(tokenData.file_url), tokenData, file);
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: Buffer.from(file.bytes)
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw createProviderError('QWENCHAT_GUEST_ATTACHMENT_UPLOAD_FAILED', `QwenChat guest attachment upload failed with status ${resp.status}`, resp.status || 502, { detail: detail.slice(0, 2000) });
  }
}

async function ensureUploadStatusForNonVideo(filetype: string, headers: Record<string, string>): Promise<void> {
  if (filetype === 'video') {
    return;
  }
  let lastPayload: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const resp = await fetch('https://chat.qwen.ai/api/v2/users/status', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': QWENCHAT_WEB_USER_AGENT,
        'Accept-Language': QWENCHAT_WEB_ACCEPT_LANGUAGE,
        'bx-v': headers['bx-v'],
        source: 'web',
        timezone: new Date().toUTCString(),
        Referer: 'https://chat.qwen.ai/',
        'x-request-id': randomUUID()
      },
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
    const raw = await resp.text();
    if (!resp.ok) {
      throw createProviderError('QWENCHAT_GUEST_UPLOAD_STATUS_FAILED', `QwenChat guest upload status failed with status ${resp.status}`, resp.status || 502, { raw: raw.slice(0, 2000) });
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    lastPayload = payload;
    if (payload.data === true) {
      return;
    }
    if (attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw createProviderError('QWENCHAT_GUEST_UPLOAD_STATUS_NOT_READY', 'QwenChat guest upload status never became ready', 502, { response: lastPayload as Record<string, unknown> | undefined });
}

async function uploadAttachments(attachments: QwenAttachment[], headers: Record<string, string>): Promise<Record<string, unknown>[]> {
  const files: Record<string, unknown>[] = [];
  for (const attachment of attachments) {
    const loaded = await getAttachmentBytes(attachment);
    const { tokenData, filetype } = await requestUploadToken(loaded, headers);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
    await ensureUploadStatusForNonVideo(filetype, headers);
    files.push(qwenFilePayload);
  }
  return files;
}

function parseQwenUpstreamJsonError(rawPayload: string): QwenUpstreamJsonError | null {
  const trimmed = rawPayload.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as QwenUpstreamJsonError;
    if (parsed && typeof parsed === 'object' && parsed.success === false) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export class QwenChatWebProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'qwenchat',
        baseUrl: readString(config.config.baseUrl) || 'https://chat.qwen.ai',
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: '/api/v2/chat/completions'
        }
      }
    };
    super(cfg, dependencies, 'openai-http-provider');
  }

  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultBaseUrl: 'https://chat.qwen.ai',
      defaultEndpoint: '/api/v2/chat/completions'
    };
  }

  protected override wantsUpstreamSse(_request: UnknownObject, _context: ProviderContext): boolean {
    return false;
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    try {
      console.warn('[qwenchat.debug] sendRequestInternal.enter', JSON.stringify({
        model: typeof request.model === 'string' ? request.model : null,
        hasMessages: Array.isArray((request as { messages?: unknown }).messages),
        requestKeys: Object.keys(request || {}).slice(0, 20)
      }));
    } catch {
      // non-blocking debug
    }
    const context = this.createProviderContext();
    const model = resolveRequestedModel(request);
    const parsedMessages = parseIncomingMessagesForQwenChat(request);
    const baseHeaders = await this.buildRequestHeaders();
    const finalizedHeaders = await this.finalizeRequestHeaders(baseHeaders, request);
    const headers = await resolveGuestBaxiaHeaders(finalizedHeaders);

    const createHeaders = {
      ...headers,
      Accept: 'application/json',
      'x-request-id': randomUUID()
    };

    const createResp = await this.httpClient.post('/api/v2/chats/new', {
      title: '新建对话',
      models: [model],
      chat_mode: 'guest',
      chat_type: parsedMessages.chatType,
      timestamp: Date.now(),
      project_id: ''
    }, createHeaders);

    const createRawText = typeof createResp.data === 'string' ? createResp.data : '';
    if (createRawText && isQwenWafHtmlPayload(createRawText)) {
      throw createProviderError(
        'QWENCHAT_GUEST_WAF_CHALLENGE',
        'QwenChat guest create-chat returned Aliyun WAF HTML challenge instead of JSON',
        502,
        {
          stage: 'create_chat',
          raw: createRawText.slice(0, 4000)
        }
      );
    }
    const createData = isRecord(createResp.data) ? (createResp.data as QwenChatCreateResponse) : undefined;
    const chatId = readString(createData?.data?.id);
    if (createResp.status !== 200 || createData?.success !== true || !chatId) {
      try {
        console.warn('[qwenchat.debug] create-chat.contract-failed', JSON.stringify({
          status: createResp.status || null,
          contentType: createResp.headers?.['content-type'] || createResp.headers?.['Content-Type'] || null,
          bodyType: typeof createResp.data,
          rawHead: typeof createResp.data === 'string' ? createResp.data.slice(0, 400) : null,
          success: createData?.success === true,
          hasChatId: Boolean(chatId)
        }));
      } catch {
        // non-blocking debug
      }
      throw createProviderError(
        'QWENCHAT_GUEST_CREATE_CHAT_FAILED',
        'QwenChat guest failed to create chat session',
        createResp.status || 502,
        {
          response: createResp.data as Record<string, unknown> | undefined
        }
      );
    }

    const requestId = randomUUID();
    const uploadedFiles = parsedMessages.attachments.length > 0
      ? await uploadAttachments(parsedMessages.attachments, headers)
      : [];
    const completionHeaders = {
      ...headers,
      Accept: 'application/json',
      version: '0.2.9',
      'x-request-id': requestId
    };

    const body = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'guest',
      model,
      parent_id: null,
      messages: [
        {
          fid: randomUUID(),
          parentId: null,
          childrenIds: [randomUUID()],
          role: 'user',
          content: parsedMessages.content,
          user_action: 'chat',
          files: uploadedFiles,
          timestamp: Date.now(),
          models: [model],
          chat_type: parsedMessages.chatType,
          feature_config: {
            thinking_enabled: true,
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: true,
            thinking_format: 'summary',
            auto_search: true
          },
          extra: { meta: { subChatType: parsedMessages.chatType } },
          sub_chat_type: parsedMessages.chatType,
          parent_id: null
        }
      ],
      timestamp: Date.now()
    };

    const stream = await this.httpClient.postStream(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, body, {
      ...completionHeaders,
      Accept: 'text/event-stream'
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as Readable) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(Buffer.from(String(chunk), 'utf8'));
      }
    }
    const rawPayload = Buffer.concat(chunks).toString('utf8');
    try {
      console.warn('[qwenchat.debug] completion.raw.head', JSON.stringify({
        chatId,
        requestId,
        rawHead: rawPayload.slice(0, 400)
      }));
    } catch {
      // non-blocking debug
    }
    if (isQwenWafHtmlPayload(rawPayload)) {
      throw createProviderError(
        'QWENCHAT_GUEST_WAF_CHALLENGE',
        'QwenChat guest upstream returned Aliyun WAF HTML challenge instead of SSE',
        502,
        {
          raw: rawPayload.slice(0, 4000)
        }
      );
    }
    const upstreamJsonError = parseQwenUpstreamJsonError(rawPayload) || parseQwenSseEmbeddedError(rawPayload);
    if (upstreamJsonError) {
      throw createProviderError(
        'QWENCHAT_GUEST_UPSTREAM_REJECTED',
        `QwenChat guest upstream rejected request: ${readString(upstreamJsonError.data?.code) || readString(upstreamJsonError.msg) || 'unknown_error'}`,
        502,
        {
          response: upstreamJsonError as Record<string, unknown>
        }
      );
    }
    const parsed = parseQwenSsePayload(rawPayload);
    if (!parsed.content && !parsed.reasoningContent) {
      throw createProviderError(
        'QWENCHAT_GUEST_EMPTY_COMPLETION',
        'QwenChat guest completion returned empty SSE payload',
        502,
        {
          raw: rawPayload.slice(0, 4000)
        }
      );
    }

    const responsePayload: Record<string, unknown> = {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: parsed.content,
            ...(parsed.reasoningContent ? { reasoning_content: parsed.reasoningContent } : {})
          },
          finish_reason: 'stop'
        }
      ],
      ...(mapUsageToOpenAi(parsed.usage) ? { usage: mapUsageToOpenAi(parsed.usage) } : {})
    };

    const runtimeMetadata = extractProviderRuntimeMetadata(request);
    if (runtimeMetadata) {
      responsePayload.__routecodex_qwenchat_guest = {
        chatId,
        requestId,
        runtimeKey: runtimeMetadata.runtimeKey || null
      };
    }
    try {
      console.warn('[qwenchat.debug] sendRequestInternal.return', JSON.stringify({
        chatId,
        requestId,
        responseKeys: Object.keys(responsePayload),
        object: responsePayload.object,
        hasChoices: Array.isArray(responsePayload.choices)
      }));
    } catch {
      // non-blocking debug
    }
    return responsePayload;
  }
}

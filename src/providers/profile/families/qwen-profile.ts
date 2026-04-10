import type {
  ApplyRequestHeadersInput,
  BuildRequestBodyInput,
  ProviderFamilyProfile,
  ResolveEndpointInput,
  ResolveOAuthTokenFileInput,
  ResolveUserAgentInput
} from '../profile-contracts.js';
import {
  buildQwenStainlessHeaderEntries,
  resolveQwenCodeUserAgent
} from '../../core/utils/qwen-client-fingerprint.js';

type UnknownRecord = Record<string, unknown>;
type QwenMessageNode = Record<string, unknown>;

const QWEN_CODE_SERVICE_NAME = 'qwen-code';
const QWEN_OAUTH_AUTH_TYPE = 'qwen-oauth';
const QWEN_OAUTH_CODER_MODEL = 'coder-model';
const QWEN_OAUTH_VISION_MODEL = 'vision-model';
const QWEN_OAUTH_MAX_TOKENS = 65536;
const QWEN_WEB_SEARCH_ENDPOINT = '/api/v1/indices/plugin/web_search';
function buildDefaultQwenSystemPart(): UnknownRecord {
  return {
    type: 'text',
    text: '',
    cache_control: { type: 'ephemeral' }
  };
}

function assignHeader(headers: Record<string, string>, target: string, value: string): void {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    return;
  }
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      headers[key] = normalizedValue;
      return;
    }
  }
  headers[target] = normalizedValue;
}

function findHeaderValue(headers: Record<string, string>, target: string): string | undefined {
  const lowered = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

function deleteHeaderInsensitive(headers: Record<string, string>, target: string): void {
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      delete headers[key];
    }
  }
}

function resolveDashScopeAuthType(input: ApplyRequestHeadersInput): string {
  const fromEnv = (process.env.ROUTECODEX_QWEN_DASHSCOPE_AUTH_TYPE || process.env.RCC_QWEN_DASHSCOPE_AUTH_TYPE || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  const runtimeAuthType =
    input.runtimeMetadata && typeof input.runtimeMetadata.authType === 'string'
      ? input.runtimeMetadata.authType.trim()
      : '';
  if (runtimeAuthType) {
    return runtimeAuthType;
  }

  return 'qwen-oauth';
}

function hasConfiguredOAuthClient(auth: ResolveOAuthTokenFileInput['auth']): boolean {
  return !!auth.clientId || !!auth.tokenUrl || !!auth.deviceCodeUrl;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toTextPart(text: string): UnknownRecord {
  return {
    type: 'text',
    text
  };
}

function isInjectedSystemPart(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type !== 'text') {
    return false;
  }
  const cacheControl = isRecord(value.cache_control) ? value.cache_control : undefined;
  const cacheType = typeof cacheControl?.type === 'string' ? cacheControl.type.trim().toLowerCase() : '';
  if (cacheType !== 'ephemeral') {
    return false;
  }
  const text = typeof value.text === 'string' ? value.text : '';
  return text === '' || text === 'You are Qwen Code.';
}

function appendSystemContent(systemParts: UnknownRecord[], content: unknown): void {
  if (content == null) {
    return;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        systemParts.push(toTextPart(item));
        continue;
      }
      if (isRecord(item)) {
        if (isInjectedSystemPart(item)) {
          continue;
        }
        systemParts.push(item);
        continue;
      }
      systemParts.push(toTextPart(String(item)));
    }
    return;
  }

  if (typeof content === 'string') {
    systemParts.push(toTextPart(content));
    return;
  }

  if (isRecord(content)) {
    if (!isInjectedSystemPart(content)) {
      systemParts.push(content);
    }
    return;
  }

  systemParts.push(toTextPart(String(content)));
}

function normalizeQwenOAuthMessages(body: UnknownRecord): void {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: UnknownRecord[] = [buildDefaultQwenSystemPart()];
  const nonSystemMessagesRaw: QwenMessageNode[] = [];

  for (const node of rawMessages) {
    if (!isRecord(node)) {
      continue;
    }
    const role = typeof node.role === 'string' ? node.role.trim().toLowerCase() : '';
    if (role === 'system') {
      appendSystemContent(systemParts, node.content);
      continue;
    }
    nonSystemMessagesRaw.push(node);
  }

  body.messages = [
    {
      role: 'system',
      content: systemParts
    },
    ...nonSystemMessagesRaw
  ];
}

function getRequestMetadata(request: unknown): UnknownRecord | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  return isRecord(request.metadata) ? request.metadata : undefined;
}

function isQwenWebSearchRequest(input: ResolveEndpointInput | BuildRequestBodyInput): boolean {
  const metadata = getRequestMetadata(input.request);
  return metadata?.qwenWebSearch === true;
}

function normalizeQwenWebSearchEndpoint(value: unknown): string {
  if (typeof value !== 'string') {
    return QWEN_WEB_SEARCH_ENDPOINT;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return QWEN_WEB_SEARCH_ENDPOINT;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.includes('/indices/plugin/web_search')) {
    return trimmed;
  }
  return QWEN_WEB_SEARCH_ENDPOINT;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function buildQwenWebSearchBody(input: BuildRequestBodyInput): UnknownRecord {
  const sourceBody =
    isRecord(input.request) && isRecord(input.request.data)
      ? input.request.data
      : isRecord(input.defaultBody)
        ? input.defaultBody
        : {};
  const body: UnknownRecord = { ...sourceBody };
  const queryRaw =
    typeof body.uq === 'string' && body.uq.trim()
      ? body.uq.trim()
      : typeof body.query === 'string' && body.query.trim()
        ? body.query.trim()
        : '';
  body.uq = queryRaw;
  body.page = toPositiveInt(body.page, 1);
  body.rows = toPositiveInt(body.rows ?? body.count, 10);
  delete body.query;
  delete body.count;
  delete body.metadata;
  delete body.qwenWebSearch;
  delete body.entryEndpoint;
  delete body.model;
  delete body.messages;
  delete body.tools;
  delete body.stream;
  delete body.max_tokens;
  delete body.maxTokens;
  return body;
}

function extractAuthType(input: BuildRequestBodyInput): string {
  const runtimeType =
    input.runtimeMetadata && typeof input.runtimeMetadata.authType === 'string'
      ? input.runtimeMetadata.authType
      : '';
  if (runtimeType.trim()) {
    return runtimeType.trim().toLowerCase();
  }
  const metadataNode = isRecord(input.request) && isRecord(input.request.metadata) ? input.request.metadata : undefined;
  const metadataType = typeof metadataNode?.authType === 'string' ? metadataNode.authType : '';
  return metadataType.trim().toLowerCase();
}

function isQwenOAuthAuthType(authType: string): boolean {
  const normalized = authType.trim().toLowerCase();
  return normalized === QWEN_OAUTH_AUTH_TYPE || normalized === 'oauth';
}

function resolveQwenOAuthModel(requestedModel: string): string {
  const normalized = requestedModel.trim().toLowerCase();
  if (normalized === QWEN_OAUTH_VISION_MODEL) {
    return QWEN_OAUTH_VISION_MODEL;
  }
  if (normalized === QWEN_OAUTH_CODER_MODEL) {
    return QWEN_OAUTH_CODER_MODEL;
  }
  if (normalized.includes('vision') || normalized.includes('-vl')) {
    return QWEN_OAUTH_VISION_MODEL;
  }
  return QWEN_OAUTH_CODER_MODEL;
}

function clampQwenOAuthMaxTokens(body: UnknownRecord): void {
  const clampValue = (key: 'max_tokens' | 'max_output_tokens') => {
    const raw = body[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > QWEN_OAUTH_MAX_TOKENS) {
      body[key] = QWEN_OAUTH_MAX_TOKENS;
      return;
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed) && parsed > QWEN_OAUTH_MAX_TOKENS) {
        body[key] = QWEN_OAUTH_MAX_TOKENS;
      }
    }
  };
  clampValue('max_tokens');
  clampValue('max_output_tokens');
}

function hasNonEmptyTools(body: UnknownRecord): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function resolveQwenOAuthProviderProtocol(input: BuildRequestBodyInput): string {
  const runtimeProtocol =
    input.runtimeMetadata && typeof input.runtimeMetadata.providerProtocol === 'string'
      ? input.runtimeMetadata.providerProtocol.trim()
      : '';
  if (runtimeProtocol) {
    return runtimeProtocol;
  }
  const metadata = getRequestMetadata(input.request);
  const metadataProtocol = typeof metadata?.providerProtocol === 'string' ? metadata.providerProtocol.trim() : '';
  return metadataProtocol;
}

function resolveQwenOAuthReasoningEffort(body: UnknownRecord, input: BuildRequestBodyInput): string {
  const direct = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim() : '';
  if (direct) {
    return direct;
  }
  const runtimeEffort =
    input.runtimeMetadata && typeof input.runtimeMetadata.reasoning_effort === 'string'
      ? input.runtimeMetadata.reasoning_effort.trim()
      : '';
  if (runtimeEffort) {
    return runtimeEffort;
  }
  const runtimeMetadataNode =
    input.runtimeMetadata && isRecord(input.runtimeMetadata.metadata) ? input.runtimeMetadata.metadata : undefined;
  const metadataEffort =
    typeof runtimeMetadataNode?.reasoning_effort === 'string' ? runtimeMetadataNode.reasoning_effort.trim() : '';
  if (metadataEffort) {
    return metadataEffort;
  }
  const requestMetadata = getRequestMetadata(input.request);
  return typeof requestMetadata?.reasoning_effort === 'string' ? requestMetadata.reasoning_effort.trim() : '';
}

function ensureQwenOAuthToolChoice(body: UnknownRecord): void {
  if (!hasNonEmptyTools(body)) {
    return;
  }
  const existing = body.tool_choice;
  if (typeof existing === 'string' && existing.trim()) {
    return;
  }
  if (isRecord(existing)) {
    return;
  }
  body.tool_choice = 'auto';
}

function normalizeQwenOAuthReasoning(body: UnknownRecord, input: BuildRequestBodyInput): void {
  if (body.reasoning === false) {
    return;
  }
  const providerProtocol = resolveQwenOAuthProviderProtocol(input).toLowerCase();
  const hasTools = hasNonEmptyTools(body);
  const shouldPromoteStructuredReasoning = providerProtocol === 'openai-chat' || hasTools;
  const effort = resolveQwenOAuthReasoningEffort(body, input) || (shouldPromoteStructuredReasoning ? 'high' : '');
  const current = body.reasoning;

  if (isRecord(current)) {
    if (!current.effort && effort) {
      current.effort = effort;
    }
    if (!current.summary && shouldPromoteStructuredReasoning) {
      current.summary = 'detailed';
    }
    return;
  }

  if (current === true || current == null) {
    if (!effort && !shouldPromoteStructuredReasoning) {
      return;
    }
    body.reasoning = {
      ...(effort ? { effort } : {}),
      ...(shouldPromoteStructuredReasoning ? { summary: 'detailed' } : {})
    };
  }
}

function mirrorQwenOAuthReasoningEffort(body: UnknownRecord): void {
  const existing = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim() : '';
  if (existing) {
    return;
  }
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const effort = typeof reasoning?.effort === 'string' ? reasoning.effort.trim() : '';
  if (effort) {
    body.reasoning_effort = effort;
  }
}

export const qwenFamilyProfile: ProviderFamilyProfile = {
  id: 'qwen/default',
  providerFamily: 'qwen',
  resolveEndpoint(input: ResolveEndpointInput): string | undefined {
    if (!isQwenWebSearchRequest(input)) {
      return undefined;
    }
    const metadata = getRequestMetadata(input.request);
    return normalizeQwenWebSearchEndpoint(metadata?.entryEndpoint);
  },
  buildRequestBody(input: BuildRequestBodyInput) {
    if (isQwenWebSearchRequest(input)) {
      return buildQwenWebSearchBody(input);
    }
    const authType = extractAuthType(input);
    if (authType && !isQwenOAuthAuthType(authType)) {
      return undefined;
    }
    const body = input.defaultBody;
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    const requestBody = body as UnknownRecord;
    const rawModel = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
    if (!rawModel) {
      return body;
    }
    const resolvedModel = resolveQwenOAuthModel(rawModel);
    if (resolvedModel && resolvedModel !== rawModel) {
      requestBody.model = resolvedModel;
    }
    clampQwenOAuthMaxTokens(requestBody);
    ensureQwenOAuthToolChoice(requestBody);
    normalizeQwenOAuthReasoning(requestBody, input);
    mirrorQwenOAuthReasoningEffort(requestBody);
    normalizeQwenOAuthMessages(requestBody);
    return body;
  },
  resolveUserAgent(input: ResolveUserAgentInput): string | undefined {
    return resolveQwenCodeUserAgent();
  },
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> {
    const headers = { ...(input.headers || {}) };

    const resolvedUserAgent = resolveQwenCodeUserAgent();
    assignHeader(headers, 'User-Agent', resolvedUserAgent);

    // Keep request headers consistent with Qwen Code DashScope-compatible client behavior.
    assignHeader(headers, 'X-DashScope-CacheControl', 'enable');
    assignHeader(headers, 'X-DashScope-UserAgent', resolvedUserAgent);
    assignHeader(headers, 'X-DashScope-AuthType', resolveDashScopeAuthType(input));
    for (const [key, value] of Object.entries(buildQwenStainlessHeaderEntries())) {
      assignHeader(headers, key, value);
    }

    // Align with Qwen CLI upstream shape: do not forward Codex session/originator headers.
    deleteHeaderInsensitive(headers, 'originator');
    deleteHeaderInsensitive(headers, 'session_id');
    deleteHeaderInsensitive(headers, 'conversation_id');

    // Remove legacy Gemini-style metadata headers for qwen requests.
    deleteHeaderInsensitive(headers, 'X-Goog-Api-Client');
    deleteHeaderInsensitive(headers, 'Client-Metadata');

    return headers;
  },
  resolveOAuthTokenFileMode(input: ResolveOAuthTokenFileInput): boolean | undefined {
    if (input.oauthProviderId !== 'qwen') {
      return undefined;
    }
    return !hasConfiguredOAuthClient(input.auth);
  }
};

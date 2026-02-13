import { createHmac } from 'node:crypto';
import type {
  ApplyRequestHeadersInput,
  BuildRequestBodyInput,
  ProviderFamilyProfile,
  ResolveBusinessResponseErrorInput,
  ResolveEndpointInput,
  ResolveOAuthTokenFileInput,
  ResolveUserAgentInput
} from '../profile-contracts.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getMetadata(request: unknown): UnknownRecord | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const metadata = request.metadata;
  return isRecord(metadata) ? metadata : undefined;
}

function isIflowWebSearch(input: ResolveEndpointInput | BuildRequestBodyInput): boolean {
  const metadata = getMetadata(input.request);
  return metadata?.iflowWebSearch === true;
}

function isKnownPublicEntryEndpoint(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return lowered === '/v1/messages'
    || lowered === '/v1/responses'
    || lowered === '/v1/chat/completions';
}

function normalizeIflowRetrieveEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }
  const pathOnly = trimmed.split('?')[0]?.replace(/\/+$/, '').toLowerCase();
  if (pathOnly === '/chat/retrieve') {
    return trimmed;
  }
  return undefined;
}

function shouldUseLegacyIflowWebSearchTransport(metadata?: UnknownRecord): boolean {
  const rawEntryEndpoint =
    typeof metadata?.entryEndpoint === 'string' && metadata.entryEndpoint.trim()
      ? metadata.entryEndpoint.trim()
      : '';
  if (!rawEntryEndpoint) {
    return true;
  }
  if (normalizeIflowRetrieveEndpoint(rawEntryEndpoint)) {
    return true;
  }
  if (isKnownPublicEntryEndpoint(rawEntryEndpoint)) {
    return false;
  }
  return true;
}

function normalizeHeaderKey(value: string): string {
  return value.replace(/[\s_-]+/g, '');
}

function findHeaderValue(headers: Record<string, string>, target: string): string | undefined {
  const lowered = typeof target === 'string' ? target.toLowerCase() : '';
  if (!lowered) {
    return undefined;
  }
  const normalizedTarget = normalizeHeaderKey(lowered);
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const loweredKey = key.toLowerCase();
    if (loweredKey === lowered || normalizeHeaderKey(loweredKey) === normalizedTarget) {
      return trimmed;
    }
  }
  return undefined;
}

function assignHeader(headers: Record<string, string>, target: string, value: string): void {
  if (!value || !value.trim()) {
    return;
  }
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      headers[key] = value;
      return;
    }
  }
  headers[target] = value;
}

function extractBearerApiKey(headers: Record<string, string>): string | undefined {
  const authorization = findHeaderValue(headers, 'Authorization');
  if (!authorization) {
    return undefined;
  }
  const matched = authorization.match(/^Bearer\s+(.+)$/i);
  if (!matched || !matched[1]) {
    return undefined;
  }
  const apiKey = matched[1].trim();
  return apiKey || undefined;
}

function buildIflowSignature(
  userAgent: string,
  sessionId: string,
  timestamp: string,
  apiKey: string
): string | undefined {
  if (!apiKey) {
    return undefined;
  }
  const payload = `${userAgent}:${sessionId}:${timestamp}`;
  try {
    return createHmac('sha256', apiKey).update(payload, 'utf8').digest('hex');
  } catch {
    return undefined;
  }
}

function readIflowBusinessErrorEnvelope(data: unknown): { code?: string; message: string } | null {
  if (!isRecord(data)) {
    return null;
  }

  const codeRaw = data.error_code ?? data.errorCode ?? data.code;
  const messageRaw =
    (typeof data.msg === 'string' && data.msg.trim().length
      ? data.msg
      : typeof data.message === 'string' && data.message.trim().length
        ? data.message
        : typeof data.error_message === 'string' && data.error_message.trim().length
          ? data.error_message
          : '') || '';

  const code =
    typeof codeRaw === 'string' && codeRaw.trim().length
      ? codeRaw.trim()
      : typeof codeRaw === 'number' && Number.isFinite(codeRaw)
        ? String(codeRaw)
        : '';

  const hasCode = code.length > 0 && code !== '0';
  const hasMessage = messageRaw.trim().length > 0;
  if (!hasCode && !hasMessage) {
    return null;
  }

  return {
    ...(hasCode ? { code } : {}),
    message: hasMessage ? messageRaw.trim() : 'iFlow upstream business error'
  };
}

function buildIflowBusinessEnvelopeError(
  envelope: { code?: string; message: string },
  data: Record<string, unknown>
): Error & {
  statusCode: number;
  status: number;
  code: string;
  response: { status: number; data: Record<string, unknown> };
} {
  const upstreamCode = envelope.code && envelope.code.trim().length ? envelope.code.trim() : 'iflow_business_error';
  const upstreamMessage = envelope.message;
  const errorMessage =
    'HTTP 400: iFlow business error (' + upstreamCode + ')' + (upstreamMessage ? ': ' + upstreamMessage : '');
  const error = new Error(errorMessage) as Error & {
    statusCode: number;
    status: number;
    code: string;
    response: { status: number; data: Record<string, unknown> };
  };

  error.statusCode = 400;
  error.status = 400;
  error.code = 'HTTP_400';
  error.response = {
    status: 400,
    data: {
      error: {
        code: upstreamCode,
        message: upstreamMessage
      },
      upstream: data
    }
  };
  return error;
}

function hasConfiguredOAuthClient(auth: ResolveOAuthTokenFileInput['auth']): boolean {
  return !!auth.clientId || !!auth.tokenUrl || !!auth.deviceCodeUrl;
}

export const iflowFamilyProfile: ProviderFamilyProfile = {
  id: 'iflow/default',
  providerFamily: 'iflow',
  resolveEndpoint(input: ResolveEndpointInput): string | undefined {
    if (!isIflowWebSearch(input)) {
      return undefined;
    }
    const metadata = getMetadata(input.request);
    const retrieveEndpoint = normalizeIflowRetrieveEndpoint(metadata?.entryEndpoint);
    if (retrieveEndpoint) {
      return retrieveEndpoint;
    }
    if (!shouldUseLegacyIflowWebSearchTransport(metadata)) {
      const fallbackDefault =
        typeof input.defaultEndpoint === 'string' && input.defaultEndpoint.trim()
          ? input.defaultEndpoint.trim()
          : '/chat/completions';
      return fallbackDefault;
    }
    return '/chat/retrieve';
  },
  buildRequestBody(input: BuildRequestBodyInput) {
    if (!isIflowWebSearch(input)) {
      return undefined;
    }
    const metadata = getMetadata(input.request);
    if (!shouldUseLegacyIflowWebSearchTransport(metadata)) {
      return isRecord(input.defaultBody) ? input.defaultBody : undefined;
    }

    const sourceBody =
      isRecord(input.request) && isRecord(input.request.data)
        ? input.request.data
        : isRecord(input.defaultBody)
          ? input.defaultBody
          : {};

    const body = { ...sourceBody };
    delete body.metadata;
    delete body.iflowWebSearch;
    delete body.entryEndpoint;
    return body;
  },
  resolveUserAgent(input: ResolveUserAgentInput): string | undefined {
    return input.uaFromConfig ?? input.uaFromService ?? input.inboundUserAgent ?? input.defaultUserAgent;
  },
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> {
    const headers = { ...(input.headers || {}) };
    const runtimeMetadata =
      input.runtimeMetadata && typeof input.runtimeMetadata === 'object' && !Array.isArray(input.runtimeMetadata)
        ? (input.runtimeMetadata as UnknownRecord)
        : undefined;
    const metadata =
      runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
        ? (runtimeMetadata.metadata as UnknownRecord)
        : undefined;
    const pickString = (...values: unknown[]): string | undefined => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    };

    const metadataSessionId = pickString(metadata?.sessionId, metadata?.session_id);
    const metadataConversationId = pickString(metadata?.conversationId, metadata?.conversation_id);
    const resolvedSessionId =
      pickString(
        findHeaderValue(headers, 'session-id'),
        findHeaderValue(headers, 'session_id'),
        metadataSessionId,
        metadataConversationId
      );
    const resolvedConversationId =
      pickString(
        findHeaderValue(headers, 'conversation-id'),
        findHeaderValue(headers, 'conversation_id'),
        metadataConversationId,
        metadataSessionId,
        resolvedSessionId
      );

    if (resolvedSessionId) {
      assignHeader(headers, 'session_id', resolvedSessionId);
      assignHeader(headers, 'session-id', resolvedSessionId);
    }
    if (resolvedConversationId) {
      assignHeader(headers, 'conversation_id', resolvedConversationId);
      assignHeader(headers, 'conversation-id', resolvedConversationId);
    }

    const resolvedOriginator =
      pickString(findHeaderValue(headers, 'originator'), metadata?.clientOriginator, metadata?.originator);
    if (resolvedOriginator) {
      assignHeader(headers, 'originator', resolvedOriginator);
    }

    const bearerApiKey = extractBearerApiKey(headers);
    if (!bearerApiKey) {
      return headers;
    }

    const userAgent = findHeaderValue(headers, 'User-Agent') ?? 'iFlow-Cli';
    const timestamp = Date.now().toString();
    const signature = buildIflowSignature(userAgent, resolvedSessionId ?? '', timestamp, bearerApiKey);
    if (!signature) {
      return headers;
    }

    assignHeader(headers, 'x-iflow-timestamp', timestamp);
    assignHeader(headers, 'x-iflow-signature', signature);
    return headers;
  },
  resolveBusinessResponseError(input: ResolveBusinessResponseErrorInput): Error | undefined {
    const payload =
      isRecord(input.response) && 'data' in input.response
        ? (input.response as { data?: unknown }).data
        : undefined;
    if (!isRecord(payload)) {
      return undefined;
    }

    const rawStatus = payload.status;
    const statusStr =
      typeof rawStatus === 'string' && rawStatus.trim().length
        ? rawStatus.trim()
        : typeof rawStatus === 'number'
          ? String(rawStatus)
          : '';
    const msg =
      (typeof payload.msg === 'string' && payload.msg.trim().length
        ? payload.msg
        : typeof payload.message === 'string' && payload.message.trim().length
          ? payload.message
          : '') || '';
    if (statusStr === '439' && /token has expired/i.test(msg)) {
      return new Error(msg);
    }

    const envelope = readIflowBusinessErrorEnvelope(payload);
    if (envelope) {
      return buildIflowBusinessEnvelopeError(envelope, payload);
    }

    return undefined;
  },
  resolveOAuthTokenFileMode(input: ResolveOAuthTokenFileInput): boolean | undefined {
    if (input.oauthProviderId !== 'iflow') {
      return undefined;
    }
    return !hasConfiguredOAuthClient(input.auth);
  }
};

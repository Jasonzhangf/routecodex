import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStreamIntentFromMetadata(value: unknown): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readBoolean(value.stream)
    ?? readBoolean(value.outboundStream)
    ?? readBoolean(value.inboundStream);
}

function readStreamIntentFromRequestMetadata(request: UnknownObject): boolean | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  return readStreamIntentFromMetadata(request.metadata);
}

function readStreamIntentFromRequestPayload(request: UnknownObject): boolean | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const direct = readBoolean(request.stream);
  if (typeof direct === 'boolean') {
    return direct;
  }
  if (isRecord(request.data)) {
    const dataStream = readBoolean(request.data.stream);
    if (typeof dataStream === 'boolean') {
      return dataStream;
    }
  }
  return undefined;
}

function resolveGenericStreamIntent(args: {
  request: UnknownObject;
  context?: ProviderContext;
  runtimeMetadata?: ProviderRuntimeMetadata;
}): boolean | undefined {
  const requestMetadataIntent = readStreamIntentFromRequestMetadata(args.request);
  const contextMetadataIntent = readStreamIntentFromMetadata(args.context?.metadata);
  const runtimeMetadataIntent = readStreamIntentFromMetadata(args.runtimeMetadata?.metadata);
  if (
    requestMetadataIntent === true
    || contextMetadataIntent === true
    || runtimeMetadataIntent === true
  ) {
    return true;
  }
  return readStreamIntentFromRequestPayload(args.request)
    ?? requestMetadataIntent
    ?? contextMetadataIntent
    ?? runtimeMetadataIntent;
}

function assertProviderOutboundBodyHasNoMetadata(body: UnknownObject, source: string): void {
  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    return;
  }
  throw new Error(`provider-runtime-error: metadata is not allowed in provider outbound body (${source})`);
}

export function resolveProviderWantsUpstreamSse(args: {
  request: UnknownObject;
  context: ProviderContext;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
}): boolean {
  const profileResolved = args.familyProfile?.resolveStreamIntent?.({
    request: args.request,
    context: args.context,
    runtimeMetadata: args.runtimeMetadata
  });
  if (typeof profileResolved === 'boolean') {
    return profileResolved;
  }
  return resolveGenericStreamIntent(args) === true;
}

export function applyProviderStreamModeHeaders(args: {
  headers: Record<string, string>;
  wantsSse: boolean;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
}): Record<string, string> {
  const normalized = { ...args.headers };
  const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');

  if (acceptKey) {
    delete normalized[acceptKey];
  }
  normalized['Accept'] = args.wantsSse ? 'text/event-stream' : 'application/json';

  const profileHeaders = args.familyProfile?.applyStreamModeHeaders?.({
    headers: normalized,
    wantsSse: args.wantsSse,
    runtimeMetadata: args.runtimeMetadata
  });
  if (profileHeaders && typeof profileHeaders === 'object') {
    return profileHeaders;
  }

  return normalized;
}

/**
 * 检测上游返回的常见业务错误模式（`base_resp.status_code`、`error_code`、`error.code` 等）。
 * 优先使用 family profile 的专用检测；无 profile 时使用通用检测。
 *
 * 检测到的错误会被 `http-request-executor.ts` 在 `sendRequestInternal` 内部抛出，
 * 从而被 `BaseProvider.sendRequest()` 的自动重试拦截器捕获。
 */
export function resolveProviderBusinessResponseError(args: {
  response: unknown;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
}): Error | undefined {
  // 1. 优先使用 family profile 的专用检测
  if (args.familyProfile?.resolveBusinessResponseError) {
    const profileError = args.familyProfile.resolveBusinessResponseError({
      response: args.response,
      runtimeMetadata: args.runtimeMetadata
    });
    if (profileError) {
      return profileError;
    }
  }

  // 2. 通用业务错误检测（不依赖 family profile）
  const responseRecord = args.response && typeof args.response === 'object' && !Array.isArray(args.response)
    ? (args.response as Record<string, unknown>)
    : undefined;
  if (!responseRecord) {
    return undefined;
  }

  const payloadRecord =
    responseRecord.data && typeof responseRecord.data === 'object' && !Array.isArray(responseRecord.data)
      ? (responseRecord.data as Record<string, unknown>)
      : responseRecord;

  // 格式 A: { base_resp: { status_code: NNNN, status_message: "..." } }
  // 常见于 MiniMax、GLM 等中国 provider
  const baseResp = payloadRecord.base_resp as Record<string, unknown> | undefined;
  if (baseResp && typeof baseResp === 'object') {
    const statusCode = baseResp.status_code;
    const statusMessage = typeof baseResp.status_message === 'string'
      ? baseResp.status_message.trim()
      : typeof baseResp.status_msg === 'string'
        ? baseResp.status_msg.trim()
        : `business error (status_code=${statusCode})`;
    if (typeof statusCode === 'number' && statusCode !== 0) {
      return Object.assign(
        new Error(`[provider] Upstream provider returned business error: ${statusMessage}`),
        {
          upstreamCode: `provider_status_${statusCode}`,
          code: 'MALFORMED_RESPONSE',
          statusCode: 200,
        }
      );
    }
  }

  // 格式 B: { error: { code: NNNN, message: "..." } }
  const errorNode = payloadRecord.error as Record<string, unknown> | undefined;
  if (errorNode && typeof errorNode === 'object') {
    const errorCode = errorNode.code;
    const errorMessage = typeof errorNode.message === 'string'
      ? errorNode.message.trim()
      : `business error (code=${errorCode})`;
    if (typeof errorCode === 'number' && errorCode > 0) {
      return Object.assign(
        new Error(`[provider] Upstream provider returned business error: ${errorMessage}`),
        {
          upstreamCode: `provider_status_${errorCode}`,
          code: 'MALFORMED_RESPONSE',
          statusCode: 200,
        }
      );
    }
  }

  // 格式 C: { error_code: NNNN, error_msg: "..." }
  // 常见于部分中国 provider 的顶层字段
  const topLevelErrorCode = payloadRecord.error_code;
  if (typeof topLevelErrorCode === 'number' && topLevelErrorCode > 0) {
    const errorMessage = typeof payloadRecord.error_msg === 'string'
      ? (payloadRecord.error_msg as string).trim()
      : typeof payloadRecord.message === 'string'
        ? (payloadRecord.message as string).trim()
        : `business error (error_code=${topLevelErrorCode})`;
    return Object.assign(
      new Error(`[provider] Upstream provider returned business error: ${errorMessage}`),
      {
        upstreamCode: `provider_status_${topLevelErrorCode}`,
        code: 'MALFORMED_RESPONSE',
        statusCode: 200,
      }
    );
  }

  return undefined;
}

export function resolveProviderRequestEndpoint(args: {
  request: UnknownObject;
  defaultEndpoint: string;
  protocolClient: HttpProtocolClient<ProtocolRequestPayload>;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
  legacyEndpoint?: string;
}): string {
  const protocolResolvedEndpoint = args.protocolClient.resolveEndpoint(
    args.request as ProtocolRequestPayload,
    args.defaultEndpoint
  );
  const profileResolvedEndpoint = args.familyProfile?.resolveEndpoint?.({
    request: args.request,
    defaultEndpoint: protocolResolvedEndpoint,
    runtimeMetadata: args.runtimeMetadata
  });
  if (typeof profileResolvedEndpoint === 'string' && profileResolvedEndpoint.trim()) {
    return profileResolvedEndpoint.trim();
  }
  if (args.legacyEndpoint) {
    return args.legacyEndpoint;
  }
  return protocolResolvedEndpoint;
}

export function buildProviderHttpRequestBody(args: {
  request: UnknownObject;
  protocolClient: HttpProtocolClient<ProtocolRequestPayload>;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
  legacyBody?: UnknownObject;
}): UnknownObject {
  const defaultBody = args.protocolClient.buildRequestBody(args.request as ProtocolRequestPayload) as UnknownObject;
  const profileBody = args.familyProfile?.buildRequestBody?.({
    request: args.request,
    defaultBody,
    runtimeMetadata: args.runtimeMetadata
  });
  if (profileBody && typeof profileBody === 'object') {
    const body = ensureGenericStreamField({
      body: profileBody as UnknownObject,
      request: args.request,
      runtimeMetadata: args.runtimeMetadata
    });
    assertProviderOutboundBodyHasNoMetadata(body, 'familyProfile.buildRequestBody');
    return body;
  }
  if (args.legacyBody && typeof args.legacyBody === 'object') {
    const body = ensureGenericStreamField({
      body: args.legacyBody,
      request: args.request,
      runtimeMetadata: args.runtimeMetadata
    });
    assertProviderOutboundBodyHasNoMetadata(body, 'legacyBody');
    return body;
  }
  const body = ensureGenericStreamField({
    body: defaultBody,
    request: args.request,
    runtimeMetadata: args.runtimeMetadata
  });
  assertProviderOutboundBodyHasNoMetadata(body, 'protocolClient.buildRequestBody');
  return body;
}

function ensureGenericStreamField(args: {
  body: UnknownObject;
  request: UnknownObject;
  runtimeMetadata?: ProviderRuntimeMetadata;
}): UnknownObject {
  if (resolveGenericStreamIntent({ request: args.request, runtimeMetadata: args.runtimeMetadata }) !== true) {
    return args.body;
  }
  if (!isRecord(args.body) || args.body.stream === true) {
    return args.body;
  }
  return {
    ...args.body,
    stream: true
  };
}

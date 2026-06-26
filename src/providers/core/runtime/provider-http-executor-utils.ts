import type { ProviderContext } from '../api/provider-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { extractStatusCodeFromError } from './provider-error-classifier.js';
import { normalizeKnownProviderError, PROVIDER_NETWORK_CODES } from './provider-error-catalog.js';
import { applyProviderConfiguredErrorMapping } from './provider-configured-error-mapping.js';
import { OAuthRecoveryHandler } from './transport/oauth-recovery-handler.js';
import type { HttpClient } from '../utils/http-client.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

function readSnapshotEntryPort(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const portContext =
    metadata.portContext && typeof metadata.portContext === 'object' && !Array.isArray(metadata.portContext)
      ? metadata.portContext as Record<string, unknown>
      : undefined;
  for (const value of [
    metadata.entryPort,
    metadata.matchedPort,
    metadata.routecodexLocalPort,
    metadata.localPort,
    metadata.portScope,
    portContext?.matchedPort,
    portContext?.localPort,
    portContext?.port
  ]) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'unknown_error';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown_error');
  }
}

function logProviderOAuthRecoveryNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const suffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[provider-oauth-recovery] ${stage} failed (non-blocking): ${summarizeUnknownError(error)}${suffix}`
    );
  } catch {
    // never throw from best-effort logging
  }
}

export async function tryRecoverOAuthAndReplay(options: {
  error: unknown;
  requestInfo: PreparedHttpRequest;
  processedRequest: UnknownObject;
  captureSse: boolean;
  context: ProviderContext;
  authProvider: IAuthProvider | null;
  oauthProviderId?: string;
  providerType: string;
  config: OpenAIStandardConfig;
  httpClient: HttpClient;
  buildRequestHeaders: () => Promise<Record<string, string>>;
  finalizeRequestHeaders: (headers: Record<string, string>, req: UnknownObject) => Promise<Record<string, string>>;
  applyStreamModeHeaders: (headers: Record<string, string>, wantsSse: boolean) => Record<string, string>;
  wrapUpstreamSseResponse: (stream: NodeJS.ReadableStream, ctx: ProviderContext) => Promise<UnknownObject>;
}): Promise<unknown | undefined> {
  try {
    const recovery = new OAuthRecoveryHandler({
      authProvider: options.authProvider,
      oauthProviderId: options.oauthProviderId,
      providerType: options.providerType,
      config: options.config,
      httpClient: options.httpClient
    });
    return await recovery.tryRecoverOAuthAndReplay(
      options.error,
      options.requestInfo,
      options.processedRequest,
      options.captureSse,
      options.context,
      options.buildRequestHeaders,
      options.finalizeRequestHeaders,
      options.applyStreamModeHeaders,
      options.wrapUpstreamSseResponse
    );
  } catch (error) {
    const auth = options.config?.config?.auth as
      | {
          type?: unknown;
          rawType?: unknown;
          tokenFile?: unknown;
          oauthProviderId?: unknown;
        }
      | undefined;
    logProviderOAuthRecoveryNonBlocking('tryRecoverOAuthAndReplay', error, {
      requestId: options.context.requestId,
      providerKey: options.context.providerKey,
      providerId: options.context.providerId,
      providerType: options.providerType,
      oauthProviderId: options.oauthProviderId ?? null,
      authType: typeof auth?.type === 'string' ? auth.type : null,
      authRawType: typeof auth?.rawType === 'string' ? auth.rawType : null,
      tokenFile: typeof auth?.tokenFile === 'string' ? auth.tokenFile : null,
      upstreamStatus: extractStatusCodeFromError(options.error as ProviderErrorAugmented) ?? null,
      upstreamCode:
        typeof (options.error as ProviderErrorAugmented | null | undefined)?.code === 'string'
          ? (options.error as ProviderErrorAugmented).code
          : null,
      upstreamMessage: summarizeUnknownError(options.error)
    });
    return undefined;
  }
}

export async function normalizeProviderHttpError(options: {
  error: unknown;
  processedRequest: UnknownObject;
  requestInfo: PreparedHttpRequest;
  context: ProviderContext;
}): Promise<ProviderErrorAugmented> {
  const normalized: ProviderErrorAugmented = options.error as ProviderErrorAugmented;
  try {
    const statusCode = extractStatusCodeFromError(normalized);
    const mappedStatusCode = applyProviderConfiguredErrorMapping({
      normalized,
      context: options.context,
      statusCode
    });
    const effectiveStatusCode = mappedStatusCode ?? statusCode;
    const inferredCatalog = normalizeKnownProviderError({
      statusCode: effectiveStatusCode,
      code: normalized.code,
      upstreamCode: normalized.response?.data?.error?.code,
      message: normalized.message
    });
    if (effectiveStatusCode && !Number.isNaN(effectiveStatusCode)) {
      normalized.statusCode = effectiveStatusCode;
      if (!normalized.status) {
        normalized.status = effectiveStatusCode;
      }
      if (!normalized.code) {
        normalized.code = `HTTP_${effectiveStatusCode}`;
      }
    }
    if (inferredCatalog) {
      if (!normalized.code) {
        normalized.code = inferredCatalog.key;
      }
      if (
        (!normalized.statusCode || Number.isNaN(normalized.statusCode))
        && (!normalized.status || Number.isNaN(normalized.status))
      ) {
        if (typeof inferredCatalog.status === 'number') {
          normalized.statusCode = inferredCatalog.status;
          normalized.status = inferredCatalog.status;
        } else if (PROVIDER_NETWORK_CODES.has(inferredCatalog.key)) {
          normalized.statusCode = 502;
          normalized.status = 502;
        }
      }
    }
    if (!normalized.response) {
      normalized.response = {};
    }
    if (!normalized.response.data) {
      normalized.response.data = {};
    }
    if (!normalized.response.data.error) {
      normalized.response.data.error = {};
    }
    const mapped = Boolean(normalized.details?.providerErrorMapping);
    if (normalized.code && (mapped || !normalized.response.data.error.code)) {
      normalized.response.data.error.code = normalized.code;
    }
    if (normalized.message && (mapped || !normalized.response.data.error.message)) {
      normalized.response.data.error.message = normalized.message;
    }
    if (typeof normalized.status === 'number' && (mapped || !normalized.response.data.error.status)) {
      normalized.response.data.error.status = normalized.status;
    }
  } catch {
    // keep original error shape when normalization fails
  }

  try {
    await writeProviderSnapshot({
      phase: 'provider-error',
      requestId: options.context.requestId,
      data: {
        status: normalized?.statusCode ?? normalized?.status ?? null,
        code: normalized?.code ?? null,
        error: typeof normalized?.message === 'string' ? normalized.message : String(options.error || '')
      },
      headers: options.requestInfo.headers,
      url: options.requestInfo.targetUrl,
      entryEndpoint:
        options.requestInfo.entryEndpoint
        ?? ProviderPayloadUtils.extractEntryEndpointFromPayload(options.processedRequest),
      entryPort: readSnapshotEntryPort(options.context.metadata),
      clientRequestId:
        options.requestInfo.clientRequestId
        ?? ProviderPayloadUtils.getClientRequestIdFromContext(options.context),
      providerKey: options.context.providerKey,
      providerId: options.context.providerId
    });
  } catch {
    // snapshot is best-effort only
  }

  return normalized;
}

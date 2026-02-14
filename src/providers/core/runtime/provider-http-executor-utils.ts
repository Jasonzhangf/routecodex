import type { ProviderContext } from '../api/provider-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { extractStatusCodeFromError } from './provider-error-classifier.js';
import { OAuthRecoveryHandler } from './transport/oauth-recovery-handler.js';
import type { HttpClient } from '../utils/http-client.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

export function getProviderHttpRetryLimit(): number {
  // Provider 层禁止重复尝试；失败后由虚拟路由负责 failover。
  return 1;
}

export async function delayBeforeProviderHttpRetry(attempt: number): Promise<void> {
  const delay = Math.min(500 * attempt, 2000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export function shouldRetryProviderHttpError(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) {
    return false;
  }
  const normalized = error as ProviderErrorAugmented;
  const statusCode = extractStatusCodeFromError(normalized);
  return Boolean(statusCode && statusCode >= 500);
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
  } catch {
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
    if (statusCode && !Number.isNaN(statusCode)) {
      normalized.statusCode = statusCode;
      if (!normalized.status) {
        normalized.status = statusCode;
      }
      if (!normalized.code) {
        normalized.code = `HTTP_${statusCode}`;
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
    if (normalized.code && !normalized.response.data.error.code) {
      normalized.response.data.error.code = normalized.code;
    }
    if (normalized.message && !normalized.response.data.error.message) {
      normalized.response.data.error.message = normalized.message;
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

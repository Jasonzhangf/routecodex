/**
 * OAuth Recovery Handler
 *
 * 处理 OAuth token 失效时的恢复逻辑：
 * - 尝试恢复 OAuth 并重放请求
 * - DeepSeek account 刷新
 */

import type { IAuthProvider } from '../../../auth/auth-interface.js';
import type { OAuthAuth } from '../../api/provider-config.js';
import type { ProviderContext } from '../../api/provider-types.js';
import type { ProviderErrorAugmented } from '../provider-error-types.js';
import { extractStatusCodeFromError } from '../provider-error-classifier.js';
import {
  attachProviderSseSnapshotStream,
  writeProviderSnapshot
} from '../../utils/snapshot-writer.js';
import { handleUpstreamInvalidOAuthToken } from '../../../auth/oauth-lifecycle.js';
import type { PreparedHttpRequest } from '../http-request-executor.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { HttpClient } from '../../utils/http-client.js';
import { MetadataCenter } from '../../../../server/runtime/http-server/metadata-center/metadata-center.js';

function readSnapshotEntryPort(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const requestTruthPortScope = MetadataCenter.read(metadata)?.readRequestTruth().portScope;
  if (typeof requestTruthPortScope === 'string') {
    const parsed = Number.parseInt(requestTruthPortScope, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  for (const value of [
    metadata.portScope,
    metadata.entryPort,
    metadata.matchedPort,
    metadata.routecodexLocalPort,
    metadata.localPort
  ]) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

function readProviderContextSnapshotEntryPort(context: ProviderContext): number | undefined {
  const runtimeMetadataRecord =
    context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  return readSnapshotEntryPort(runtimeMetadataRecord) ?? readSnapshotEntryPort(context.metadata);
}

type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };

export interface OAuthRecoveryContext {
  authProvider: IAuthProvider | null;
  oauthProviderId?: string;
  providerType: string;
  config: {
    config: {
      auth: OAuthAuth | { type: string };
    };
  };
  httpClient: HttpClient;
}

export class OAuthRecoveryHandler {
  private context: OAuthRecoveryContext;

  constructor(context: OAuthRecoveryContext) {
    this.context = context;
  }

  private formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack || `${error.name}: ${error.message}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private logNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
    try {
      const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
      console.warn(
        `[oauth-recovery-handler] ${stage} failed (non-blocking): ${this.formatUnknownError(error)}${detailSuffix}`
      );
    } catch {
      // Never throw from non-blocking logging.
    }
  }

  private async executeRecoveredSseReplay(options: {
    requestInfo: PreparedHttpRequest;
    finalRetryHeaders: Record<string, string>;
    captureSse: boolean;
    context: ProviderContext;
    wrapUpstreamSseResponse: (stream: NodeJS.ReadableStream, ctx: ProviderContext) => Promise<UnknownObject>;
    extra: Record<string, unknown>;
    snapshotStage: string;
  }): Promise<unknown> {
    const {
      requestInfo,
      finalRetryHeaders,
      captureSse,
      context,
      wrapUpstreamSseResponse,
      extra,
      snapshotStage
    } = options;
    const upstreamResult = await this.context.httpClient.postStreamOrResponse(
      requestInfo.targetUrl,
      requestInfo.body,
      finalRetryHeaders
    );
    if (upstreamResult.kind === 'response') {
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: {
            mode: upstreamResult.responseKind,
            captureSse,
            transport: 'upstream-response',
            payload: upstreamResult.response.data ?? null,
            ...extra
          },
          headers: finalRetryHeaders,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          entryPort: readProviderContextSnapshotEntryPort(context),
          clientRequestId: requestInfo.clientRequestId,
          providerKey: context.providerKey,
          providerId: context.providerId
        });
      } catch (snapshotError) {
        this.logNonBlockingError(`writeProviderSnapshot.${snapshotStage}.json`, snapshotError, {
          requestId: context.requestId,
          providerKey: context.providerKey,
          providerId: context.providerId
        });
      }
      return upstreamResult.response;
    }

    const streamForHost = captureSse
      ? attachProviderSseSnapshotStream(upstreamResult.stream, {
        requestId: context.requestId,
        headers: finalRetryHeaders,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        entryPort: readProviderContextSnapshotEntryPort(context),
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId,
        extra
      })
      : upstreamResult.stream;
    const wrapped = await wrapUpstreamSseResponse(streamForHost, context);
    if (!captureSse) {
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: {
            mode: 'sse',
            captureSse,
            transport: 'upstream-stream',
            ...extra
          },
          headers: finalRetryHeaders,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          entryPort: readProviderContextSnapshotEntryPort(context),
          clientRequestId: requestInfo.clientRequestId,
          providerKey: context.providerKey,
          providerId: context.providerId
        });
      } catch (snapshotError) {
        this.logNonBlockingError(`writeProviderSnapshot.${snapshotStage}.sse`, snapshotError, {
          requestId: context.requestId,
          providerKey: context.providerKey,
          providerId: context.providerId
        });
      }
    }
    return wrapped;
  }

  async tryRecoverOAuthAndReplay(
    error: unknown,
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    captureSse: boolean,
    context: ProviderContext,
    buildRequestHeaders: () => Promise<Record<string, string>>,
    finalizeRequestHeaders: (headers: Record<string, string>, req: UnknownObject) => Promise<Record<string, string>>,
    applyStreamModeHeaders: (headers: Record<string, string>, wantsSse: boolean) => Record<string, string>,
    wrapUpstreamSseResponse: (stream: NodeJS.ReadableStream, ctx: ProviderContext) => Promise<UnknownObject>
  ): Promise<unknown | undefined> {
    try {
      const providerAuth = this.context.config.config.auth;
      const authRawType =
        typeof (providerAuth as { rawType?: unknown }).rawType === 'string'
          ? String((providerAuth as { rawType?: string }).rawType).trim().toLowerCase()
          : '';
      const isDeepSeekAccount = authRawType === 'deepseek-account';

      if (isDeepSeekAccount) {
        return await this.handleDeepSeekRecovery(
          error,
          requestInfo,
          processedRequest,
          captureSse,
          context,
          buildRequestHeaders,
          finalizeRequestHeaders,
          applyStreamModeHeaders,
          wrapUpstreamSseResponse
        );
      }

      if (this.normalizeAuthMode(providerAuth.type) !== 'oauth') {
        return undefined;
      }

      return await this.handleOAuthRecovery(
        error,
        requestInfo,
        processedRequest,
        captureSse,
        context,
        providerAuth as OAuthAuthExtended,
        buildRequestHeaders,
        finalizeRequestHeaders,
        applyStreamModeHeaders,
        wrapUpstreamSseResponse
      );
    } catch (recoveryError) {
      this.logNonBlockingError('tryRecoverOAuthAndReplay', recoveryError, {
        requestId: context.requestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
      return undefined;
    }
  }

  private async handleDeepSeekRecovery(
    error: unknown,
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    captureSse: boolean,
    context: ProviderContext,
    buildRequestHeaders: () => Promise<Record<string, string>>,
    finalizeRequestHeaders: (headers: Record<string, string>, req: UnknownObject) => Promise<Record<string, string>>,
    applyStreamModeHeaders: (headers: Record<string, string>, wantsSse: boolean) => Record<string, string>,
    wrapUpstreamSseResponse: (stream: NodeJS.ReadableStream, ctx: ProviderContext) => Promise<UnknownObject>
  ): Promise<unknown | undefined> {
    const statusCode = extractStatusCodeFromError(error as ProviderErrorAugmented);
    const authProvider = this.context.authProvider;
    if (statusCode === 401 && authProvider?.refreshCredentials) {
      await authProvider.refreshCredentials();
      const retryHeaders = await buildRequestHeaders();
      let finalRetryHeaders = await finalizeRequestHeaders(retryHeaders, processedRequest);
      finalRetryHeaders = applyStreamModeHeaders(finalRetryHeaders, requestInfo.wantsSse);
      if (requestInfo.wantsSse) {
        return await this.executeRecoveredSseReplay({
          requestInfo,
          finalRetryHeaders,
          captureSse,
          context,
          wrapUpstreamSseResponse,
          extra: { retry: true, authRefresh: true },
          snapshotStage: 'sse_deepseek_retry'
        });
      }
      const response = await this.context.httpClient.post(requestInfo.targetUrl, requestInfo.body, finalRetryHeaders);
      return response;
    }
    return undefined;
  }

  private async handleOAuthRecovery(
    error: unknown,
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    captureSse: boolean,
    context: ProviderContext,
    providerAuth: OAuthAuthExtended,
    buildRequestHeaders: () => Promise<Record<string, string>>,
    finalizeRequestHeaders: (headers: Record<string, string>, req: UnknownObject) => Promise<Record<string, string>>,
    applyStreamModeHeaders: (headers: Record<string, string>, wantsSse: boolean) => Record<string, string>,
    wrapUpstreamSseResponse: (stream: NodeJS.ReadableStream, ctx: ProviderContext) => Promise<UnknownObject>
  ): Promise<unknown | undefined> {
    const shouldRetry = await handleUpstreamInvalidOAuthToken(
      this.context.oauthProviderId || this.context.providerType,
      providerAuth,
      error,
      { allowBlocking: false }
    );
    if (!shouldRetry) {
      return undefined;
    }
    const retryHeaders = await buildRequestHeaders();
    let finalRetryHeaders = await finalizeRequestHeaders(retryHeaders, processedRequest);
    finalRetryHeaders = applyStreamModeHeaders(finalRetryHeaders, requestInfo.wantsSse);
    if (requestInfo.wantsSse) {
      return await this.executeRecoveredSseReplay({
        requestInfo,
        finalRetryHeaders,
        captureSse,
        context,
        wrapUpstreamSseResponse,
        extra: { retry: true },
        snapshotStage: 'sse_retry'
      });
    }
    const response = await this.context.httpClient.post(requestInfo.targetUrl, requestInfo.body, finalRetryHeaders);
    try {
      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId: context.requestId,
        data: response,
        headers: finalRetryHeaders,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint,
        entryPort: readSnapshotEntryPort(context.metadata),
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch (snapshotError) {
      this.logNonBlockingError('writeProviderSnapshot.http_retry', snapshotError, {
        requestId: context.requestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    }
    return response;
  }

  private normalizeAuthMode(type: unknown): 'apikey' | 'oauth' {
    return typeof type === 'string' && type.toLowerCase().includes('oauth') ? 'oauth' : 'apikey';
  }
}

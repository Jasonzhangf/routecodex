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
    } catch {
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
        const upstreamStream = await this.context.httpClient.postStream(requestInfo.targetUrl, requestInfo.body, finalRetryHeaders);
        const streamForHost = captureSse
          ? attachProviderSseSnapshotStream(upstreamStream, {
            requestId: context.requestId,
            headers: finalRetryHeaders,
            url: requestInfo.targetUrl,
            entryEndpoint: requestInfo.entryEndpoint,
            clientRequestId: requestInfo.clientRequestId,
            providerKey: context.providerKey,
            providerId: context.providerId,
            extra: { retry: true, authRefresh: true }
          })
          : upstreamStream;
        return await wrapUpstreamSseResponse(streamForHost, context);
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
      const upstreamStream = await this.context.httpClient.postStream(requestInfo.targetUrl, requestInfo.body, finalRetryHeaders);
      const streamForHost = captureSse
        ? attachProviderSseSnapshotStream(upstreamStream, {
          requestId: context.requestId,
          headers: finalRetryHeaders,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          clientRequestId: requestInfo.clientRequestId,
          providerKey: context.providerKey,
          providerId: context.providerId,
          extra: { retry: true }
        })
        : upstreamStream;
      const wrapped = await wrapUpstreamSseResponse(streamForHost, context);
      if (!captureSse) {
        try {
          await writeProviderSnapshot({
            phase: 'provider-response',
            requestId: context.requestId,
            data: { mode: 'sse', retry: true },
            headers: finalRetryHeaders,
            url: requestInfo.targetUrl,
            entryEndpoint: requestInfo.entryEndpoint,
            clientRequestId: requestInfo.clientRequestId,
            providerKey: context.providerKey,
            providerId: context.providerId
          });
        } catch { /* non-blocking */ }
      }
      return wrapped;
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
        clientRequestId: requestInfo.clientRequestId,
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch { /* non-blocking */ }
    return response;
  }

  private normalizeAuthMode(type: unknown): 'apikey' | 'oauth' {
    return typeof type === 'string' && type.toLowerCase().includes('oauth') ? 'oauth' : 'apikey';
  }
}

import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { HttpClient } from '../utils/http-client.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';
import type { HttpRequestExecutorDeps, PreparedHttpRequest, PreparedRequestExecutor } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';

type BuildProviderRequestExecutorDepsArgs = {
  wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean;
  getEffectiveEndpoint(): string;
  resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string;
  buildRequestHeaders(): Promise<Record<string, string>>;
  finalizeRequestHeaders(headers: Record<string, string>, request: UnknownObject): Promise<Record<string, string>>;
  applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string>;
  getEffectiveBaseUrl(): string;
  getBaseUrlCandidates(context: ProviderContext): string[] | undefined;
  buildHttpRequestBody(request: UnknownObject): UnknownObject;
  prepareSseRequestBody(body: UnknownObject, context: ProviderContext): void;
  wrapUpstreamSseResponse(stream: NodeJS.ReadableStream, context: ProviderContext): Promise<UnknownObject>;
  executePreparedRequest?: PreparedRequestExecutor;
  resolveBusinessResponseError(response: unknown, context: ProviderContext): Error | undefined;
  normalizeHttpError(
    error: unknown,
    processedRequest: UnknownObject,
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<ProviderErrorAugmented>;
  authProvider: IAuthProvider | null;
  providerType: string;
  config: OpenAIStandardConfig;
  httpClient: HttpClient;
};

export function buildProviderRequestExecutorDeps(args: BuildProviderRequestExecutorDepsArgs): HttpRequestExecutorDeps {
  return {
    wantsUpstreamSse: args.wantsUpstreamSse,
    getEffectiveEndpoint: args.getEffectiveEndpoint,
    resolveRequestEndpoint: args.resolveRequestEndpoint,
    buildRequestHeaders: args.buildRequestHeaders,
    finalizeRequestHeaders: args.finalizeRequestHeaders,
    applyStreamModeHeaders: args.applyStreamModeHeaders,
    getEffectiveBaseUrl: args.getEffectiveBaseUrl,
    getBaseUrlCandidates: args.getBaseUrlCandidates,
    buildHttpRequestBody: args.buildHttpRequestBody,
    prepareSseRequestBody: args.prepareSseRequestBody,
    getEntryEndpointFromPayload: (payload) => ProviderPayloadUtils.extractEntryEndpointFromPayload(payload),
    getClientRequestIdFromContext: (context) => ProviderPayloadUtils.getClientRequestIdFromContext(context),
    wrapUpstreamSseResponse: args.wrapUpstreamSseResponse,
    executePreparedRequest: args.executePreparedRequest,
    resolveBusinessResponseError: args.resolveBusinessResponseError,
    normalizeHttpError: (error, processedRequest, requestInfo, context) =>
      args.normalizeHttpError(error, processedRequest, requestInfo, context)
  };
}

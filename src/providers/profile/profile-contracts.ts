import type { UnknownObject } from '../../types/common-types.js';
import type { ProviderContext } from '../core/api/provider-types.js';
import type { ProviderRuntimeMetadata } from '../core/runtime/provider-runtime-metadata.js';

export interface ResolveEndpointInput {
  request: UnknownObject;
  defaultEndpoint: string;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface BuildRequestBodyInput {
  request: UnknownObject;
  defaultBody: UnknownObject;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ResolveUserAgentInput {
  uaFromConfig?: string;
  uaFromService?: string;
  inboundUserAgent?: string;
  defaultUserAgent: string;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ApplyRequestHeadersInput {
  headers: Record<string, string>;
  request?: UnknownObject;
  runtimeMetadata?: ProviderRuntimeMetadata;
  isCodexUaMode?: boolean;
}

export interface ApplyStreamModeHeadersInput {
  headers: Record<string, string>;
  wantsSse: boolean;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ResolveBusinessResponseErrorInput {
  response: unknown;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ResolveStreamIntentInput {
  request: UnknownObject;
  context: ProviderContext;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface PrepareStreamBodyInput {
  body: UnknownObject;
  context: ProviderContext;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ResolveOAuthTokenFileInput {
  oauthProviderId: string;
  auth: {
    clientId?: string;
    tokenUrl?: string;
    deviceCodeUrl?: string;
  };
  moduleType: string;
}

export interface ProviderFamilyProfile {
  id: string;
  providerFamily: string;
  resolveEndpoint?(input: ResolveEndpointInput): string | undefined;
  buildRequestBody?(input: BuildRequestBodyInput): UnknownObject | undefined;
  resolveUserAgent?(input: ResolveUserAgentInput): string | undefined | Promise<string | undefined>;
  applyRequestHeaders?(input: ApplyRequestHeadersInput): Record<string, string> | undefined;
  applyStreamModeHeaders?(input: ApplyStreamModeHeadersInput): Record<string, string> | undefined;
  resolveBusinessResponseError?(input: ResolveBusinessResponseErrorInput): Error | undefined;
  resolveStreamIntent?(input: ResolveStreamIntentInput): boolean | undefined;
  prepareStreamBody?(input: PrepareStreamBodyInput): void;
  resolveOAuthTokenFileMode?(input: ResolveOAuthTokenFileInput): boolean | undefined;
}

export interface ProviderFamilyLookupInput {
  providerId?: string;
  providerFamily?: string;
  providerKey?: string;
  providerType?: string;
  oauthProviderId?: string;
}

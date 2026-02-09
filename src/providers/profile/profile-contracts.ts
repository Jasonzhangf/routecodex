import type { UnknownObject } from '../../types/common-types.js';
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
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ResolveBusinessResponseErrorInput {
  response: unknown;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

export interface ProviderFamilyProfile {
  id: string;
  providerFamily: string;
  resolveEndpoint?(input: ResolveEndpointInput): string | undefined;
  buildRequestBody?(input: BuildRequestBodyInput): UnknownObject | undefined;
  resolveUserAgent?(input: ResolveUserAgentInput): string | undefined;
  applyRequestHeaders?(input: ApplyRequestHeadersInput): Record<string, string> | undefined;
  resolveBusinessResponseError?(input: ResolveBusinessResponseErrorInput): Error | undefined;
}

export interface ProviderFamilyLookupInput {
  providerId?: string;
  providerFamily?: string;
  providerKey?: string;
  oauthProviderId?: string;
}

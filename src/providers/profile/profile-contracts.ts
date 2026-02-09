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

export interface ProviderFamilyProfile {
  id: string;
  providerFamily: string;
  resolveEndpoint?(input: ResolveEndpointInput): string | undefined;
  buildRequestBody?(input: BuildRequestBodyInput): UnknownObject | undefined;
  resolveUserAgent?(input: ResolveUserAgentInput): string | undefined;
}

export interface ProviderFamilyLookupInput {
  providerId?: string;
  providerFamily?: string;
  providerKey?: string;
  oauthProviderId?: string;
}

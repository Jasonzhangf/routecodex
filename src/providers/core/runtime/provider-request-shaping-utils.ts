import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';

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
  return typeof profileResolved === 'boolean' ? profileResolved : false;
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

export function resolveProviderBusinessResponseError(args: {
  response: unknown;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
}): Error | undefined {
  if (!args.familyProfile?.resolveBusinessResponseError) {
    return undefined;
  }
  return args.familyProfile.resolveBusinessResponseError({
    response: args.response,
    runtimeMetadata: args.runtimeMetadata
  });
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
    return profileBody as UnknownObject;
  }
  if (args.legacyBody && typeof args.legacyBody === 'object') {
    return args.legacyBody;
  }
  return defaultBody;
}

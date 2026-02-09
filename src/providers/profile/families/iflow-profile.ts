import type {
  BuildRequestBodyInput,
  ProviderFamilyProfile,
  ResolveEndpointInput,
  ResolveUserAgentInput
} from '../profile-contracts.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getMetadata(request: unknown): UnknownRecord | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const metadata = request.metadata;
  return isRecord(metadata) ? metadata : undefined;
}

function isIflowWebSearch(input: ResolveEndpointInput | BuildRequestBodyInput): boolean {
  const metadata = getMetadata(input.request);
  return metadata?.iflowWebSearch === true;
}

export const iflowFamilyProfile: ProviderFamilyProfile = {
  id: 'iflow/default',
  providerFamily: 'iflow',
  resolveEndpoint(input: ResolveEndpointInput): string | undefined {
    if (!isIflowWebSearch(input)) {
      return undefined;
    }
    const metadata = getMetadata(input.request);
    const entryEndpoint =
      typeof metadata?.entryEndpoint === 'string' && metadata.entryEndpoint.trim()
        ? metadata.entryEndpoint.trim()
        : undefined;
    return entryEndpoint || '/chat/retrieve';
  },
  buildRequestBody(input: BuildRequestBodyInput) {
    if (!isIflowWebSearch(input)) {
      return undefined;
    }
    if (isRecord(input.request) && isRecord(input.request.data)) {
      return input.request.data;
    }
    return {};
  },
  resolveUserAgent(input: ResolveUserAgentInput): string | undefined {
    return input.uaFromConfig ?? input.uaFromService ?? input.inboundUserAgent ?? input.defaultUserAgent;
  }
};

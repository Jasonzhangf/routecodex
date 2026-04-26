import { getProviderFamilyProfile } from '../../profile/profile-registry.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { UnknownObject } from '../../../types/common-types.js';

function normalizeIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length ? normalized : undefined;
}

export function resolveProviderFamilyProfile(options: {
  runtimeMetadata?: ProviderRuntimeMetadata;
  runtimeProfile?: {
    providerFamily?: unknown;
    providerKey?: unknown;
  };
  configProviderId?: unknown;
  configProviderType?: unknown;
  providerType?: string;
  oauthProviderId?: string;
}): ProviderFamilyProfile | undefined {
  const targetNode =
    options.runtimeMetadata?.target && typeof options.runtimeMetadata.target === 'object'
      ? (options.runtimeMetadata.target as Record<string, unknown>)
      : undefined;

  return getProviderFamilyProfile({
    providerFamily:
      normalizeIdentity(options.runtimeMetadata?.providerFamily) ??
      normalizeIdentity(options.runtimeProfile?.providerFamily),
    providerId:
      normalizeIdentity(options.runtimeMetadata?.providerId) ??
      normalizeIdentity(targetNode?.providerId) ??
      normalizeIdentity(options.configProviderId),
    providerKey:
      normalizeIdentity(options.runtimeMetadata?.providerKey) ??
      normalizeIdentity(targetNode?.providerKey) ??
      normalizeIdentity(options.runtimeProfile?.providerKey),
    providerType:
      normalizeIdentity(options.runtimeMetadata?.providerType) ??
      normalizeIdentity(targetNode?.providerType) ??
      normalizeIdentity(options.configProviderType) ??
      normalizeIdentity(options.providerType),
    oauthProviderId: normalizeIdentity(options.oauthProviderId)
  });
}


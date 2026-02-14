import { DynamicProfileLoader } from '../config/service-profiles.js';
import type { ProviderRuntimeProfile } from '../api/provider-types.js';

export interface EffectiveBaseUrlInput {
  runtime?: ProviderRuntimeProfile;
  overrideBaseUrl?: string;
  configBaseUrl?: string;
  serviceDefaultBaseUrl?: string;
  profileKey: string;
  providerType: string;
}

export interface EffectiveEndpointInput {
  runtime?: ProviderRuntimeProfile;
  overrideEndpoint?: string;
  serviceDefaultEndpoint: string;
}

export class RuntimeEndpointResolver {
  static resolveEffectiveBaseUrl(input: EffectiveBaseUrlInput): string {
    const runtimeEndpoint = RuntimeEndpointResolver.pickRuntimeBaseUrl(input.runtime);
    const candidates = [
      runtimeEndpoint,
      input.runtime?.baseUrl,
      input.overrideBaseUrl,
      input.configBaseUrl,
      input.serviceDefaultBaseUrl
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);

    const firstAbsolute = candidates.find((value) => RuntimeEndpointResolver.looksLikeAbsoluteUrl(value));
    if (firstAbsolute) {
      return firstAbsolute;
    }

    const serviceDefault = String(input.serviceDefaultBaseUrl || '').trim();
    if (serviceDefault && RuntimeEndpointResolver.looksLikeAbsoluteUrl(serviceDefault)) {
      return serviceDefault;
    }

    const staticServiceDefault = RuntimeEndpointResolver.resolveStaticServiceDefaultBaseUrl(
      input.profileKey,
      input.providerType
    );
    if (staticServiceDefault && RuntimeEndpointResolver.looksLikeAbsoluteUrl(staticServiceDefault)) {
      return staticServiceDefault;
    }

    return candidates[0] || String(input.serviceDefaultBaseUrl || '');
  }

  static resolveEffectiveEndpoint(input: EffectiveEndpointInput): string {
    const runtimeEndpoint =
      input.runtime?.endpoint && !RuntimeEndpointResolver.looksLikeAbsoluteUrl(input.runtime.endpoint)
        ? input.runtime.endpoint
        : undefined;
    return (
      runtimeEndpoint ||
      input.overrideEndpoint ||
      input.serviceDefaultEndpoint
    );
  }

  static looksLikeAbsoluteUrl(value?: string): boolean {
    if (!value) {
      return false;
    }
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
  }

  private static pickRuntimeBaseUrl(runtime?: ProviderRuntimeProfile): string | undefined {
    if (!runtime) {
      return undefined;
    }
    if (typeof runtime.baseUrl === 'string' && runtime.baseUrl.trim()) {
      return runtime.baseUrl.trim();
    }
    if (typeof runtime.endpoint === 'string' && RuntimeEndpointResolver.looksLikeAbsoluteUrl(runtime.endpoint)) {
      return runtime.endpoint.trim();
    }
    return undefined;
  }

  private static resolveStaticServiceDefaultBaseUrl(profileKey: string, providerType: string): string | undefined {
    const baseProfile =
      DynamicProfileLoader.buildServiceProfile(profileKey) ||
      DynamicProfileLoader.buildServiceProfile(providerType);
    const candidate = typeof baseProfile?.defaultBaseUrl === 'string'
      ? baseProfile.defaultBaseUrl.trim()
      : '';
    return candidate || undefined;
  }
}

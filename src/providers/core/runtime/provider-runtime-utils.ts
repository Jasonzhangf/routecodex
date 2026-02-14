import type { ProviderContext, ProviderType, ServiceProfile } from '../api/provider-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

export function resolveProviderProfileKey(options: {
  moduleType: string;
  providerType: string;
  providerId?: string;
}): string {
  const { moduleType, providerType, providerId } = options;
  if (moduleType === 'gemini-cli-http-provider') {
    return 'gemini-cli';
  }
  const direct = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim().toLowerCase()
    : '';
  return direct || providerType;
}

export function isCodexUaMode(options: {
  runtime?: ProviderRuntimeMetadata;
  providerType: string;
}): boolean {
  const raw =
    process.env.ROUTECODEX_UA_MODE ??
    process.env.RCC_UA_MODE ??
    '';
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const { runtime, providerType } = options;
  if (!runtime) {
    return false;
  }
  const effectiveProviderType = (runtime.providerType as ProviderType) || providerType;
  const entryEndpoint = ProviderPayloadUtils.extractEntryEndpointFromRuntime(runtime);

  if (normalized === 'codex') {
    return true;
  }

  if (effectiveProviderType === 'responses' && entryEndpoint) {
    const lowered = entryEndpoint.trim().toLowerCase();
    if (!lowered.includes('/responses')) {
      return true;
    }
  }

  return false;
}

export function createProviderRuntimeContext(options: {
  runtime?: ProviderRuntimeMetadata;
  serviceProfile: ServiceProfile;
  providerType: string;
}): ProviderContext {
  const { runtime, serviceProfile, providerType } = options;
  return {
    requestId: runtime?.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    providerType: (runtime?.providerType as ProviderType) || (providerType as ProviderType),
    startTime: Date.now(),
    profile: serviceProfile,
    routeName: runtime?.routeName,
    providerId: runtime?.providerId,
    providerKey: runtime?.providerKey,
    providerProtocol: runtime?.providerProtocol,
    metadata: runtime?.metadata,
    target: runtime?.target,
    runtimeMetadata: runtime,
    pipelineId: runtime?.pipelineId
  };
}

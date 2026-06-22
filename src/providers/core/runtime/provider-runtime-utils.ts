import type { ProviderContext, ProviderType, ServiceProfile } from '../api/provider-types.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveProviderProfileKey(options: {
  moduleType: string;
  providerType: string;
  providerId?: string;
}): string {
  const { moduleType, providerType, providerId } = options;
  const direct = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim().toLowerCase()
    : '';
  if (moduleType !== 'deepseek-http-provider' && direct === 'deepseek' && providerType === 'openai') {
    return 'openai';
  }
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
  runtimeProfileExtensions?: Record<string, unknown>;
  configExtensions?: Record<string, unknown>;
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
    extensions: resolveProviderContextExtensions({
      runtime,
      runtimeProfileExtensions: options.runtimeProfileExtensions,
      configExtensions: options.configExtensions
    }),
    pipelineId: runtime?.pipelineId,
    abortSignal:
      runtime?.abortSignal && typeof runtime.abortSignal === 'object'
        ? (runtime.abortSignal as AbortSignal)
        : undefined
  };
}

export function resolveProviderContextExtensions(options: {
  runtime?: ProviderRuntimeMetadata;
  runtimeProfileExtensions?: Record<string, unknown>;
  configExtensions?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const runtimeRecord = asRecord(options.runtime);
  const runtimeExtensions = asRecord(runtimeRecord?.extensions);
  const targetExtensions = asRecord(asRecord(runtimeRecord?.target)?.extensions);
  return runtimeExtensions ?? options.runtimeProfileExtensions ?? options.configExtensions ?? targetExtensions;
}

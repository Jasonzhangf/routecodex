import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import { emitProviderErrorAndWait } from '../../../providers/core/utils/provider-error-reporter.js';
import type { ProviderHandle, ProviderProtocol, VirtualRouterArtifacts } from './types.js';
import { disposeHubPipelineNative } from '../../../modules/llmswitch/bridge/routing-integrations.js';
import { ProviderFactory } from '../../../providers/core/runtime/provider-factory.js';
import { normalizeProviderType, resolveProviderIdentity } from './provider-utils.js';
import { resolveProviderRoutingScope } from './provider-routing-scope.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';

function logRuntimeProvidersNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(`[runtime-providers] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function isCredentialMissingInitError(error: unknown): { missing: boolean; reason: string } {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  const normalized = message.toLowerCase();
  if (
    normalized.includes('environment variable') &&
    normalized.includes('is not defined')
  ) {
    return { missing: true, reason: message };
  }
  if (normalized.includes('missing api key')) {
    return { missing: true, reason: message };
  }
  if (normalized.includes('missing required authentication credential')) {
    return { missing: true, reason: message };
  }
  if (normalized.includes('authfile') && normalized.includes('not found')) {
    return { missing: true, reason: message };
  }
  return { missing: false, reason: message };
}

export async function initializeProviderRuntimes(server: any, artifacts?: VirtualRouterArtifacts): Promise<void> {
  const baseRuntimeMap =
    artifacts?.runtime
    ?? server.currentRouterArtifacts?.runtime
    ?? undefined;
  const targetRuntimeMap =
    artifacts?.targetRuntime
    ?? server.currentRouterArtifacts?.targetRuntime
    ?? undefined;
  const runtimeMap = {
    ...(targetRuntimeMap ?? {}),
    ...(baseRuntimeMap ?? {})
  } as Record<string, ProviderRuntimeProfile>;
  if (!runtimeMap || Object.keys(runtimeMap).length < 1) {
    return;
  }
  await server.disposeProviders();
  server.providerKeyToRuntimeKey.clear();
  server.providerRuntimeInitErrors.clear();
  server.runtimeKeyCredentialSkipped.clear();
  server.startupExcludedProviderKeys.clear();
  const {
    hasRoutingProviderScope,
    routedProviderKeys,
    isInRoutingScope
  } = resolveProviderRoutingScope(server.routingProviderScope as { providerKeys?: unknown[] } | undefined);
  const directTargetRuntimeProviderKeys = new Set(
    Object.keys(targetRuntimeMap ?? {})
      .map((key) => (typeof key === 'string' ? key.trim().toLowerCase() : ''))
      .filter(Boolean)
  );

  const runtimeKeyAuthType = new Map<string, string | null>();
  const apikeyDailyResetTime = (() => {
    const vr = server.userConfig && typeof server.userConfig === 'object' ? (server.userConfig as any).virtualrouter : null;
    const quota = vr && typeof vr === 'object' && !Array.isArray(vr) ? (vr as any).quota : null;
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
      return null;
    }
    const raw =
      typeof (quota as any).apikeyDailyResetTime === 'string'
        ? (quota as any).apikeyDailyResetTime
        : typeof (quota as any).apikeyResetTime === 'string'
          ? (quota as any).apikeyResetTime
          : typeof (quota as any).apikeyReset === 'string'
            ? (quota as any).apikeyReset
            : null;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed ? trimmed : null;
  })();

  const failedRuntimeKeys = new Set<string>();
  for (const [providerKeyRaw, runtime] of Object.entries(runtimeMap)) {
    const providerKey = typeof providerKeyRaw === 'string' ? providerKeyRaw.trim() : '';
    if (!providerKey) {
      continue;
    }
    const directTargetRuntime = directTargetRuntimeProviderKeys.has(providerKey.toLowerCase());
    if (!directTargetRuntime && !isInRoutingScope(providerKey)) {
      continue;
    }
    if (!runtime) {
      continue;
    }
    const runtimeProfile = runtime as ProviderRuntimeProfile;
    const runtimeKey = typeof runtimeProfile.runtimeKey === 'string' && runtimeProfile.runtimeKey.trim()
      ? runtimeProfile.runtimeKey.trim()
      : providerKey;

    const authTypeFromRuntime =
      runtimeProfile && (runtimeProfile as any).auth && typeof (runtimeProfile as any).auth.type === 'string'
        ? String((runtimeProfile as any).auth.type).trim()
        : null;

    if (failedRuntimeKeys.has(runtimeKey)) {
      if (server.runtimeKeyCredentialSkipped.has(runtimeKey)) {
        server.startupExcludedProviderKeys.add(providerKey);
      }
      continue;
    }

    if (!server.providerHandles.has(runtimeKey)) {
        let patchedRuntime: ProviderRuntimeProfile | null = null;
        try {
          const resolvedRuntime = await server.materializeRuntimeProfile(runtimeProfile);
          patchedRuntime = server.applyProviderProfileOverrides(resolvedRuntime);
        try {
          const authTypeFromPatched =
            patchedRuntime && patchedRuntime.auth && typeof (patchedRuntime.auth as { type?: unknown }).type === 'string'
              ? String((patchedRuntime.auth as { type?: string }).type).trim()
              : null;
          if (authTypeFromPatched) {
            runtimeKeyAuthType.set(runtimeKey, authTypeFromPatched);
          } else if (authTypeFromRuntime) {
            runtimeKeyAuthType.set(runtimeKey, authTypeFromRuntime);
          } else if (!runtimeKeyAuthType.has(runtimeKey)) {
            runtimeKeyAuthType.set(runtimeKey, null);
          }
        } catch (error) {
          logRuntimeProvidersNonBlockingError('runtime.auth_type_extract', error, {
            providerKey,
            runtimeKey
          });
        }

        const handle = await server.createProviderHandle(runtimeKey, patchedRuntime);
        server.providerHandles.set(runtimeKey, handle);
        server.providerRuntimeInitErrors.delete(runtimeKey);
      } catch (error) {
        const credentialMissing = isCredentialMissingInitError(error);
        failedRuntimeKeys.add(runtimeKey);
        if (error instanceof Error) {
          server.providerRuntimeInitErrors.set(runtimeKey, error);
        } else {
          server.providerRuntimeInitErrors.set(runtimeKey, new Error(String(error)));
        }
        if (credentialMissing.missing) {
          server.runtimeKeyCredentialSkipped.add(runtimeKey);
          server.startupExcludedProviderKeys.add(providerKey);
          console.warn(
            `[provider.init.skip] providerKey=${providerKey} runtimeKey=${runtimeKey} reason=credential_missing detail=${credentialMissing.reason}`
          );
          continue;
        }
        try {
          await emitProviderErrorAndWait({
            error,
            stage: 'provider.runtime.init',
            runtime: {
              requestId: `startup_${Date.now()}`,
              providerKey,
              providerId: runtimeProfile.providerId || runtimeKey.split('.')[0],
              providerType: String((runtimeProfile as any).providerType || runtimeProfile.providerType || 'unknown'),
              providerProtocol: String((runtimeProfile as any).outboundProfile || ''),
              routeName: 'startup',
              pipelineId: 'startup',
              runtimeKey
            },
            dependencies: server.getModuleDependencies(),
            recoverable: false,
            affectsHealth: true,
            details: {
              reason: 'provider_init_failed',
              runtimeKey,
              providerKey
            }
          });
        } catch (reportError) {
          logRuntimeProvidersNonBlockingError('runtime.emit_provider_error', reportError, {
            providerKey,
            runtimeKey
          });
        }
        continue;
      }
    }

    if (server.providerHandles.has(runtimeKey)) {
      server.providerKeyToRuntimeKey.set(providerKey, runtimeKey);
    }
  }
}


export async function createProviderHandle(
  server: any,
  runtimeKey: string,
  runtime: ProviderRuntimeProfile
): Promise<ProviderHandle> {
  const protocolType = normalizeProviderType(runtime.providerType);
  const providerFamily = runtime.providerFamily || protocolType;
  const providerProtocolRaw =
    typeof runtime.outboundProfile === 'string' && runtime.outboundProfile.trim()
      ? runtime.outboundProfile.trim()
      : '';
  if (!providerProtocolRaw) {
    throw new Error(
      `Provider runtime ${runtimeKey} is missing required outboundProfile protocol truth`
    );
  }
  const providerProtocol = providerProtocolRaw as ProviderProtocol;
  const instance = ProviderFactory.createProviderFromRuntime(runtime, server.getModuleDependencies());
  await instance.initialize();
  const providerId = runtime.providerId || runtimeKey.split('.')[0];
  return {
    runtimeKey,
    providerId,
    providerType: protocolType,
    providerFamily,
    providerProtocol,
    runtime,
    instance
  };
}

export async function materializeRuntimeProfile(server: any, runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
  const auth = await server.resolveRuntimeAuth(runtime);
  const baseUrl = server.normalizeRuntimeBaseUrl(runtime);
  const identity = resolveProviderIdentity(runtime.providerType, runtime.providerFamily);
  return {
    ...runtime,
    ...(baseUrl ? { baseUrl } : {}),
    providerType: identity.providerType as ProviderRuntimeProfile['providerType'],
    providerFamily: identity.providerFamily,
    auth
  };
}

export function normalizeRuntimeBaseUrl(_server: any, runtime: ProviderRuntimeProfile): string | undefined {
  const candidates = [runtime.baseUrl, runtime.endpoint];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}


export async function resolveRuntimeAuth(server: any, runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile['auth']> {
  const auth = runtime.auth || { type: 'apikey' };
  const authType = server.normalizeAuthType(auth.type);
  const rawType = typeof auth.rawType === 'string' ? auth.rawType.trim().toLowerCase() : '';

  if (authType === 'apikey') {
    if (rawType.includes('account') || rawType.includes('token') || rawType.includes('oauth')) {
      throw new Error(`[runtime-providers] credential-file auth has been removed for runtime ${runtime.runtimeKey || runtime.providerId}`);
    }
    const value = await server.resolveApiKeyValue(runtime, auth);
    return { ...auth, type: 'apikey', value };
  }

  throw new Error(`[runtime-providers] unsupported auth type "${authType}" for runtime ${runtime.runtimeKey || runtime.providerId}`);
}

export async function resolveApiKeyValue(
  server: any,
  runtime: ProviderRuntimeProfile,
  auth: ProviderRuntimeProfile['auth']
): Promise<string> {
  const inline = typeof auth?.value === 'string' ? auth.value.trim() : '';
  if (inline) {
    if (server.isSafeSecretReference(inline)) {
      return await server.resolveSecretValue(inline);
    }
    return inline;
  }

  const rawSecretRef = typeof auth?.secretRef === 'string' ? auth.secretRef.trim() : '';
  if (rawSecretRef && server.isSafeSecretReference(rawSecretRef)) {
    const resolved = await server.resolveSecretValue(rawSecretRef);
    if (resolved) {
      return resolved;
    }
  }

  const baseURL =
    typeof (runtime as any)?.baseURL === 'string'
      ? String((runtime as any).baseURL).trim()
      : typeof (runtime as any)?.baseUrl === 'string'
        ? String((runtime as any).baseUrl).trim()
        : typeof (runtime as any)?.endpoint === 'string'
          ? String((runtime as any).endpoint).trim()
          : '';
  if (server.isLocalBaseUrl(baseURL)) {
    return '';
  }

  throw new Error(`Provider runtime "${runtime.runtimeKey || runtime.providerId}" missing API key`);
}

export function isLocalBaseUrl(_server: any, value: string): boolean {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return false;
  }
  try {
    const url = new URL(raw);
    const host = String(url.hostname || '').trim().toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::ffff:127.0.0.1'
    );
  } catch {
    const lower = raw.toLowerCase();
    return (
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('0.0.0.0') ||
      lower.includes('[::1]')
    );
  }
}

export function disposeHubPipelines(server: any): void {
  const hubPipelines = new Set<any>();
  if (server.hubPipeline) {
    hubPipelines.add(server.hubPipeline);
  }
  if (server.hubPipelinesByRoutingPolicyGroup instanceof Map) {
    for (const pipeline of server.hubPipelinesByRoutingPolicyGroup.values()) {
      if (pipeline) {
        hubPipelines.add(pipeline);
      }
    }
  }
  for (const pipeline of hubPipelines) {
    try {
      if (typeof pipeline === 'string') {
        disposeHubPipelineNative(pipeline);
      }
    } catch (error) {
      logRuntimeProvidersNonBlockingError('dispose.hub_pipeline_runtime_ingress', error);
    }
  }
  server.hubPipeline = null;
  if (server.hubPipelinesByRoutingPolicyGroup instanceof Map) {
    server.hubPipelinesByRoutingPolicyGroup.clear();
  }
}

export async function disposeProviders(server: any): Promise<void> {
  const handles = Array.from(server.providerHandles.values()) as ProviderHandle[];
  await Promise.all(
    handles.map(async (handle) => {
      try {
        await handle.instance.cleanup();
      } catch (error) {
        logRuntimeProvidersNonBlockingError('dispose.provider_cleanup', error, {
          runtimeKey: handle.runtimeKey,
          providerId: handle.providerId,
          providerType: handle.providerType
        });
      }
    })
  );
  server.providerHandles.clear();
  (ProviderFactory as unknown as { clearInstanceCache?: () => void }).clearInstanceCache?.();
}

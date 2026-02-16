import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderHandle, ProviderProtocol, VirtualRouterArtifacts } from './types.js';
import { ProviderFactory } from '../../../providers/core/runtime/provider-factory.js';
import { mapProviderProtocol, normalizeProviderType, resolveProviderIdentity } from './provider-utils.js';
import {
  preloadAntigravityAliasUserAgents,
  primeAntigravityUserAgentVersion
} from '../../../providers/auth/antigravity-user-agent.js';
import {
  getAntigravityWarmupBlacklistDurationMs,
  isAntigravityWarmupEnabled,
  warmupCheckAntigravityAlias
} from '../../../providers/auth/antigravity-warmup.js';

type LegacyAuthFields = ProviderRuntimeProfile['auth'] & {
  token_file?: unknown;
  token_url?: unknown;
  device_code_url?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  authorization_url?: unknown;
  authUrl?: unknown;
  user_info_url?: unknown;
  refresh_url?: unknown;
  scope?: unknown;
  accountAlias?: unknown;
  account_alias?: unknown;
};

function resolveOAuthProviderIdFromType(rawType?: string): string | undefined {
  if (typeof rawType !== 'string') {
    return undefined;
  }
  const match = rawType.trim().toLowerCase().match(/^([a-z0-9._-]+)-oauth$/);
  return match ? match[1] : undefined;
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
  const runtimeMap = artifacts?.targetRuntime ?? server.currentRouterArtifacts?.targetRuntime ?? undefined;
  if (!runtimeMap) {
    return;
  }
  await server.disposeProviders();
  server.providerKeyToRuntimeKey.clear();
  server.providerRuntimeInitErrors.clear();
  server.runtimeKeyCredentialSkipped.clear();
  server.startupExcludedProviderKeys.clear();

  try {
    const aliases: string[] = [];
    for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
      const key = typeof providerKey === 'string' ? providerKey.trim() : '';
      const rk =
        runtime && typeof (runtime as any).runtimeKey === 'string' ? String((runtime as any).runtimeKey).trim() : '';
      for (const candidate of [rk, key]) {
        if (!candidate.toLowerCase().startsWith('antigravity.')) {
          continue;
        }
        const parts = candidate.split('.');
        if (parts.length >= 2 && parts[1] && parts[1].trim()) {
          aliases.push(parts[1].trim());
        }
      }
    }
    if (aliases.length) {
      await Promise.allSettled([primeAntigravityUserAgentVersion(), preloadAntigravityAliasUserAgents(aliases)]);
    }
  } catch {
    // best-effort
  }

  const quotaModule = server.managerDaemon?.getModule('quota') as
    | {
        registerProviderStaticConfig?: (
          providerKey: string,
          config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null }
        ) => void;
        disableProvider?: (options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }) => Promise<unknown>;
      }
    | undefined;

  if (isAntigravityWarmupEnabled()) {
    try {
      const providerKeysByAlias = new Map<string, string[]>();
      for (const providerKey of Object.keys(runtimeMap)) {
        const key = typeof providerKey === 'string' ? providerKey.trim() : '';
        if (!key.toLowerCase().startsWith('antigravity.')) {
          continue;
        }
        const parts = key.split('.');
        if (parts.length < 3) {
          continue;
        }
        const alias = parts[1]?.trim();
        if (!alias) {
          continue;
        }
        const list = providerKeysByAlias.get(alias) || [];
        list.push(key);
        providerKeysByAlias.set(alias, list);
      }

      if (providerKeysByAlias.size > 0) {
        const canBlacklist = Boolean(quotaModule && typeof quotaModule.disableProvider === 'function');
        const durationMs = getAntigravityWarmupBlacklistDurationMs();
        let okCount = 0;
        let failCount = 0;
        for (const [alias, providerKeys] of providerKeysByAlias.entries()) {
          const result = await warmupCheckAntigravityAlias(alias);
          if (result.ok) {
            okCount += 1;
            console.log(
              `[antigravity:warmup] ok alias=${alias} profile=${result.profileId} fp_os=${result.fingerprintOs} fp_arch=${result.fingerprintArch} ua_suffix=${result.actualSuffix} ua=${result.actualUserAgent}`
            );
            continue;
          }
          failCount += 1;
          const expected = result.expectedSuffix ? ` expected=${result.expectedSuffix}` : '';
          const actual = result.actualSuffix ? ` actual=${result.actualSuffix}` : '';
          const hint =
            result.reason === 'linux_not_allowed'
              ? ` hint="run: routecodex camoufox-fp repair --provider antigravity --alias ${alias}"`
              : result.reason === 'reauth_required'
                ? ` hint="run: routecodex oauth antigravity-auto ${result.tokenFile || `antigravity-oauth-*-` + alias + `.json`}"` +
                  `${result.fromSuffix ? ` from=${result.fromSuffix}` : ''}${result.toSuffix ? ` to=${result.toSuffix}` : ''}`
                : '';
          console.error(
            `[antigravity:warmup] FAIL alias=${alias} profile=${result.profileId}${result.fingerprintOs ? ` fp_os=${result.fingerprintOs}` : ''}${result.fingerprintArch ? ` fp_arch=${result.fingerprintArch}` : ''} reason=${result.reason}${expected}${actual}${hint} providerKeys=${providerKeys.length}${canBlacklist ? '' : ' (quota module unavailable; cannot blacklist)'}`
          );
          if (canBlacklist) {
            await Promise.allSettled(
              providerKeys.map((providerKey) => quotaModule!.disableProvider!({ providerKey, mode: 'blacklist', durationMs }))
            );
          }
        }
        console.log(`[antigravity:warmup] summary ok=${okCount} fail=${failCount} total=${providerKeysByAlias.size}`);
      }
    } catch {
      // best-effort
    }
  }

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

  for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
    if (!runtime) {
      continue;
    }
    const runtimeProfile = runtime as ProviderRuntimeProfile;
    const runtimeKey = runtimeProfile.runtimeKey || providerKey;

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
        } catch {
          // ignore
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
          const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
          emitProviderError({
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
        } catch {
          // ignore
        }
        continue;
      }
    }

    try {
      const authType = runtimeKeyAuthType.get(runtimeKey) ?? authTypeFromRuntime;
      const apikeyResetForKey = authType === 'apikey' ? apikeyDailyResetTime : null;
      quotaModule?.registerProviderStaticConfig?.(providerKey, {
        authType: authType ?? null,
        apikeyDailyResetTime: apikeyResetForKey
      });
    } catch {
      // best-effort
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
  const providerProtocol =
    (typeof runtime.outboundProfile === 'string' && runtime.outboundProfile.trim()
      ? (runtime.outboundProfile.trim() as ProviderProtocol)
      : undefined) ?? mapProviderProtocol(protocolType);
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
  const authRecord = auth as LegacyAuthFields;
  const authType = server.normalizeAuthType(auth.type);
  const rawType = typeof auth.rawType === 'string' ? auth.rawType.trim().toLowerCase() : '';
  const pickString = (...candidates: unknown[]): string | undefined => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
    return undefined;
  };
  const pickStringArray = (value: unknown): string[] | undefined => {
    if (!value) {
      return undefined;
    }
    if (Array.isArray(value)) {
      const normalized = value.map((item) => pickString(item)).filter((item): item is string => typeof item === 'string');
      return normalized.length ? normalized : undefined;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalized = value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      return normalized.length ? normalized : undefined;
    }
    return undefined;
  };

  if (authType === 'apikey') {
    if (rawType === 'iflow-cookie') {
      return { ...auth, type: 'apikey', rawType: auth.rawType ?? 'iflow-cookie' };
    }
    if (rawType === 'deepseek-account') {
      const tokenFile = pickString(authRecord.tokenFile, authRecord.token_file);
      const accountAlias = pickString(authRecord.accountAlias, authRecord.account_alias, runtime.keyAlias);
      return {
        type: 'apikey',
        rawType: auth.rawType ?? 'deepseek-account',
        value: '',
        ...(accountAlias ? { accountAlias } : {}),
        ...(tokenFile ? { tokenFile } : {})
      };
    }
    const value = await server.resolveApiKeyValue(runtime, auth);
    return { ...auth, type: 'apikey', value };
  }

  const resolved: ProviderRuntimeProfile['auth'] = {
    type: 'oauth',
    secretRef: auth.secretRef,
    value: auth.value,
    oauthProviderId:
      pickString(auth.oauthProviderId) ??
      resolveOAuthProviderIdFromType(pickString(auth.rawType, auth.type)) ??
      pickString(runtime.providerId, runtime.providerFamily),
    rawType: pickString(auth.rawType, auth.type),
    tokenFile: pickString(authRecord.tokenFile, authRecord.token_file),
    tokenUrl: pickString(authRecord.tokenUrl, authRecord.token_url),
    deviceCodeUrl: pickString(authRecord.deviceCodeUrl, authRecord.device_code_url),
    clientId: pickString(authRecord.clientId, authRecord.client_id),
    clientSecret: pickString(authRecord.clientSecret, authRecord.client_secret),
    authorizationUrl: pickString(authRecord.authorizationUrl, authRecord.authorization_url, authRecord.authUrl),
    userInfoUrl: pickString(authRecord.userInfoUrl, authRecord.user_info_url),
    refreshUrl: pickString(authRecord.refreshUrl, authRecord.refresh_url),
    scopes: pickStringArray(authRecord.scopes ?? authRecord.scope)
  };

  let tokenFile = resolved.tokenFile;
  if (!tokenFile && typeof auth.secretRef === 'string' && auth.secretRef.trim()) {
    tokenFile = await server.resolveSecretValue(auth.secretRef.trim());
  }
  resolved.tokenFile = tokenFile;

  return resolved;
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

export async function disposeProviders(server: any): Promise<void> {
  const handles = Array.from(server.providerHandles.values()) as ProviderHandle[];
  await Promise.all(
    handles.map(async (handle) => {
      try {
        await handle.instance.cleanup();
      } catch {
        // ignore cleanup errors
      }
    })
  );
  server.providerHandles.clear();
  (ProviderFactory as unknown as { clearInstanceCache?: () => void }).clearInstanceCache?.();
}

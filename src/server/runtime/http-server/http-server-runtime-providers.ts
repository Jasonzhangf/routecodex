import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderHandle, ProviderProtocol, VirtualRouterArtifacts } from './types.js';
import { ProviderFactory } from '../../../providers/core/runtime/provider-factory.js';
import { mapProviderProtocol, normalizeProviderType, resolveProviderIdentity } from './provider-utils.js';
import { resolveLegacyRouteCodexUserDir, resolveRccAuthDirForRead } from '../../../config/user-data-paths.js';
import {
  buildAntigravityAliasMap,
  collectAntigravityAliases,
  startAntigravityPreload,
  startAntigravityWarmup
} from './antigravity-startup-tasks.js';

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

function resolveHomeDir(): string {
  const envHome = String(process.env.HOME || '').trim();
  if (envHome) {
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir());
}

function expandUserPath(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(resolveHomeDir(), rawPath.slice(2));
  }
  return rawPath;
}

function normalizePath(rawPath: string): string {
  return path.resolve(expandUserPath(rawPath));
}

function isPathWithinDir(targetPath: string, dirPath: string): boolean {
  if (targetPath === dirPath) {
    return true;
  }
  return targetPath.startsWith(`${dirPath}${path.sep}`);
}

async function hasUsableDeepSeekTokenAtPath(tokenFilePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(tokenFilePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') {
        return parsed.trim().length > 0;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const token = record.access_token ?? record.token;
        return typeof token === 'string' && token.trim().length > 0;
      }
      return false;
    } catch {
      return !trimmed.startsWith('{') && !trimmed.startsWith('[');
    }
  } catch {
    return false;
  }
}

async function normalizeDeepSeekLegacyTokenFilePath(rawTokenFilePath: string): Promise<string> {
  const normalizedInputPath = normalizePath(rawTokenFilePath);
  const legacyAuthDir = path.resolve(path.join(resolveLegacyRouteCodexUserDir(), 'auth'));
  if (!isPathWithinDir(normalizedInputPath, legacyAuthDir)) {
    return rawTokenFilePath;
  }

  const candidatePath = path.resolve(path.join(resolveRccAuthDirForRead(), path.basename(normalizedInputPath)));
  if (candidatePath === normalizedInputPath) {
    return rawTokenFilePath;
  }

  const [legacyUsable, candidateUsable] = await Promise.all([
    hasUsableDeepSeekTokenAtPath(normalizedInputPath),
    hasUsableDeepSeekTokenAtPath(candidatePath)
  ]);

  if (!legacyUsable && candidateUsable) {
    return candidatePath;
  }
  return rawTokenFilePath;
}

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
    startAntigravityPreload(collectAntigravityAliases(runtimeMap as Record<string, unknown>));
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

  startAntigravityWarmup(buildAntigravityAliasMap(runtimeMap as Record<string, unknown>), quotaModule);

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
        const runtimeKeyParts = runtimeKey.split('.');
        if (runtimeKeyParts.length >= 3) {
          const aliasScopedRuntimeKey = `${runtimeKeyParts[0]}.${runtimeKeyParts[1]}`;
          if (!server.providerHandles.has(aliasScopedRuntimeKey)) {
            server.providerHandles.set(aliasScopedRuntimeKey, handle);
          }
        }
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
      const providerKeyParts = providerKey.split('.');
      if (providerKeyParts.length >= 3) {
        const aliasScopedKey = `${providerKeyParts[0]}.${providerKeyParts[1]}`;
        if (!server.providerKeyToRuntimeKey.has(aliasScopedKey)) {
          server.providerKeyToRuntimeKey.set(aliasScopedKey, runtimeKey);
        }
      }
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
      const tokenFileRaw = pickString(authRecord.tokenFile, authRecord.token_file);
      const tokenFile = tokenFileRaw
        ? await normalizeDeepSeekLegacyTokenFilePath(tokenFileRaw)
        : undefined;
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

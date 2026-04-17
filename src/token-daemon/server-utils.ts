import path from 'path';
const fetch = globalThis.fetch;
import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';
import { resolveRccConfigFile } from '../config/user-data-paths.js';
import {
  describeHealthProbeFailure,
  probeRouteCodexHealth,
  type RouteCodexHealthProbeResult
} from '../utils/http-health-probe.js';
import type {
  ProviderProfileCollection,
} from '../providers/profile/provider-profile.js';

type UnknownRecord = Record<string, unknown>;
const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

export interface ServerInstanceInfo {
  id: string;
  baseUrl: string;
  host: string;
  port: number;
  configPath: string;
  status: 'online' | 'offline';
}

export interface ProviderAuthView {
  id: string;
  protocol: string;
  transport: {
    baseUrl?: string;
    endpoint?: string;
  };
  auth: {
    kind: 'apikey' | 'oauth' | 'none';
    rawType?: string;
    apiKeySource?: 'inline' | 'secretRef' | 'env';
    apiKeyPreview?: string;
    secretRef?: string;
    env?: string;
    tokenFile?: string;
    clientId?: string;
    tokenUrl?: string;
    deviceCodeUrl?: string;
  };
}

export interface ServerAuthSnapshot {
  server: ServerInstanceInfo;
  providers: ProviderAuthView[];
}

export type DetectLocalServerInstanceDetailedResult =
  | {
      ok: true;
      server: ServerInstanceInfo;
      probe: RouteCodexHealthProbeResult;
    }
  | {
      ok: false;
      kind: 'config_error';
      errorMessage: string;
    };

// const SERVER_PID_FILE = path.join(homedir(), '.routecodex', 'server.cli.pid');

// function tryReadNumber(value: string | null | undefined): number | null {
//   if (!value) {
//     return null;
//   }
//   const parsed = Number(String(value).trim());
//   return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
// }

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return String(error ?? 'unknown');
}

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function logServerUtilsNonBlocking(
  stage: string,
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[token-daemon.server-utils] stage=${stage} operation=${operation} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

export async function detectLocalServerInstanceDetailed(): Promise<DetectLocalServerInstanceDetailedResult> {
  try {
    const cfgPath = await resolveUserConfigPath();
    const { userConfig } = await loadRouteCodexConfig(cfgPath);
    const cfg = userConfig as UnknownRecord;
    const httpNode = (cfg.httpserver && typeof cfg.httpserver === 'object'
      ? (cfg.httpserver as UnknownRecord)
      : undefined);
    const srvNode = (cfg.server && typeof cfg.server === 'object'
      ? (cfg.server as UnknownRecord)
      : undefined);
    const host =
      readString(httpNode?.host) ??
      readString(srvNode?.host) ??
      '127.0.0.1';
    const port =
      readNumber(httpNode?.port) ??
      readNumber(srvNode?.port) ??
      readNumber(cfg.port) ??
      5555;
    const baseUrl = `http://${host}:${port}`;
    const probe = await probeRouteCodexHealth({
      fetchImpl: fetch,
      host,
      port,
      timeoutMs: 1500
    });
    if (!probe.ok) {
      logServerUtilsNonBlocking('detect_local_server', 'health_probe', describeHealthProbeFailure(probe), {
        host,
        port,
        kind: probe.kind,
        status: probe.status
      });
    }

    return {
      ok: true,
      server: {
        id: `local-${port}`,
        baseUrl,
        host,
        port,
        configPath: cfgPath,
        status: probe.ok ? 'online' : 'offline'
      },
      probe
    };
  } catch (error) {
    logServerUtilsNonBlocking('detect_local_server', 'load_config', error);
    return {
      ok: false,
      kind: 'config_error',
      errorMessage: formatUnknownError(error)
    };
  }
}

export async function detectLocalServerInstance(): Promise<ServerInstanceInfo | null> {
  const result = await detectLocalServerInstanceDetailed();
  if (!result.ok) {
    return null;
  }
  return result.server;
}

async function resolveUserConfigPath(): Promise<string> {
  try {
    // Prefer ROUTECODEX_CONFIG if present
    const envPath = process.env.ROUTECODEX_CONFIG || process.env.ROUTECODEX_CONFIG_PATH;
    if (envPath && envPath.trim()) {
      return path.resolve(envPath.trim());
    }
    return resolveRccConfigFile();
  } catch (error) {
    logServerUtilsNonBlocking('resolve_user_config_path', 'fallback_to_default_config_path', error, {
      envPath: process.env.ROUTECODEX_CONFIG || process.env.ROUTECODEX_CONFIG_PATH || ''
    });
    return resolveRccConfigFile();
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function buildServerAuthSnapshot(): Promise<ServerAuthSnapshot | null> {
  const server = await detectLocalServerInstance();
  if (!server) {
    return null;
  }
  const { userConfig, providerProfiles } = await loadRouteCodexConfig(server.configPath);
  const providers = projectProviderAuth(providerProfiles, userConfig as UnknownRecord);
  return { server, providers };
}

function projectProviderAuth(
  collection: ProviderProfileCollection,
  _userConfig: UnknownRecord
): ProviderAuthView[] {
  const result: ProviderAuthView[] = [];
  for (const profile of collection.profiles) {
    const baseUrl = profile.transport.baseUrl;
    const endpoint = profile.transport.endpoint;
    const auth = profile.auth;
    if (auth.kind === 'apikey') {
      const apiKeyPreview =
        typeof auth.apiKey === 'string' && auth.apiKey.trim()
          ? anonymizeSecret(auth.apiKey.trim())
          : undefined;
      const rawType = typeof auth.rawType === 'string' && auth.rawType.trim() ? auth.rawType.trim() : undefined;
      const apiKeySource: ProviderAuthView['auth']['apiKeySource'] =
        apiKeyPreview ? 'inline'
        : auth.secretRef ? 'secretRef'
        : auth.env ? 'env'
        : undefined;
      result.push({
        id: profile.id,
        protocol: profile.protocol,
        transport: { baseUrl, endpoint },
        auth: {
          kind: 'apikey',
          rawType,
          apiKeySource,
          apiKeyPreview,
          secretRef: auth.secretRef,
          env: auth.env,
          tokenFile: auth.tokenFile
        }
      });
      continue;
    }
    if (auth.kind === 'oauth') {
      result.push({
        id: profile.id,
        protocol: profile.protocol,
        transport: { baseUrl, endpoint },
        auth: {
          kind: 'oauth',
          tokenFile: auth.tokenFile,
          clientId: auth.clientId,
          tokenUrl: auth.tokenUrl,
          deviceCodeUrl: auth.deviceCodeUrl
        }
      });
      continue;
    }
    result.push({
      id: profile.id,
      protocol: profile.protocol,
      transport: { baseUrl, endpoint },
      auth: { kind: 'none' }
    });
  }
  return result;
}

function anonymizeSecret(value: string): string {
  if (!value || value.length <= 8) {
    return '***';
  }
  const prefix = value.slice(0, 4);
  const suffix = value.slice(-4);
  return `${prefix}…${suffix}`;
}

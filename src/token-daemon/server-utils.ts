import path from 'path';
import { homedir } from 'os';
import fetch from 'node-fetch';
import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';
import type {
  ProviderProfileCollection,
} from '../providers/profile/provider-profile.js';

type UnknownRecord = Record<string, unknown>;

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

// const SERVER_PID_FILE = path.join(homedir(), '.routecodex', 'server.cli.pid');

// function tryReadNumber(value: string | null | undefined): number | null {
//   if (!value) {
//     return null;
//   }
//   const parsed = Number(String(value).trim());
//   return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
// }

export async function detectLocalServerInstance(): Promise<ServerInstanceInfo | null> {
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

    let status: ServerInstanceInfo['status'] = 'offline';
    try {
      const res = await fetch(`${baseUrl}/health`, { method: 'GET', timeout: 1500 } as any);
      if (res.ok) {
        status = 'online';
      }
    } catch {
      status = 'offline';
    }

    return {
      id: `local-${port}`,
      baseUrl,
      host,
      port,
      configPath: cfgPath,
      status
    };
  } catch {
    return null;
  }
}

async function resolveUserConfigPath(): Promise<string> {
  try {
    // Prefer ROUTECODEX_CONFIG if present
    const envPath = process.env.ROUTECODEX_CONFIG || process.env.ROUTECODEX_CONFIG_PATH;
    if (envPath && envPath.trim()) {
      return path.resolve(envPath.trim());
    }
    const defaultPath = path.join(homedir(), '.routecodex', 'config.json');
    return defaultPath;
  } catch {
    return path.join(homedir(), '.routecodex', 'config.json');
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
          apiKeySource,
          apiKeyPreview,
          secretRef: auth.secretRef,
          env: auth.env
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

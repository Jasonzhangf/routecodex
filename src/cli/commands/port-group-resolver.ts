import fs from 'node:fs';
import { homedir } from 'node:os';

import { LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { decodeUserConfigFileSync } from '../../config/user-config-codec.js';

export type PortGroupResolveContext = {
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
  getHomeDir?: () => string;
};

export type ResolvedPortGroup = {
  ports: number[];
  host: string;
  configPath: string;
};

function asValidPort(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return null;
  }
  return Math.floor(v);
}

export function resolvePortGroupFromConfig(
  ctx: PortGroupResolveContext,
  options?: { configPath?: string; targetPort?: number | null }
): ResolvedPortGroup | null {
  const fsImpl = ctx.fsImpl ?? fs;
  const home = ctx.getHomeDir ?? (() => homedir());
  const configPath = options?.configPath || resolveRouteCodexConfigPath();
  if (!fsImpl.existsSync(configPath)) {
    return null;
  }

  const parsed = decodeUserConfigFileSync(configPath, fsImpl as Pick<typeof fs, 'readFileSync'>).parsed as Record<string, unknown>;
  const httpserver = (parsed.httpserver && typeof parsed.httpserver === 'object' ? parsed.httpserver : {}) as Record<string, unknown>;
  const server = (parsed.server && typeof parsed.server === 'object' ? parsed.server : {}) as Record<string, unknown>;

  const host = String(httpserver.host ?? server.host ?? parsed.host ?? LOCAL_HOSTS.LOCALHOST);

  const fromPorts: number[] = [];
  const portsRaw = httpserver.ports;
  if (Array.isArray(portsRaw)) {
    for (const entry of portsRaw) {
      const p = entry && typeof entry === 'object' ? asValidPort((entry as Record<string, unknown>).port) : null;
      if (p) {
        fromPorts.push(p);
      }
    }
  }

  if (fromPorts.length > 0) {
    const unique = Array.from(new Set(fromPorts)).sort((a, b) => a - b);
    if (options?.targetPort && !unique.includes(options.targetPort)) {
      return null;
    }
    return { ports: unique, host, configPath };
  }

  const single = asValidPort(httpserver.port) ?? asValidPort(server.port) ?? asValidPort((parsed as Record<string, unknown>).port);
  if (!single) {
    return null;
  }
  if (options?.targetPort && single !== options.targetPort) {
    return null;
  }
  return { ports: [single], host, configPath };
}

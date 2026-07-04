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

export type PortGroupResolveOptions = {
  configPath?: string;
  targetPort?: number | null;
  includeSiblingsForTarget?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readHost(record: Record<string, unknown> | null): string {
  if (!record) {
    return '';
  }
  const value = record.host;
  return typeof value === 'string' ? value.trim() : '';
}

export function resolvePortGroupFromParsedConfig(
  parsed: Record<string, unknown>,
  options?: PortGroupResolveOptions
): ResolvedPortGroup | null {
  const httpserver = (parsed.httpserver && typeof parsed.httpserver === 'object' ? parsed.httpserver : {}) as Record<string, unknown>;
  const server = (parsed.server && typeof parsed.server === 'object' ? parsed.server : {}) as Record<string, unknown>;

  const defaultHost = String(httpserver.host ?? server.host ?? parsed.host ?? LOCAL_HOSTS.LOCALHOST);

  const fromPorts: number[] = [];
  const portsRaw = httpserver.ports;
  let matchedPortHost = '';
  let matchedPortSeen = false;
  if (Array.isArray(portsRaw)) {
    for (const entry of portsRaw) {
      const record = asRecord(entry);
      const p = record ? asValidPort(record.port) : null;
      if (p) {
        fromPorts.push(p);
        if (options?.targetPort && p === options.targetPort) {
          matchedPortSeen = true;
          matchedPortHost = readHost(record);
        }
      }
    }
  }

  if (fromPorts.length > 0) {
    const unique = Array.from(new Set(fromPorts)).sort((a, b) => a - b);
    if (options?.targetPort && !matchedPortSeen) {
      return null;
    }
    const resolvedPorts = options?.targetPort && !options.includeSiblingsForTarget ? [options.targetPort] : unique;
    return {
      ports: resolvedPorts,
      host: matchedPortHost || defaultHost,
      configPath: options?.configPath || ''
    };
  }

  const single = asValidPort(httpserver.port) ?? asValidPort(server.port) ?? asValidPort((parsed as Record<string, unknown>).port);
  if (!single) {
    return null;
  }
  if (options?.targetPort && single !== options.targetPort) {
    return null;
  }
  return {
    ports: [single],
    host: defaultHost,
    configPath: options?.configPath || ''
  };
}

function asValidPort(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return null;
  }
  return Math.floor(v);
}

export function resolvePortGroupFromConfig(
  ctx: PortGroupResolveContext,
  options?: PortGroupResolveOptions
): ResolvedPortGroup | null {
  const fsImpl = ctx.fsImpl ?? fs;
  const home = ctx.getHomeDir ?? (() => homedir());
  const configPath = options?.configPath || resolveRouteCodexConfigPath();
  if (!fsImpl.existsSync(configPath)) {
    return null;
  }

  const parsed = decodeUserConfigFileSync(configPath, fsImpl as Pick<typeof fs, 'readFileSync'>).parsed as Record<string, unknown>;
  return resolvePortGroupFromParsedConfig(parsed, {
    configPath,
    targetPort: options?.targetPort,
    includeSiblingsForTarget: options?.includeSiblingsForTarget
  });
}

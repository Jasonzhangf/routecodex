import type { Request } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRouteCodexConfigPath } from '../../../../config/config-paths.js';

export type RoutingLocation = 'virtualrouter.routing' | 'routing';

export interface RoutingSnapshot {
  routing: Record<string, unknown>;
  loadBalancing: Record<string, unknown>;
  hasLoadBalancing: boolean;
  location: RoutingLocation;
  version: string | null;
}

export interface RoutingSourceSummary {
  id: string;
  kind: 'active' | 'routecodex' | 'import' | 'provider';
  label: string;
  path: string;
  location: RoutingLocation;
  version: string | null;
}

export function pickProviderRootDir(): string {
  const envPath = process.env.ROUTECODEX_PROVIDER_DIR;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath.trim());
  }
  return path.join(pickHomeDir(), '.routecodex', 'provider');
}

function pickHomeDir(): string {
  const home = process.env.HOME;
  if (home && home.trim()) {
    return path.resolve(home.trim());
  }
  return os.homedir();
}

export function pickUserConfigPath(): string {
  const envPaths = [
    process.env.RCC4_CONFIG_PATH,
    process.env.ROUTECODEX_CONFIG,
    process.env.ROUTECODEX_CONFIG_PATH
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const p of envPaths) {
    try {
      if (p && fsSync.existsSync(p) && fsSync.statSync(p).isFile()) {
        return p;
      }
    } catch {
      // ignore
    }
  }
  return resolveRouteCodexConfigPath();
}

export function extractRoutingSnapshot(config: unknown): RoutingSnapshot {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      routing: {},
      loadBalancing: {},
      hasLoadBalancing: false,
      location: 'virtualrouter.routing',
      version: null
    };
  }
  const root = config as Record<string, unknown>;
  const version = typeof root.version === 'string' ? root.version : null;

  const vr = root.virtualrouter;
  if (vr && typeof vr === 'object' && !Array.isArray(vr)) {
    const routingNode = (vr as Record<string, unknown>).routing;
    const loadBalancingNode = (vr as Record<string, unknown>).loadBalancing;
    const hasLoadBalancing = Boolean(
      loadBalancingNode && typeof loadBalancingNode === 'object' && !Array.isArray(loadBalancingNode)
    );
    if (routingNode && typeof routingNode === 'object' && !Array.isArray(routingNode)) {
      return {
        routing: routingNode as Record<string, unknown>,
        loadBalancing: hasLoadBalancing ? (loadBalancingNode as Record<string, unknown>) : {},
        hasLoadBalancing,
        location: 'virtualrouter.routing',
        version
      };
    }
    return {
      routing: {},
      loadBalancing: hasLoadBalancing ? (loadBalancingNode as Record<string, unknown>) : {},
      hasLoadBalancing,
      location: 'virtualrouter.routing',
      version
    };
  }

  const routingNode = root.routing;
  const loadBalancingNode = root.loadBalancing;
  const hasLoadBalancing = Boolean(
    loadBalancingNode && typeof loadBalancingNode === 'object' && !Array.isArray(loadBalancingNode)
  );
  if (routingNode && typeof routingNode === 'object' && !Array.isArray(routingNode)) {
    return {
      routing: routingNode as Record<string, unknown>,
      loadBalancing: hasLoadBalancing ? (loadBalancingNode as Record<string, unknown>) : {},
      hasLoadBalancing,
      location: 'routing',
      version
    };
  }
  return {
    routing: {},
    loadBalancing: hasLoadBalancing ? (loadBalancingNode as Record<string, unknown>) : {},
    hasLoadBalancing,
    location: 'routing',
    version
  };
}

export function applyRoutingAtLocation(
  config: unknown,
  routing: Record<string, unknown>,
  location: RoutingLocation,
  options?: {
    applyLoadBalancing?: boolean;
    loadBalancing?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  const shouldApplyLoadBalancing = options?.applyLoadBalancing === true;
  const loadBalancing = options?.loadBalancing;
  if (location === 'routing') {
    if (!shouldApplyLoadBalancing) {
      return { ...root, routing };
    }
    if (loadBalancing === null) {
      const rest = { ...root };
      delete rest.loadBalancing;
      return { ...rest, routing };
    }
    return { ...root, routing, loadBalancing: loadBalancing ?? {} };
  }
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  if (!shouldApplyLoadBalancing) {
    return { ...root, virtualrouter: { ...vr, routing } };
  }
  if (loadBalancing === null) {
    const vrRest = { ...vr };
    delete vrRest.loadBalancing;
    return { ...root, virtualrouter: { ...vrRest, routing } };
  }
  return { ...root, virtualrouter: { ...vr, routing, loadBalancing: loadBalancing ?? {} } };
}

export function readQueryString(req: Request, key: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function expandTilde(inputPath: string): string {
  if (!inputPath.startsWith('~')) {
    return inputPath;
  }
  if (inputPath === '~') {
    return pickHomeDir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(pickHomeDir(), inputPath.slice(2));
  }
  return inputPath;
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
  const base = path.resolve(dirPath);
  const abs = path.resolve(filePath);
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..');
}

export function resolveAllowedAdminFilePath(inputPath: string | undefined): string {
  const active = pickUserConfigPath();
  if (!inputPath) {
    return active;
  }
  const expanded = expandTilde(inputPath);
  const resolved = path.resolve(expanded);
  if (resolved === active) {
    return resolved;
  }
  const routecodexHome = path.join(pickHomeDir(), '.routecodex');
  const providerRoot = pickProviderRootDir();
  if (isPathWithinDir(resolved, routecodexHome) || isPathWithinDir(resolved, providerRoot)) {
    return resolved;
  }
  const error = new Error('path is not allowed') as Error & { code?: string };
  error.code = 'forbidden_path';
  throw error;
}

export async function listRoutingSources(): Promise<RoutingSourceSummary[]> {
  const activePath = pickUserConfigPath();
  const routecodexHome = path.join(pickHomeDir(), '.routecodex');
  const providerRoot = pickProviderRootDir();

  const candidates: Array<{ kind: RoutingSourceSummary['kind']; label: string; path: string }> = [];
  candidates.push({ kind: 'active', label: 'Active config', path: activePath });

  const defaultConfig = path.join(routecodexHome, 'config.json');
  if (defaultConfig !== activePath) {
    candidates.push({ kind: 'routecodex', label: 'Default config.json', path: defaultConfig });
  }

  // Root-level config backups or variants (config_*.json)
  try {
    const entries = await fs.readdir(routecodexHome, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      const lower = name.toLowerCase();
      if (!lower.endsWith('.json')) continue;
      if (!lower.startsWith('config_')) continue;
      candidates.push({ kind: 'routecodex', label: name, path: path.join(routecodexHome, name) });
    }
  } catch {
    // ignore
  }

  // Imported configs under ~/.routecodex/config and ~/.routecodex/config/multi
  for (const dir of [path.join(routecodexHome, 'config'), path.join(routecodexHome, 'config', 'multi')]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const name = ent.name;
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (lower.endsWith('.ds_store')) continue;
        const label = dir.endsWith(path.join('config', 'multi')) ? `config/multi/${name}` : `config/${name}`;
        candidates.push({ kind: 'import', label, path: path.join(dir, name) });
      }
    } catch {
      // ignore
    }
  }

  // Provider directory v1 configs often carry their own virtualrouter.routing for standalone operation.
  try {
    const dirs = await fs.readdir(providerRoot, { withFileTypes: true });
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const providerId = ent.name;
      const providerDir = path.join(providerRoot, providerId);
      let files: string[] = [];
      try {
        files = (await fs.readdir(providerDir, { withFileTypes: true }))
          .filter((f) => f.isFile())
          .map((f) => f.name);
      } catch {
        files = [];
      }
      for (const name of files) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (!lower.includes('.v1.json') && lower !== 'config.codex.json') continue;
        candidates.push({ kind: 'provider', label: `provider/${providerId}/${name}`, path: path.join(providerDir, name) });
      }
    }
  } catch {
    // ignore
  }

  const out: RoutingSourceSummary[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const abs = path.resolve(candidate.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const allowed = resolveAllowedAdminFilePath(abs);
      const raw = await fs.readFile(allowed, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const snapshot = extractRoutingSnapshot(parsed);

      const hasRoutingContainer =
        snapshot.location === 'virtualrouter.routing'
          ? Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).virtualrouter)
          : Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
      if (!hasRoutingContainer) continue;

      out.push({
        id: abs,
        kind: candidate.kind,
        label: candidate.label,
        path: abs,
        location: snapshot.location,
        version: snapshot.version
      });
    } catch {
      // ignore parse/read errors
    }
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
  return out;
}

export async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const backup = `${filePath}.${Date.now()}.bak`;
  try {
    await fs.copyFile(filePath, backup);
  } catch {
    return;
  }
}

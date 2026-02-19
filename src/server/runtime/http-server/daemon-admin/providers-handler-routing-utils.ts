import type { Request } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRouteCodexConfigPath } from '../../../../config/config-paths.js';

type UnknownRecord = Record<string, unknown>;

const ROUTING_POLICY_OPTIONAL_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'clock'
] as const;

type RoutingPolicyOptionalKey = (typeof ROUTING_POLICY_OPTIONAL_KEYS)[number];

type RoutingGroupErrorCode =
  | 'invalid_group_id'
  | 'invalid_policy'
  | 'group_not_found'
  | 'group_in_use'
  | 'group_last_one';

export type RoutingLocation = 'virtualrouter.routing' | 'routing';

export interface RoutingPolicyGroup {
  routing: Record<string, unknown>;
  loadBalancing?: Record<string, unknown>;
  classifier?: Record<string, unknown>;
  health?: Record<string, unknown>;
  contextRouting?: Record<string, unknown>;
  webSearch?: Record<string, unknown>;
  execCommandGuard?: Record<string, unknown>;
  clock?: Record<string, unknown>;
}

export interface RoutingGroupsSnapshot {
  groups: Record<string, RoutingPolicyGroup>;
  activeGroupId: string;
  hasRoutingPolicyGroups: boolean;
  location: RoutingLocation;
  version: string | null;
}

export interface RoutingSnapshot {
  routing: Record<string, unknown>;
  loadBalancing: Record<string, unknown>;
  hasLoadBalancing: boolean;
  location: RoutingLocation;
  version: string | null;
  activeGroupId?: string;
  hasRoutingPolicyGroups?: boolean;
}

export interface RoutingSourceSummary {
  id: string;
  kind: 'active' | 'routecodex' | 'import' | 'provider';
  label: string;
  path: string;
  location: RoutingLocation;
  version: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createRoutingGroupError(code: RoutingGroupErrorCode, message: string): Error & { code: RoutingGroupErrorCode } {
  const error = new Error(message) as Error & { code: RoutingGroupErrorCode };
  error.code = code;
  return error;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function getRoutingPolicyOptionalValue(
  input: RoutingPolicyGroup,
  key: RoutingPolicyOptionalKey
): Record<string, unknown> | undefined {
  switch (key) {
    case 'loadBalancing':
      return input.loadBalancing;
    case 'classifier':
      return input.classifier;
    case 'health':
      return input.health;
    case 'contextRouting':
      return input.contextRouting;
    case 'webSearch':
      return input.webSearch;
    case 'execCommandGuard':
      return input.execCommandGuard;
    case 'clock':
      return input.clock;
    default:
      return undefined;
  }
}

function setRoutingPolicyOptionalValue(
  target: RoutingPolicyGroup,
  key: RoutingPolicyOptionalKey,
  value: Record<string, unknown>
): void {
  switch (key) {
    case 'loadBalancing':
      target.loadBalancing = value;
      return;
    case 'classifier':
      target.classifier = value;
      return;
    case 'health':
      target.health = value;
      return;
    case 'contextRouting':
      target.contextRouting = value;
      return;
    case 'webSearch':
      target.webSearch = value;
      return;
    case 'execCommandGuard':
      target.execCommandGuard = value;
      return;
    case 'clock':
      target.clock = value;
      return;
  }
}

function normalizeRoutingPolicyGroupNode(
  input: unknown,
  options?: { strictRouting?: boolean }
): RoutingPolicyGroup {
  if (!isRecord(input)) {
    if (options?.strictRouting) {
      throw createRoutingGroupError('invalid_policy', 'policy must be an object');
    }
    return { routing: {} };
  }

  const inputRouting = input.routing;
  if (!isRecord(inputRouting)) {
    if (options?.strictRouting) {
      throw createRoutingGroupError('invalid_policy', 'policy.routing must be an object');
    }
  }

  const out: RoutingPolicyGroup = {
    routing: isRecord(inputRouting) ? cloneRecord(inputRouting) : {}
  };

  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = input[key];
    if (isRecord(value)) {
      setRoutingPolicyOptionalValue(out, key, cloneRecord(value));
    }
  }

  return out;
}

function serializeRoutingPolicyGroupNode(input: RoutingPolicyGroup): Record<string, unknown> {
  const out: Record<string, unknown> = {
    routing: cloneRecord(isRecord(input.routing) ? input.routing : {})
  };
  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = getRoutingPolicyOptionalValue(input, key);
    if (isRecord(value)) {
      out[key] = cloneRecord(value);
    }
  }
  return out;
}

function detectRoutingLocation(root: UnknownRecord): RoutingLocation {
  return isRecord(root.virtualrouter) ? 'virtualrouter.routing' : 'routing';
}

function getLocationContainer(root: UnknownRecord, location: RoutingLocation): UnknownRecord {
  if (location === 'routing') {
    return root;
  }
  const vr = root.virtualrouter;
  return isRecord(vr) ? (vr as UnknownRecord) : {};
}

function withLocationContainer(
  root: UnknownRecord,
  location: RoutingLocation,
  updater: (container: UnknownRecord) => UnknownRecord
): UnknownRecord {
  if (location === 'routing') {
    return updater(cloneRecord(root));
  }
  const vr = isRecord(root.virtualrouter) ? (root.virtualrouter as UnknownRecord) : {};
  const nextVr = updater(cloneRecord(vr));
  return {
    ...root,
    virtualrouter: nextVr
  };
}

function hasRoutingPolicyGroupConfig(container: UnknownRecord): boolean {
  const groupsNode = container.routingPolicyGroups;
  if (isRecord(groupsNode)) {
    return true;
  }
  const activeNode = container.activeRoutingPolicyGroup;
  return typeof activeNode === 'string' && activeNode.trim().length > 0;
}

function extractPolicyFromContainer(container: UnknownRecord): RoutingPolicyGroup {
  return normalizeRoutingPolicyGroupNode(container);
}

function resolveActiveGroupId(groups: Record<string, RoutingPolicyGroup>, preferred: unknown): string {
  const names = Object.keys(groups);
  if (!names.length) {
    return 'default';
  }

  if (typeof preferred === 'string') {
    const candidate = preferred.trim();
    if (candidate && groups[candidate]) {
      return candidate;
    }
  }

  if (groups.default) {
    return 'default';
  }

  names.sort((a, b) => a.localeCompare(b));
  return names[0];
}

function materializePolicyIntoContainer(
  container: UnknownRecord,
  policy: RoutingPolicyGroup,
  options?: { preserveOptionalWhenMissing?: boolean }
): UnknownRecord {
  const next = cloneRecord(container);
  next.routing = cloneRecord(isRecord(policy.routing) ? policy.routing : {});

  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = getRoutingPolicyOptionalValue(policy, key);
    if (isRecord(value)) {
      next[key] = cloneRecord(value);
      continue;
    }
    if (options?.preserveOptionalWhenMissing) {
      continue;
    }
    delete next[key];
  }

  return next;
}

function serializeRoutingGroups(groups: Record<string, RoutingPolicyGroup>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    out[key] = serializeRoutingPolicyGroupNode(groups[key]);
  }
  return out;
}

function applyRoutingGroupsIntoContainer(
  container: UnknownRecord,
  groups: Record<string, RoutingPolicyGroup>,
  activeGroupId: string
): UnknownRecord {
  const activePolicy = groups[activeGroupId] ?? { routing: {} };
  const withMirror = materializePolicyIntoContainer(container, activePolicy);
  withMirror.activeRoutingPolicyGroup = activeGroupId;
  withMirror.routingPolicyGroups = serializeRoutingGroups(groups);
  return withMirror;
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

export function extractRoutingGroupsSnapshot(
  config: unknown,
  preferredLocation?: RoutingLocation
): RoutingGroupsSnapshot {
  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const version = typeof root.version === 'string' ? root.version : null;
  const location = preferredLocation ?? detectRoutingLocation(root);
  const container = getLocationContainer(root, location);

  const groupsNode = container.routingPolicyGroups;
  const groups: Record<string, RoutingPolicyGroup> = {};

  if (isRecord(groupsNode)) {
    for (const [groupId, groupNode] of Object.entries(groupsNode)) {
      if (typeof groupId !== 'string' || !groupId.trim()) {
        continue;
      }
      if (!isRecord(groupNode)) {
        continue;
      }
      groups[groupId] = normalizeRoutingPolicyGroupNode(groupNode);
    }
  }

  if (!Object.keys(groups).length) {
    groups.default = extractPolicyFromContainer(container);
  }

  const activeGroupId = resolveActiveGroupId(groups, container.activeRoutingPolicyGroup);

  return {
    groups,
    activeGroupId,
    hasRoutingPolicyGroups: isRecord(groupsNode),
    location,
    version
  };
}

export function extractRoutingSnapshot(config: unknown): RoutingSnapshot {
  const groupsSnapshot = extractRoutingGroupsSnapshot(config);
  const activePolicy = groupsSnapshot.groups[groupsSnapshot.activeGroupId] ?? { routing: {} };
  const hasLoadBalancing = isRecord(activePolicy.loadBalancing);

  return {
    routing: cloneRecord(isRecord(activePolicy.routing) ? activePolicy.routing : {}),
    loadBalancing: hasLoadBalancing ? cloneRecord(activePolicy.loadBalancing as Record<string, unknown>) : {},
    hasLoadBalancing,
    location: groupsSnapshot.location,
    version: groupsSnapshot.version,
    activeGroupId: groupsSnapshot.activeGroupId,
    hasRoutingPolicyGroups: groupsSnapshot.hasRoutingPolicyGroups
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
  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const shouldApplyLoadBalancing = options?.applyLoadBalancing === true;
  const nextRouting = cloneRecord(isRecord(routing) ? routing : {});

  const container = getLocationContainer(root, location);
  if (!hasRoutingPolicyGroupConfig(container)) {
    return withLocationContainer(root, location, (baseContainer) => {
      if (!shouldApplyLoadBalancing) {
        return {
          ...baseContainer,
          routing: nextRouting
        };
      }

      if (options?.loadBalancing === null) {
        const rest = { ...baseContainer, routing: nextRouting } as UnknownRecord;
        delete rest.loadBalancing;
        return rest;
      }

      return {
        ...baseContainer,
        routing: nextRouting,
        loadBalancing: cloneRecord(options?.loadBalancing ?? {})
      };
    });
  }

  const groupsSnapshot = extractRoutingGroupsSnapshot(root, location);
  const groups = { ...groupsSnapshot.groups };
  const activeGroupId = groupsSnapshot.activeGroupId;
  const baseActive = groups[activeGroupId] ?? { routing: {} };
  const nextActive: RoutingPolicyGroup = {
    ...baseActive,
    routing: nextRouting
  };

  if (shouldApplyLoadBalancing) {
    if (options?.loadBalancing === null) {
      delete nextActive.loadBalancing;
    } else {
      nextActive.loadBalancing = cloneRecord(options?.loadBalancing ?? {});
    }
  }

  groups[activeGroupId] = nextActive;

  return withLocationContainer(root, location, (baseContainer) =>
    applyRoutingGroupsIntoContainer(baseContainer, groups, activeGroupId)
  );
}

export function applyRoutingPolicyAtLocation(
  config: unknown,
  policy: unknown,
  location: RoutingLocation
): Record<string, unknown> {
  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const normalizedPolicy = normalizeRoutingPolicyGroupNode(policy, { strictRouting: true });
  const container = getLocationContainer(root, location);

  if (!hasRoutingPolicyGroupConfig(container)) {
    return withLocationContainer(root, location, (baseContainer) =>
      materializePolicyIntoContainer(baseContainer, normalizedPolicy)
    );
  }

  const groupsSnapshot = extractRoutingGroupsSnapshot(root, location);
  const groups = {
    ...groupsSnapshot.groups,
    [groupsSnapshot.activeGroupId]: normalizedPolicy
  };

  return withLocationContainer(root, location, (baseContainer) =>
    applyRoutingGroupsIntoContainer(baseContainer, groups, groupsSnapshot.activeGroupId)
  );
}

export function upsertRoutingGroupAtLocation(
  config: unknown,
  groupId: string,
  policy: unknown,
  location: RoutingLocation
): Record<string, unknown> {
  const normalizedGroupId = typeof groupId === 'string' ? groupId.trim() : '';
  if (!normalizedGroupId) {
    throw createRoutingGroupError('invalid_group_id', 'groupId is required');
  }

  const normalizedPolicy = normalizeRoutingPolicyGroupNode(policy, { strictRouting: true });
  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const groupsSnapshot = extractRoutingGroupsSnapshot(root, location);

  const groups = {
    ...groupsSnapshot.groups,
    [normalizedGroupId]: normalizedPolicy
  };

  const activeGroupId = resolveActiveGroupId(groups, groupsSnapshot.activeGroupId);

  return withLocationContainer(root, location, (baseContainer) =>
    applyRoutingGroupsIntoContainer(baseContainer, groups, activeGroupId)
  );
}

export function deleteRoutingGroupAtLocation(
  config: unknown,
  groupId: string,
  location: RoutingLocation
): Record<string, unknown> {
  const normalizedGroupId = typeof groupId === 'string' ? groupId.trim() : '';
  if (!normalizedGroupId) {
    throw createRoutingGroupError('invalid_group_id', 'groupId is required');
  }

  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const groupsSnapshot = extractRoutingGroupsSnapshot(root, location);
  const groups = { ...groupsSnapshot.groups };

  if (!groups[normalizedGroupId]) {
    throw createRoutingGroupError('group_not_found', `group not found: ${normalizedGroupId}`);
  }

  if (groupsSnapshot.activeGroupId === normalizedGroupId) {
    throw createRoutingGroupError('group_in_use', `cannot delete active group: ${normalizedGroupId}`);
  }

  if (Object.keys(groups).length <= 1) {
    throw createRoutingGroupError('group_last_one', 'cannot delete the last routing policy group');
  }

  delete groups[normalizedGroupId];

  const activeGroupId = resolveActiveGroupId(groups, groupsSnapshot.activeGroupId);

  return withLocationContainer(root, location, (baseContainer) =>
    applyRoutingGroupsIntoContainer(baseContainer, groups, activeGroupId)
  );
}

export function activateRoutingGroupAtLocation(
  config: unknown,
  groupId: string,
  location: RoutingLocation
): Record<string, unknown> {
  const normalizedGroupId = typeof groupId === 'string' ? groupId.trim() : '';
  if (!normalizedGroupId) {
    throw createRoutingGroupError('invalid_group_id', 'groupId is required');
  }

  const root = isRecord(config) ? (config as UnknownRecord) : {};
  const groupsSnapshot = extractRoutingGroupsSnapshot(root, location);
  if (!groupsSnapshot.groups[normalizedGroupId]) {
    throw createRoutingGroupError('group_not_found', `group not found: ${normalizedGroupId}`);
  }

  return withLocationContainer(root, location, (baseContainer) =>
    applyRoutingGroupsIntoContainer(baseContainer, groupsSnapshot.groups, normalizedGroupId)
  );
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

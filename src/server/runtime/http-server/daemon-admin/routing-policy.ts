import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeUserConfigFile } from '../../../../config/user-config-codec.js';
import { writeUserConfigFile } from '../../../../config/user-config-writer.js';
import { stableStringify } from '../../../../monitoring/semantic-tracker.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';
import {
  applyRoutingPolicyAtLocation,
  extractRoutingGroupsSnapshot
} from './providers-handler-routing-utils.js';

type UnknownRecord = Record<string, unknown>;

export type RoutingPolicySnapshotV1 = {
  schemaVersion: 1;
  virtualrouter: {
    routing: unknown;
    loadBalancing?: unknown;
    classifier?: unknown;
    health?: unknown;
    contextRouting?: unknown;
    webSearch?: unknown;
    execCommandGuard?: unknown;
    session?: unknown;
  };
};


function coercePolicyVirtualRouterNode(policy: unknown): UnknownRecord | null {
  if (!isRecord(policy)) {
    return null;
  }
  const vr = (policy as UnknownRecord).virtualrouter;
  if (isRecord(vr)) {
    return vr as UnknownRecord;
  }
  // Allow a flattened shape (policy.routing / policy.loadBalancing) for compatibility.
  return policy as UnknownRecord;
}

export function canonicalizePolicyFromRawConfig(rawConfig: UnknownRecord): RoutingPolicySnapshotV1 | null {
  const preferredLocation = isRecord(rawConfig.virtualrouter) ? 'virtualrouter.routing' : 'routing';
  const groupsSnapshot = extractRoutingGroupsSnapshot(rawConfig, preferredLocation);
  const activePolicy = groupsSnapshot.groups[groupsSnapshot.activeGroupId];
  const routing = activePolicy?.routing;
  if (!isRecord(routing)) {
    return null;
  }

  const loadBalancing = activePolicy.loadBalancing;
  const classifier = activePolicy.classifier;
  const health = activePolicy.health;
  const contextRouting = activePolicy.contextRouting;
  const webSearch = activePolicy.webSearch;
  const execCommandGuard = activePolicy.execCommandGuard;
  const session = activePolicy.session;

  const vr: RoutingPolicySnapshotV1['virtualrouter'] = {
    routing,
    ...(loadBalancing !== undefined ? { loadBalancing } : {}),
    ...(classifier !== undefined ? { classifier } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(contextRouting !== undefined ? { contextRouting } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(execCommandGuard !== undefined ? { execCommandGuard } : {}),
    ...(session !== undefined ? { session } : {})
  };

  return { schemaVersion: 1, virtualrouter: vr };
}

export function hashRoutingPolicy(policy: RoutingPolicySnapshotV1): string {
  const content = stableStringify(policy);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function loadPolicyFromConfigPath(
  configPath: string | null | undefined
): Promise<{ policy: RoutingPolicySnapshotV1 | null; policyHash: string | null }> {
  if (!configPath || !configPath.trim()) {
    return { policy: null, policyHash: null };
  }
  try {
    const decoded = await decodeUserConfigFile(configPath);
    const cfg: UnknownRecord = isRecord(decoded.parsed) ? decoded.parsed : {};
    const policy = canonicalizePolicyFromRawConfig(cfg);
    if (!policy) {
      return { policy: null, policyHash: null };
    }
    return { policy, policyHash: hashRoutingPolicy(policy) };
  } catch {
    return { policy: null, policyHash: null };
  }
}

export async function writePolicyToConfigPath(options: {
  configPath: string;
  policy: unknown;
}): Promise<{ policy: RoutingPolicySnapshotV1; policyHash: string; wroteAtMs: number }> {
  const policyVr = coercePolicyVirtualRouterNode(options.policy);
  if (!policyVr) {
    throw new Error('policy must be an object');
  }
  const routing = policyVr.routing;
  if (!isRecord(routing)) {
    throw new Error('policy.virtualrouter.routing must be an object');
  }

  const loadBalancing = policyVr.loadBalancing;
  const classifier = policyVr.classifier;
  const health = policyVr.health;
  const contextRouting = policyVr.contextRouting;
  const webSearch = policyVr.webSearch;
  const execCommandGuard = policyVr.execCommandGuard;
  const session = policyVr.session;

  const canonical: RoutingPolicySnapshotV1 = {
    schemaVersion: 1,
    virtualrouter: {
      routing,
      ...(loadBalancing !== undefined ? { loadBalancing } : {}),
      ...(classifier !== undefined ? { classifier } : {}),
      ...(health !== undefined ? { health } : {}),
      ...(contextRouting !== undefined ? { contextRouting } : {}),
      ...(webSearch !== undefined ? { webSearch } : {}),
      ...(execCommandGuard !== undefined ? { execCommandGuard } : {}),
      ...(session !== undefined ? { session } : {})
    }
  };
  const decoded = await decodeUserConfigFile(options.configPath);
  const cfg: UnknownRecord = isRecord(decoded.parsed) ? decoded.parsed : {};
  const location = isRecord(cfg.virtualrouter) ? 'virtualrouter.routing' : 'routing';
  const nextConfig = applyRoutingPolicyAtLocation(cfg, canonical.virtualrouter, location);

  const wroteAtMs = Date.now();
  await writeUserConfigFile(options.configPath, nextConfig);

  const persistedPolicy = canonicalizePolicyFromRawConfig(nextConfig) ?? canonical;
  const policyHash = hashRoutingPolicy(persistedPolicy);
  return { policy: persistedPolicy, policyHash, wroteAtMs };
}

export function buildPolicyPathForLog(configPath: string): string {
  try {
    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    return path.join(dir, base);
  } catch {
    return configPath;
  }
}

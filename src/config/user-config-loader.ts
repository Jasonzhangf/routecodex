// feature_id: config.user_config_materialization
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { isRecord } from '../utils/common-utils.js';
import { buildVirtualRouterInputV2 } from './virtual-router-types.js';

export type UnknownRecord = Record<string, unknown>;

const ROUTING_POLICY_OPTIONAL_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'servertool',
  'session'
] as const;

function routeEntryHasTarget(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (typeof entry.target === 'string' && entry.target.trim()) return true;
  if (typeof entry.provider === 'string' && entry.provider.trim()) return true;
  return Array.isArray(entry.targets) && entry.targets.some(
    (target) => typeof target === 'string' && target.trim().length > 0
  );
}

function routingDefaultHasExplicitTarget(routing: UnknownRecord): boolean {
  const defaultRoute = routing.default;
  const entries = Array.isArray(defaultRoute) ? defaultRoute : [defaultRoute];
  return entries.some((entry) => routeEntryHasTarget(entry));
}

export interface MaterializedRouteCodexConfig {
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function materializeRouteCodexConfig(
  userConfigInput: UnknownRecord,
  providerRootDir?: string
): Promise<MaterializedRouteCodexConfig> {
  const userConfig: UnknownRecord = structuredClone(userConfigInput);
  normalizeV2RuntimeSource(userConfig);
  validateV2ConfigSources(userConfig);
  materializeActiveRoutingPolicyGroup(userConfig);
  const vrBase = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const routingPolicyGroup = resolvePrimaryRouterRoutingPolicyGroup(userConfig);
  const v2Input = await buildVirtualRouterInputV2(userConfig, providerRootDir, {
    ...(routingPolicyGroup ? { routingPolicyGroup } : {})
  });
  userConfig.virtualrouter = {
    ...vrBase,
    providers: v2Input.providers,
    routing: v2Input.routing,
    ...(v2Input.forwarders ? { forwarders: v2Input.forwarders } : {}),
    ...(v2Input.applyPatch ? { applyPatch: v2Input.applyPatch } : {})
  };
  const providerProfiles = buildProviderProfiles(userConfig);
  return { userConfig, providerProfiles };
}

export function collectV2ConfigSourceErrors(userConfig: UnknownRecord): string[] {
  const errors: string[] = [];
  const modeRaw = userConfig.virtualrouterMode;
  const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
  if (mode !== 'v2' && !isImplicitV2Config(userConfig)) {
    errors.push('RouteCodex only supports virtualrouterMode="v2"');
  }
  const allowedTopLevel = new Set(['version', 'httpserver', 'virtualrouter', 'virtualrouterMode', 'servertool']);
  for (const key of Object.keys(userConfig)) {
    if (!allowedTopLevel.has(key)) errors.push(`v2 config disallows top-level field "${key}"`);
  }
  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  if (httpserver) {
    const allowedHttp = new Set(['host', 'port', 'apikey', 'ports', 'sameProtocolBehavior']);
    for (const key of Object.keys(httpserver)) {
      if (!allowedHttp.has(key)) errors.push(`v2 config disallows httpserver field "${key}"`);
    }
    if (!Array.isArray(httpserver.ports) || httpserver.ports.length === 0) {
      errors.push('v2 config requires non-empty httpserver.ports[]');
    }
  } else {
    errors.push('v2 config requires httpserver.ports[]');
  }
  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  if (!vr) errors.push('v2 config requires virtualrouter.routingPolicyGroups');
  else {
    const allowedVr = new Set(['routingPolicyGroups', 'forwarders', 'activeRoutingPolicyGroup', 'routing']);
    for (const key of Object.keys(vr)) {
      if (!allowedVr.has(key)) errors.push(`v2 config disallows virtualrouter field "${key}"`);
    }
    const groupsNode = isRecord(vr.routingPolicyGroups) ? (vr.routingPolicyGroups as UnknownRecord) : undefined;
    if (!groupsNode || !Object.keys(groupsNode).length) {
      errors.push('v2 config requires non-empty virtualrouter.routingPolicyGroups');
    } else {
      const allowedGroupKeys = new Set(['routing', ...ROUTING_POLICY_OPTIONAL_KEYS]);
      for (const [groupId, groupNode] of Object.entries(groupsNode)) {
        if (!groupId.trim()) { errors.push('v2 routingPolicyGroups contains empty group id'); continue; }
        if (!isRecord(groupNode)) { errors.push(`v2 routingPolicyGroups["${groupId}"] must be an object`); continue; }
        for (const key of Object.keys(groupNode as UnknownRecord)) {
          if (!allowedGroupKeys.has(key)) errors.push(`v2 routingPolicyGroups["${groupId}"] disallows field "${key}"`);
        }
        const routing = isRecord((groupNode as UnknownRecord).routing)
          ? ((groupNode as UnknownRecord).routing as UnknownRecord) : undefined;
        if (!routing) errors.push(`v2 routingPolicyGroups["${groupId}"] must define routing`);
        else if (!routingDefaultHasExplicitTarget(routing))
          errors.push(`v2 routingPolicyGroups["${groupId}"].routing.default must define an explicit non-empty default provider tier`);
      }
    }
  }
  return errors;
}

export function validateV2ConfigSources(userConfig: UnknownRecord): void {
  const errors = collectV2ConfigSourceErrors(userConfig);
  if (errors.length) {
    const message = ['[config] v2 config must use single-source layout:', ...errors].join('\n- ');
    throw new Error(message);
  }
}

export function materializeActiveRoutingPolicyGroup(_userConfig: UnknownRecord): void {
  // No-op: per-port routingPolicyGroup in httpserver.ports[] replaces global active.
}

function resolvePrimaryRouterRoutingPolicyGroup(userConfig: UnknownRecord): string | undefined {
  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  const ports = Array.isArray(httpserver?.ports) ? (httpserver.ports as unknown[]) : [];
  for (const port of ports) {
    if (!isRecord(port)) continue;
    const mode = typeof port.mode === 'string' ? port.mode.trim().toLowerCase() : '';
    if (mode && mode !== 'router') continue;
    const group = typeof port.routingPolicyGroup === 'string' ? port.routingPolicyGroup.trim() : '';
    if (group) return group;
  }
  const virtualrouter = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  const groups = isRecord(virtualrouter?.routingPolicyGroups)
    ? (virtualrouter!.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groups) return undefined;
  const activeGroup = typeof virtualrouter?.activeRoutingPolicyGroup === 'string'
    ? virtualrouter.activeRoutingPolicyGroup.trim() : '';
  if (activeGroup && isRecord(groups[activeGroup])) return activeGroup;
  const groupIds = Object.keys(groups).filter((groupId) => groupId.trim());
  return groupIds.length === 1 ? groupIds[0] : undefined;
}

function isImplicitV2Config(userConfig: UnknownRecord): boolean {
  if (userConfig.version !== '2.0.0') return false;
  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  return Boolean(vr && isRecord(vr.routingPolicyGroups));
}

function normalizeV2RuntimeSource(userConfig: UnknownRecord): void {
  if (!userConfig.virtualrouterMode && isImplicitV2Config(userConfig)) {
    userConfig.virtualrouterMode = 'v2';
  }
}

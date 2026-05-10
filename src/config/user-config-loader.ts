import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { isRecord } from '../utils/common-utils.js';
import { buildVirtualRouterInputV2 } from './virtual-router-builder.js';

export type UnknownRecord = Record<string, unknown>;

const ROUTING_POLICY_OPTIONAL_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'session'
] as const;

const REASONING_STOP_MODE_ENV_KEYS = [
  'ROUTECODEX_REASONING_STOP_MODE',
  'RCC_REASONING_STOP_MODE'
] as const;

type ReasoningStopMode = 'on' | 'off' | 'endless';

export interface MaterializedRouteCodexConfig {
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function materializeRouteCodexConfig(
  userConfigInput: UnknownRecord,
  providerRootDir?: string
): Promise<MaterializedRouteCodexConfig> {
  const userConfig: UnknownRecord = structuredClone(userConfigInput);
  validateV2ConfigSources(userConfig);
  materializeActiveRoutingPolicyGroup(userConfig);
  projectReasoningStopModeFromConfig(userConfig);
  const vrBase = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const v2Input = await buildVirtualRouterInputV2(userConfig, providerRootDir);
  userConfig.virtualrouter = {
    ...vrBase,
    providers: v2Input.providers,
    routing: v2Input.routing
  };
  const providerProfiles = buildProviderProfiles(userConfig);
  return {
    userConfig,
    providerProfiles
  };
}

export function collectV2ConfigSourceErrors(userConfig: UnknownRecord): string[] {
  const errors: string[] = [];
  const modeRaw = userConfig.virtualrouterMode;
  const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
  if (mode !== 'v2') {
    errors.push('RouteCodex only supports virtualrouterMode="v2"');
  }
  const allowedTopLevel = new Set(['version', 'httpserver', 'virtualrouter', 'virtualrouterMode']);
  for (const key of Object.keys(userConfig)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`v2 config disallows top-level field "${key}"`);
    }
  }

  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  if (httpserver) {
    const allowedHttp = new Set(['host', 'port', 'apikey']);
    for (const key of Object.keys(httpserver)) {
      if (!allowedHttp.has(key)) {
        errors.push(`v2 config disallows httpserver field "${key}" (only host/port/apikey allowed)`);
      }
    }
  }

  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  if (!vr) {
    errors.push('v2 config requires virtualrouter.routingPolicyGroups');
  } else {
    const allowedVr = new Set(['routingPolicyGroups', 'activeRoutingPolicyGroup']);
    for (const key of Object.keys(vr)) {
      if (!allowedVr.has(key)) {
        errors.push(`v2 config disallows virtualrouter field "${key}" (routingPolicyGroups only)`);
      }
    }

    const groupsNode = isRecord(vr.routingPolicyGroups) ? (vr.routingPolicyGroups as UnknownRecord) : undefined;
    if (!groupsNode || !Object.keys(groupsNode).length) {
      errors.push('v2 config requires non-empty virtualrouter.routingPolicyGroups');
    } else {
      const allowedGroupKeys = new Set(['routing', ...ROUTING_POLICY_OPTIONAL_KEYS]);
      for (const [groupId, groupNode] of Object.entries(groupsNode)) {
        if (!groupId.trim()) {
          errors.push('v2 routingPolicyGroups contains empty group id');
          continue;
        }
        if (!isRecord(groupNode)) {
          errors.push(`v2 routingPolicyGroups["${groupId}"] must be an object`);
          continue;
        }
        for (const key of Object.keys(groupNode as UnknownRecord)) {
          if (!allowedGroupKeys.has(key)) {
            errors.push(
              `v2 routingPolicyGroups["${groupId}"] disallows field "${key}" (routing/optional policy fields only)`
            );
          }
        }
        if (!isRecord((groupNode as UnknownRecord).routing)) {
          errors.push(`v2 routingPolicyGroups["${groupId}"] must define routing`);
        }
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

export function materializeActiveRoutingPolicyGroup(userConfig: UnknownRecord): void {
  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : null;
  if (!vr) {
    return;
  }

  const groupsNode = vr.routingPolicyGroups;
  if (!isRecord(groupsNode)) {
    return;
  }

  const groups: Record<string, UnknownRecord> = {};
  for (const [groupId, groupNode] of Object.entries(groupsNode)) {
    if (!groupId.trim() || !isRecord(groupNode)) {
      continue;
    }
    groups[groupId] = groupNode as UnknownRecord;
  }
  const groupIds = Object.keys(groups);
  if (!groupIds.length) {
    return;
  }

  const activeCandidate = typeof vr.activeRoutingPolicyGroup === 'string' ? vr.activeRoutingPolicyGroup.trim() : '';
  const activeGroupId =
    activeCandidate && groups[activeCandidate]
      ? activeCandidate
      : groups.default
        ? 'default'
        : groupIds.sort((a, b) => a.localeCompare(b))[0];

  const activePolicy = groups[activeGroupId];
  if (!isRecord(activePolicy.routing)) {
    return;
  }

  vr.activeRoutingPolicyGroup = activeGroupId;
  vr.routing = activePolicy.routing;

  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = activePolicy[key];
    if (isRecord(value)) {
      vr[key] = value;
      continue;
    }
    delete vr[key];
  }
}

function normalizeReasoningStopMode(value: unknown): ReasoningStopMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'endless') {
    return normalized;
  }
  return undefined;
}

function resolveReasoningStopModeFromConfig(userConfig: UnknownRecord): ReasoningStopMode {
  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : null;
  const session = vr && isRecord(vr.session) ? (vr.session as UnknownRecord) : null;
  return normalizeReasoningStopMode(session?.reasoningStopMode) ?? 'off';
}

export function projectReasoningStopModeFromConfig(userConfig: UnknownRecord): void {
  const mode = resolveReasoningStopModeFromConfig(userConfig);
  for (const key of REASONING_STOP_MODE_ENV_KEYS) {
    process.env[key] = mode;
  }
}

// feature_id: config.user_config_materialization
import { loadProviderConfigsV2, type ProviderConfigV2 } from './provider-v2-loader.js';
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { isRecord } from '../utils/common-utils.js';

export type UnknownRecord = Record<string, unknown>;
export type VirtualRouterInput = UnknownRecord;

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

export type BuildVirtualRouterInputV2Options = {
  routingPolicyGroup?: string;
  includeAllRoutingPolicyGroups?: boolean;
};

type ProviderConfigMap = Record<string, ProviderConfigV2>;

function withRoutePolicyGroupTag(routeEntry: unknown, groupId: string): unknown {
  if (!routeEntry || typeof routeEntry !== 'object') return routeEntry;
  if (Array.isArray(routeEntry)) return routeEntry.map((item) => withRoutePolicyGroupTag(item, groupId));
  const record = routeEntry as UnknownRecord;
  const routeParams = isRecord(record.routeParams) ? { ...(record.routeParams as UnknownRecord) } : {};
  if (typeof routeParams.routePolicyGroup !== 'string' || !routeParams.routePolicyGroup.trim()) {
    routeParams.routePolicyGroup = groupId;
  }
  return { ...record, routeParams };
}

function extractRoutingFromUserConfig(
  userConfig: UnknownRecord,
  options?: BuildVirtualRouterInputV2Options
): UnknownRecord {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groupsNode) throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups');

  let groupEntries = Object.entries(groupsNode)
    .filter(([groupId, groupNode]) => Boolean(groupId.trim()) && isRecord(groupNode))
    .map(([groupId, groupNode]) => [groupId.trim(), groupNode as UnknownRecord] as const);
  const requestedGroup = typeof options?.routingPolicyGroup === 'string' ? options.routingPolicyGroup.trim() : '';
  if (requestedGroup) {
    groupEntries = groupEntries.filter(([groupId]) => groupId === requestedGroup);
    if (groupEntries.length === 0) {
      throw new Error(`[config] v2 config missing virtualrouter.routingPolicyGroups["${requestedGroup}"]`);
    }
  } else if (options?.includeAllRoutingPolicyGroups !== true && groupEntries.length > 1) {
    throw new Error('[config] v2 config with multiple routingPolicyGroups requires an explicit routingPolicyGroup');
  }
  if (groupEntries.length === 0) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups with at least one group');
  }

  const routing: UnknownRecord = {};
  for (const [groupId, groupNode] of groupEntries) {
    const groupRouting = isRecord(groupNode.routing) ? (groupNode.routing as UnknownRecord) : undefined;
    if (!groupRouting) continue;
    for (const [routeType, routeEntry] of Object.entries(groupRouting)) {
      if (!routeEntry || typeof routeEntry !== 'object') continue;
      const taggedRouteEntry = withRoutePolicyGroupTag(routeEntry, groupId);
      const taggedRouteArray = Array.isArray(taggedRouteEntry) ? taggedRouteEntry : [taggedRouteEntry];
      const existing = Array.isArray(routing[routeType]) ? (routing[routeType] as unknown[]) : [];
      routing[routeType] = [...existing, ...taggedRouteArray];
    }
  }
  if (!Object.keys(routing).length) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups group with routing field');
  }
  return routing;
}

function extractPolicyGroupOptionFromUserConfig(
  userConfig: UnknownRecord,
  key: string,
  options?: BuildVirtualRouterInputV2Options
): UnknownRecord | undefined {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groupsNode) return undefined;
  const requestedGroup = typeof options?.routingPolicyGroup === 'string' ? options.routingPolicyGroup.trim() : '';
  if (!requestedGroup) return isRecord(vrNode[key]) ? (vrNode[key] as UnknownRecord) : undefined;
  const group = isRecord(groupsNode[requestedGroup]) ? (groupsNode[requestedGroup] as UnknownRecord) : undefined;
  if (isRecord(group?.[key])) return group![key] as UnknownRecord;
  return isRecord(vrNode[key]) ? (vrNode[key] as UnknownRecord) : undefined;
}

function parseProviderIdFromProviderKeyForConfig(providerKey?: string): string | undefined {
  return providerKey?.split('.', 1)[0]?.trim() || undefined;
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractMaterializedProviderConfigsFromUserConfig(
  userConfig: UnknownRecord
): ProviderConfigMap | undefined {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  const providersNode = isRecord(vrNode?.providers) ? (vrNode!.providers as UnknownRecord) : undefined;
  if (!providersNode || Object.keys(providersNode).length === 0) return undefined;

  const providerConfigs: ProviderConfigMap = {};
  for (const [providerIdRaw, providerValue] of Object.entries(providersNode)) {
    const providerId = providerIdRaw.trim();
    if (!providerId) {
      throw new Error('[config] materialized virtualrouter.providers contains empty provider id');
    }
    if (!isRecord(providerValue)) {
      throw new Error(`[config] materialized virtualrouter.providers["${providerId}"] must be an object`);
    }
    const provider = structuredClone(providerValue) as UnknownRecord;
    const providerNodeId = pickString(provider.id);
    if (providerNodeId && providerNodeId !== providerId) {
      throw new Error(
        `[config] materialized virtualrouter.providers["${providerId}"].id="${providerNodeId}" does not match provider id`
      );
    }
    if (!providerNodeId) provider.id = providerId;
    providerConfigs[providerId] = {
      version: '2.0.0',
      providerId,
      provider
    };
  }
  return providerConfigs;
}

function resolveReferencedProviderIdsFromRouting(routing: UnknownRecord): Set<string> {
  const providerIds = new Set<string>();
  for (const entries of Object.values(routing)) {
    const routeEntries = Array.isArray(entries) ? entries : entries ? [entries] : [];
    for (const entry of routeEntries) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.targets)) {
        for (const target of entry.targets) {
          const providerId = parseProviderIdFromProviderKeyForConfig(pickString(target));
          if (providerId) providerIds.add(providerId);
        }
      }
      const targetProviderId = parseProviderIdFromProviderKeyForConfig(pickString(entry.target));
      if (targetProviderId) providerIds.add(targetProviderId);
      const loadBalancing = isRecord(entry.loadBalancing) ? (entry.loadBalancing as UnknownRecord) : undefined;
      const weights = isRecord(loadBalancing?.weights) ? (loadBalancing.weights as UnknownRecord) : undefined;
      if (!weights) continue;
      for (const target of Object.keys(weights)) {
        const providerId = parseProviderIdFromProviderKeyForConfig(target);
        if (providerId) providerIds.add(providerId);
      }
    }
  }
  return providerIds;
}

function resolveReferencedForwarderIdsFromRouting(routing: UnknownRecord): Set<string> {
  const ids = new Set<string>();
  for (const entries of Object.values(routing)) {
    const routeEntries = Array.isArray(entries) ? entries : entries ? [entries] : [];
    for (const entry of routeEntries) {
      if (!isRecord(entry)) continue;
      const collect = (target: unknown) => {
        const trimmed = pickString(target);
        if (trimmed?.startsWith('fwd.') && trimmed.length > 4) ids.add(trimmed);
      };
      if (Array.isArray(entry.targets)) {
        for (const target of entry.targets) collect(target);
      }
      collect(entry.target);
    }
  }
  return ids;
}

function resolveProviderIdsFromProviderPorts(userConfig: UnknownRecord): Set<string> {
  const ids = new Set<string>();
  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  const ports = Array.isArray(httpserver?.ports) ? (httpserver.ports as unknown[]) : [];
  for (const portRaw of ports) {
    if (!isRecord(portRaw)) continue;
    const mode = typeof portRaw.mode === 'string' ? portRaw.mode.trim().toLowerCase() : '';
    if (mode !== 'provider') continue;
    const providerId = parseProviderIdFromProviderKeyForConfig(pickString(portRaw.providerBinding));
    if (providerId) ids.add(providerId);
  }
  return ids;
}

function extractApplyPatchConfigFromUserConfig(userConfig: UnknownRecord): UnknownRecord | undefined {
  const candidates: unknown[] = [];
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  const topServertool = isRecord(userConfig.servertool) ? (userConfig.servertool as UnknownRecord) : undefined;
  const vrServertool = vrNode && isRecord(vrNode.servertool) ? (vrNode.servertool as UnknownRecord) : undefined;
  if (topServertool && isRecord(topServertool.applyPatch)) candidates.push(topServertool.applyPatch);
  if (topServertool && isRecord(topServertool.apply_patch)) candidates.push(topServertool.apply_patch);
  if (vrServertool && isRecord(vrServertool.applyPatch)) candidates.push(vrServertool.applyPatch);
  if (vrServertool && isRecord(vrServertool.apply_patch)) candidates.push(vrServertool.apply_patch);
  const first = candidates[0];
  if (!isRecord(first)) return undefined;
  const mode = typeof first.mode === 'string' ? first.mode.trim().toLowerCase() : '';
  return mode === 'freeform' ? { ...(first as UnknownRecord), mode: 'client' } : { ...(first as UnknownRecord) };
}

function extractForwardersFromUserConfig(userConfig: UnknownRecord): Record<string, UnknownRecord> | undefined {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  const candidates: unknown[] = [vrNode?.forwarders, userConfig.forwarders];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const filtered: Record<string, UnknownRecord> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (key.startsWith('fwd.') && isRecord(value)) filtered[key] = value as UnknownRecord;
    }
    if (Object.keys(filtered).length) return filtered;
  }
  return undefined;
}

function normalizeForwardersForNative(
  source: Record<string, UnknownRecord>,
  providerConfigs: ProviderConfigMap
): Record<string, UnknownRecord> {
  const out: Record<string, UnknownRecord> = {};
  for (const [id, raw] of Object.entries(source)) {
    const entry: UnknownRecord = { ...raw };
    entry.forwarderId = pickString(entry.forwarderId) ?? id;
    const protocol = pickString(entry.protocol);
    if (!protocol) throw new Error(`[forwarder-config] ${id} missing protocol`);
    const normalizedModelId = pickString(entry.modelId);
    const authoringModel = pickString(entry.model);
    if (normalizedModelId && authoringModel && normalizedModelId !== authoringModel) {
      throw new Error(`[forwarder-config] ${id} has conflicting model/modelId`);
    }
    const modelId = authoringModel ?? normalizedModelId;
    if (!modelId) throw new Error(`[forwarder-config] ${id} missing top-level model`);
    entry.modelId = modelId;
    delete entry.model;
    if (!pickString(entry.resolutionMode)) entry.resolutionMode = 'model-first';
    if (!pickString(entry.strategy)) entry.strategy = 'round-robin';
    if (!pickString(entry.stickyKey)) entry.stickyKey = 'none';
    if (Array.isArray(entry.targets)) {
      entry.targets = entry.targets
        .filter((target): target is UnknownRecord => isRecord(target))
        .flatMap((target) => resolveForwarderTargetProviderKeys({
          forwarderId: id,
          forwarderModelId: modelId,
          target,
          providerConfigs
        }).map((providerKey) => ({
          providerKey,
          providerId: pickString(target.providerId),
          weight: pickNumber(target.weight),
          priority: pickNumber(target.priority),
          disabled: target.disabled === true
        })));
    }
    out[id] = entry;
  }
  return out;
}

function resolveForwarderTargetProviderKeys(options: {
  forwarderId: string;
  forwarderModelId?: string;
  target: UnknownRecord;
  providerConfigs: ProviderConfigMap;
}): string[] {
  const providerKey = pickString(options.target.providerKey);
  if (providerKey) return [providerKey];
  if (pickString(options.target.provider)) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target must declare providerId`);
  }
  const providerId = pickString(options.target.providerId);
  if (!providerId) throw new Error(`[forwarder-config] ${options.forwarderId} target requires providerId`);
  const providerConfig = options.providerConfigs[providerId];
  if (!providerConfig) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target providerId '${providerId}' is not configured`);
  }
  const targetModelId = pickString(options.target.modelId) ?? pickString(options.target.model);
  const modelId = options.forwarderModelId;
  if (!modelId) throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' requires forwarder.model`);
  if (targetModelId && targetModelId !== modelId) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' model '${targetModelId}' must match forwarder.model '${modelId}'`);
  }
  if (!providerDeclaresModel(providerConfig.provider, modelId)) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' does not declare model '${modelId}'`);
  }
  const aliases = providerAuthAliases(providerConfig.provider);
  if (aliases.length === 0) throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' has no auth aliases`);
  return aliases.map((alias) => `${providerId}.${alias}.${modelId}`);
}

function providerAuthAliases(provider: UnknownRecord): string[] {
  const auth = isRecord(provider.auth) ? (provider.auth as UnknownRecord) : {};
  const aliases: string[] = [];
  const seen = new Set<string>();
  const add = (alias?: string) => {
    const base = alias?.trim() || `key${seen.size + 1}`;
    let normalized = base;
    let index = 1;
    while (seen.has(normalized)) {
      normalized = `${base}_${index}`;
      index += 1;
    }
    seen.add(normalized);
    aliases.push(normalized);
  };
  if (Array.isArray(auth.entries)) {
    for (const entry of auth.entries) if (isRecord(entry)) add(pickString(entry.alias));
  }
  if (Array.isArray(auth.keys)) {
    for (const entry of auth.keys) {
      if (isRecord(entry)) add(pickString(entry.alias));
      else if (typeof entry === 'string' && entry.trim()) add(undefined);
    }
  } else if (isRecord(auth.keys)) {
    for (const alias of Object.keys(auth.keys)) add(alias);
  }
  if (aliases.length === 0 && (pickString(provider.apiKey) || pickString(auth.apiKey) || pickString(auth.value))) {
    add(undefined);
  }
  return aliases;
}

function providerDeclaresModel(provider: UnknownRecord, modelId: string): boolean {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return false;
  const models = provider.models;
  if (Array.isArray(models)) {
    return models.some((model) => isRecord(model) && pickString(model.id)?.trim() === normalizedModelId);
  }
  if (isRecord(models)) return Object.prototype.hasOwnProperty.call(models, normalizedModelId);
  const defaultModel = pickString(provider.defaultModel) ?? pickString(provider.modelId) ?? pickString(provider.model);
  return defaultModel?.trim() === normalizedModelId;
}

export async function buildVirtualRouterInputV2(
  userConfig: UnknownRecord,
  providerRootDir?: string,
  options?: BuildVirtualRouterInputV2Options
): Promise<VirtualRouterInput> {
  const routing = extractRoutingFromUserConfig(userConfig, options);
  const hitLog = extractPolicyGroupOptionFromUserConfig(userConfig, 'hitLog', options);
  const referencedProviderIds = resolveReferencedProviderIdsFromRouting(routing);
  for (const providerId of resolveProviderIdsFromProviderPorts(userConfig)) referencedProviderIds.add(providerId);

  const referencedForwarderIds = resolveReferencedForwarderIdsFromRouting(routing);
  const forwardersSource = extractForwardersFromUserConfig(userConfig);
  if (forwardersSource) {
    for (const fwdId of Object.keys(forwardersSource)) {
      if (!fwdId.startsWith('fwd.')) throw new Error(`[forwarder-config] forwarder id '${fwdId}' must start with 'fwd.'`);
    }
    for (const refId of referencedForwarderIds) {
      if (!forwardersSource[refId]) throw new Error(`[forwarder-config] routing references unknown forwarder '${refId}'`);
    }
  }
  const providerConfigs = extractMaterializedProviderConfigsFromUserConfig(userConfig)
    ?? (await loadProviderConfigsV2(providerRootDir));
  const forwarders = forwardersSource && Object.keys(forwardersSource).length
    ? normalizeForwardersForNative(forwardersSource, providerConfigs)
    : undefined;
  if (forwarders) {
    for (const fwdNode of Object.values(forwarders)) {
      const targets = Array.isArray((fwdNode as UnknownRecord).targets)
        ? ((fwdNode as UnknownRecord).targets as Array<UnknownRecord>)
        : [];
      for (const target of targets) {
        const providerId = pickString(target.providerId) ?? parseProviderIdFromProviderKeyForConfig(pickString(target.providerKey));
        if (providerId) referencedProviderIds.add(providerId);
      }
    }
  }
  const providers: Record<string, UnknownRecord> = {};
  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    if (referencedProviderIds.size > 0 && !referencedProviderIds.has(providerId)) continue;
    providers[providerId] = cfg.provider;
  }
  const applyPatch = extractApplyPatchConfigFromUserConfig(userConfig);
  const requestedRoutingPolicyGroup = typeof options?.routingPolicyGroup === 'string' && options.routingPolicyGroup.trim()
    ? options.routingPolicyGroup.trim()
    : undefined;
  const nativeInput: VirtualRouterInput = {
    providers,
    routing,
    ...(requestedRoutingPolicyGroup ? { routingPolicyGroup: requestedRoutingPolicyGroup } : {}),
    ...(forwarders ? { forwarders } : {}),
    ...(applyPatch ? { applyPatch } : {}),
    ...(hitLog ? { hitLog } : {})
  };
  return nativeInput;
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

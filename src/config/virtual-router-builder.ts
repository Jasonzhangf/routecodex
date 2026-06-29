import type {
  UnknownRecord,
  VirtualRouterInput,
  VirtualRouterProvidersConfig,
  VirtualRouterRoutingConfig
} from './virtual-router-types.js';
import { loadProviderConfigsV2, type ProviderConfigV2 } from './provider-v2-loader.js';
import { isRecord } from '../utils/common-utils.js';


function resolveReferencedProviderIdsFromRouting(routing: VirtualRouterRoutingConfig): Set<string> {
  const providerIds = new Set<string>();
  for (const entries of Object.values(routing)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }

      if (Array.isArray(entry.targets)) {
        for (const target of entry.targets) {
          if (typeof target !== 'string' || !target.trim()) {
            continue;
          }
          const providerId = target.trim().split('.', 1)[0];
          if (providerId) {
            providerIds.add(providerId);
          }
        }
      }

      if (typeof entry.target === 'string' && entry.target.trim()) {
        const providerId = entry.target.trim().split('.', 1)[0];
        if (providerId) {
          providerIds.add(providerId);
        }
      }

      const loadBalancing = isRecord(entry.loadBalancing) ? (entry.loadBalancing as UnknownRecord) : undefined;
      const weights = isRecord(loadBalancing?.weights) ? (loadBalancing.weights as UnknownRecord) : undefined;
      if (!weights) {
        continue;
      }
      for (const target of Object.keys(weights)) {
        if (typeof target !== 'string' || !target.trim()) {
          continue;
        }
        const providerId = target.trim().split('.', 1)[0];
        if (providerId) {
          providerIds.add(providerId);
        }
      }
    }
  }
  return providerIds;
}

/**
 * 收集 routing target 中引用的 forwarder id（`fwd.*`）。
 * 这些 id 必须在 `virtualrouter.forwarders` 中存在，否则 bootstrap 失败。
 */
function resolveReferencedForwarderIdsFromRouting(routing: VirtualRouterRoutingConfig): Set<string> {
  const ids = new Set<string>();
  for (const entries of Object.values(routing)) {
    for (const entry of entries) {
      const collect = (target: unknown) => {
        if (typeof target !== 'string') return;
        const trimmed = target.trim();
        if (trimmed.startsWith('fwd.') && trimmed.length > 4) {
          ids.add(trimmed);
        }
      };
      if (Array.isArray(entry.targets)) {
        for (const t of entry.targets) collect(t);
      }
      if (typeof entry.target === 'string') {
        collect(entry.target);
      }
    }
  }
  return ids;
}

function resolveProviderIdsFromProviderPorts(userConfig: UnknownRecord): Set<string> {
  const ids = new Set<string>();
  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  const ports = Array.isArray(httpserver?.ports) ? (httpserver!.ports as unknown[]) : [];
  for (const portRaw of ports) {
    if (!isRecord(portRaw)) {
      continue;
    }
    const mode = typeof portRaw.mode === 'string' ? portRaw.mode.trim().toLowerCase() : '';
    if (mode !== 'provider') {
      continue;
    }
    const binding = typeof portRaw.providerBinding === 'string' ? portRaw.providerBinding.trim() : '';
    if (!binding) {
      continue;
    }
    const providerId = binding.split('.', 1)[0]?.trim();
    if (providerId) {
      ids.add(providerId);
    }
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
  if (!isRecord(first)) {
    return undefined;
  }
  const mode = typeof first.mode === 'string' ? first.mode.trim().toLowerCase() : '';
  if (mode === 'freeform') {
    return { ...(first as UnknownRecord), mode: 'client' };
  }
  return { ...(first as UnknownRecord) };
}

function withRoutePolicyGroupTag(routeEntry: unknown, groupId: string): unknown {
  if (!routeEntry || typeof routeEntry !== 'object') {
    return routeEntry;
  }
  if (Array.isArray(routeEntry)) {
    return routeEntry.map((item) => withRoutePolicyGroupTag(item, groupId));
  }
  const record = routeEntry as UnknownRecord;
  const routeParams = isRecord(record.routeParams) ? { ...(record.routeParams as UnknownRecord) } : {};
  if (typeof routeParams.routePolicyGroup !== 'string' || !routeParams.routePolicyGroup.trim()) {
    routeParams.routePolicyGroup = groupId;
  }
  return {
    ...record,
    routeParams,
  };
}

/**
 * Per-port routing: build one VirtualRouterInput for one routingPolicyGroup.
 */
export type BuildVirtualRouterInputV2Options = {
  routingPolicyGroup?: string;
  includeAllRoutingPolicyGroups?: boolean;
};

type ProviderConfigMap = Record<string, ProviderConfigV2>;

function extractRoutingFromUserConfig(
  userConfig: UnknownRecord,
  options?: BuildVirtualRouterInputV2Options,
): VirtualRouterRoutingConfig {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groupsNode) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups');
  }
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
  // Collect routing into a flat RoutingPools config for exactly one selected group.
  // Multi-port servers build one isolated VirtualRouterInput per port/group.
  const routing: VirtualRouterRoutingConfig = {};
  for (const [groupId, groupNode] of groupEntries) {
    const groupRouting = isRecord(groupNode.routing) ? (groupNode.routing as VirtualRouterRoutingConfig) : undefined;
    if (!groupRouting) continue;
    for (const [routeType, routeEntry] of Object.entries(groupRouting)) {
      if (!routeEntry || typeof routeEntry !== 'object') continue;
            const taggedRouteEntry = withRoutePolicyGroupTag(routeEntry, groupId) as any;
      const taggedRouteArray = Array.isArray(taggedRouteEntry) ? taggedRouteEntry : [taggedRouteEntry];
      const existing = Array.isArray(routing[routeType]) ? routing[routeType] as any[] : [];
      routing[routeType] = [...existing, ...taggedRouteArray] as any;
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
  options?: BuildVirtualRouterInputV2Options,
): UnknownRecord | undefined {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groupsNode) {
    return undefined;
  }
  const requestedGroup = typeof options?.routingPolicyGroup === 'string' ? options.routingPolicyGroup.trim() : '';
  if (!requestedGroup) {
    return isRecord(vrNode[key]) ? (vrNode[key] as UnknownRecord) : undefined;
  }
  const group = isRecord(groupsNode[requestedGroup]) ? (groupsNode[requestedGroup] as UnknownRecord) : undefined;
  if (isRecord(group?.[key])) {
    return group![key] as UnknownRecord;
  }
  return isRecord(vrNode[key]) ? (vrNode[key] as UnknownRecord) : undefined;
}

/**
 * Build a VirtualRouterInput in "v2" mode by combining:
 * - Provider v2 configs loaded from ~/.rcc/provider (or a custom root)
 * - RoutingPools selected from one routingPolicyGroup; multi-port runtime builds one router per group
 *
 * V2 config is the single source of truth: no legacy routing fallback and no
 * auto-synthesized capability routes are injected here.
 */
export async function buildVirtualRouterInputV2(
  userConfig: UnknownRecord,
  providerRootDir?: string,
  options?: BuildVirtualRouterInputV2Options,
): Promise<VirtualRouterInput> {
  const routing = extractRoutingFromUserConfig(userConfig, options);
  const hitLog = extractPolicyGroupOptionFromUserConfig(userConfig, 'hitLog', options);
  const referencedProviderIds = resolveReferencedProviderIdsFromRouting(routing);
  for (const providerId of resolveProviderIdsFromProviderPorts(userConfig)) {
    referencedProviderIds.add(providerId);
  }

  // 收集 forwarder 引用 + forwarder 定义。配置态禁止要求用户写 auth key。
  const referencedForwarderIds = resolveReferencedForwarderIdsFromRouting(routing);
  const forwardersSource = extractForwardersFromUserConfig(userConfig);
  if (forwardersSource) {
    for (const fwdId of Object.keys(forwardersSource)) {
      if (!fwdId.startsWith('fwd.')) {
        throw new Error(`[forwarder-config] forwarder id '${fwdId}' must start with 'fwd.'`);
      }
    }
    for (const refId of referencedForwarderIds) {
      if (!forwardersSource[refId]) {
        throw new Error(`[forwarder-config] routing references unknown forwarder '${refId}'`);
      }
    }
    // 收集 forwarder targets 引用的 provider id。
    for (const fwdNode of Object.values(forwardersSource)) {
      const targets = Array.isArray((fwdNode as UnknownRecord).targets)
        ? ((fwdNode as UnknownRecord).targets as Array<UnknownRecord>)
        : [];
      for (const t of targets) {
        const providerId = pickString(t.providerId) ?? parseProviderIdFromProviderKeyForLegacyConfig(pickString(t.providerKey));
        if (providerId) {
            referencedProviderIds.add(providerId);
        }
      }
    }
  }

  const providerConfigs = await loadProviderConfigsV2(providerRootDir);
  const providers: VirtualRouterProvidersConfig = {};

  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    if (referencedProviderIds.size > 0 && !referencedProviderIds.has(providerId)) {
      continue;
    }
    providers[providerId] = cfg.provider;
  }

  const applyPatch = extractApplyPatchConfigFromUserConfig(userConfig);
  const input: VirtualRouterInput = {
    providers,
    routing,
    ...(forwardersSource && Object.keys(forwardersSource).length
      ? { forwarders: normalizeForwardersForNative(forwardersSource, providerConfigs) }
      : {}),
    ...(applyPatch ? { applyPatch } : {}),
    ...(hitLog ? { hitLog } : {})
  };
  return input;
}

function normalizeForwardersForNative(
  source: Record<string, UnknownRecord>,
  providerConfigs: ProviderConfigMap,
): Record<string, UnknownRecord> {
  const out: Record<string, UnknownRecord> = {};
  for (const [id, raw] of Object.entries(source)) {
    const entry: UnknownRecord = { ...raw };
    entry.forwarderId = pickString(entry.forwarderId) ?? id;
    const protocol = pickString(entry.protocol);
    if (!protocol) {
      throw new Error(`[forwarder-config] ${id} missing protocol`);
    }
    const normalizedModelId = pickString(entry.modelId);
    const authoringModel = pickString(entry.model);
    if (normalizedModelId && authoringModel && normalizedModelId !== authoringModel) {
      throw new Error(`[forwarder-config] ${id} has conflicting model/modelId`);
    }
    const modelId = authoringModel ?? normalizedModelId;
    if (!modelId) {
      throw new Error(`[forwarder-config] ${id} missing top-level model`);
    }
    entry.modelId = modelId;
    delete entry.model;
    const resolutionMode = pickString(entry.resolutionMode);
    if (!resolutionMode) {
      entry.resolutionMode = 'model-first';
    }
    const strategy = pickString(entry.strategy);
    if (!strategy) {
      entry.strategy = 'round-robin';
    }
    const stickyKey = pickString(entry.stickyKey);
    if (!stickyKey) {
      entry.stickyKey = 'none';
    }
    if (Array.isArray(entry.targets)) {
      entry.targets = entry.targets
        .filter((target): target is UnknownRecord => isRecord(target))
        .flatMap((target) => {
          const providerKeys = resolveForwarderTargetProviderKeys({
            forwarderId: id,
            forwarderModelId: modelId,
            target,
            providerConfigs,
          });
          return providerKeys.map((providerKey) => ({
            providerKey,
            providerId: pickString(target.providerId),
            weight: pickNumber(target.weight),
            priority: pickNumber(target.priority),
            disabled: target.disabled === true
          }));
        });
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
  if (providerKey) {
    return [providerKey];
  }

  if (pickString(options.target.provider)) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target must declare providerId`);
  }

  const providerId = pickString(options.target.providerId);
  if (!providerId) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target requires providerId`);
  }
  const providerConfig = options.providerConfigs[providerId];
  if (!providerConfig) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target providerId '${providerId}' is not configured`);
  }
  const targetModelId = pickString(options.target.modelId) ?? pickString(options.target.model);
  const modelId = options.forwarderModelId;
  if (!modelId) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' requires forwarder.model`);
  }
  if (targetModelId && targetModelId !== modelId) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' model '${targetModelId}' must match forwarder.model '${modelId}'`);
  }
  if (!providerDeclaresModel(providerConfig.provider, modelId)) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' does not declare model '${modelId}'`);
  }
  const aliases = providerAuthAliases(providerConfig.provider);
  if (aliases.length === 0) {
    throw new Error(`[forwarder-config] ${options.forwarderId} target '${providerId}' has no auth aliases`);
  }
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
    if (!seen.has(normalized)) {
      seen.add(normalized);
      aliases.push(normalized);
    }
  };

  if (Array.isArray(auth.entries)) {
    for (const entry of auth.entries) {
      if (isRecord(entry)) {
        add(pickString(entry.alias));
      }
    }
  }
  if (Array.isArray(auth.keys)) {
    for (const entry of auth.keys) {
      if (isRecord(entry)) {
        add(pickString(entry.alias));
      } else if (typeof entry === 'string' && entry.trim()) {
        add(undefined);
      }
    }
  } else if (isRecord(auth.keys)) {
    for (const alias of Object.keys(auth.keys)) {
      add(alias);
    }
  }
  if (aliases.length === 0 && (pickString(provider.apiKey) || pickString(auth.apiKey) || pickString(auth.value))) {
    add(undefined);
  }
  return aliases;
}

function providerDeclaresModel(provider: UnknownRecord, modelId: string): boolean {
  // Per Jason 2026-06-20, `provider.models.<id>.aliases` is display-only for
  // `/v1/models`. Forwarder / VR / provider wire must only accept canonical
  // model keys declared under `provider.models` (or, for legacy array form,
  // each entry's `id`). Aliases must never define a routable / wire model.
  const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
  if (!normalizedModelId) {
    return false;
  }
  const models = provider.models;
  if (Array.isArray(models)) {
    return models.some((model) => {
      if (!isRecord(model)) {
        return false;
      }
      return pickString(model.id)?.trim() === normalizedModelId;
    });
  }
  if (isRecord(models)) {
    return Object.prototype.hasOwnProperty.call(models, normalizedModelId);
  }
  const defaultModel = pickString(provider.defaultModel) ?? pickString(provider.modelId) ?? pickString(provider.model);
  return defaultModel?.trim() === normalizedModelId;
}

function parseProviderIdFromProviderKeyForLegacyConfig(providerKey?: string): string | undefined {
  if (!providerKey) {
    return undefined;
  }
  return providerKey.split('.', 1)[0]?.trim() || undefined;
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractForwardersFromUserConfig(userConfig: UnknownRecord): Record<string, UnknownRecord> | undefined {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  const candidates: Array<unknown> = [
    vrNode?.forwarders,
    userConfig.forwarders,
  ];
  for (const c of candidates) {
    if (isRecord(c)) {
      // 仅保留 fwd. 前缀的
      const filtered: Record<string, UnknownRecord> = {};
      for (const [k, v] of Object.entries(c)) {
        if (k.startsWith('fwd.') && isRecord(v)) {
          filtered[k] = v as UnknownRecord;
        }
      }
      if (Object.keys(filtered).length) return filtered;
    }
  }
  return undefined;
}

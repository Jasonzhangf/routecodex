import type { UnknownObject } from '../../../types/common-types.js';
import { asRecord } from './provider-utils.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import { applyDefaultStageTimingMode, resolveRuntimeBuildMode } from './stage-timing-defaults.js';
import { registerClockRuntimeHooks } from './clock-runtime-hooks.js';
import { registerHeartbeatRuntimeHooks } from './heartbeat-runtime-hooks.js';

type RoutingProviderScope = {
  providerKeys: string[];
  providerIds: string[];
  oauthProviderKeys: string[];
  oauthProviderIds: string[];
};

export async function setupRuntime(server: any, userConfig: UnknownObject): Promise<void> {
  applyDefaultStageTimingMode();
  server.userConfig = asRecord(userConfig);
  server.ensureProviderProfilesFromUserConfig();
  const routerInput = server.resolveVirtualRouterInput(server.userConfig);
  const bootstrapArtifacts = await server.bootstrapVirtualRouter(routerInput);
  server.currentRouterArtifacts = bootstrapArtifacts;
  await applyRoutingScopeToManagerModules(
    server,
    deriveRoutingProviderScope(bootstrapArtifacts?.targetRuntime, routerInput)
  );
  const hubCtor = await server.ensureHubPipelineCtor();
  const hubConfig: { virtualRouter: unknown; [key: string]: unknown } = {
    virtualRouter: bootstrapArtifacts.config
  };

  const hubPolicyModeRaw = String(process.env.ROUTECODEX_HUB_POLICY_MODE || '').trim().toLowerCase();
  const hubPolicyMode =
    hubPolicyModeRaw === 'off' || hubPolicyModeRaw === '0' || hubPolicyModeRaw === 'false'
      ? null
      : hubPolicyModeRaw === 'observe' || hubPolicyModeRaw === 'enforce'
        ? hubPolicyModeRaw
        : 'enforce';

  server.hubPolicyMode = hubPolicyMode ?? 'off';

  if (hubPolicyMode) {
    const sampleRateRaw = String(process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE || '').trim();
    const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : undefined;
    hubConfig.policy = {
      mode: hubPolicyMode,
      ...(Number.isFinite(sampleRate) ? { sampleRate } : {})
    };
  }

  const toolSurfaceModeRaw = String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '').trim().toLowerCase();
  const toolSurfaceMode =
    toolSurfaceModeRaw === 'off' || toolSurfaceModeRaw === '0' || toolSurfaceModeRaw === 'false'
      ? null
      : toolSurfaceModeRaw === 'observe' || toolSurfaceModeRaw === 'shadow' || toolSurfaceModeRaw === 'enforce'
        ? toolSurfaceModeRaw
        : resolveRuntimeBuildMode() === 'dev'
          ? 'enforce'
          : null;

  if (toolSurfaceMode) {
    const sampleRateRaw = String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_SAMPLE_RATE || '').trim();
    const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : undefined;
    hubConfig.toolSurface = {
      mode: toolSurfaceMode,
      ...(Number.isFinite(sampleRate) ? { sampleRate } : {})
    };
    if (!process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE) {
      process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE = toolSurfaceMode;
    }
  }

  if (!process.env.ROUTECODEX_HUB_FOLLOWUP_MODE) {
    if (resolveRuntimeBuildMode() === 'dev') {
      process.env.ROUTECODEX_HUB_FOLLOWUP_MODE = 'shadow';
    }
  }

  const healthModule = server.managerDaemon?.getModule('health') as HealthManagerModule | undefined;
  const healthStore = healthModule?.getHealthStore();
  if (healthStore) {
    hubConfig.healthStore = healthStore;
  }
  const routingModule = server.managerDaemon?.getModule('routing') as RoutingStateManagerModule | undefined;
  const routingStateStore = routingModule?.getRoutingStateStore();
  if (routingStateStore) {
    hubConfig.routingStateStore = routingStateStore;
  }
  const quotaModule = server.managerDaemon?.getModule('quota') as
    | { getQuotaView?: () => unknown; getQuotaViewReadOnly?: () => unknown }
    | undefined;
  if (server.isQuotaRoutingEnabled() && quotaModule && typeof quotaModule.getQuotaView === 'function') {
    hubConfig.quotaView = quotaModule.getQuotaView() as any;
    if (typeof quotaModule.getQuotaViewReadOnly === 'function') {
      (hubConfig as Record<string, unknown>).quotaViewReadOnly = quotaModule.getQuotaViewReadOnly();
    }
  }
  if (!server.hubPipeline) {
    server.hubPipeline = new hubCtor(hubConfig);
  } else {
    const existing = server.hubPipeline as {
      updateRuntimeDeps?: (deps: { healthStore?: unknown; routingStateStore?: unknown; quotaView?: unknown }) => void;
      updateVirtualRouterConfig?: (config: unknown) => void;
    };
    try {
      existing.updateRuntimeDeps?.({
        ...(healthStore ? { healthStore } : {}),
        ...(routingStateStore ? { routingStateStore } : {}),
        ...('quotaView' in hubConfig ? { quotaView: hubConfig.quotaView } : {})
      });
    } catch {
      // best-effort
    }
    server.hubPipeline.updateVirtualRouterConfig(bootstrapArtifacts.config);
  }

  server.hubPipelineConfigForShadow = hubConfig as Record<string, unknown>;
  server.hubPipelineEngineShadow = null;

  await server.initializeProviderRuntimes(bootstrapArtifacts);
  await registerClockRuntimeHooks();
  await registerHeartbeatRuntimeHooks(server);
  server.startSessionDaemonInjectLoop();
}

function deriveRoutingProviderScope(
  targetRuntime: Record<string, ProviderRuntimeProfile> | undefined,
  routerInput: UnknownObject
): RoutingProviderScope {
  const configuredProviderIds = collectConfiguredProviderIds(routerInput);
  const providerKeys = new Set<string>();
  const providerIds = new Set<string>();
  const oauthProviderKeys = new Set<string>();
  const oauthProviderIds = new Set<string>();
  const runtimeMap = targetRuntime ?? {};

  for (const [providerKeyRaw, runtime] of Object.entries(runtimeMap)) {
    const providerKey = typeof providerKeyRaw === 'string' ? providerKeyRaw.trim().toLowerCase() : '';
    if (!providerKey) {
      continue;
    }

    const providerId =
      typeof runtime?.providerId === 'string' && runtime.providerId.trim()
        ? runtime.providerId.trim().toLowerCase()
        : providerKey.split('.')[0] ?? '';
    if (configuredProviderIds.size > 0 && providerId && !configuredProviderIds.has(providerId)) {
      continue;
    }
    providerKeys.add(providerKey);
    if (providerId) {
      providerIds.add(providerId);
    }

    const authType = typeof runtime?.auth?.type === 'string' ? runtime.auth.type.trim().toLowerCase() : '';
    const rawType = typeof runtime?.auth?.rawType === 'string' ? runtime.auth.rawType.trim().toLowerCase() : '';
    const oauthLike =
      authType.includes('oauth') ||
      rawType.includes('oauth') ||
      rawType.includes('account') ||
      rawType.includes('cookie');
    if (!oauthLike) {
      continue;
    }

    oauthProviderKeys.add(providerKey);
    if (providerId) {
      oauthProviderIds.add(providerId);
    }
  }

  return {
    providerKeys: Array.from(providerKeys),
    providerIds: Array.from(providerIds),
    oauthProviderKeys: Array.from(oauthProviderKeys),
    oauthProviderIds: Array.from(oauthProviderIds)
  };
}

function collectConfiguredProviderIds(routerInput: UnknownObject): Set<string> {
  const routing = resolveActiveRoutingNode(routerInput);
  const ids = new Set<string>();
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return ids;
  }
  for (const pools of Object.values(routing as Record<string, unknown>)) {
    if (!Array.isArray(pools)) {
      continue;
    }
    for (const pool of pools) {
      if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
        continue;
      }
      const poolRecord = pool as Record<string, unknown>;
      const targets = Array.isArray(poolRecord.targets) ? poolRecord.targets : [];
      for (const target of targets) {
        const providerId = extractProviderIdFromRouteTarget(target);
        if (providerId) {
          ids.add(providerId);
        }
      }
      const loadBalancing =
        poolRecord.loadBalancing && typeof poolRecord.loadBalancing === 'object' && !Array.isArray(poolRecord.loadBalancing)
          ? (poolRecord.loadBalancing as Record<string, unknown>)
          : null;
      const weights =
        loadBalancing?.weights && typeof loadBalancing.weights === 'object' && !Array.isArray(loadBalancing.weights)
          ? (loadBalancing.weights as Record<string, unknown>)
          : null;
      if (!weights) {
        continue;
      }
      for (const weightKey of Object.keys(weights)) {
        const providerId = extractProviderIdFromRouteTarget(weightKey);
        if (providerId) {
          ids.add(providerId);
        }
      }
    }
  }
  return ids;
}

function resolveActiveRoutingNode(routerInput: UnknownObject): Record<string, unknown> | null {
  if (routerInput.routing && typeof routerInput.routing === 'object' && !Array.isArray(routerInput.routing)) {
    return routerInput.routing as Record<string, unknown>;
  }
  const groups =
    routerInput.routingPolicyGroups &&
    typeof routerInput.routingPolicyGroups === 'object' &&
    !Array.isArray(routerInput.routingPolicyGroups)
      ? (routerInput.routingPolicyGroups as Record<string, unknown>)
      : null;
  if (!groups) {
    return null;
  }
  const groupEntries = Object.entries(groups)
    .filter(([groupId, groupNode]) => Boolean(groupId.trim()) && groupNode && typeof groupNode === 'object' && !Array.isArray(groupNode));
  if (groupEntries.length === 0) {
    return null;
  }
  const activeGroupId =
    typeof routerInput.activeRoutingPolicyGroup === 'string'
      ? routerInput.activeRoutingPolicyGroup.trim()
      : '';
  const selected =
    (activeGroupId ? groupEntries.find(([groupId]) => groupId === activeGroupId) : undefined) ??
    groupEntries.find(([groupId]) => groupId === 'default') ??
    groupEntries[0];
  const node = selected?.[1];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null;
  }
  const routing = (node as Record<string, unknown>).routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return null;
  }
  return routing as Record<string, unknown>;
}

function extractProviderIdFromRouteTarget(target: unknown): string | null {
  if (typeof target !== 'string') {
    return null;
  }
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const idx = trimmed.indexOf('.');
  if (idx <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, idx);
}

async function applyRoutingScopeToManagerModules(server: any, scope: RoutingProviderScope): Promise<void> {
  const tokenModule = server.managerDaemon?.getModule?.('token') as
    | { updateRoutingScope?: (scope: RoutingProviderScope) => Promise<void> | void }
    | undefined;
  const quotaModule = server.managerDaemon?.getModule?.('quota') as
    | { updateRoutingScope?: (scope: RoutingProviderScope) => Promise<void> | void }
    | undefined;

  if (tokenModule && typeof tokenModule.updateRoutingScope === 'function') {
    await tokenModule.updateRoutingScope(scope);
  }
  if (quotaModule && typeof quotaModule.updateRoutingScope === 'function') {
    await quotaModule.updateRoutingScope(scope);
  }
}

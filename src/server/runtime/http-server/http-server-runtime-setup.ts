import type { UnknownObject } from '../../../types/common-types.js';
import { asRecord } from './provider-utils.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { HubPipeline, HubPipelineConfig, HubPipelineCtor, VirtualRouterArtifacts } from './types.js';
import { applyDefaultStageTimingMode, resolveRuntimeBuildMode } from './stage-timing-defaults.js';
import { clearUnresolvedResponsesConversationRequests, preloadCriticalBridgeRuntimeModules } from '../../../modules/llmswitch/bridge.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import { buildVirtualRouterInputV2 } from '../../../config/virtual-router-builder.js';
import { trafficGovernorIsAtCapacity } from '../../../modules/traffic-governor/index.js';

type RoutingProviderScope = {
  providerKeys: string[];
  providerIds: string[];
  oauthProviderKeys: string[];
  oauthProviderIds: string[];
};

const TRUTHY_FLAG_SET = new Set(['1', 'true', 'yes', 'on']);


function logRuntimeSetupNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[http-server-runtime-setup] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

function collectRouterRoutingPolicyGroups(server: any): string[] {
  const getPortConfigs = typeof server?.getPortConfigs === 'function' ? server.getPortConfigs.bind(server) : undefined;
  const ports = getPortConfigs ? getPortConfigs() : [];
  const groups = new Set<string>();
  for (const port of Array.isArray(ports) ? ports : []) {
    if (!port || typeof port !== 'object') {
      continue;
    }
    const record = port as Record<string, unknown>;
    if (record.mode !== 'router') {
      continue;
    }
    const group = typeof record.routingPolicyGroup === 'string' ? record.routingPolicyGroup.trim() : '';
    if (group) {
      groups.add(group);
    }
  }
  return [...groups].sort();
}

async function rebuildRoutingPolicyGroupHubPipelines(args: {
  server: any;
  hubCtor: HubPipelineCtor;
  baseConfig: HubPipelineConfig;
}): Promise<void> {
  const groups = collectRouterRoutingPolicyGroups(args.server);
  const previous = args.server.hubPipelinesByRoutingPolicyGroup instanceof Map
    ? (args.server.hubPipelinesByRoutingPolicyGroup as Map<string, HubPipeline>)
    : new Map<string, HubPipeline>();
  const next = new Map<string, HubPipeline>();
  for (const group of groups) {
    const config = await args.server.buildHubPipelineConfigForRoutingPolicyGroup(group, args.baseConfig);
    const existing = previous.get(group);
    if (existing) {
      existing.updateVirtualRouterConfig(config.virtualRouter);
      next.set(group, existing);
    } else {
      next.set(group, new args.hubCtor(config));
    }
  }
  for (const [group, pipeline] of previous.entries()) {
    if (!next.has(group)) {
      try {
        (pipeline as { dispose?: () => void }).dispose?.();
      } catch (error) {
        logRuntimeSetupNonBlockingError('setupRuntime.disposeGroupHubPipeline', error, { group });
      }
    }
  }
  args.server.hubPipelinesByRoutingPolicyGroup = next;
}

async function buildAllRouterGroupArtifacts(args: {
  server: any;
  primaryArtifacts: VirtualRouterArtifacts;
}): Promise<VirtualRouterArtifacts> {
  const groups = collectRouterRoutingPolicyGroups(args.server);
  if (groups.length < 1) {
    return args.primaryArtifacts;
  }
  const runtime = { ...(args.primaryArtifacts.runtime ?? {}) } as Record<string, ProviderRuntimeProfile>;
  const targetRuntime = { ...(args.primaryArtifacts.targetRuntime ?? {}) } as Record<string, ProviderRuntimeProfile>;
  const mergedConfig = isRecord(args.primaryArtifacts.config)
    ? structuredClone(args.primaryArtifacts.config)
    : {};
  const mergedRouting = isRecord(mergedConfig.routing) ? mergedConfig.routing : {};
  mergedConfig.routing = mergedRouting;
  for (const group of groups) {
    const routerInput = await buildVirtualRouterInputV2(args.server.userConfig as Record<string, unknown>, undefined, {
      routingPolicyGroup: group,
    });
    const artifacts = await args.server.bootstrapVirtualRouter(routerInput as UnknownObject);
    Object.assign(runtime, artifacts.runtime ?? {});
    Object.assign(targetRuntime, artifacts.targetRuntime ?? {});
    const routerInputRouting = isRecord(routerInput.routing) ? routerInput.routing : undefined;
    if (routerInputRouting) {
      Object.assign(mergedRouting, structuredClone(routerInputRouting));
    }
    if (isRecord(artifacts.config) && isRecord(artifacts.config.routing)) {
      Object.assign(mergedRouting, structuredClone(artifacts.config.routing));
    }
  }
  return {
    ...args.primaryArtifacts,
    config: {
      ...mergedConfig,
      routing: mergedRouting,
    },
    runtime,
    targetRuntime,
  };
}

function readTruthyEnv(names: string[]): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) {
      continue;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY_FLAG_SET.has(normalized)) {
      return true;
    }
  }
  return false;
}

function isMockRuntimeGuardBypassed(): boolean {
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return true;
  }
  return readTruthyEnv([
    'ROUTECODEX_ALLOW_MOCK_RUNTIME',
    'RCC_ALLOW_MOCK_RUNTIME',
    'ROUTECODEX_ALLOW_MOCK_PROVIDER',
    'RCC_ALLOW_MOCK_PROVIDER'
  ]);
}

function collectMockRuntimeViolations(options: {
  runtimeMap?: Record<string, ProviderRuntimeProfile>;
  configPath?: string;
}): string[] {
  const violations: string[] = [];
  const runtimeMap = options.runtimeMap ?? {};
  const configPath = typeof options.configPath === 'string' ? options.configPath.trim() : '';

  if (readTruthyEnv(['ROUTECODEX_USE_MOCK', 'RCC_USE_MOCK'])) {
    violations.push('环境变量 ROUTECODEX_USE_MOCK/RCC_USE_MOCK 已启用');
  }
  if (process.env.ROUTECODEX_MOCK_CONFIG_PATH || process.env.ROUTECODEX_MOCK_SAMPLES_DIR) {
    violations.push('检测到 ROUTECODEX_MOCK_CONFIG_PATH/ROUTECODEX_MOCK_SAMPLES_DIR');
  }
  if (
    configPath &&
    (configPath.includes('/routecodex-verify-') || configPath.includes('/routecodex-verify-mock-'))
  ) {
    violations.push(`配置路径疑似 verify 临时配置: ${configPath}`);
  }

  for (const [providerKeyRaw, runtime] of Object.entries(runtimeMap)) {
    const providerKey = String(providerKeyRaw || '').trim().toLowerCase();
    const providerType = String(runtime?.providerType || '').trim().toLowerCase();
    const providerModule = String(runtime?.providerModule || '').trim().toLowerCase();
    const providerId = String(runtime?.providerId || '').trim().toLowerCase();
    const defaultModel = String(runtime?.defaultModel || '').trim().toLowerCase();
    const endpoint = String(runtime?.endpoint || '').trim().toLowerCase();
    const baseUrl = String(runtime?.baseUrl || '').trim().toLowerCase();

    const isMockProvider =
      providerType === 'mock' ||
      providerModule === 'mock-provider' ||
      providerModule.includes('mock-provider');
    const isVerifySignature =
      providerId === 'verify' ||
      providerKey.startsWith('verify.') ||
      providerKey.includes('.verify-mock') ||
      defaultModel === 'verify-mock' ||
      endpoint.includes('mock.local') ||
      baseUrl.includes('mock.local');

    if (isMockProvider || isVerifySignature) {
      violations.push(
        `provider=${providerKeyRaw} type=${providerType || 'unknown'} module=${providerModule || 'unknown'} model=${defaultModel || 'unknown'}`
      );
    }
  }

  return violations;
}

function enforceNoMockRuntimeInServer(options: {
  runtimeMap?: Record<string, ProviderRuntimeProfile>;
  configPath?: string;
}): void {
  if (isMockRuntimeGuardBypassed()) {
    return;
  }
  const violations = collectMockRuntimeViolations(options);
  if (violations.length < 1) {
    return;
  }
  const detail = violations.slice(0, 6).join('; ');
  const hint = '如确需本地验证 mock，请显式设置 ROUTECODEX_ALLOW_MOCK_RUNTIME=1（仅测试/验证环境）';
  throw new Error(`[mock-runtime-guard] 生产运行时禁止 mock/verify provider: ${detail}. ${hint}`);
}

export async function setupRuntime(server: any, userConfig: UnknownObject): Promise<void> {
  applyDefaultStageTimingMode();
  server.userConfig = asRecord(userConfig);
  server.ensureProviderProfilesFromUserConfig();
  const routerInput = await server.resolveVirtualRouterInput(server.userConfig);
  const bootstrapArtifacts = await server.bootstrapVirtualRouter(routerInput);
  const providerRuntimeArtifacts = await buildAllRouterGroupArtifacts({
    server,
    primaryArtifacts: bootstrapArtifacts,
  });
  enforceNoMockRuntimeInServer({
    runtimeMap: providerRuntimeArtifacts?.targetRuntime,
    configPath: server?.config?.configPath
  });
  server.currentRouterArtifacts = bootstrapArtifacts;
  const runtimeForScope = {
    ...(providerRuntimeArtifacts?.runtime ?? {}),
    ...(providerRuntimeArtifacts?.targetRuntime ?? {})
  } as Record<string, ProviderRuntimeProfile>;
  const routingScope = deriveRoutingProviderScope(
    runtimeForScope,
    (providerRuntimeArtifacts?.config as UnknownObject | undefined)
      ?? (bootstrapArtifacts?.config as UnknownObject | undefined)
      ?? ({ routing: {} } as UnknownObject),
    server.userConfig
  );
  // Runtime-level scope cache: provider init/warmup must honor the same routing scope
  // as token/quota managers to avoid non-routed providers doing background tasks.
  server.routingProviderScope = routingScope;
  await applyRoutingScopeToManagerModules(server, routingScope);
  try {
    // traffic-governor: 已迁移到独立模块 (traffic-governor-core)
    // reset 功能后续通过 Rust 启动流程处理
    const runtimeKey = process.env.ROUTECODEX_SERVER_ID || `pid-${process.pid}`;
    const isAtCap = trafficGovernorIsAtCapacity(runtimeKey);
    if (isAtCap) {
      console.warn(`[traffic-governor] runtimeKey=${runtimeKey} at capacity on startup — stale leases may remain`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[provider-traffic] failed to reset state on runtime setup (non-blocking): ${reason}`);
  }
  await preloadCriticalBridgeRuntimeModules();
  try {
    const cleared = await clearUnresolvedResponsesConversationRequests();
    if (cleared > 0) {
      console.warn('[responses-store] cleared unresolved requests on runtime setup', { cleared });
    }
  } catch (error) {
    logRuntimeSetupNonBlockingError('setupRuntime.clearUnresolvedResponsesConversationRequests', error);
  }
  const hubCtor = await server.ensureHubPipelineCtor();
  const hubConfig: HubPipelineConfig = {
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
  if (!server.hubPipeline) {
    server.hubPipeline = new hubCtor(hubConfig);
  } else {
    const existing = server.hubPipeline as {
      updateRuntimeDeps?: (deps: { healthStore?: unknown; routingStateStore?: unknown }) => void;
      updateVirtualRouterConfig?: (config: unknown) => void;
    };
    try {
      existing.updateRuntimeDeps?.({
        ...(healthStore ? { healthStore } : {}),
        ...(routingStateStore ? { routingStateStore } : {})
      });
    } catch (error) {
      logRuntimeSetupNonBlockingError('setupRuntime.updateRuntimeDeps', error, {
        hasHealthStore: Boolean(healthStore),
        hasRoutingStateStore: Boolean(routingStateStore)
      });
    }
    server.hubPipeline.updateVirtualRouterConfig(bootstrapArtifacts.config);
  }

  await rebuildRoutingPolicyGroupHubPipelines({ server, hubCtor, baseConfig: hubConfig });

  server.hubPipelineConfigForShadow = hubConfig as Record<string, unknown>;
  server.hubPipelineEngineShadow = null;

  await server.initializeProviderRuntimes(providerRuntimeArtifacts);
}

function deriveRoutingProviderScope(
  targetRuntime: Record<string, ProviderRuntimeProfile> | undefined,
  routerInput: UnknownObject,
  userConfig?: UnknownObject
): RoutingProviderScope {
  const configuredProviderIds = collectConfiguredProviderIds(routerInput, userConfig);
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

function collectConfiguredProviderIds(routerInput: UnknownObject, userConfig?: UnknownObject): Set<string> {
  const routing = resolveActiveRoutingNode(routerInput);
  const ids = new Set<string>();
  const forwarders =
    routerInput.forwarders && typeof routerInput.forwarders === 'object' && !Array.isArray(routerInput.forwarders)
      ? (routerInput.forwarders as Record<string, unknown>)
      : null;
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
        for (const expandedProviderId of extractForwarderProviderIds(target, forwarders)) {
          ids.add(expandedProviderId);
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
  for (const providerId of collectProviderIdsFromProviderPorts(userConfig)) {
    ids.add(providerId);
  }
  return ids;
}

function collectProviderIdsFromProviderPorts(userConfig?: UnknownObject): Set<string> {
  const ids = new Set<string>();
  if (!userConfig || typeof userConfig !== 'object') {
    return ids;
  }
  const httpserver =
    userConfig.httpserver && typeof userConfig.httpserver === 'object' && !Array.isArray(userConfig.httpserver)
      ? (userConfig.httpserver as Record<string, unknown>)
      : null;
  const ports = Array.isArray(httpserver?.ports) ? (httpserver!.ports as unknown[]) : [];
  for (const portRaw of ports) {
    if (!portRaw || typeof portRaw !== 'object' || Array.isArray(portRaw)) {
      continue;
    }
    const port = portRaw as Record<string, unknown>;
    const mode = typeof port.mode === 'string' ? port.mode.trim().toLowerCase() : '';
    if (mode !== 'provider') {
      continue;
    }
    const binding = typeof port.providerBinding === 'string' ? port.providerBinding.trim().toLowerCase() : '';
    if (!binding) {
      continue;
    }
    const firstDot = binding.indexOf('.');
    const providerId = firstDot > 0 ? binding.slice(0, firstDot) : binding;
    if (providerId) {
      ids.add(providerId);
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

function extractForwarderProviderIds(
  target: unknown,
  forwarders: Record<string, unknown> | null,
): string[] {
  if (typeof target !== 'string' || !forwarders) {
    return [];
  }
  const forwarder = forwarders[target];
  if (!forwarder || typeof forwarder !== 'object' || Array.isArray(forwarder)) {
    return [];
  }
  const targets = Array.isArray((forwarder as Record<string, unknown>).targets)
    ? ((forwarder as Record<string, unknown>).targets as unknown[])
    : [];
  const ids = new Set<string>();
  for (const entry of targets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const providerIdRaw = typeof record.providerId === 'string' ? record.providerId.trim().toLowerCase() : '';
    if (providerIdRaw) {
      ids.add(providerIdRaw);
    }
    const providerKeyRaw = typeof record.providerKey === 'string' ? record.providerKey : '';
    const providerIdFromKey = extractProviderIdFromRouteTarget(providerKeyRaw);
    if (providerIdFromKey) {
      ids.add(providerIdFromKey);
    }
  }
  return [...ids];
}

async function applyRoutingScopeToManagerModules(server: any, scope: RoutingProviderScope): Promise<void> {
  const tokenModule = server.managerDaemon?.getModule?.('token') as
    | { updateRoutingScope?: (scope: RoutingProviderScope) => Promise<void> | void }
    | undefined;

  if (tokenModule && typeof tokenModule.updateRoutingScope === 'function') {
    await tokenModule.updateRoutingScope(scope);
  }
}

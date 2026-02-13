import type { UnknownObject } from '../../../types/common-types.js';
import { asRecord } from './provider-utils.js';
import { buildInfo } from '../../../build-info.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';

export async function setupRuntime(server: any, userConfig: UnknownObject): Promise<void> {
  server.userConfig = asRecord(userConfig);
  server.ensureProviderProfilesFromUserConfig();
  const routerInput = server.resolveVirtualRouterInput(server.userConfig);
  const bootstrapArtifacts = await server.bootstrapVirtualRouter(routerInput);
  server.currentRouterArtifacts = bootstrapArtifacts;
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
        : buildInfo.mode === 'dev'
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
    if (buildInfo.mode === 'dev') {
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
  server.startClockDaemonInjectLoop();
}

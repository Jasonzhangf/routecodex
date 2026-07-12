/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor.
 */

import {
  assertNativeObject,
  callNativeJsonCapability,
  parseNativeJsonResult as parseSharedNativeJsonResult,
  requireNativeFunction,
  stringifyNativeJsonArg,
} from './native-json-invoker.js';
import { getRouterHotpathJsonBindingSync } from './routing-native-host.js';

export {
  buildRequestStageRuntimeControlWritePlanNative,
  resolveEntryProtocolFromEndpointNative,
} from './routing-native-host.js';

// feature_id: hub.runtime_ingress_bridge
// Rust owner symbols:
// create_hub_pipeline_engine_json, hub_pipeline_execute_json,
// dispose_hub_pipeline_engine_json,
// update_hub_pipeline_virtual_router_config_json,
// update_hub_pipeline_engine_deps_json.
type AnyRecord = Record<string, unknown>;
type NativeHubPipelineOrchestrationSemantics = {
  createHubPipelineEngineJson?: (inputJson: string) => string;
  disposeHubPipelineEngineJson?: (handle: string) => void;
  hubPipelineExecuteJson?: (handle: string, requestJson: string) => string;
  updateHubPipelineEngineDepsJson?: (handle: string, depsJson: string) => void;
  updateHubPipelineVirtualRouterConfigJson?: (handle: string, configJson: string) => void;
  hubPipelineVirtualRouterRouteJson?: (handle: string, requestJson: string, metadataJson: string) => string;
  hubPipelineVirtualRouterDiagnoseRouteJson?: (handle: string, requestJson: string, metadataJson: string) => string;
  hubPipelineVirtualRouterStatusJson?: (handle: string) => string;
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson?: (handle: string, scopeKey: string) => void;
  hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson?: (handle: string, scopeKey: string) => void;
};

type VirtualRouterRouteHostEffectsPlan = AnyRecord & {
  cleanedRequest?: unknown;
};

let cachedNativeHubPipelineOrchestrationSemantics:
  | NativeHubPipelineOrchestrationSemantics
  | null = null;

function getNativeHubPipelineOrchestrationSemantics(): NativeHubPipelineOrchestrationSemantics {
  if (!cachedNativeHubPipelineOrchestrationSemantics) {
    cachedNativeHubPipelineOrchestrationSemantics =
      loadNativeBindingForConfigCodec() as NativeHubPipelineOrchestrationSemantics;
  }
  return cachedNativeHubPipelineOrchestrationSemantics;
}

function requireNativeHubPipelineFn<T extends Function>(
  name: keyof NativeHubPipelineOrchestrationSemantics
): T {
  void getNativeHubPipelineOrchestrationSemantics;
  return requireNativeFunction(
    loadNativeBindingForConfigCodec,
    String(name),
    { label: 'llmswitch-bridge' }
  ) as unknown as T;
}

function parseNativeObjectResult(name: string, raw: unknown): AnyRecord {
  return assertNativeObject(
    name,
    parseSharedNativeJsonResult(name, raw, { label: 'llmswitch-bridge' }),
    { label: 'llmswitch-bridge' }
  );
}

function resolveRccUserDirForNativeRouting(): string | undefined {
  const parsed = callNativeJsonCapability(
    loadNativeBindingForConfigCodec,
    'resolveRccUserDirJson',
    [{
      homeDir: process.env.HOME,
      rccHome: process.env.RCC_HOME,
      routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
      routecodexHome: process.env.ROUTECODEX_HOME
    }],
    { label: 'llmswitch-bridge' }
  );
  return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
}

export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  return assertNativeObject(
    'bootstrapVirtualRouterConfigJson',
    callNativeJsonCapability(
      loadNativeBindingForConfigCodec,
      'bootstrapVirtualRouterConfigJson',
      [input ?? {}],
      { label: 'llmswitch-bridge' }
    ),
    { label: 'llmswitch-bridge' }
  );
}

function loadNativeBindingForConfigCodec(): AnyRecord {
  return getRouterHotpathJsonBindingSync() as unknown as AnyRecord;
}

// ---------------------------------------------------------------------------
// Native handle-mode HubPipeline entry points.
// Server runtime stores opaque handles and calls the native engine directly.
// ---------------------------------------------------------------------------

export function createHubPipelineNative(config: AnyRecord): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] createHubPipelineNative requires a JSON object config');
  }
  const createHubPipelineEngineJson = requireNativeHubPipelineFn<(inputJson: string) => string>(
    'createHubPipelineEngineJson'
  );
  const result = createHubPipelineEngineJson(
    stringifyNativeJsonArg('createHubPipelineNative', config, { label: 'llmswitch-bridge' }) ?? 'null'
  );
  const parsed = parseNativeObjectResult('createHubPipelineNative', result);
  const handle = parsed.handle;
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] createHubPipelineNative returned invalid handle');
  }
  return handle;
}

export function executeHubPipelineNative(handle: string, request: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] executeHubPipelineNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] executeHubPipelineNative requires JSON object request');
  }
  const hubPipelineExecuteJson = requireNativeHubPipelineFn<(handle: string, requestJson: string) => string>(
    'hubPipelineExecuteJson'
  );
  const raw = hubPipelineExecuteJson(
    handle,
    stringifyNativeJsonArg('executeHubPipelineNative', request, { label: 'llmswitch-bridge' }) ?? 'null'
  );
  return parseNativeObjectResult('executeHubPipelineNative', raw);
}

export function updateHubPipelineVirtualRouterConfigNative(handle: string, config: AnyRecord): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires non-empty handle');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires JSON object config');
  }
  const updateHubPipelineVirtualRouterConfigJson = requireNativeHubPipelineFn<
    (handle: string, configJson: string) => void
  >('updateHubPipelineVirtualRouterConfigJson');
  updateHubPipelineVirtualRouterConfigJson(
    handle,
    stringifyNativeJsonArg('updateHubPipelineVirtualRouterConfigNative', config, { label: 'llmswitch-bridge' }) ?? 'null'
  );
}

export function updateHubPipelineEngineDepsNative(handle: string, deps: AnyRecord): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires non-empty handle');
  }
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires JSON object deps');
  }
  const updateHubPipelineEngineDepsJson = requireNativeHubPipelineFn<
    (handle: string, depsJson: string) => void
  >('updateHubPipelineEngineDepsJson');
  updateHubPipelineEngineDepsJson(
    handle,
    stringifyNativeJsonArg('updateHubPipelineEngineDepsNative', deps, { label: 'llmswitch-bridge' }) ?? 'null'
  );
}

export function routeHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object request');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object metadata');
  }
  const hubPipelineVirtualRouterRouteJson = requireNativeHubPipelineFn<
    (handle: string, requestJson: string, metadataJson: string) => string
  >('hubPipelineVirtualRouterRouteJson');
  const routeHostEffectsPlan = planVirtualRouterRouteHostEffectsNative(request, metadata);
  const nativeMetadata = injectVirtualRouterRuntimeMetadataLocal(metadata);
  const raw = hubPipelineVirtualRouterRouteJson(
    handle,
    stringifyNativeJsonArg('routeHubPipelineVirtualRouterNative', request, { label: 'llmswitch-bridge' }) ?? 'null',
    stringifyNativeJsonArg('routeHubPipelineVirtualRouterNative', nativeMetadata, { label: 'llmswitch-bridge' }) ?? 'null'
  );
  const parsed = parseNativeObjectResult('routeHubPipelineVirtualRouterNative', raw);
  finalizeVirtualRouterRouteHostEffectsNative(parsed, routeHostEffectsPlan);
  const cleanedRequest = routeHostEffectsPlan.cleanedRequest;
  if (cleanedRequest && typeof cleanedRequest === 'object' && !Array.isArray(cleanedRequest)) {
    for (const key of Object.keys(request)) {
      delete request[key];
    }
    Object.assign(request, cleanedRequest as AnyRecord);
  }
  return parsed;
}

function injectVirtualRouterRuntimeMetadataLocal(metadata: AnyRecord): AnyRecord {
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const existingRt = metadataRecord.__rt && typeof metadataRecord.__rt === 'object' && !Array.isArray(metadataRecord.__rt)
    ? metadataRecord.__rt as AnyRecord
    : undefined;
  const runtimeOverrides: AnyRecord = { nowMs: Date.now() };
  if (typeof existingRt?.rccUserDir !== 'string' || !existingRt.rccUserDir.trim()) {
    const rccUserDir = resolveRccUserDirForNativeRouting();
    if (rccUserDir) {
      runtimeOverrides.rccUserDir = rccUserDir;
    }
  }
  return {
    ...metadataRecord,
    __rt: { ...(existingRt ?? {}), ...runtimeOverrides }
  };
}

function planVirtualRouterRouteHostEffectsNative(request: AnyRecord, metadata: AnyRecord): VirtualRouterRouteHostEffectsPlan {
  return assertNativeObject(
    'planVirtualRouterRouteHostEffectsJson',
    callNativeJsonCapability(
      loadNativeBindingForConfigCodec,
      'planVirtualRouterRouteHostEffectsJson',
      [
        request ?? null,
        metadata ?? null,
      resolveRccUserDirForNativeRouting()
      ],
      { label: 'llmswitch-bridge' }
    ),
    { label: 'llmswitch-bridge' }
  ) as VirtualRouterRouteHostEffectsPlan;
}

function finalizeVirtualRouterRouteHostEffectsNative(result: AnyRecord, plan: VirtualRouterRouteHostEffectsPlan): void {
  const parsed = callNativeJsonCapability(
    loadNativeBindingForConfigCodec,
    'finalizeVirtualRouterRouteHostEffectsJson',
    [{ result, plan }],
    { label: 'llmswitch-bridge' }
  );
  if (parsed === null || typeof parsed === 'undefined') {
    return;
  }
  if (typeof parsed !== 'string') {
    throw new Error('[llmswitch-bridge] finalizeVirtualRouterRouteHostEffectsJson returned invalid payload');
  }
  console.log(parsed);
}

export function diagnoseHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object request');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object metadata');
  }
  const hubPipelineVirtualRouterDiagnoseRouteJson = requireNativeHubPipelineFn<
    (handle: string, requestJson: string, metadataJson: string) => string
  >('hubPipelineVirtualRouterDiagnoseRouteJson');
  const raw = hubPipelineVirtualRouterDiagnoseRouteJson(
    handle,
    stringifyNativeJsonArg('diagnoseHubPipelineVirtualRouterNative', request, { label: 'llmswitch-bridge' }) ?? 'null',
    stringifyNativeJsonArg('diagnoseHubPipelineVirtualRouterNative', metadata, { label: 'llmswitch-bridge' }) ?? 'null'
  );
  return parseNativeObjectResult('diagnoseHubPipelineVirtualRouterNative', raw);
}

export function getHubPipelineVirtualRouterStatusNative(handle: string): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterStatusJson = requireNativeHubPipelineFn<(handle: string) => string>(
    'hubPipelineVirtualRouterStatusJson'
  );
  const raw = hubPipelineVirtualRouterStatusJson(handle);
  return parseNativeObjectResult('getHubPipelineVirtualRouterStatusNative', raw);
}

export function markHubPipelineVirtualRouterConcurrencyScopeBusyNative(handle: string, scopeKey: string): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeBusyNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson = requireNativeHubPipelineFn<
    (handle: string, scopeKey: string) => void
  >('hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson');
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson(handle, String(scopeKey ?? ''));
}

export function markHubPipelineVirtualRouterConcurrencyScopeIdleNative(handle: string, scopeKey: string): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeIdleNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson = requireNativeHubPipelineFn<
    (handle: string, scopeKey: string) => void
  >('hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson');
  hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson(handle, String(scopeKey ?? ''));
}

export function disposeHubPipelineNative(handle: string): void {
  if (typeof handle !== 'string' || !handle) {
    return;
  }
  const disposeHubPipelineEngineJson = requireNativeHubPipelineFn<(handle: string) => void>(
    'disposeHubPipelineEngineJson'
  );
  disposeHubPipelineEngineJson(handle);
}

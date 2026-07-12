/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor.
 */

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
  const fn = getNativeHubPipelineOrchestrationSemantics()[name];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${String(name)} not available`);
  }
  return fn as unknown as T;
}

function parseNativeJsonResult(raw: unknown): unknown {
  const text = String(raw);
  if (text.startsWith('Error:')) {
    throw new Error(text.slice('Error:'.length).trimStart());
  }
  return JSON.parse(text) as unknown;
}

function callNativeBindingFn(name: string, args: unknown[]): unknown {
  const fn = loadNativeBindingForConfigCodec()[name];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${name} not available`);
  }
  return fn(...args);
}

function stringifyNativePayload(name: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] ${name} JSON stringify failed: ${detail}`);
  }
}

function parseNativeRecord(name: string, raw: unknown): AnyRecord {
  const parsed = parseNativeJsonResult(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[llmswitch-bridge] ${name} returned invalid payload`);
  }
  return parsed as AnyRecord;
}

function resolveRccUserDirForNativeRouting(): string | undefined {
  const parsed = parseNativeJsonResult(callNativeBindingFn('resolveRccUserDirJson', [
    stringifyNativePayload('resolveRccUserDirJson', {
      homeDir: process.env.HOME,
      rccHome: process.env.RCC_HOME,
      routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
      routecodexHome: process.env.ROUTECODEX_HOME
    })
  ]));
  return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
}

function parseHubPipelineNativeJsonResult(raw: unknown, label: string): AnyRecord {
  const text = String(raw);
  if (text.startsWith('Error:')) {
    throw new Error(text.slice('Error:'.length).trimStart());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] ${label} returned invalid payload: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[llmswitch-bridge] ${label} returned non-object payload`);
  }
  return parsed as AnyRecord;
}

export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.bootstrapVirtualRouterConfigJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfigJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify(input ?? {}))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfigJson returned invalid payload');
  }
  return output as AnyRecord;
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
  const result = createHubPipelineEngineJson(JSON.stringify(config));
  const parsed = parseHubPipelineNativeJsonResult(result, 'createHubPipelineNative');
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
  const raw = hubPipelineExecuteJson(handle, JSON.stringify(request));
  return parseHubPipelineNativeJsonResult(raw, 'executeHubPipelineNative');
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
  updateHubPipelineVirtualRouterConfigJson(handle, JSON.stringify(config));
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
  updateHubPipelineEngineDepsJson(handle, JSON.stringify(deps));
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
  const raw = hubPipelineVirtualRouterRouteJson(handle, JSON.stringify(request), JSON.stringify(nativeMetadata));
  const parsed = parseHubPipelineNativeJsonResult(raw, 'routeHubPipelineVirtualRouterNative');
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
  return parseNativeRecord(
    'planVirtualRouterRouteHostEffectsJson',
    callNativeBindingFn('planVirtualRouterRouteHostEffectsJson', [
      stringifyNativePayload('planVirtualRouterRouteHostEffectsJson', request ?? null),
      stringifyNativePayload('planVirtualRouterRouteHostEffectsJson', metadata ?? null),
      resolveRccUserDirForNativeRouting()
    ])
  ) as VirtualRouterRouteHostEffectsPlan;
}

function finalizeVirtualRouterRouteHostEffectsNative(result: AnyRecord, plan: VirtualRouterRouteHostEffectsPlan): void {
  const parsed = parseNativeJsonResult(callNativeBindingFn('finalizeVirtualRouterRouteHostEffectsJson', [
    stringifyNativePayload('finalizeVirtualRouterRouteHostEffectsJson', { result, plan })
  ]));
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
  const raw = hubPipelineVirtualRouterDiagnoseRouteJson(handle, JSON.stringify(request), JSON.stringify(metadata));
  try {
    return JSON.parse(raw) as AnyRecord;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative returned invalid payload: ${String(error)}`);
  }
}

export function getHubPipelineVirtualRouterStatusNative(handle: string): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterStatusJson = requireNativeHubPipelineFn<(handle: string) => string>(
    'hubPipelineVirtualRouterStatusJson'
  );
  const raw = hubPipelineVirtualRouterStatusJson(handle);
  try {
    return JSON.parse(raw) as AnyRecord;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative returned invalid payload: ${String(error)}`);
  }
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

import { readNativeFunction } from './native-router-hotpath-loader.js';

type AnyRecord = Record<string, unknown>;

type VirtualRouterRouteHostEffectsPlan = AnyRecord & {
  cleanedRequest?: unknown;
};

function nativeFn(name: string): (...args: string[]) => unknown {
  const fn = readNativeFunction(name);
  if (!fn) {
    throw new Error(`[hub-pipeline-handle-direct-native] ${name} not available`);
  }
  return fn as (...args: string[]) => unknown;
}

function stringifyNativePayload(name: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[hub-pipeline-handle-direct-native] ${name} JSON stringify failed: ${detail}`);
  }
}

function parseNativeJsonResult(raw: unknown): unknown {
  const text = String(raw);
  if (text.startsWith('Error:')) {
    throw new Error(text.slice('Error:'.length).trimStart());
  }
  return JSON.parse(text) as unknown;
}

function parseNativeRecord(name: string, raw: unknown): AnyRecord {
  const parsed = parseNativeJsonResult(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[hub-pipeline-handle-direct-native] ${name} returned invalid payload`);
  }
  return parsed as AnyRecord;
}

function resolveRccUserDirForNativeRouting(): string | undefined {
  const parsed = parseNativeJsonResult(nativeFn('resolveRccUserDirJson')(
    stringifyNativePayload('resolveRccUserDirJson', {
      homeDir: process.env.HOME,
      rccHome: process.env.RCC_HOME,
      routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
      routecodexHome: process.env.ROUTECODEX_HOME,
    })
  ));
  return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
}

function createHubPipelineHandle(config: AnyRecord): string {
  const parsed = parseNativeRecord(
    'createHubPipelineEngineJson',
    nativeFn('createHubPipelineEngineJson')(stringifyNativePayload('createHubPipelineEngineJson', config))
  );
  const handle = parsed.handle;
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[hub-pipeline-handle-direct-native] create returned invalid handle');
  }
  return handle;
}

function executeHubPipelineHandle(handle: string, request: AnyRecord): AnyRecord {
  return parseNativeRecord(
    'hubPipelineExecuteJson',
    nativeFn('hubPipelineExecuteJson')(handle, stringifyNativePayload('hubPipelineExecuteJson', request))
  );
}

function updateHubPipelineVirtualRouterConfig(handle: string, config: AnyRecord): void {
  nativeFn('updateHubPipelineVirtualRouterConfigJson')(
    handle,
    stringifyNativePayload('updateHubPipelineVirtualRouterConfigJson', config)
  );
}

function updateHubPipelineEngineDeps(handle: string, deps: AnyRecord): void {
  nativeFn('updateHubPipelineEngineDepsJson')(
    handle,
    stringifyNativePayload('updateHubPipelineEngineDepsJson', deps)
  );
}

function injectVirtualRouterRuntimeMetadata(metadata: AnyRecord): AnyRecord {
  const existingRt = metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? metadata.__rt as AnyRecord
    : undefined;
  const runtimeOverrides: AnyRecord = { nowMs: Date.now() };
  if (typeof existingRt?.rccUserDir !== 'string' || !existingRt.rccUserDir.trim()) {
    const rccUserDir = resolveRccUserDirForNativeRouting();
    if (rccUserDir) {
      runtimeOverrides.rccUserDir = rccUserDir;
    }
  }
  return {
    ...metadata,
    __rt: { ...(existingRt ?? {}), ...runtimeOverrides },
  };
}

function planVirtualRouterRouteHostEffects(request: AnyRecord, metadata: AnyRecord): VirtualRouterRouteHostEffectsPlan {
  return parseNativeRecord(
    'planVirtualRouterRouteHostEffectsJson',
    nativeFn('planVirtualRouterRouteHostEffectsJson')(
      stringifyNativePayload('planVirtualRouterRouteHostEffectsJson', request ?? null),
      stringifyNativePayload('planVirtualRouterRouteHostEffectsJson', metadata ?? null),
      resolveRccUserDirForNativeRouting() ?? ''
    )
  ) as VirtualRouterRouteHostEffectsPlan;
}

function finalizeVirtualRouterRouteHostEffects(result: AnyRecord, plan: VirtualRouterRouteHostEffectsPlan): void {
  const parsed = parseNativeJsonResult(nativeFn('finalizeVirtualRouterRouteHostEffectsJson')(
    stringifyNativePayload('finalizeVirtualRouterRouteHostEffectsJson', { result, plan })
  ));
  if (parsed === null || typeof parsed === 'undefined') {
    return;
  }
  if (typeof parsed !== 'string') {
    throw new Error('[hub-pipeline-handle-direct-native] finalizeVirtualRouterRouteHostEffectsJson returned invalid payload');
  }
  console.log(parsed);
}

function routeHubPipelineVirtualRouter(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  const routeHostEffectsPlan = planVirtualRouterRouteHostEffects(request, metadata);
  const parsed = parseNativeRecord(
    'hubPipelineVirtualRouterRouteJson',
    nativeFn('hubPipelineVirtualRouterRouteJson')(
      handle,
      stringifyNativePayload('hubPipelineVirtualRouterRouteJson', request),
      stringifyNativePayload('hubPipelineVirtualRouterRouteJson', injectVirtualRouterRuntimeMetadata(metadata))
    )
  );
  finalizeVirtualRouterRouteHostEffects(parsed, routeHostEffectsPlan);
  const cleanedRequest = routeHostEffectsPlan.cleanedRequest;
  if (cleanedRequest && typeof cleanedRequest === 'object' && !Array.isArray(cleanedRequest)) {
    for (const key of Object.keys(request)) {
      delete request[key];
    }
    Object.assign(request, cleanedRequest as AnyRecord);
  }
  return parsed;
}

function diagnoseHubPipelineVirtualRouter(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  return parseNativeRecord(
    'hubPipelineVirtualRouterDiagnoseRouteJson',
    nativeFn('hubPipelineVirtualRouterDiagnoseRouteJson')(
      handle,
      stringifyNativePayload('hubPipelineVirtualRouterDiagnoseRouteJson', request),
      stringifyNativePayload('hubPipelineVirtualRouterDiagnoseRouteJson', metadata)
    )
  );
}

function getHubPipelineVirtualRouterStatus(handle: string): AnyRecord {
  return parseNativeRecord(
    'hubPipelineVirtualRouterStatusJson',
    nativeFn('hubPipelineVirtualRouterStatusJson')(handle)
  );
}

function markHubPipelineVirtualRouterConcurrencyScopeBusy(handle: string, scopeKey: string): void {
  nativeFn('hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson')(handle, String(scopeKey ?? ''));
}

function disposeHubPipelineHandle(handle: string): void {
  if (!handle) {
    return;
  }
  nativeFn('disposeHubPipelineEngineJson')(handle);
}

export class DirectNativeHubPipelineTestWrapper {
  private readonly handle: string;

  constructor(config: AnyRecord) {
    this.handle = createHubPipelineHandle(config);
  }

  getNativeHandle(): string {
    return this.handle;
  }

  async execute(request: AnyRecord): Promise<AnyRecord> {
    return executeHubPipelineHandle(this.handle, request);
  }

  updateRuntimeDeps(deps: AnyRecord): void {
    updateHubPipelineEngineDeps(this.handle, deps);
  }

  updateVirtualRouterConfig(config: AnyRecord): void {
    updateHubPipelineVirtualRouterConfig(this.handle, config);
  }

  getVirtualRouter(): {
    route: (request: AnyRecord, metadata: AnyRecord) => AnyRecord;
    diagnoseRoute: (request: AnyRecord, metadata: AnyRecord) => AnyRecord;
    getStatus: () => AnyRecord;
    markConcurrencyScopeBusy: (scopeKey: string) => void;
  } {
    return {
      route: (request, metadata) => routeHubPipelineVirtualRouter(this.handle, request, metadata),
      diagnoseRoute: (request, metadata) => diagnoseHubPipelineVirtualRouter(this.handle, request, metadata),
      getStatus: () => getHubPipelineVirtualRouterStatus(this.handle),
      markConcurrencyScopeBusy: (scopeKey) =>
        markHubPipelineVirtualRouterConcurrencyScopeBusy(this.handle, scopeKey),
    };
  }

  dispose(): void {
    disposeHubPipelineHandle(this.handle);
  }
}

import {
  createHubPipelineNative,
  disposeHubPipelineNative,
  executeHubPipelineNative,
  updateHubPipelineEngineDepsNative,
  updateHubPipelineVirtualRouterConfigNative,
  routeHubPipelineVirtualRouterNative,
  diagnoseHubPipelineVirtualRouterNative,
  getHubPipelineVirtualRouterStatusNative,
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative,
} from '../../src/modules/llmswitch/bridge/routing-integrations.js';

type AnyRecord = Record<string, unknown>;

export class NativeHubPipelineTestWrapper {
  private readonly handle: string;

  constructor(config: AnyRecord) {
    this.handle = createHubPipelineNative(config);
  }

  async execute(request: AnyRecord): Promise<AnyRecord> {
    return executeHubPipelineNative(this.handle, request);
  }

  updateRuntimeDeps(deps: AnyRecord): void {
    updateHubPipelineEngineDepsNative(this.handle, deps);
  }

  updateVirtualRouterConfig(config: AnyRecord): void {
    updateHubPipelineVirtualRouterConfigNative(this.handle, config);
  }

  getVirtualRouter(): {
    route: (request: AnyRecord, metadata: AnyRecord) => AnyRecord;
    diagnoseRoute: (request: AnyRecord, metadata: AnyRecord) => AnyRecord;
    getStatus: () => AnyRecord;
    markConcurrencyScopeBusy: (scopeKey: string) => void;
  } {
    return {
      route: (request, metadata) => routeHubPipelineVirtualRouterNative(this.handle, request, metadata),
      diagnoseRoute: (request, metadata) => diagnoseHubPipelineVirtualRouterNative(this.handle, request, metadata),
      getStatus: () => getHubPipelineVirtualRouterStatusNative(this.handle),
      markConcurrencyScopeBusy: (scopeKey) =>
        markHubPipelineVirtualRouterConcurrencyScopeBusyNative(this.handle, scopeKey),
    };
  }

  dispose(): void {
    disposeHubPipelineNative(this.handle);
  }
}

export async function getNativeHubPipelineTestCtor(): Promise<typeof NativeHubPipelineTestWrapper> {
  return NativeHubPipelineTestWrapper;
}

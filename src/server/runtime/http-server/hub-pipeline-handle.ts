import {
  diagnoseHubPipelineVirtualRouterNative,
  getHubPipelineVirtualRouterStatusNative,
  routeHubPipelineVirtualRouterNative,
} from '../../../modules/llmswitch/bridge/routing-integrations.js';

export type HubPipelineNativeHandle = string;

export interface HubPipelineVirtualRouterFacade {
  route(request: Record<string, unknown>, metadata: Record<string, unknown>): unknown;
  getStatus(): unknown;
  diagnoseRoute(request: Record<string, unknown>, metadata: Record<string, unknown>): unknown;
}

export interface HubPipelineRuntimeHandle {
  handle: HubPipelineNativeHandle;
  getVirtualRouter(): HubPipelineVirtualRouterFacade;
}

export type HubPipelineHandle = HubPipelineNativeHandle | HubPipelineRuntimeHandle;

export function readHubPipelineNativeHandle(pipeline: unknown): string | null {
  if (typeof pipeline === 'string' && pipeline.trim()) {
    return pipeline;
  }
  if (pipeline && typeof pipeline === 'object' && !Array.isArray(pipeline)) {
    const handle = (pipeline as Record<string, unknown>).handle;
    if (typeof handle === 'string' && handle.trim()) {
      return handle;
    }
  }
  return null;
}

export function createHubPipelineRuntimeHandle(handle: string): HubPipelineRuntimeHandle {
  const nativeHandle = handle.trim();
  return {
    handle: nativeHandle,
    getVirtualRouter(): HubPipelineVirtualRouterFacade {
      return createNativeVirtualRouterFacade(nativeHandle);
    },
  };
}

export function readHubPipelineVirtualRouter(pipeline: unknown): HubPipelineVirtualRouterFacade | null {
  const handle = readHubPipelineNativeHandle(pipeline);
  if (pipeline && typeof pipeline === 'object' && !Array.isArray(pipeline)) {
    const getter = (pipeline as Record<string, unknown>).getVirtualRouter;
    if (typeof getter === 'function') {
      const virtualRouter = getter.call(pipeline);
      const facade = coerceVirtualRouterFacade(virtualRouter, handle);
      if (facade) {
        return facade;
      }
    }
  }
  return handle ? createNativeVirtualRouterFacade(handle) : null;
}

function createNativeVirtualRouterFacade(handle: string): HubPipelineVirtualRouterFacade {
  return {
    route(request: Record<string, unknown>, metadata: Record<string, unknown>): unknown {
      return routeHubPipelineVirtualRouterNative(handle, request, metadata);
    },
    getStatus(): unknown {
      return getHubPipelineVirtualRouterStatusNative(handle);
    },
    diagnoseRoute(request: Record<string, unknown>, metadata: Record<string, unknown>): unknown {
      return diagnoseHubPipelineVirtualRouterNative(handle, request, metadata);
    },
  };
}

function coerceVirtualRouterFacade(value: unknown, handle: string | null): HubPipelineVirtualRouterFacade | null {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (typeof (value as Record<string, unknown>).route !== 'function'
      && typeof (value as Record<string, unknown>).getStatus !== 'function'
      && typeof (value as Record<string, unknown>).diagnoseRoute !== 'function')
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const nativeFacade = handle ? createNativeVirtualRouterFacade(handle) : null;
  const routeFn = typeof record.route === 'function' ? record.route : null;
  const getStatusFn = typeof record.getStatus === 'function' ? record.getStatus : null;
  const diagnoseRouteFn = typeof record.diagnoseRoute === 'function' ? record.diagnoseRoute : null;
  return {
    route: routeFn
      ? (request: Record<string, unknown>, metadata: Record<string, unknown>) => routeFn.call(value, request, metadata)
      : (request: Record<string, unknown>, metadata: Record<string, unknown>) => {
          if (nativeFacade) {
            return nativeFacade.route(request, metadata);
          }
          throw new Error('VirtualRouter.route is not available');
        },
    getStatus: getStatusFn
      ? () => getStatusFn.call(value)
      : () => {
          if (nativeFacade) {
            return nativeFacade.getStatus();
          }
          throw new Error('VirtualRouter.getStatus is not available');
        },
    diagnoseRoute: diagnoseRouteFn
      ? (request: Record<string, unknown>, metadata: Record<string, unknown>) => diagnoseRouteFn.call(value, request, metadata)
      : (request: Record<string, unknown>, metadata: Record<string, unknown>) => {
          if (nativeFacade) {
            return nativeFacade.diagnoseRoute(request, metadata);
          }
          throw new Error('VirtualRouter.diagnoseRoute is not available');
        },
  };
}

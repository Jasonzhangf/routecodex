import { getRouterHotpathJsonBindingSync } from './native-exports.js';

// Rust canonical builders: plan_direct_route_request_hooks_json,
// plan_direct_route_model_observation_effects_json,
// rewrite_direct_route_response_model_json, rewrite_direct_route_sse_frame_json.
import {
  assertNativeObject,
  callNativeJsonCapability,
} from './native-json-invoker.js';

type JsonObject = Record<string, unknown>;
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-model-hooks-host' };

export interface DirectRouteResolvedSemantics {
  semanticClass: 'routing' | 'passthrough';
  selectedProviderKey?: string;
  selectedRuntimeKey?: string;
  configuredModelId?: string;
  requestModel?: string;
  routeThinking?: string;
  requestThinking?: string;
  originalClientModel?: string;
}

export function resolveDirectSemanticClassificationNative(input: unknown): DirectRouteResolvedSemantics {
  return assertNativeObject(
    'resolveDirectSemanticClassificationJson',
    callNativeJsonCapability(getBinding, 'resolveDirectSemanticClassificationJson', [input], options),
    options,
  ) as unknown as DirectRouteResolvedSemantics;
}

export function planDirectRouteRequestHooksNative(input: unknown): {
  payload: JsonObject;
  originalClientModel?: string;
  providerModelId?: string;
  payloadChanged: boolean;
  resolvedSemantics: DirectRouteResolvedSemantics;
} {
  return assertNativeObject(
    'planDirectRouteRequestHooksJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteRequestHooksJson', [input], options),
    options,
  ) as {
    payload: JsonObject;
    originalClientModel?: string;
    providerModelId?: string;
    payloadChanged: boolean;
    resolvedSemantics: DirectRouteResolvedSemantics;
  };
}

export interface DirectRouteModelObservationEffect {
  family: 'provider_observation';
  key: 'clientModelId' | 'assignedModelId';
  value: string;
  reason: string;
}

export function planDirectRouteModelObservationEffectsNative(input: {
  originalClientModel?: string;
  providerModelId?: string;
}): { originalClientModel?: string; writes: DirectRouteModelObservationEffect[] } {
  return assertNativeObject(
    'planDirectRouteModelObservationEffectsJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteModelObservationEffectsJson', [input], options),
    options,
  ) as unknown as { originalClientModel?: string; writes: DirectRouteModelObservationEffect[] };
}

export function rewriteDirectRouteResponseModelNative(value: unknown, clientModel: string): unknown {
  return callNativeJsonCapability(getBinding, 'rewriteDirectRouteResponseModelJson', [{ value, clientModel }], options);
}

export function rewriteDirectRouteSseFrameNative(frame: string, clientModel: string): string {
  return callNativeJsonCapability(getBinding, 'rewriteDirectRouteSseFrameJson', [{ frame, clientModel }], options);
}

export function projectDirectRouteSseHeadersNative(headers: unknown): Record<string, string> {
  return assertNativeObject(
    'projectDirectRouteSseHeadersJson',
    callNativeJsonCapability(getBinding, 'projectDirectRouteSseHeadersJson', [headers], options),
    options,
  ) as Record<string, string>;
}

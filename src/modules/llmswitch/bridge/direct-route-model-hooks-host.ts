import { getRouterHotpathJsonBindingSync } from './native-exports.js';

// Rust canonical builders: plan_direct_route_request_hooks_json,
// rewrite_direct_route_response_model_json, rewrite_direct_route_sse_frame_json.
import {
  assertNativeObject,
  callNativeJsonCapability,
} from './native-json-invoker.js';

type JsonObject = Record<string, unknown>;
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-model-hooks-host' };

export function planDirectRouteRequestHooksNative(input: unknown): {
  payload: JsonObject;
  originalClientModel?: string;
  providerModelId?: string;
  payloadChanged: boolean;
} {
  return assertNativeObject(
    'planDirectRouteRequestHooksJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteRequestHooksJson', [input], options),
    options,
  ) as { payload: JsonObject; originalClientModel?: string; providerModelId?: string; payloadChanged: boolean };
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

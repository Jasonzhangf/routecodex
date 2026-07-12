import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: hub.router_direct_response_error_projection
// Rust canonical builder: plan_direct_route_response_error_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-response-error-host' };

export interface DirectRouteResponseErrorPlan {
  shouldRaise: boolean;
  message?: string;
  status?: number;
  statusCode?: number;
  code?: string;
}

export function planDirectRouteResponseErrorNative(status: number | undefined): DirectRouteResponseErrorPlan {
  return assertNativeObject(
    'planDirectRouteResponseErrorJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteResponseErrorJson', [{ status }], options),
    options,
  ) as DirectRouteResponseErrorPlan;
}

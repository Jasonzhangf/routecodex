import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: hub.router_direct_response_action_plan
// Rust canonical builder: plan_direct_route_response_action_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-response-action-host' };

export interface DirectRouteResponseActionPlan {
  action: 'passthrough' | 'project_json_model' | 'project_sse_headers_only' | 'project_sse_headers_and_model_stream';
  clientModel?: string;
}

export function planDirectRouteResponseActionNative(input: unknown): DirectRouteResponseActionPlan {
  return assertNativeObject(
    'planDirectRouteResponseActionJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteResponseActionJson', [input], options),
    options,
  ) as unknown as DirectRouteResponseActionPlan;
}

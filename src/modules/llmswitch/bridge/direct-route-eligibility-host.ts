import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: hub.router_direct_eligibility_plan
// Rust canonical builder: plan_direct_route_eligibility_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-eligibility-host' };

export interface DirectRouteEligibilityPlan {
  action: 'skip' | 'resolve_provider' | 'execute_direct';
  effectiveBehavior: 'direct' | 'relay' | string;
  eligible: boolean;
  reason?: string;
}

export function planDirectRouteEligibilityNative(input: unknown): DirectRouteEligibilityPlan {
  return assertNativeObject(
    'planDirectRouteEligibilityJson',
    callNativeJsonCapability(getBinding, 'planDirectRouteEligibilityJson', [input], options),
    options,
  ) as unknown as DirectRouteEligibilityPlan;
}

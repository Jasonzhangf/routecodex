import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: hub.router_direct_audit_projection
// Rust canonical builder: project_direct_route_audit_fields_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'direct-route-audit-projection-host' };

export function projectDirectRouteAuditFieldsNative(payload: unknown): {
  observedFields: Array<{ field: string; value: unknown }>;
} {
  return assertNativeObject(
    'projectDirectRouteAuditFieldsJson',
    callNativeJsonCapability(getBinding, 'projectDirectRouteAuditFieldsJson', [{ payload }], options),
    options,
  ) as { observedFields: Array<{ field: string; value: unknown }> };
}

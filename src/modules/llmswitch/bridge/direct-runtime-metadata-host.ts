import { getRouterHotpathJsonBindingSync } from './native-exports.js';

// Rust canonical builders: build_router_direct_route_metadata_json,
// build_direct_provider_runtime_metadata_json. This host performs transport only.

type JsonObject = Record<string, unknown>;

function stringifyGraphForNative(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (_key, current: unknown) {
    if (!current || typeof current !== 'object') {
      return current;
    }
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(current as object)) {
      return undefined;
    }
    ancestors.push(current as object);
    return current;
  }) ?? 'null';
}

function callProjection(capability: string, input: unknown): JsonObject {
  const fn = (getRouterHotpathJsonBindingSync() as Record<string, unknown>)[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[direct-runtime-metadata-host] ${capability} not available`);
  }
  const raw = (fn as (inputJson: string) => unknown)(stringifyGraphForNative(input));
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`[direct-runtime-metadata-host] ${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[direct-runtime-metadata-host] ${capability} returned non-object payload`);
  }
  return parsed as JsonObject;
}

export function buildRouterDirectRouteMetadataNative(input: unknown): JsonObject {
  return callProjection('buildRouterDirectRouteMetadataJson', input);
}

export function buildDirectProviderRuntimeMetadataNative(input: unknown): JsonObject {
  return callProjection('buildDirectProviderRuntimeMetadataJson', input);
}

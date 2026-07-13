import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: hub.provider_response_metadata_sync_effect_plan
// Rust canonical builder: plan_provider_response_metadata_sync_effect_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'provider-response-metadata-sync-host' };

export type ProviderResponseMetadataSyncWrite = {
  family: 'runtime_control' | 'debug_snapshot';
  key: string;
  value: unknown;
  reason: string;
  writer: { module: string; symbol: string; stage: string };
};

export type ProviderResponseMetadataSyncEffectPlan = {
  action: 'no_op' | 'bind_bridge_center' | 'apply_writes';
  writes: ProviderResponseMetadataSyncWrite[];
};

export function planProviderResponseMetadataSyncEffectNative(input: unknown): ProviderResponseMetadataSyncEffectPlan {
  return assertNativeObject(
    'planProviderResponseMetadataSyncEffectJson',
    callNativeJsonCapability(getBinding, 'planProviderResponseMetadataSyncEffectJson', [input], options),
    options,
  ) as unknown as ProviderResponseMetadataSyncEffectPlan;
}

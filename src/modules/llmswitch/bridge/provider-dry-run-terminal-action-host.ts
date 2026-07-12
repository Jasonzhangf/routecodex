import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import { assertNativeObject, callNativeJsonCapability } from './native-json-invoker.js';

// feature_id: debug.pipeline_dry_run_terminal_action_plan
// Rust canonical builder: plan_provider_dry_run_terminal_action_json.
const getBinding = getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>;
const options = { label: 'provider-dry-run-terminal-action-host' };

export interface ProviderDryRunTerminalActionPlan {
  action: 'return_dry_run_terminal' | 'continue_normal_response' | 'invalid_input';
}

export function planProviderDryRunTerminalActionNative(
  providerRequestDryRunResponseMarked: boolean,
): ProviderDryRunTerminalActionPlan {
  return assertNativeObject(
    'planProviderDryRunTerminalActionJson',
    callNativeJsonCapability(
      getBinding,
      'planProviderDryRunTerminalActionJson',
      [{ providerRequestDryRunResponseMarked }],
      options,
    ),
    options,
  ) as unknown as ProviderDryRunTerminalActionPlan;
}

import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type VirtualRouterBootstrapInput,
  type VirtualRouterBootstrapResult
} from './virtual-router-contracts.js';
import { parseVirtualRouterNativeError } from './native-router-hotpath-loader.js';
import { isNativeDisabledByEnv, makeNativeRequiredError } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';

function requireNativeBootstrapConfigFunction(): (inputJson: string) => unknown {
  const exportName = 'bootstrapVirtualRouterConfigJson';
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(exportName, 'native disabled');
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(exportName);
  }
  return fn as (inputJson: string) => unknown;
}

export function bootstrapVirtualRouterConfig(
  input: VirtualRouterBootstrapInput
): VirtualRouterBootstrapResult {
  const fn = requireNativeBootstrapConfigFunction();
  let raw: unknown;
  try {
    raw = fn(JSON.stringify(input ?? {}));
  } catch (error) {
    const virtualRouterError = parseVirtualRouterNativeError(error);
    if (virtualRouterError) throw virtualRouterError;
    throw error;
  }
  const returnedVirtualRouterError = parseVirtualRouterNativeError(raw);
  if (returnedVirtualRouterError) {
    throw returnedVirtualRouterError;
  }
  if (typeof raw !== 'string' || !raw) {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned empty payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  try {
    return JSON.parse(raw) as VirtualRouterBootstrapResult;
  } catch {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
}

import type { UnknownObject } from '../../../types/common-types.js';
import type { RouteCodexRuntimeConfigManifest } from '../../../config/user-config-loader.js';

const ROUTECODEX_RUNTIME_MANIFEST_SYMBOL = Symbol.for('routecodex.runtimeConfigManifest');

export type RouterBootstrapInputWithRuntimeManifest = UnknownObject & {
  [ROUTECODEX_RUNTIME_MANIFEST_SYMBOL]?: RouteCodexRuntimeConfigManifest;
};

export function getRuntimeConfigManifestFromBootstrapInput(
  routerInput: unknown
): RouteCodexRuntimeConfigManifest | undefined {
  if (!routerInput || typeof routerInput !== 'object') return undefined;
  return (routerInput as RouterBootstrapInputWithRuntimeManifest)[ROUTECODEX_RUNTIME_MANIFEST_SYMBOL];
}

export function attachRuntimeConfigManifest(
  routerInput: UnknownObject,
  manifest: RouteCodexRuntimeConfigManifest
): UnknownObject {
  Object.defineProperty(routerInput, ROUTECODEX_RUNTIME_MANIFEST_SYMBOL, {
    value: manifest,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return routerInput;
}

/**
 * Request executor pipeline-attempt bridge surface.
 *
 * Route-pool normalization stays native-owned; this host only exposes the
 * narrow calls used by the request executor attempt shell.
 */

export {
  mergeObservedRoutePoolChainNative,
  normalizeExplicitRoutePoolNative,
} from './native-exports.js';

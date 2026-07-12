/**
 * Virtual Router route-availability bridge surface.
 *
 * Route availability and default-floor policy remain Rust-owned; this host only
 * exposes the native decisions consumed by HTTP executor shells.
 */
export {
  evaluateSingletonRoutePoolExhaustionNative,
  planPrimaryExhaustedToDefaultPoolNative,
  resolveErrorErr05RouteAvailabilityDecisionNative,
} from './native-exports.js';

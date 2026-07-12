/**
 * Hub/Virtual Router native bridge surface.
 *
 * Routing integrations use this owner host for Hub Pipeline and Virtual Router
 * native capabilities; route selection truth remains Rust-owned.
 */

export {
  buildRequestStageRuntimeControlWritePlanNative,
  getRouterHotpathJsonBindingSync,
  resolveEntryProtocolFromEndpointNative,
} from './native-exports.js';

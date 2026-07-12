/**
 * Provider outbound sanitize bridge surface.
 *
 * Provider wire payload sanitization remains Rust-owned; this host only
 * exposes the native capability consumed by HTTP provider transport.
 */

export {
  normalizeResponsesDirectCurrentRequestPayload,
  sanitizeProviderOutboundPayload,
} from './native-exports.js';

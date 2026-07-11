/**
 * MiMo Web text-tool harvest bridge surface.
 *
 * Tool-call extraction remains Rust-owned; this host only exposes the native
 * capability consumed by the MiMo Web provider runtime.
 */

export { normalizeAssistantTextToToolCallsJson } from './native-exports.js';

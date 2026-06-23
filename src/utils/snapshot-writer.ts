/**
 * M3 thin shell: server snapshot APIs delegate to the unified debug snapshot surface.
 * This file must not contain direct fs writes, hook bridge calls, or path logic.
 * Owner: debug.unified_surface -> src/debug/snapshot/server-writer.ts
 */
export * from '../debug/snapshot/server-writer.js';

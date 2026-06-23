/**
 * M4 thin shell: provider snapshot APIs delegate to the unified debug snapshot surface.
 * This file must not contain direct fs writes, queue state, hook bridge calls, or path logic.
 * Owner: debug.unified_surface -> src/debug/snapshot/provider-writer.ts
 */
export * from '../../../debug/snapshot/provider-writer.js';

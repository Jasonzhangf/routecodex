/**
 * RouteCodex hub entry exports.
 *
 * Keep the root package entry metadata-only. Runtime native facades must be
 * imported by their owning subpath so public barrels do not keep TS shells alive.
 */

export type * from './native/router-hotpath/virtual-router-contracts.js';
export const VERSION = '0.4.0';

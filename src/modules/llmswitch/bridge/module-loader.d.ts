/**
 * Module Loader
 *
 * Core module loading utilities for the single llmswitch-core dist surface.
 */
import { resolveCoreModulePath } from '../core-loader.js';
type AnyRecord = Record<string, unknown>;
declare function importCoreDist<TModule extends object = AnyRecord>(subpath: string): Promise<TModule>;
declare function requireCoreDist<TModule extends object = AnyRecord>(subpath: string): TModule;
export { resolveCoreModulePath, importCoreDist, requireCoreDist };
export type { AnyRecord };

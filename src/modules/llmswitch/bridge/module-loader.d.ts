/**
 * Module Loader
 *
 * Core module loading utilities with ts/engine implementation selection.
 */
import { resolveCoreModulePath } from '../core-loader.js';
import type { LlmsImpl } from '../core-loader.js';
type AnyRecord = Record<string, unknown>;
declare function parsePrefixList(raw: string | undefined): string[];
declare function matchesPrefix(subpath: string, prefixes: string[]): boolean;
declare function isEngineEnabled(): boolean;
declare function getEnginePrefixes(): string[];
declare function resolveImplForSubpath(subpath: string): LlmsImpl;
declare function importCoreDist<TModule extends object = AnyRecord>(subpath: string, impl?: LlmsImpl): Promise<TModule>;
declare function requireCoreDist<TModule extends object = AnyRecord>(subpath: string, impl?: LlmsImpl): TModule;
export { parsePrefixList, matchesPrefix, isEngineEnabled, getEnginePrefixes, resolveImplForSubpath, resolveCoreModulePath, importCoreDist, requireCoreDist };
export type { AnyRecord, LlmsImpl };

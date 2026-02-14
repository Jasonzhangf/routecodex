/**
 * Module Loader
 *
 * Core module loading utilities with ts/engine implementation selection.
 */

import { createRequire } from 'module';
import {
  importCoreModule,
  resolveCoreModulePath
} from '../core-loader.js';
import type { LlmsImpl } from '../core-loader.js';

type AnyRecord = Record<string, unknown>;

const require = createRequire(import.meta.url);

function parsePrefixList(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\/*/, '').replace(/\/+$/, ''));
}

function matchesPrefix(subpath: string, prefixes: string[]): boolean {
  if (!prefixes.length) {
    return false;
  }
  const normalized = subpath.replace(/^\/*/, '').replace(/\.js$/i, '');
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isEngineEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_LLMS_ENGINE_ENABLE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getEnginePrefixes(): string[] {
  return parsePrefixList(process.env.ROUTECODEX_LLMS_ENGINE_PREFIXES);
}

function resolveImplForSubpath(subpath: string): LlmsImpl {
  if (!isEngineEnabled()) {
    return 'ts';
  }
  const enginePrefixes = getEnginePrefixes();
  if (matchesPrefix(subpath, enginePrefixes)) {
    return 'engine';
  }
  return 'ts';
}

async function importCoreDist<TModule extends object = AnyRecord>(
  subpath: string,
  impl: LlmsImpl = resolveImplForSubpath(subpath)
): Promise<TModule> {
  try {
    return await importCoreModule<TModule>(subpath, impl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const pkg = impl === 'engine' ? '@jsonstudio/llms-engine' : '@jsonstudio/llms';
    throw new Error(
      `[llmswitch-bridge] Unable to load core module "${subpath}" (${impl}). 请确认 ${pkg} 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`
    );
  }
}

function requireCoreDist<TModule extends object = AnyRecord>(
  subpath: string,
  impl: LlmsImpl = resolveImplForSubpath(subpath)
): TModule {
  if (impl === 'engine' && !isEngineEnabled()) {
    throw new Error('[llmswitch-bridge] ROUTECODEX_LLMS_ENGINE_ENABLE must be enabled to load engine core');
  }
  const modulePath = resolveCoreModulePath(subpath, impl);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as TModule;
}

export {
  parsePrefixList,
  matchesPrefix,
  isEngineEnabled,
  getEnginePrefixes,
  resolveImplForSubpath,
  importCoreDist,
  requireCoreDist
};

export type { AnyRecord, LlmsImpl };

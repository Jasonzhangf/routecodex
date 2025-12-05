import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { CompatibilityModuleFactory } from './compatibility-factory.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { CompatibilityModule } from './compatibility-interface.js';

const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export function resolveCompatSearchDirs(): string[] {
  const env = process.env.ROUTECODEX_COMPAT_DIRS || process.env.ROUTECODEX_COMPAT_PATH || '';
  const envDirs = env
    .split(path.delimiter)
    .map(dir => dir.trim())
    .filter(Boolean)
    .map(expandHome);
  const defaults = [path.join(os.homedir(), '.routecodex', 'compat')];
  const combined = [...envDirs, ...defaults];
  const deduped: string[] = [];
  for (const dir of combined) {
    if (!dir) {
      continue;
    }
    if (!deduped.includes(dir)) {
      deduped.push(dir);
    }
  }
  return deduped;
}

export async function loadCompatibilityModulesFromDirs(
  dirs: string[],
  logger?: ModuleDependencies['logger']
): Promise<void> {
  for (const dir of dirs) {
    try {
      await registerModulesInDir(dir, logger);
    } catch (error) {
      logger?.logError?.(error as Error, { component: 'compat-directory-loader', dir });
    }
  }
}

async function registerModulesInDir(dir: string, logger?: ModuleDependencies['logger']): Promise<void> {
  if (!dir) {
    return;
  }
  let stats;
  try {
    stats = await fs.stat(dir);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  const files = await fs.readdir(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const ext = path.extname(fullPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      continue;
    }
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      await registerModuleExport(mod, logger, fullPath);
    } catch (error) {
      logger?.logError?.(error as Error, { component: 'compat-module-import', file: fullPath });
    }
  }
}

type CompatibilityModuleCtor = new (dependencies: ModuleDependencies) => CompatibilityModule;

interface CompatibilityModuleExportShape {
  type?: string;
  module?: CompatibilityModuleCtor;
}

interface CompatibilityModuleNamespace {
  register?: (factory: typeof CompatibilityModuleFactory) => void;
  registerCompatibility?: (factory: typeof CompatibilityModuleFactory) => void;
  default?: CompatibilityModuleExportShape;
  compatibilities?: CompatibilityModuleExportShape[];
  type?: string;
  module?: CompatibilityModuleCtor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCompatibilityModuleNamespace(value: unknown): value is CompatibilityModuleNamespace {
  return isRecord(value);
}

function isExportShape(shape: unknown): shape is CompatibilityModuleExportShape {
  if (!isRecord(shape)) {
    return false;
  }
  const type = typeof shape.type === 'string' ? shape.type.trim() : '';
  return Boolean(type && typeof shape.module === 'function');
}

function collectExportShapes(namespace: CompatibilityModuleNamespace): CompatibilityModuleExportShape[] {
  const shapes: CompatibilityModuleExportShape[] = [];
  if (Array.isArray(namespace.compatibilities)) {
    for (const compat of namespace.compatibilities) {
      if (isExportShape(compat)) {
        shapes.push(compat);
      }
    }
  }
  if (isExportShape(namespace.default)) {
    shapes.push(namespace.default);
  }
  if (isExportShape(namespace)) {
    shapes.push({ type: namespace.type, module: namespace.module });
  }
  return shapes;
}

async function registerModuleExport(
  mod: unknown,
  logger: ModuleDependencies['logger'] | undefined,
  source: string
): Promise<void> {
  if (!isCompatibilityModuleNamespace(mod)) {
    return;
  }
  const factory = CompatibilityModuleFactory;
  try {
    if (typeof mod.registerCompatibility === 'function') {
      mod.registerCompatibility(factory);
      return;
    }
    if (typeof mod.register === 'function') {
      mod.register(factory);
      return;
    }
    const exportShapes = collectExportShapes(mod);
    for (const entry of exportShapes) {
      const type = typeof entry.type === 'string' ? entry.type.trim() : '';
      const moduleCtor = entry.module;
      if (!type || typeof moduleCtor !== 'function') {
        logger?.logError?.(new Error('Invalid compatibility module export'), {
          component: 'compat-module-register',
          source
        });
        continue;
      }
      factory.registerModuleType(type, moduleCtor);
    }
  } catch (error) {
    logger?.logError?.(error as Error, { component: 'compat-module-register', source });
  }
}

function expandHome(input: string): string {
  if (!input.startsWith('~/')) {
    return input;
  }
  return path.join(os.homedir(), input.slice(2));
}

export async function registerCompatibilityModuleForTest(exported: unknown): Promise<void> {
  await registerModuleExport(exported, undefined, 'test');
}

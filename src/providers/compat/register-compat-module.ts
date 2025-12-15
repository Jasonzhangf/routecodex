import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { CompatibilityModule } from './compatibility-interface.js';

type CompatibilityModuleCtor = new (dependencies: ModuleDependencies) => CompatibilityModule;

export interface CompatibilityModuleFactoryLike {
  registerModuleType(type: string, moduleClass: CompatibilityModuleCtor): void;
}

interface CompatibilityModuleExportShape {
  type?: string;
  module?: CompatibilityModuleCtor;
}

interface CompatibilityModuleNamespace {
  register?: (factory: CompatibilityModuleFactoryLike) => void;
  registerCompatibility?: (factory: CompatibilityModuleFactoryLike) => void;
  default?: CompatibilityModuleExportShape;
  compatibilities?: CompatibilityModuleExportShape[];
  type?: string;
  module?: CompatibilityModuleCtor;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isCompatibilityModuleNamespace(value: unknown): value is CompatibilityModuleNamespace {
  return isRecord(value);
}

function isExportShape(value: unknown): value is CompatibilityModuleExportShape {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.module === 'function' && typeof value.type === 'string' && value.type.trim().length > 0;
}

function collectExportShapes(namespace: CompatibilityModuleNamespace): CompatibilityModuleExportShape[] {
  const shapes: CompatibilityModuleExportShape[] = [];
  if (Array.isArray(namespace.compatibilities)) {
    for (const entry of namespace.compatibilities) {
      if (isExportShape(entry)) {
        shapes.push(entry);
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

export function registerCompatibilityNamespace(
  factory: CompatibilityModuleFactoryLike,
  namespace: unknown,
  source: string,
  logger?: ModuleDependencies['logger']
): void {
  if (!isCompatibilityModuleNamespace(namespace)) {
    return;
  }

  if (typeof namespace.registerCompatibility === 'function') {
    namespace.registerCompatibility(factory);
    return;
  }

  if (typeof namespace.register === 'function') {
    namespace.register(factory);
    return;
  }

  const exportShapes = collectExportShapes(namespace);
  for (const entry of exportShapes) {
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    if (!type || typeof entry.module !== 'function') {
      logger?.logError?.(new Error('Invalid compatibility module export'), {
        component: 'compat-module-register',
        source
      });
      continue;
    }
    factory.registerModuleType(type, entry.module);
  }
}

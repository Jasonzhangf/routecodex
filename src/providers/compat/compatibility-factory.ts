import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompatibilityModule } from './compatibility-interface.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from './compatibility-interface.js';
import { registerCompatibilityNamespace } from './register-compat-module.js';

/**
 * 兼容性模块配置接口
 * 兼容现有的RouteCodex配置文件格式
 */
export interface CompatibilityModuleConfig {
  id: string;
  type: string;
  providerType: string;
  config?: UnknownObject;
  // 兼容现有配置格式
  enabled?: boolean;
  priority?: number;
  profileId?: string;
  transformationProfile?: string;
  // Hook配置
  hookConfig?: {
    enabled: boolean;
    debugMode?: boolean;
    snapshotEnabled?: boolean;
  };
  // 其他兼容性配置
  [key: string]: unknown;
}

/**
 * 兼容性模块实例配置（运行时）
 */
export interface CompatibilityModuleInstance {
  id: string;
  config: CompatibilityModuleConfig;
  module: CompatibilityModule;
  context: CompatibilityContext;
  isInitialized: boolean;
}

/**
 * 兼容性模块工厂
 * 用于创建和管理不同类型的兼容性模块
 */
const SUPPORTED_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const DEFAULT_COMPAT_DIR = path.join(os.homedir(), '.routecodex', 'compat');
const BUILTIN_PROFILE_ROOT = fileURLToPath(new URL('./profiles/', import.meta.url));

export class CompatibilityModuleFactory {
  private static readonly moduleRegistry = new Map<string, new (dependencies: ModuleDependencies) => CompatibilityModule>();
  private static readonly loadingTasks = new Map<string, Promise<void>>();

  /**
   * 注册兼容性模块类型
   */
  static registerModuleType(type: string, moduleClass: new (dependencies: ModuleDependencies) => CompatibilityModule): void {
    this.moduleRegistry.set(type, moduleClass);
  }

  /**
   * 创建兼容性模块实例
   */
  static async createModule(
    config: CompatibilityModuleConfig,
    dependencies: ModuleDependencies
  ): Promise<CompatibilityModule> {
    await this.ensureModuleTypeRegistered(config.type);
    const ModuleClass = this.moduleRegistry.get(config.type);

    if (!ModuleClass) {
      throw new Error(`Unknown compatibility module type: ${config.type}`);
    }

    const module = new ModuleClass(dependencies) as unknown as CompatibilityModule & { setConfig?: (cfg: unknown) => void };

    // 尝试将配置传入模块（若模块支持 setConfig 钩子）
    try {
      if (typeof module.setConfig === 'function') {
        module.setConfig(config as unknown);
      }
    } catch {
      // 安全忽略：模块不支持 setConfig 或者不需要配置注入
    }

    await module.initialize();

    return module;
  }

  /**
   * 获取已注册的模块类型列表
   */
  static getRegisteredTypes(): string[] {
    return Array.from(this.moduleRegistry.keys());
  }

  /**
   * 检查模块类型是否已注册
   */
  static isTypeRegistered(type: string): boolean {
    return this.moduleRegistry.has(type);
  }

  private static async ensureModuleTypeRegistered(type: string): Promise<void> {
    if (this.moduleRegistry.has(type)) {
      return;
    }
    if (!this.loadingTasks.has(type)) {
      this.loadingTasks.set(type, this.loadModuleType(type));
    }
    await this.loadingTasks.get(type);
  }

  private static async loadModuleType(type: string): Promise<void> {
    const [protocol, profile] = splitProfileIdentifier(type);
    if (!protocol || !profile) {
      throw new Error(
        `Unknown compatibility module type: ${type}. Expected "protocol:profile" identifier (e.g. "chat:glm").`
      );
    }
    const candidates = buildCandidatePaths(protocol, profile);
    for (const candidate of candidates) {
      const registered = await this.tryRegisterCandidate(candidate, type);
      if (registered) {
        return;
      }
    }
    throw new Error(`Unknown compatibility module type: ${type}`);
  }

  private static async tryRegisterCandidate(candidate: string, targetType: string): Promise<boolean> {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      registerCompatibilityNamespace(this, mod, candidate);
      return this.moduleRegistry.has(targetType);
    } catch {
      return false;
    }
  }
}

function splitProfileIdentifier(type: string): [string, string] {
  if (typeof type !== 'string') {
    return ['', ''];
  }
  const trimmed = type.trim();
  const idx = trimmed.indexOf(':');
  if (idx === -1) {
    return ['', ''];
  }
  const protocol = trimmed.slice(0, idx).trim();
  const profile = trimmed.slice(idx + 1).trim();
  if (!protocol || !profile) {
    return ['', ''];
  }
  return [sanitizeSegment(protocol), sanitizeSegment(profile)];
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
}

function buildCandidatePaths(protocol: string, profile: string): string[] {
  const paths: string[] = [];
  for (const ext of SUPPORTED_EXTENSIONS) {
    paths.push(path.join(BUILTIN_PROFILE_ROOT, protocol, profile, `index${ext}`));
  }
  const userDirs = resolveUserCompatDirs();
  for (const dir of userDirs) {
    paths.push(path.join(dir, protocol, `${profile}.js`));
    paths.push(path.join(dir, protocol, `${profile}.mjs`));
    paths.push(path.join(dir, protocol, `${profile}.cjs`));
    paths.push(path.join(dir, protocol, profile, 'index.js'));
    paths.push(path.join(dir, protocol, profile, 'index.mjs'));
    paths.push(path.join(dir, protocol, profile, 'index.cjs'));
  }
  return dedupe(paths);
}

function resolveUserCompatDirs(): string[] {
  const env = process.env.ROUTECODEX_COMPAT_DIRS || process.env.ROUTECODEX_COMPAT_PATH || '';
  const dirs = env
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(expandHome);
  dirs.push(expandHome(DEFAULT_COMPAT_DIR));
  return dedupe(dirs.filter(Boolean));
}

function expandHome(input: string): string {
  if (!input) {
    return input;
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Provider Hooks - Provider特定处理钩子
 *
 * 提供配置驱动的特殊处理机制，避免硬编码
 */

import type { ProviderContext, ServiceProfile } from '../api/provider-types.js';

/**
 * 字段注入钩子接口 - 只做字段级别的修改
 */
export interface FieldInjector {
  /** 注入器名称 */
  name: string;

  /** 注入目标类型 */
  target: 'request' | 'response' | 'headers';

  /** 字段注入规则 */
  inject: (data: Record<string, unknown>, context: ProviderContext) => Record<string, unknown>;

  /** 字段过滤规则 */
  filter?: (data: Record<string, unknown>, context: ProviderContext) => Record<string, unknown>;

  /** 字段转换规则 */
  transform?: (data: Record<string, unknown>, context: ProviderContext) => Record<string, unknown>;
}

/**
 * 验证钩子接口
 */
export interface ValidationHook {
  /** 验证器名称 */
  name: string;

  /** 验证目标类型 */
  target: 'request' | 'response';

  /** 验证函数 */
  validate: (data: Record<string, unknown>, context: ProviderContext) => {
    isValid: boolean;
    errors: string[];
    warnings?: string[];
  };
}

/**
 * Provider钩子配置 - 仅支持字段注入和验证
 */
export interface ProviderHooks {
  /** 字段注入器 */
  injectors?: FieldInjector[];

  /** 验证钩子 */
  validators?: ValidationHook[];
}

/**
 * Hook工厂接口
 */
export interface HookFactory {
  /** 工厂类型标识 */
  readonly providerType: string;

  /** 创建字段注入器 */
  createInjectors?(profile: ServiceProfile): FieldInjector[] | null;

  /** 创建验证钩子 */
  createValidators?(profile: ServiceProfile): ValidationHook[] | null;
}

/**
 * Hook注册器
 */
export class HookRegistry {
  private static factories = new Map<string, HookFactory>();
  private static hooks = new Map<string, ProviderHooks>();

  /**
   * 注册Hook工厂
   */
  static registerFactory(factory: HookFactory): void {
    if (!factory.providerType) {
      throw new Error('HookFactory must have a providerType');
    }
    this.factories.set(factory.providerType, factory);
  }

  /**
   * 获取Provider的Hooks
   */
  static getHooks(providerType: string, profile: ServiceProfile): ProviderHooks {
    // 检查是否已缓存
    const cacheKey = `${providerType}:${JSON.stringify(profile)}`;
    if (this.hooks.has(cacheKey)) {
      return this.hooks.get(cacheKey)!;
    }

    // 创建新的Hooks
    const factory = this.factories.get(providerType);
    const hooks: ProviderHooks = {};

    if (factory) {
      // 创建字段注入器
      if (factory.createInjectors) {
        const injectors = factory.createInjectors(profile);
        if (injectors && injectors.length > 0) {
          hooks.injectors = injectors;
        }
      }

      // 创建验证钩子
      if (factory.createValidators) {
        const validators = factory.createValidators(profile);
        if (validators && validators.length > 0) {
          hooks.validators = validators;
        }
      }
    }

    // 应用profile中的自定义hooks
    if (profile.hooks) {
      if (profile.hooks.injectors) {
        hooks.injectors = [...(hooks.injectors || []), ...profile.hooks.injectors];
      }
      if (profile.hooks.validators) {
        hooks.validators = [...(hooks.validators || []), ...profile.hooks.validators];
      }
    }

    // 缓存结果
    this.hooks.set(cacheKey, hooks);
    return hooks;
  }

  /**
   * 检查Provider是否有Hooks
   */
  static hasHooks(providerType: string): boolean {
    return this.factories.has(providerType);
  }

  /**
   * 获取Hook工厂
   */
  static getFactory(providerType: string): HookFactory | null {
    return this.factories.get(providerType) || null;
  }

  /**
   * 清理缓存
   */
  static clearCache(): void {
    this.hooks.clear();
  }

  /**
   * 获取所有已注册的provider类型
   */
  static getRegisteredTypes(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * 应用字段注入器到数据
   */
  static applyInjectors(data: Record<string, unknown>, target: 'request' | 'response' | 'headers', hooks: ProviderHooks, context: ProviderContext): Record<string, unknown> {
    let processed = { ...data };

    if (hooks.injectors) {
      for (const injector of hooks.injectors) {
        if (injector.target === target) {
          // 应用字段过滤
          if (injector.filter) {
            processed = injector.filter(processed, context);
          }

          // 应用字段转换
          if (injector.transform) {
            processed = injector.transform(processed, context);
          }

          // 应用字段注入
          processed = injector.inject(processed, context);
        }
      }
    }

    return processed;
  }

  /**
   * 应用验证钩子到数据
   */
  static applyValidators(data: Record<string, unknown>, target: 'request' | 'response', hooks: ProviderHooks, context: ProviderContext): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const results = {
      isValid: true,
      errors: [] as string[],
      warnings: [] as string[]
    };

    if (hooks.validators) {
      for (const validator of hooks.validators) {
        if (validator.target === target) {
          const validation = validator.validate(data, context);
          results.isValid = results.isValid && validation.isValid;
          results.errors.push(...validation.errors);
          if (validation.warnings) {
            results.warnings.push(...validation.warnings);
          }
        }
      }
    }

    return results;
  }

  /**
   * 自动注册Hook工厂 - 通过导入自动发现
   */
  static autoRegisterHookFactories(): void {
    // 这个方法可以在模块初始化时调用，自动发现并注册Hook工厂
    // 实际的Hook工厂会在各自文件中通过注册函数自动注册
  }
}


export default HookRegistry;
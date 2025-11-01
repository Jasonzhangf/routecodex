/**
 * Hook注册中心
 *
 * 负责Hook的注册、注销、查找和统计功能
 * 支持按阶段、目标、模块等多维度查找
 */

import type {
  IBidirectionalHook,
  UnifiedHookStage,
  HookTarget,
  IHookRegistry,
  HookRegistration
} from '../types/hook-types.js';

/**
 * Hook注册信息（内部使用）
 */
interface InternalHookRegistration extends HookRegistration {
  registeredAt: number;
  lastUsed?: number;
  usageCount: number;
}

/**
 * Hook注册中心实现
 */
export class HookRegistry implements IHookRegistry {
  private hooks: Map<string, InternalHookRegistration> = new Map();
  private hooksByStage: Map<UnifiedHookStage, Set<string>> = new Map();
  private hooksByTarget: Map<HookTarget, Set<string>> = new Map();
  private hooksByModule: Map<string, Set<string>> = new Map();

  /**
   * 注册Hook
   */
  register(hook: IBidirectionalHook, moduleId?: string): void {
    const hookName = hook.name;

    // 检查是否已注册
    if (this.hooks.has(hookName)) {
      throw new Error(`Hook already registered: ${hookName}`);
    }

    // 创建注册信息
    const registration: InternalHookRegistration = {
      hook,
      moduleId: moduleId || 'global',
      registeredAt: Date.now(),
      usageCount: 0
    };

    // 注册到主索引
    this.hooks.set(hookName, registration);

    // 注册到阶段索引
    if (!this.hooksByStage.has(hook.stage)) {
      this.hooksByStage.set(hook.stage, new Set());
    }
    this.hooksByStage.get(hook.stage)!.add(hookName);

    // 注册到目标索引
    if (!this.hooksByTarget.has(hook.target)) {
      this.hooksByTarget.set(hook.target, new Set());
    }
    this.hooksByTarget.get(hook.target)!.add(hookName);

    // 注册到模块索引
    if (!this.hooksByModule.has(moduleId || 'global')) {
      this.hooksByModule.set(moduleId || 'global', new Set());
    }
    this.hooksByModule.get(moduleId || 'global')!.add(hookName);

    console.log(`Hook registered: ${hookName} (${moduleId || 'global'})`);
  }

  /**
   * 注销Hook
   */
  unregister(hookName: string): void {
    const registration = this.hooks.get(hookName);
    if (!registration) {
      throw new Error(`Hook not found: ${hookName}`);
    }

    const { hook, moduleId } = registration;

    // 从主索引移除
    this.hooks.delete(hookName);

    // 从阶段索引移除
    const stageHooks = this.hooksByStage.get(hook.stage);
    if (stageHooks) {
      stageHooks.delete(hookName);
      if (stageHooks.size === 0) {
        this.hooksByStage.delete(hook.stage);
      }
    }

    // 从目标索引移除
    const targetHooks = this.hooksByTarget.get(hook.target);
    if (targetHooks) {
      targetHooks.delete(hookName);
      if (targetHooks.size === 0) {
        this.hooksByTarget.delete(hook.target);
      }
    }

    // 从模块索引移除
    const moduleHooks = this.hooksByModule.get(moduleId);
    if (moduleHooks) {
      moduleHooks.delete(hookName);
      if (moduleHooks.size === 0) {
        this.hooksByModule.delete(moduleId);
      }
    }

    console.log(`Hook unregistered: ${hookName}`);
  }

  /**
   * 按阶段和目标查找Hook
   */
  find(stage: UnifiedHookStage, target: HookTarget): IBidirectionalHook[] {
    const stageHooks = this.hooksByStage.get(stage) || new Set();
    const targetHooks = this.hooksByTarget.get(target) || new Set();

    // 取交集（同时匹配阶段和目标）
    const matchingHookNames = new Set(
      Array.from(stageHooks).filter(name => targetHooks.has(name))
    );

    const results: IBidirectionalHook[] = [];
    for (const hookName of matchingHookNames) {
      const registration = this.hooks.get(hookName);
      if (registration) {
        // 更新使用统计
        registration.usageCount++;
        registration.lastUsed = Date.now();
        results.push(registration.hook);
      }
    }

    // 按优先级排序
    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 按模块查找Hook
   */
  findByModule(moduleId: string): IBidirectionalHook[] {
    const moduleHooks = this.hooksByModule.get(moduleId) || new Set();
    const results: IBidirectionalHook[] = [];

    for (const hookName of moduleHooks) {
      const registration = this.hooks.get(hookName);
      if (registration) {
        results.push(registration.hook);
      }
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 获取所有Hook
   */
  getAll(): IBidirectionalHook[] {
    const results: IBidirectionalHook[] = [];

    for (const registration of this.hooks.values()) {
      results.push(registration.hook);
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 清除所有Hook
   */
  clear(): void {
    const hookCount = this.hooks.size;
    this.hooks.clear();
    this.hooksByStage.clear();
    this.hooksByTarget.clear();
    this.hooksByModule.clear();

    console.log(`All hooks cleared (${hookCount} hooks)`);
  }

  /**
   * 获取注册统计信息
   */
  getStats(): {
    totalHooks: number;
    hooksByStage: Record<string, number>;
    hooksByModule: Record<string, number>;
    hooksByTarget: Record<string, number>;
    usageStats: Array<{
      name: string;
      moduleId: string;
      usageCount: number;
      lastUsed?: number;
      registeredAt: number;
    }>;
  } {
    const hooksByStage: Record<string, number> = {};
    const hooksByModule: Record<string, number> = {};
    const hooksByTarget: Record<string, number> = {};

    // 统计按阶段分组的Hook数量
    for (const [stage, hookNames] of this.hooksByStage.entries()) {
      hooksByStage[stage] = hookNames.size;
    }

    // 统计按模块分组的Hook数量
    for (const [moduleId, hookNames] of this.hooksByModule.entries()) {
      hooksByModule[moduleId] = hookNames.size;
    }

    // 统计按目标分组的Hook数量
    for (const [target, hookNames] of this.hooksByTarget.entries()) {
      hooksByTarget[target] = hookNames.size;
    }

    // 使用统计
    const usageStats = Array.from(this.hooks.entries())
      .map(([name, registration]) => ({
        name,
        moduleId: registration.moduleId,
        usageCount: registration.usageCount,
        lastUsed: registration.lastUsed,
        registeredAt: registration.registeredAt
      }))
      .sort((a, b) => b.usageCount - a.usageCount);

    return {
      totalHooks: this.hooks.size,
      hooksByStage,
      hooksByModule,
      hooksByTarget,
      usageStats
    };
  }

  /**
   * 检查Hook是否存在
   */
  hasHook(hookName: string): boolean {
    return this.hooks.has(hookName);
  }

  /**
   * 获取Hook详细信息
   */
  getHookInfo(hookName: string): {
    hook: IBidirectionalHook;
    moduleId: string;
    registeredAt: number;
    usageCount: number;
    lastUsed?: number;
  } | null {
    const registration = this.hooks.get(hookName);
    if (!registration) {
      return null;
    }

    return {
      hook: registration.hook,
      moduleId: registration.moduleId,
      registeredAt: registration.registeredAt,
      usageCount: registration.usageCount,
      lastUsed: registration.lastUsed
    };
  }

  /**
   * 获取指定阶段的所有Hook
   */
  getHooksByStage(stage: UnifiedHookStage): IBidirectionalHook[] {
    const stageHooks = this.hooksByStage.get(stage) || new Set();
    const results: IBidirectionalHook[] = [];

    for (const hookName of stageHooks) {
      const registration = this.hooks.get(hookName);
      if (registration) {
        results.push(registration.hook);
      }
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 获取指定目标的所有Hook
   */
  getHooksByTarget(target: HookTarget): IBidirectionalHook[] {
    const targetHooks = this.hooksByTarget.get(target) || new Set();
    const results: IBidirectionalHook[] = [];

    for (const hookName of targetHooks) {
      const registration = this.hooks.get(hookName);
      if (registration) {
        results.push(registration.hook);
      }
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 查找未使用的Hook（超过指定时间未使用）
   */
  findUnusedHooks(maxIdleTime: number = 24 * 60 * 60 * 1000): Array<{
    name: string;
    moduleId: string;
    lastUsed?: number;
    idleTime: number;
  }> {
    const now = Date.now();
    const unusedHooks: Array<{
      name: string;
      moduleId: string;
      lastUsed?: number;
      idleTime: number;
    }> = [];

    for (const [name, registration] of this.hooks.entries()) {
      const lastUsed = registration.lastUsed;
      const idleTime = lastUsed ? now - lastUsed : now - registration.registeredAt;

      if (idleTime > maxIdleTime) {
        unusedHooks.push({
          name,
          moduleId: registration.moduleId,
          lastUsed,
          idleTime
        });
      }
    }

    return unusedHooks.sort((a, b) => b.idleTime - a.idleTime);
  }

  /**
   * 清理未使用的Hook
   */
  cleanupUnusedHooks(maxIdleTime: number = 24 * 60 * 60 * 1000): number {
    const unusedHooks = this.findUnusedHooks(maxIdleTime);
    let cleanedCount = 0;

    for (const { name } of unusedHooks) {
      try {
        this.unregister(name);
        cleanedCount++;
      } catch (error) {
        console.error(`Failed to cleanup unused hook ${name}:`, error);
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} unused hooks`);
    }

    return cleanedCount;
  }

  /**
   * 验证Hook配置
   */
  validateHook(hook: IBidirectionalHook): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // 检查必填字段
    if (!hook.name || typeof hook.name !== 'string') {
      errors.push('Hook name is required and must be a string');
    }

    if (!hook.stage) {
      errors.push('Hook stage is required');
    }

    if (!hook.target) {
      errors.push('Hook target is required');
    }

    if (typeof hook.priority !== 'number') {
      errors.push('Hook priority must be a number');
    }

    // 检查Hook名称格式
    if (hook.name && !/^[a-z][a-z0-9-]*[a-z0-9]$/i.test(hook.name)) {
      errors.push('Hook name must follow pattern: [a-z][a-z0-9-]*[a-z0-9]');
    }

    // 检查Hook名称长度
    if (hook.name && hook.name.length > 50) {
      errors.push('Hook name must be 50 characters or less');
    }

    // 检查优先级范围
    if (typeof hook.priority === 'number' && (hook.priority < 0 || hook.priority > 1000)) {
      errors.push('Hook priority must be between 0 and 1000');
    }

    // 检查是否实现了至少一个执行方法
    if (!hook.read && !hook.write && !hook.transform && !hook.execute) {
      errors.push('Hook must implement at least one of: read, write, transform, execute');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 导出注册信息
   */
  export(): {
    version: string;
    exportedAt: number;
    hooks: Array<{
      name: string;
      stage: UnifiedHookStage;
      target: HookTarget;
      priority: number;
      moduleId: string;
      registeredAt: number;
      usageCount: number;
      lastUsed?: number;
    }>;
  } {
    const hooks = Array.from(this.hooks.entries()).map(([name, registration]) => ({
      name,
      stage: registration.hook.stage,
      target: registration.hook.target,
      priority: registration.hook.priority,
      moduleId: registration.moduleId,
      registeredAt: registration.registeredAt,
      usageCount: registration.usageCount,
      lastUsed: registration.lastUsed
    }));

    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      hooks
    };
  }

  /**
   * 导入注册信息（仅元数据，不包含Hook实现）
   */
  importMetadata(metadata: {
    hooks: Array<{
      name: string;
      moduleId: string;
      registeredAt: number;
      usageCount: number;
      lastUsed?: number;
    }>;
  }): void {
    let importedCount = 0;

    for (const hookMeta of metadata.hooks) {
      const existingRegistration = this.hooks.get(hookMeta.name);
      if (existingRegistration) {
        // 更新现有Hook的统计信息
        existingRegistration.usageCount = hookMeta.usageCount;
        existingRegistration.lastUsed = hookMeta.lastUsed;
        importedCount++;
      }
    }

    console.log(`Imported metadata for ${importedCount} hooks`);
  }
}
/**
 * 兼容性模块主导出文件
 * 提供统一的对外API接口
 */

// 核心接口和工厂
export type { CompatibilityContext, CompatibilityModule } from './compatibility-interface.js';
export type { CompatibilityModuleConfig } from './compatibility-factory.js';
export { CompatibilityModuleFactory } from './compatibility-factory.js';
export { CompatibilityManager } from './compatibility-manager.js';

// 导入GLM模块以触发注册
import './glm/index.js';

/**
 * 兼容性模块API
 * 提供标准的创建和管理接口
 */
export class CompatibilityAPI {
  private manager: CompatibilityManager;
  private isInitialized = false;

  constructor(dependencies: any) {
    this.manager = new CompatibilityManager(dependencies);
  }

  /**
   * 初始化兼容性API
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.manager.initialize();
    this.isInitialized = true;
  }

  /**
   * 创建兼容性模块
   */
  async createModule(config: any): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('CompatibilityAPI not initialized');
    }

    return await this.manager.createModule(config);
  }

  /**
   * 处理请求
   */
  async processRequest(moduleId: string, request: any, context: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('CompatibilityAPI not initialized');
    }

    return await this.manager.processRequest(moduleId, request, context);
  }

  /**
   * 处理响应
   */
  async processResponse(moduleId: string, response: any, context: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('CompatibilityAPI not initialized');
    }

    return await this.manager.processResponse(moduleId, response, context);
  }

  /**
   * 获取模块
   */
  getModule(moduleId: string) {
    return this.manager.getModule(moduleId);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return this.manager.getStats();
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.isInitialized) {
      await this.manager.cleanup();
      this.isInitialized = false;
    }
  }
}

/**
 * 创建兼容性API实例
 */
export function createCompatibilityAPI(dependencies: any): CompatibilityAPI {
  return new CompatibilityAPI(dependencies);
}
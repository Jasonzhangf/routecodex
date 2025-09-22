/**
 * Base Module Class
 * 基础模块类 - 所有模块的基类
 */

import { EventEmitter } from 'events';

/**
 * 模块基本信息接口
 */
export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  dependencies?: string[];
}

/**
 * 模块状态枚举
 */
export enum ModuleStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error'
}

/**
 * 基础模块类
 */
export abstract class BaseModule extends EventEmitter {
  protected info: ModuleInfo;
  protected status: ModuleStatus = ModuleStatus.STOPPED;
  protected isRunning: boolean = false;

  constructor(info: ModuleInfo) {
    super();
    this.info = info;
  }

  /**
   * 获取模块信息
   */
  getInfo(): ModuleInfo {
    return { ...this.info };
  }

  /**
   * 获取模块状态
   */
  getStatus(): ModuleStatus {
    return this.status;
  }

  /**
   * 检查模块是否运行中
   */
  isModuleRunning(): boolean {
    return this.isRunning;
  }

  /**
   * 初始化模块 - 子类必须实现
   */
  abstract initialize(config: any): Promise<void>;

  /**
   * 启动模块
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn(`Module ${this.info.id} is already running`);
      return;
    }

    try {
      this.status = ModuleStatus.STARTING;
      this.emit('starting', this.info);

      // 子类可以重写此方法来实现启动逻辑
      await this.doStart();

      this.status = ModuleStatus.RUNNING;
      this.isRunning = true;
      this.emit('started', this.info);

      console.log(`✅ Module ${this.info.id} started successfully`);
    } catch (error) {
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: this.info, error });
      throw error;
    }
  }

  /**
   * 停止模块
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.warn(`Module ${this.info.id} is not running`);
      return;
    }

    try {
      this.status = ModuleStatus.STOPPING;
      this.emit('stopping', this.info);

      // 子类可以重写此方法来实现停止逻辑
      await this.doStop();

      this.status = ModuleStatus.STOPPED;
      this.isRunning = false;
      this.emit('stopped', this.info);

      console.log(`🛑 Module ${this.info.id} stopped successfully`);
    } catch (error) {
      this.status = ModuleStatus.ERROR;
      this.emit('error', { module: this.info, error });
      throw error;
    }
  }

  /**
   * 重启模块
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * 获取模块统计信息
   */
  getStats(): any {
    return {
      id: this.info.id,
      name: this.info.name,
      version: this.info.version,
      status: this.status,
      isRunning: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.getStartTime() : 0
    };
  }

  /**
   * 启动逻辑 - 子类可以重写
   */
  protected async doStart(): Promise<void> {
    // 默认实现：子类可以重写此方法
  }

  /**
   * 停止逻辑 - 子类可以重写
   */
  protected async doStop(): Promise<void> {
    // 默认实现：子类可以重写此方法
  }

  /**
   * 获取启动时间
   */
  private getStartTime(): number {
    // 这里可以存储实际的启动时间
    // 为了简化，返回当前时间
    return Date.now();
  }

  /**
   * 处理模块错误
   */
  protected handleError(error: Error, context?: string): void {
    this.emit('error', {
      module: this.info,
      error,
      context,
      timestamp: new Date().toISOString()
    });
  }
}
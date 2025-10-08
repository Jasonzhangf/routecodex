/**
 * Backend Service Auto-Manager
 * 自动检测和管理RouteCodex后端服务
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface BackendStatus {
  isRunning: boolean;
  isStarting: boolean;
  port: number;
  health?: any;
  error?: string;
  lastCheck: Date;
}

export class BackendServiceManager extends EventEmitter {
  private static instance: BackendServiceManager;
  private backendProcess: ChildProcess | null = null;
  private isStarting = false;
  private status: BackendStatus = {
    isRunning: false,
    isStarting: false,
    port: 5506,
    lastCheck: new Date()
  };
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 5000; // 5秒检查一次

  private constructor() {
    super();
    this.startHealthCheck();
  }

  static getInstance(): BackendServiceManager {
    if (!BackendServiceManager.instance) {
      BackendServiceManager.instance = new BackendServiceManager();
    }
    return BackendServiceManager.instance;
  }

  /**
   * 确保后端服务正在运行
   */
  async ensureBackendRunning(): Promise<boolean> {
    console.log('🔍 检查后端服务状态...');

    // 1. 检测后端是否已运行
    const isHealthy = await this.checkBackendHealth();
    if (isHealthy) {
      console.log('✅ 后端服务已运行');
      return true;
    }

    // 2. 自动启动后端
    if (!this.isStarting) {
      console.log('🚀 启动后端服务...');
      return await this.startBackend();
    }

    // 3. 正在启动中，等待结果
    console.log('⏳ 后端服务启动中...');
    return await this.waitForStartup();
  }

  /**
   * 检查后端健康状态
   */
  private async checkBackendHealth(): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:5506/health', {
        method: 'GET',
        timeout: 3000
      });

      if (response.ok) {
        const health = await response.json();
        this.updateStatus({
          isRunning: true,
          isStarting: false,
          health,
          error: undefined,
          lastCheck: new Date()
        });
        return true;
      }
    } catch (error) {
      this.updateStatus({
        isRunning: false,
        isStarting: this.isStarting,
        error: (error as Error).message,
        lastCheck: new Date()
      });
    }
    return false;
  }

  /**
   * 启动后端服务
   */
  private async startBackend(): Promise<boolean> {
    if (this.isStarting || this.backendProcess) {
      return await this.waitForStartup();
    }

    this.isStarting = true;
    this.updateStatus({
      isStarting: true,
      lastCheck: new Date()
    });

    try {
      // 查找RouteCodex配置文件
      const configPath = await this.findConfigFile();
      if (!configPath) {
        throw new Error('未找到RouteCodex配置文件');
      }

      console.log(`📁 使用配置文件: ${configPath}`);

      // 启动RouteCodex后端
      const args = [
        'start',
        '--config', configPath,
        '--port', '5506'
      ];

      this.backendProcess = spawn('rcc4', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.setupProcessEventHandlers();

      // 等待启动完成
      const success = await this.waitForStartup();

      if (success) {
        console.log('✅ 后端服务启动成功');
      } else {
        console.log('❌ 后端服务启动失败');
      }

      return success;

    } catch (error) {
      console.error('❌ 启动后端服务失败:', error);
      this.updateStatus({
        isStarting: false,
        error: (error as Error).message,
        lastCheck: new Date()
      });
      return false;
    }
  }

  /**
   * 等待后端启动完成
   */
  private async waitForStartup(timeout = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.checkBackendHealth()) {
        this.isStarting = false;
        this.updateStatus({
          isStarting: false,
          lastCheck: new Date()
        });
        return true;
      }

      if (!this.isStarting && !this.backendProcess) {
        // 启动过程中断了
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 超时
    this.isStarting = false;
    if (this.backendProcess) {
      this.backendProcess.kill();
      this.backendProcess = null;
    }
    return false;
  }

  /**
   * 查找配置文件
   */
  private async findConfigFile(): Promise<string | null> {
    const possiblePaths = [
      `${process.env.HOME}/.route-claudecode/config/v4/single-provider/lmstudio-v4-5506.json`,
      './config/default.json',
      './config/rcc4-config.json'
    ];

    for (const path of possiblePaths) {
      try {
        const fs = await import('fs/promises');
        await fs.access(path);
        return path;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 设置进程事件处理器
   */
  private setupProcessEventHandlers() {
    if (!this.backendProcess) return;

    this.backendProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[RouteCodex] ${output}`);
      }
    });

    this.backendProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[RouteCodex Error] ${output}`);
      }
    });

    this.backendProcess.on('exit', (code, signal) => {
      console.log(`RouteCodex 进程退出: code=${code}, signal=${signal}`);
      this.backendProcess = null;
      this.isStarting = false;
      this.updateStatus({
        isRunning: false,
        isStarting: false,
        error: `进程退出: code=${code}, signal=${signal}`,
        lastCheck: new Date()
      });
    });
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      if (this.status.isRunning || this.status.isStarting) {
        await this.checkBackendHealth();
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * 更新状态并发出事件
   */
  private updateStatus(newStatus: Partial<BackendStatus>) {
    this.status = { ...this.status, ...newStatus };
    this.emit('statusChanged', this.status);
  }

  /**
   * 获取当前状态
   */
  getStatus(): BackendStatus {
    return { ...this.status };
  }

  /**
   * 停止后端服务
   */
  async stopBackend(): Promise<boolean> {
    if (this.backendProcess) {
      this.backendProcess.kill('SIGTERM');

      // 等待进程退出
      await new Promise(resolve => {
        if (this.backendProcess) {
          this.backendProcess.on('exit', resolve);
        } else {
          resolve(undefined);
        }
      });

      this.backendProcess = null;
    }

    this.updateStatus({
      isRunning: false,
      isStarting: false,
      lastCheck: new Date()
    });

    return true;
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    await this.stopBackend();
    this.removeAllListeners();
  }
}

// 导出单例实例
export const backendManager = BackendServiceManager.getInstance();
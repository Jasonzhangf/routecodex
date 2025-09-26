/**
 * 简单日志配置集成模块
 *
 * 提供简单日志配置与主日志系统的集成
 */

import { LogLevel, type LoggerConfig } from './types.js';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';

/**
 * 简单日志配置接口
 */
interface SimpleLogConfig {
  enabled: boolean;
  logLevel: LogLevel;
  output: 'console' | 'file' | 'both';
  logDirectory?: string;
  autoStart: boolean;
}

/**
 * 简单日志配置管理器
 */
class SimpleLogConfigManager extends EventEmitter {
  private config: SimpleLogConfig | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private watchInterval: NodeJS.Timeout | null = null;

  /**
   * 获取简单日志配置文件路径
   */
  getConfigPath(): string {
    return path.join(homedir(), '.routecodex', 'simple-log-config.json');
  }

  /**
   * 加载配置
   */
  loadConfig(): SimpleLogConfig | null {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return null;
    }

    try {
      const configData = fs.readFileSync(configPath, 'utf-8');
      const newConfig = JSON.parse(configData);

      // 检查配置是否发生变化
      if (JSON.stringify(newConfig) !== JSON.stringify(this.config)) {
        this.config = newConfig;
        this.emit('config_changed', newConfig);
      }

      return newConfig;
    } catch (error) {
      console.warn('无法读取简单日志配置，使用默认设置');
      return null;
    }
  }

  /**
   * 开始监控配置文件变化
   */
  startWatching(): void {
    const configPath = this.getConfigPath();

    // 确保目录存在
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    try {
      // 使用文件系统监控
      this.fileWatcher = fs.watch(configPath, eventType => {
        if (eventType === 'change') {
          this.loadConfig();
        }
      });

      // 备用：定期检查文件修改时间
      this.watchInterval = setInterval(() => {
        this.loadConfig();
      }, 5000); // 5秒检查一次

      console.log('🔍 开始监控简单日志配置文件变化');
    } catch (error) {
      console.warn('无法监控配置文件变化，将使用定期检查:', error);
    }
  }

  /**
   * 停止监控
   */
  stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  /**
   * 获取当前配置
   */
  getCurrentConfig(): SimpleLogConfig | null {
    return this.config;
  }
}

/**
 * 全局配置管理器实例
 */
const configManager = new SimpleLogConfigManager();

/**
 * 获取配置管理器
 */
export function getConfigManager(): SimpleLogConfigManager {
  return configManager;
}

/**
 * 加载简单日志配置（使用配置管理器）
 */
export function loadSimpleLogConfig(): SimpleLogConfig | null {
  return configManager.loadConfig();
}

/**
 * 检查简单日志是否启用
 */
export function isSimpleLogEnabled(): boolean {
  const config = loadSimpleLogConfig();
  return config?.enabled || false;
}

/**
 * 获取简单日志配置
 */
export function getSimpleLogConfig(): SimpleLogConfig | null {
  return loadSimpleLogConfig();
}

/**
 * 应用简单日志配置到环境变量
 */
export function applySimpleLogConfig(): void {
  const config = configManager.getCurrentConfig() || loadSimpleLogConfig();

  if (config && config.enabled) {
    console.log('📝 检测到简单日志配置，正在应用...');
    console.log(`📊 日志级别: ${config.logLevel}`);
    console.log(`🎯 输出方式: ${config.output}`);

    // 将简单日志配置应用到环境变量
    process.env.SIMPLE_LOG_ENABLED = 'true';
    process.env.SIMPLE_LOG_LEVEL = config.logLevel;
    process.env.SIMPLE_LOG_OUTPUT = config.output;

    if (config.output === 'file' || config.output === 'both') {
      process.env.SIMPLE_LOG_DIRECTORY =
        config.logDirectory || path.join(homedir(), '.routecodex', 'logs');
      console.log(`📁 日志目录: ${process.env.SIMPLE_LOG_DIRECTORY}`);
    }

    console.log('✨ 简单日志配置已应用到系统！');
  }
}

/**
 * 根据简单日志配置创建简单的Logger对象
 */
export function createLoggerWithSimpleConfig(moduleId: string, moduleType: string): any {
  const simpleConfig = configManager.getCurrentConfig() || loadSimpleLogConfig();

  if (!simpleConfig || !simpleConfig.enabled) {
    // 如果简单日志未启用，返回默认logger
    return {
      debug: (message: string, ...args: any[]) =>
        console.log(`[DEBUG] [${moduleId}] ${message}`, ...args),
      info: (message: string, ...args: any[]) =>
        console.log(`[INFO] [${moduleId}] ${message}`, ...args),
      warn: (message: string, ...args: any[]) =>
        console.warn(`[WARN] [${moduleId}] ${message}`, ...args),
      error: (message: string, ...args: any[]) =>
        console.error(`[ERROR] [${moduleId}] ${message}`, ...args),
    };
  }

  // 根据简单日志配置创建logger
  return {
    debug: (message: string, ...args: any[]) => {
      if (simpleConfig.logLevel === 'debug') {
        console.log(`[DEBUG] [${moduleId}] ${message}`, ...args);
      }
    },
    info: (message: string, ...args: any[]) => {
      if (simpleConfig.logLevel === 'debug' || simpleConfig.logLevel === 'info') {
        console.log(`[INFO] [${moduleId}] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: any[]) => {
      if (
        simpleConfig.logLevel === 'debug' ||
        simpleConfig.logLevel === 'info' ||
        simpleConfig.logLevel === 'warn'
      ) {
        console.warn(`[WARN] [${moduleId}] ${message}`, ...args);
      }
    },
    error: (message: string, ...args: any[]) => {
      console.error(`[ERROR] [${moduleId}] ${message}`, ...args);
    },
  };
}

/**
 * 检查是否应该使用简单日志配置
 */
export function shouldUseSimpleLogConfig(): boolean {
  return isSimpleLogEnabled() || process.env.SIMPLE_LOG_ENABLED === 'true';
}

/**
 * 启动简单日志配置监控
 */
export function startSimpleLogConfigWatching(): void {
  configManager.startWatching();
}

/**
 * 停止简单日志配置监控
 */
export function stopSimpleLogConfigWatching(): void {
  configManager.stopWatching();
}

/**
 * 监听配置变化
 */
export function onSimpleLogConfigChange(callback: (config: SimpleLogConfig) => void): void {
  configManager.on('config_changed', callback);
}

/**
 * 获取当前应用的日志级别
 */
export function getAppliedLogLevel(): LogLevel {
  if (shouldUseSimpleLogConfig()) {
    const config = configManager.getCurrentConfig() || getSimpleLogConfig();
    return config?.logLevel || LogLevel.INFO;
  }

  // 从环境变量或默认配置获取
  const envLevel = process.env.LOG_LEVEL || process.env.SIMPLE_LOG_LEVEL;
  if (envLevel && Object.values(LogLevel).includes(envLevel as LogLevel)) {
    return envLevel as LogLevel;
  }

  return LogLevel.INFO;
}

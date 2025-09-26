/**
 * LoggerFactory 工厂类实现
 *
 * 提供统一的Logger实例创建和管理功能
 */

import type { UnifiedLogger, LoggerFactory, LoggerFactoryStatus } from './interfaces.js';
import type { LoggerConfig } from './types.js';
import { UnifiedModuleLogger } from './UnifiedLogger.js';
import { FACTORY_CONSTANTS } from './constants.js';
import {
  shouldUseSimpleLogConfig,
  createLoggerWithSimpleConfig,
  onSimpleLogConfigChange,
  getAppliedLogLevel,
} from './simple-log-integration.js';

/**
 * LoggerFactory 实现类
 */
export class LoggerFactoryImpl implements LoggerFactory {
  private loggers = new Map<string, UnifiedModuleLogger>();
  private isShuttingDown = false;
  private totalLogEntries = 0;
  private memoryUsage = 0;

  /**
   * 创建Logger实例
   */
  createLogger(config: LoggerConfig): UnifiedLogger {
    if (this.isShuttingDown) {
      throw new Error('LoggerFactory is shutting down');
    }

    // 检查Logger数量限制
    if (this.loggers.size >= FACTORY_CONSTANTS.MAX_LOGGERS) {
      throw new Error(`Maximum number of loggers (${FACTORY_CONSTANTS.MAX_LOGGERS}) reached`);
    }

    // 应用简单日志配置（如果启用）
    let finalConfig = config;
    if (shouldUseSimpleLogConfig()) {
      finalConfig = createLoggerWithSimpleConfig(config.moduleId, config.moduleType);
      // 保留原始配置中的一些重要设置
      finalConfig = {
        ...finalConfig,
        maxHistory: config.maxHistory,
        maxFileSize: config.maxFileSize,
        maxFiles: config.maxFiles,
        enableCompression: config.enableCompression,
        sensitiveFields: config.sensitiveFields,
      };
    }

    // 创建Logger实例
    const logger = new UnifiedModuleLogger(finalConfig);

    // 监听日志事件以更新统计信息
    logger.on('log_written', () => {
      this.totalLogEntries++;
    });

    // 存储Logger实例
    this.loggers.set(config.moduleId, logger);

    return logger;
  }

  /**
   * 获取已创建的Logger
   */
  getLogger(moduleId: string): UnifiedLogger | undefined {
    return this.loggers.get(moduleId);
  }

  /**
   * 获取所有已创建的Logger
   */
  getAllLoggers(): UnifiedLogger[] {
    return Array.from(this.loggers.values());
  }

  /**
   * 移除Logger
   */
  removeLogger(moduleId: string): void {
    const logger = this.loggers.get(moduleId);
    if (logger) {
      logger.cleanup().catch(error => {
        console.error(`Failed to cleanup logger ${moduleId}:`, error);
      });
      this.loggers.delete(moduleId);
    }
  }

  /**
   * 清理所有Logger
   */
  async cleanup(): Promise<void> {
    this.isShuttingDown = true;

    const cleanupPromises = Array.from(this.loggers.values()).map(logger =>
      logger.cleanup().catch(error => {
        console.error('Failed to cleanup logger:', error);
      })
    );

    await Promise.all(cleanupPromises);
    this.loggers.clear();
  }

  /**
   * 获取工厂状态
   */
  getFactoryStatus(): LoggerFactoryStatus {
    return {
      loggerCount: this.loggers.size,
      activeLoggers: this.getActiveLoggerCount(),
      totalLogEntries: this.totalLogEntries,
      memoryUsage: this.calculateMemoryUsage(),
      status: this.isShuttingDown ? 'shutting_down' : 'active',
    };
  }

  /**
   * 获取活跃的Logger数量
   */
  private getActiveLoggerCount(): number {
    let activeCount = 0;
    const loggers = Array.from(this.loggers.values());
    for (const logger of loggers) {
      const stats = logger.getStats();
      if (stats.totalLogs > 0) {
        activeCount++;
      }
    }
    return activeCount;
  }

  /**
   * 计算内存使用量
   */
  private calculateMemoryUsage(): number {
    // 简化的内存使用计算
    return this.loggers.size * 1024 * 1024; // 假设每个Logger使用1MB
  }

  /**
   * 定期清理不活跃的Logger
   */
  startPeriodicCleanup(): void {
    setInterval(() => {
      this.cleanupInactiveLoggers();
    }, FACTORY_CONSTANTS.CACHE_CLEANUP_INTERVAL);
  }

  /**
   * 清理不活跃的Logger
   */
  private cleanupInactiveLoggers(): void {
    const now = Date.now();
    const inactiveThreshold = 30 * 60 * 1000; // 30分钟

    const entries = Array.from(this.loggers.entries());
    for (const [moduleId, logger] of entries) {
      const stats = logger.getStats();
      const lastLogTime = stats.latestLog;

      if (lastLogTime && now - lastLogTime > inactiveThreshold) {
        // 清理不活跃的Logger
        this.removeLogger(moduleId);
      }
    }
  }

  /**
   * 获取Logger统计信息
   */
  getLoggerStats(): Record<string, any> {
    const stats: Record<string, any> = {};

    const entries = Array.from(this.loggers.entries());
    for (const [moduleId, logger] of entries) {
      stats[moduleId] = {
        ...logger.getStats(),
        context: logger.getContext(),
      };
    }

    return stats;
  }

  /**
   * 批量查询日志
   */
  async queryAllLogs(
    filter: import('./types.js').LogFilter
  ): Promise<import('./types.js').LogQueryResult> {
    const allLogs: import('./types.js').UnifiedLogEntry[] = [];
    let total = 0;

    const loggers = Array.from(this.loggers.values());
    for (const logger of loggers) {
      const result = await logger.queryLogs(filter);
      allLogs.push(...result.logs);
      total += result.total;
    }

    // 合并结果并排序
    allLogs.sort((a, b) => a.timestamp - b.timestamp);

    return {
      logs: allLogs,
      total,
      filter,
      queryTime: 0, // 简化实现
    };
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      // 检查所有Logger的状态
      const loggers = Array.from(this.loggers.values());
      for (const logger of loggers) {
        const stats = logger.getStats();
        if (!stats) {
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }

  /**
   * 根据简单日志配置更新所有Logger
   */
  updateAllLoggersFromSimpleConfig(config: any): void {
    const loggers = Array.from(this.loggers.values());

    for (const logger of loggers) {
      try {
        // 更新Logger的日志级别
        logger.updateLogLevel(config.logLevel);
        console.log(`✅ 已更新Logger [${logger.getModuleId()}] 的日志级别为: ${config.logLevel}`);
      } catch (error) {
        console.error(`❌ 更新Logger [${logger.getModuleId()}] 失败:`, error);
      }
    }
  }
}

/**
 * 全局LoggerFactory实例
 */
let globalFactory: LoggerFactoryImpl | null = null;

/**
 * 获取全局LoggerFactory实例
 */
export function getGlobalLoggerFactory(): LoggerFactoryImpl {
  if (!globalFactory) {
    globalFactory = new LoggerFactoryImpl();
    // 启动定期清理
    globalFactory.startPeriodicCleanup();

    // 监听简单日志配置变化
    onSimpleLogConfigChange(config => {
      console.log(`🔄 LoggerFactory: 检测到简单日志配置变化，正在更新所有Logger...`);
      globalFactory?.updateAllLoggersFromSimpleConfig(config);
    });
  }
  return globalFactory;
}

/**
 * 创建Logger实例的便捷函数
 */
export function createLogger(config: LoggerConfig): UnifiedLogger {
  const factory = getGlobalLoggerFactory();
  return factory.createLogger(config);
}

/**
 * 获取Logger实例的便捷函数
 */
export function getLogger(moduleId: string): UnifiedLogger | undefined {
  const factory = getGlobalLoggerFactory();
  return factory.getLogger(moduleId);
}

/**
 * 清理所有Logger的便捷函数
 */
export async function cleanupAllLoggers(): Promise<void> {
  if (globalFactory) {
    await globalFactory.cleanup();
    globalFactory = null;
  }
}

/**
 * 向后兼容的console.log包装器
 */
export class CompatibilityLogger {
  private logger: UnifiedLogger;

  constructor(moduleId: string, moduleType: string) {
    this.logger =
      getLogger(moduleId) ||
      createLogger({
        moduleId,
        moduleType,
        enableFile: false, // 默认不写入文件，保持向后兼容
        enableConsole: true,
      });
  }

  log = (message: string, ...args: any[]): void => {
    this.logger.info(message, { args });
  };

  info = (message: string, ...args: any[]): void => {
    this.logger.info(message, { args });
  };

  warn = (message: string, ...args: any[]): void => {
    this.logger.warn(message, { args });
  };

  error = (message: string, ...args: any[]): void => {
    const error = args.find(arg => arg instanceof Error);
    const data = error ? { args: args.filter(arg => arg !== error) } : { args };
    this.logger.error(message, error, data);
  };

  debug = (message: string, ...args: any[]): void => {
    this.logger.debug(message, { args });
  };
}

/**
 * 快照服务模块导出
 */

// 主要服务导出
export { SnapshotService, DEFAULT_SNAPSHOT_CONFIG } from './snapshot-service.js';
export type { SnapshotServiceConfig } from './snapshot-service.js';

// 格式化器导出
export {
  JsonFormatter,
  StructuredFormatter,
  CompactFormatter
} from './formatters/index.js';

export type { SnapshotFormatter } from './formatters/json-formatter.js';

/**
 * 创建默认快照服务
 */
export function createSnapshotService(config?: Partial<SnapshotServiceConfig>) {
  return new SnapshotService(config);
}

/**
 * 快照服务工厂
 */
export class SnapshotServiceFactory {
  /**
   * 创建生产环境快照服务
   */
  static createProduction(): SnapshotService {
    return new SnapshotService({
      enabled: true,
      format: 'structured',
      compression: 'gzip',
      sampling: {
        enabled: true,
        defaultRate: 0.05, // 生产环境较低采样率
        moduleRates: {
          'provider-v2': 0.1,
          'pipeline-compat': 0.02,
          'server-chat': 0.05
        }
      },
      performance: {
        maxFileSize: 512 * 1024, // 512KB
        batchSize: 20,
        writeInterval: 10000 // 10秒
      }
    });
  }

  /**
   * 创建开发环境快照服务
   */
  static createDevelopment(): SnapshotService {
    return new SnapshotService({
      enabled: true,
      format: 'structured',
      compression: 'none', // 开发环境不压缩，便于调试
      sampling: {
        enabled: false // 开发环境记录所有数据
      },
      dataMasking: {
        enabled: false // 开发环境不遮蔽数据
      },
      performance: {
        maxFileSize: 2 * 1024 * 1024, // 2MB
        batchSize: 5,
        writeInterval: 1000 // 1秒
      }
    });
  }

  /**
   * 创建测试环境快照服务
   */
  static createTesting(): SnapshotService {
    return new SnapshotService({
      enabled: true,
      basePath: './test-snapshots',
      format: 'compact',
      compression: 'none',
      retention: {
        maxFiles: 100,
        maxAge: 60 * 60 * 1000 // 1小时
      },
      sampling: {
        enabled: false
      },
      throttling: {
        maxWritesPerSecond: 50,
        maxWritesPerRequest: 10
      }
    });
  }

  /**
   * 创建最小化快照服务
   */
  static createMinimal(): SnapshotService {
    return new SnapshotService({
      enabled: true,
      format: 'compact',
      compression: 'gzip',
      sampling: {
        enabled: true,
        defaultRate: 0.01 // 1%采样率
      },
      performance: {
        maxFileSize: 100 * 1024, // 100KB
        batchSize: 50,
        writeInterval: 30000 // 30秒
      }
    });
  }
}
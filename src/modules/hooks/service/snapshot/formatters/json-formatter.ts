/**
 * JSON格式化器
 *
 * 提供标准JSON格式的快照数据格式化功能
 */

import type { SnapshotData } from '../../../types/hook-types.js';

/**
 * 快照格式化器接口
 */
export interface SnapshotFormatter {
  format(data: SnapshotData): string;
  getFileExtension(): string;
  getMimeType(): string;
}

/**
 * JSON格式化器实现
 */
export class JsonFormatter implements SnapshotFormatter {
  private prettyPrint: boolean;
  private includeMetadata: boolean;

  constructor(options: {
    prettyPrint?: boolean;
    includeMetadata?: boolean;
  } = {}) {
    this.prettyPrint = options.prettyPrint !== false;
    this.includeMetadata = options.includeMetadata !== false;
  }

  /**
   * 格式化快照数据为JSON
   */
  format(data: SnapshotData): string {
    const formattedData = this.prepareData(data);

    if (this.prettyPrint) {
      return JSON.stringify(formattedData, null, 2);
    } else {
      return JSON.stringify(formattedData);
    }
  }

  /**
   * 获取文件扩展名
   */
  getFileExtension(): string {
    return 'json';
  }

  /**
   * 获取MIME类型
   */
  getMimeType(): string {
    return 'application/json';
  }

  /**
   * 准备格式化数据
   */
  private prepareData(data: SnapshotData): unknown {
    if (this.includeMetadata) {
      return data;
    }

    // 不包含元数据的精简版本
    return {
      executionContext: data.executionContext,
      hooks: data.hooks,
      summary: data.summary
    };
  }

  /**
   * 创建默认JSON格式化器
   */
  static createDefault(): JsonFormatter {
    return new JsonFormatter();
  }

  /**
   * 创建紧凑JSON格式化器
   */
  static createCompact(): JsonFormatter {
    return new JsonFormatter({
      prettyPrint: false,
      includeMetadata: false
    });
  }

  /**
   * 创建详细JSON格式化器
   */
  static createDetailed(): JsonFormatter {
    return new JsonFormatter({
      prettyPrint: true,
      includeMetadata: true
    });
  }
}
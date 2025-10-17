/**
 * 数据验证和清洗器
 * 
 * 验证日志数据格式，清洗不一致和损坏的数据
 */

import type { UnifiedLogEntry, LogLevel } from '../types.js';
import { LogLevel as LogLevelEnum } from '../types.js';
import { ERROR_CONSTANTS } from '../constants.js';

/**
 * 数据验证选项
 */
export interface DataValidationOptions {
  /** 验证级别 */
  validationLevel?: 'strict' | 'moderate' | 'lenient';
  /** 自动修复 */
  autoFix?: boolean;
  /** 移除无效条目 */
  removeInvalid?: boolean;
  /** 验证时间戳 */
  validateTimestamps?: boolean;
  /** 时间戳范围 */
  timestampRange?: {
    start: number;
    end: number;
  };
  /** 验证模块ID格式 */
  validateModuleId?: boolean;
  /** 模块ID格式正则 */
  moduleIdPattern?: RegExp;
  /** 验证消息长度 */
  validateMessageLength?: boolean;
  /** 最大消息长度 */
  maxMessageLength?: number;
  /** 验证数据字段 */
  validateDataFields?: boolean;
  /** 必需的数据字段 */
  requiredDataFields?: string[];
  /** 验证错误格式 */
  validateErrorFormat?: boolean;
}

/**
 * 清洗选项
 */
export interface DataCleaningOptions {
  /** 标准化时间戳 */
  normalizeTimestamps?: boolean;
  /** 标准化日志级别 */
  normalizeLogLevels?: boolean;
  /** 修剪消息长度 */
  trimMessages?: boolean;
  /** 移除空数据字段 */
  removeEmptyData?: boolean;
  /** 标准化模块ID */
  normalizeModuleIds?: boolean;
  /** 修复常见错误 */
  fixCommonErrors?: boolean;
  /** 去重 */
  deduplicate?: boolean;
  /** 排序 */
  sortByTimestamp?: boolean;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否有效 */
  isValid: boolean;
  /** 验证错误 */
  errors: ValidationError[];
  /** 警告信息 */
  warnings: ValidationWarning[];
  /** 修复建议 */
  fixes: ValidationFix[];
}

/**
 * 验证错误
 */
export interface ValidationError {
  /** 错误类型 */
  type: 'missing_field' | 'invalid_type' | 'invalid_value' | 'schema_violation' | 'format_error';
  /** 字段名 */
  field?: string;
  /** 错误消息 */
  message: string;
  /** 期望值 */
  expected?: unknown;
  /** 实际值 */
  actual?: unknown;
  /** 严重程度 */
  severity: 'error' | 'warning';
}

/**
 * 验证警告
 */
export interface ValidationWarning {
  /** 警告类型 */
  type: 'deprecated_field' | 'unusual_value' | 'performance_concern' | 'data_quality';
  /** 字段名 */
  field?: string;
  /** 警告消息 */
  message: string;
  /** 建议 */
  suggestion?: string;
}

/**
 * 验证修复
 */
export interface ValidationFix {
  /** 修复类型 */
  type: 'add_field' | 'fix_type' | 'normalize_value' | 'remove_invalid';
  /** 字段名 */
  field?: string;
  /** 修复描述 */
  description: string;
  /** 修复函数 */
  fixFunction: (entry: UnifiedLogEntry) => UnifiedLogEntry;
}

/**
 * 清洗结果
 */
export interface CleaningResult {
  /** 清洗后的条目 */
  cleanedEntries: UnifiedLogEntry[];
  /** 移除的条目 */
  removedEntries: UnifiedLogEntry[];
  /** 修复的条目 */
  fixedEntries: UnifiedLogEntry[];
  /** 统计信息 */
  stats: CleaningStats;
}

/**
 * 清洗统计
 */
export interface CleaningStats {
  /** 总条目数 */
  totalEntries: number;
  /** 有效条目数 */
  validEntries: number;
  /** 无效条目数 */
  invalidEntries: number;
  /** 修复条目数 */
  fixedEntries: number;
  /** 移除条目数 */
  removedEntries: number;
  /** 去重条目数 */
  deduplicatedEntries: number;
  /** 标准化操作数 */
  normalizedOperations: number;
}

/**
 * 数据验证和清洗器
 */
export class DataValidatorAndCleaner {
  private validationOptions: Required<DataValidationOptions>;
  private cleaningOptions: Required<DataCleaningOptions>;

  constructor(
    validationOptions: DataValidationOptions = {},
    cleaningOptions: DataCleaningOptions = {}
  ) {
    this.validationOptions = {
      validationLevel: validationOptions.validationLevel || 'moderate',
      autoFix: validationOptions.autoFix ?? true,
      removeInvalid: validationOptions.removeInvalid ?? false,
      validateTimestamps: validationOptions.validateTimestamps ?? true,
      timestampRange: validationOptions.timestampRange || { start: 0, end: Date.now() },
      validateModuleId: validationOptions.validateModuleId ?? true,
      moduleIdPattern: validationOptions.moduleIdPattern || /^[a-zA-Z0-9_-]+$/,
      validateMessageLength: validationOptions.validateMessageLength ?? true,
      maxMessageLength: validationOptions.maxMessageLength || ERROR_CONSTANTS.MAX_ERROR_MESSAGE_LENGTH,
      validateDataFields: validationOptions.validateDataFields ?? false,
      requiredDataFields: validationOptions.requiredDataFields || [],
      validateErrorFormat: validationOptions.validateErrorFormat ?? true
    };

    this.cleaningOptions = {
      normalizeTimestamps: cleaningOptions.normalizeTimestamps ?? true,
      normalizeLogLevels: cleaningOptions.normalizeLogLevels ?? true,
      trimMessages: cleaningOptions.trimMessages ?? true,
      removeEmptyData: cleaningOptions.removeEmptyData ?? true,
      normalizeModuleIds: cleaningOptions.normalizeModuleIds ?? true,
      fixCommonErrors: cleaningOptions.fixCommonErrors ?? true,
      deduplicate: cleaningOptions.deduplicate ?? true,
      sortByTimestamp: cleaningOptions.sortByTimestamp ?? true
    };
  }

  /**
   * 验证单个日志条目
   */
  validateEntry(entry: unknown): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const fixes: ValidationFix[] = [];

    // 基础结构验证
    if (!entry || typeof entry !== 'object') {
      errors.push({
        type: 'invalid_type',
        message: '日志条目必须是对象',
        actual: typeof entry,
        expected: 'object',
        severity: 'error'
      });
      return { isValid: false, errors, warnings, fixes };
    }

    // 必需字段验证
    const requiredFields = ['timestamp', 'level', 'moduleId', 'moduleType', 'message', 'version'];
    for (const field of requiredFields) {
      if (!(field in entry)) {
        errors.push({
          type: 'missing_field',
          field,
          message: `缺少必需字段: ${field}`,
          severity: 'error'
        });
      }
    }

    // 如果缺少必需字段，直接返回
    if (errors.length > 0) {
      return { isValid: false, errors, warnings, fixes };
    }

    // 时间戳验证
    if (this.validationOptions.validateTimestamps) {
      this.validateTimestamp((entry as any).timestamp, errors, warnings, fixes);
    }

    // 日志级别验证
    this.validateLogLevel((entry as any).level, errors, warnings, fixes);

    // 模块ID验证
    if (this.validationOptions.validateModuleId) {
      this.validateModuleId((entry as any).moduleId, errors, warnings, fixes);
    }

    // 模块类型验证
    this.validateModuleType((entry as any).moduleType, errors, warnings, fixes);

    // 消息验证
    this.validateMessage((entry as any).message, errors, warnings, fixes);

    // 数据字段验证
    if (this.validationOptions.validateDataFields && (entry as any).data) {
      this.validateDataFields((entry as any).data, errors, warnings, fixes);
    }

    // 错误格式验证
    if ((entry as any).error) {
      this.validateErrorFormat((entry as any).error, errors, warnings, fixes);
    }

    // 版本验证
    if ((this.validationOptions as any).validateVersion) {
      this.validateVersion((entry as any).version, errors, warnings, fixes);
    }

    // 可选字段验证
    this.validateOptionalFields(entry as any, errors, warnings, fixes);

    const isValid = errors.length === 0 || (this.validationOptions.validationLevel === 'lenient' && errors.every(e => e.severity === 'warning'));

    return { isValid, errors, warnings, fixes };
  }

  /**
   * 验证时间戳
   */
  private validateTimestamp(timestamp: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof timestamp !== 'number') {
      errors.push({
        type: 'invalid_type',
        field: 'timestamp',
        message: '时间戳必须是数字',
        actual: typeof timestamp,
        expected: 'number',
        severity: 'error'
      });
      return;
    }

    if (timestamp <= 0) {
      errors.push({
        type: 'invalid_value',
        field: 'timestamp',
        message: '时间戳必须大于0',
        actual: timestamp,
        severity: 'error'
      });
      return;
    }

    // 检查时间戳范围
    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const oneHourLater = now + 60 * 60 * 1000;

    if (timestamp < oneYearAgo) {
      _warnings.push({
        type: 'data_quality',
        field: 'timestamp',
        message: '时间戳过早（超过1年前）',
        suggestion: '检查系统时间或数据源'
      });
    }

    if (timestamp > oneHourLater) {
      _warnings.push({
        type: 'data_quality',
        field: 'timestamp',
        message: '时间戳在未来（超过1小时后）',
        suggestion: '检查系统时间或数据源'
      });
    }

    // 自定义时间范围验证
    if (this.validationOptions.timestampRange) {
      const { start, end } = this.validationOptions.timestampRange;
      if (timestamp < start || timestamp > end) {
        errors.push({
          type: 'invalid_value',
          field: 'timestamp',
          message: `时间戳不在有效范围内 [${new Date(start).toISOString()} - ${new Date(end).toISOString()}]`,
          actual: new Date(timestamp).toISOString(),
          severity: 'error'
        });
      }
    }
  }

  /**
   * 验证日志级别
   */
  private validateLogLevel(level: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof level !== 'string') {
      errors.push({
        type: 'invalid_type',
        field: 'level',
        message: '日志级别必须是字符串',
        actual: typeof level,
        expected: 'string',
        severity: 'error'
      });
      return;
    }

    const validLevels = Object.values(LogLevelEnum);
    if (!validLevels.includes(level as LogLevelEnum)) {
      errors.push({
        type: 'invalid_value',
        field: 'level',
        message: `无效的日志级别: ${level}`,
        actual: level,
        expected: validLevels.join(', '),
        severity: 'error'
      });
    }
  }

  /**
   * 验证模块ID
   */
  private validateModuleId(moduleId: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof moduleId !== 'string') {
      errors.push({
        type: 'invalid_type',
        field: 'moduleId',
        message: '模块ID必须是字符串',
        actual: typeof moduleId,
        expected: 'string',
        severity: 'error'
      });
      return;
    }

    if (moduleId.length === 0) {
      errors.push({
        type: 'invalid_value',
        field: 'moduleId',
        message: '模块ID不能为空',
        severity: 'error'
      });
      return;
    }

    if (!this.validationOptions.moduleIdPattern.test(moduleId)) {
      errors.push({
        type: 'format_error',
        field: 'moduleId',
        message: '模块ID格式不符合要求',
        actual: moduleId,
        expected: this.validationOptions.moduleIdPattern.source,
        severity: 'error'
      });
    }
  }

  /**
   * 验证模块类型
   */
  private validateModuleType(moduleType: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof moduleType !== 'string') {
      errors.push({
        type: 'invalid_type',
        field: 'moduleType',
        message: '模块类型必须是字符串',
        actual: typeof moduleType,
        expected: 'string',
        severity: 'error'
      });
      return;
    }

    if (moduleType.length === 0) {
      errors.push({
        type: 'invalid_value',
        field: 'moduleType',
        message: '模块类型不能为空',
        severity: 'error'
      });
    }
  }

  /**
   * 验证消息
   */
  private validateMessage(message: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof message !== 'string') {
      errors.push({
        type: 'invalid_type',
        field: 'message',
        message: '消息必须是字符串',
        actual: typeof message,
        expected: 'string',
        severity: 'error'
      });
      return;
    }

    if (message.length === 0) {
      _warnings.push({
        type: 'data_quality',
        field: 'message',
        message: '消息为空',
        suggestion: '考虑添加有意义的日志消息'
      });
    }

    if (this.validationOptions.validateMessageLength && message.length > this.validationOptions.maxMessageLength) {
      errors.push({
        type: 'invalid_value',
        field: 'message',
        message: `消息长度超过限制: ${message.length} > ${this.validationOptions.maxMessageLength}`,
        actual: message.length,
        expected: `<= ${this.validationOptions.maxMessageLength}`,
        severity: 'error'
      });
    }
  }

  /**
   * 验证数据字段
   */
  private validateDataFields(data: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (data === null || data === undefined) {
      return;
    }

    if (typeof data !== 'object') {
      errors.push({
        type: 'invalid_type',
        field: 'data',
        message: '数据字段必须是对象',
        actual: typeof data,
        expected: 'object',
        severity: 'error'
      });
      return;
    }

    // 检查必需的数据字段
    for (const field of this.validationOptions.requiredDataFields) {
      if (!(field in data)) {
        errors.push({
          type: 'missing_field',
          field: `data.${field}`,
          message: `缺少必需的数据字段: ${field}`,
          severity: 'error'
        });
      }
    }
  }

  /**
   * 验证错误格式
   */
  private validateErrorFormat(error: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof error !== 'object' || error === null) {
      errors.push({
        type: 'invalid_type',
        field: 'error',
        message: '错误信息必须是对象',
        actual: typeof error,
        expected: 'object',
        severity: 'error'
      });
      return;
    }

    // 检查错误对象的结构
    const requiredErrorFields = ['name', 'message'];
    for (const field of requiredErrorFields) {
      if (!(field in error)) {
        errors.push({
          type: 'missing_field',
          field: `error.${field}`,
          message: `错误信息缺少必需字段: ${field}`,
          severity: 'error'
        });
      }
    }
  }

  /**
   * 验证版本
   */
  private validateVersion(version: unknown, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    if (typeof version !== 'string') {
      errors.push({
        type: 'invalid_type',
        field: 'version',
        message: '版本必须是字符串',
        actual: typeof version,
        expected: 'string',
        severity: 'error'
      });
      return;
    }

    // 版本格式验证 (语义化版本)
    const versionPattern = /^\d+\.\d+\.\d+$/;
    if (!versionPattern.test(version)) {
      _warnings.push({
        type: 'data_quality',
        field: 'version',
        message: `版本格式不符合语义化版本规范: ${version}`,
        suggestion: '使用格式: major.minor.patch'
      });
    }
  }

  /**
   * 验证可选字段
   */
  private validateOptionalFields(entry: UnifiedLogEntry, errors: ValidationError[], _warnings: ValidationWarning[], _fixes: ValidationFix[]): void {
    // 验证持续时间
    if (entry.duration !== undefined) {
      if (typeof entry.duration !== 'number' || entry.duration < 0) {
        errors.push({
          type: 'invalid_value',
          field: 'duration',
          message: '持续时间必须是非负数字',
          actual: entry.duration,
          severity: 'error'
        });
      }
    }

    // 验证内存使用
    if (entry.memoryUsage !== undefined) {
      if (typeof entry.memoryUsage !== 'number' || entry.memoryUsage < 0) {
        errors.push({
          type: 'invalid_value',
          field: 'memoryUsage',
          message: '内存使用必须是非负数字',
          actual: entry.memoryUsage,
          severity: 'error'
        });
      }
    }

    // 验证标签
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags)) {
        errors.push({
          type: 'invalid_type',
          field: 'tags',
          message: '标签必须是数组',
          actual: typeof entry.tags,
          expected: 'array',
          severity: 'error'
        });
      } else {
        for (let i = 0; i < entry.tags.length; i++) {
          if (typeof entry.tags[i] !== 'string') {
            errors.push({
              type: 'invalid_type',
              field: `tags[${i}]`,
              message: '标签必须是字符串',
              actual: typeof entry.tags[i],
              expected: 'string',
              severity: 'error'
            });
          }
        }
      }
    }
  }

  /**
   * 清洗日志数据
   */
  cleanEntries(entries: UnifiedLogEntry[]): CleaningResult {
    const cleanedEntries: UnifiedLogEntry[] = [];
    const removedEntries: UnifiedLogEntry[] = [];
    const fixedEntries: UnifiedLogEntry[] = [];
    
    const stats: CleaningStats = {
      totalEntries: entries.length,
      validEntries: 0,
      invalidEntries: 0,
      fixedEntries: 0,
      removedEntries: 0,
      deduplicatedEntries: 0,
      normalizedOperations: 0
    };

    // 去重
    let uniqueEntries = entries;
    if (this.cleaningOptions.deduplicate) {
      const dedupResult = this.deduplicateEntries(entries);
      uniqueEntries = dedupResult.uniqueEntries;
      stats.deduplicatedEntries = dedupResult.duplicateCount;
    }

    // 处理每个条目
    for (const entry of uniqueEntries) {
      let cleanedEntry = { ...entry };
      let wasFixed = false;
      // const isValid = true;

      // 标准化时间戳
      if (this.cleaningOptions.normalizeTimestamps) {
        const result = this.normalizeTimestamp(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 标准化日志级别
      if (this.cleaningOptions.normalizeLogLevels) {
        const result = this.normalizeLogLevel(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 修剪消息
      if (this.cleaningOptions.trimMessages) {
        const result = this.trimMessage(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 移除空数据字段
      if (this.cleaningOptions.removeEmptyData) {
        const result = this.removeEmptyData(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 标准化模块ID
      if (this.cleaningOptions.normalizeModuleIds) {
        const result = this.normalizeModuleId(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 修复常见错误
      if (this.cleaningOptions.fixCommonErrors) {
        const result = this.fixCommonErrors(cleanedEntry);
        if (result.fixed) {
          cleanedEntry = result.entry;
          wasFixed = true;
          stats.normalizedOperations++;
        }
      }

      // 验证清洗后的条目
      const validationResult = this.validateEntry(cleanedEntry);
      
      if (validationResult.isValid) {
        cleanedEntries.push(cleanedEntry);
        stats.validEntries++;
        
        if (wasFixed) {
          fixedEntries.push(cleanedEntry);
          stats.fixedEntries++;
        }
      } else {
        stats.invalidEntries++;
        
        if (this.validationOptions.removeInvalid) {
          removedEntries.push(cleanedEntry);
          stats.removedEntries++;
        } else {
          // 如果不清除无效条目，仍然保留但标记
          cleanedEntries.push(cleanedEntry);
        }
      }
    }

    // 排序
    if (this.cleaningOptions.sortByTimestamp) {
      cleanedEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    return {
      cleanedEntries,
      removedEntries,
      fixedEntries,
      stats
    };
  }

  /**
   * 去重日志条目
   */
  private deduplicateEntries(entries: UnifiedLogEntry[]): {
    uniqueEntries: UnifiedLogEntry[];
    duplicateCount: number;
  } {
    const seen = new Set<string>();
    const unique: UnifiedLogEntry[] = [];
    let duplicateCount = 0;

    for (const entry of entries) {
      // 基于关键字段生成唯一键
      const key = `${(entry as any).timestamp}-${(entry as any).moduleId}-${(entry as any).level}-${(entry as any).message}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(entry);
      } else {
        duplicateCount++;
      }
    }

    return { uniqueEntries: unique, duplicateCount };
  }

  /**
   * 标准化时间戳
   */
  private normalizeTimestamp(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    let fixed = false;
    let timestamp = (entry as any).timestamp;

    // 确保时间戳是数字
    if (typeof timestamp !== 'number') {
      if (typeof timestamp === 'string') {
        const parsed = Date.parse(timestamp);
        if (!isNaN(parsed)) {
          timestamp = parsed;
          fixed = true;
        }
      }
    }

    // 确保时间戳是整数
    if (!Number.isInteger(timestamp)) {
      timestamp = Math.floor(timestamp);
      fixed = true;
    }

    return {
      entry: { ...entry, timestamp },
      fixed
    };
  }

  /**
   * 标准化日志级别
   */
  private normalizeLogLevel(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    let level = entry.level;
    let fixed = false;

    // 转换为大写
    if (typeof level === 'string' && level !== level.toLowerCase()) {
      level = level.toLowerCase() as LogLevel;
      fixed = true;
    }

    // 验证并修复日志级别
    const validLevels = Object.values(LogLevelEnum);
    if (!validLevels.includes(level as LogLevelEnum)) {
      // 尝试修复常见的拼写错误
      const levelMap: Record<string, LogLevel> = {
        'debug': LogLevelEnum.DEBUG,
        'info': LogLevelEnum.INFO,
        'warn': LogLevelEnum.WARN,
        'warning': LogLevelEnum.WARN,
        'error': LogLevelEnum.ERROR,
        'err': LogLevelEnum.ERROR
      };

      const normalizedLevel = levelMap[level.toLowerCase()];
      if (normalizedLevel) {
        level = normalizedLevel;
        fixed = true;
      }
    }

    return {
      entry: { ...entry, level },
      fixed
    };
  }

  /**
   * 修剪消息
   */
  private trimMessage(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    let message = entry.message;
    let fixed = false;

    if (typeof message === 'string') {
      const trimmed = message.trim();
      if (trimmed !== message) {
        message = trimmed;
        fixed = true;
      }

      // 限制消息长度
      const maxLength = this.validationOptions.maxMessageLength;
      if (message.length > maxLength) {
        message = `${message.substring(0, maxLength)  }...`;
        fixed = true;
      }
    }

    return {
      entry: { ...entry, message },
      fixed
    };
  }

  /**
   * 移除空数据字段
   */
  private removeEmptyData(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    if (!entry.data || typeof entry.data !== 'object') {
      return { entry, fixed: false };
    }

    let fixed = false;
    const cleanedData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries((entry as any).data || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedData[key] = value;
      } else {
        fixed = true;
      }
    }

    // 如果清理后数据对象为空，则移除data字段
    if (Object.keys(cleanedData).length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { data: _data, ...rest } = entry as any;
      return {
        entry: rest as UnifiedLogEntry,
        fixed: true
      };
    }

    return {
      entry: { ...entry, data: cleanedData },
      fixed
    };
  }

  /**
   * 标准化模块ID
   */
  private normalizeModuleId(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    let moduleId = entry.moduleId;
    let fixed = false;

    if (typeof moduleId === 'string') {
      // 移除特殊字符，只保留字母数字、下划线和连字符
      const normalized = moduleId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (normalized !== moduleId) {
        moduleId = normalized;
        fixed = true;
      }

      // 转换为小写
      const lowercased = moduleId.toLowerCase();
      if (lowercased !== moduleId) {
        moduleId = lowercased;
        fixed = true;
      }
    }

    return {
      entry: { ...entry, moduleId },
      fixed
    };
  }

  /**
   * 修复常见错误
   */
  private fixCommonErrors(entry: UnifiedLogEntry): { entry: UnifiedLogEntry; fixed: boolean } {
    const cleanedEntry = { ...entry };
    let fixed = false;

    // 修复undefined值
    for (const [key, value] of Object.entries(cleanedEntry)) {
      if (value === undefined) {
        (cleanedEntry as any)[key] = null;
        fixed = true;
      }
    }

    // 修复空数组
    if (cleanedEntry.tags && Array.isArray(cleanedEntry.tags) && cleanedEntry.tags.length === 0) {
      delete (cleanedEntry as any).tags;
      fixed = true;
    }

    // 修复错误对象格式
    if (cleanedEntry.error && typeof cleanedEntry.error === 'object') {
      if (!cleanedEntry.error.name) {cleanedEntry.error.name = 'Error';}
      if (!cleanedEntry.error.message) {cleanedEntry.error.message = 'Unknown error';}
      fixed = true;
    }

    return {
      entry: cleanedEntry,
      fixed
    };
  }

  /**
   * 批量验证和清洗
   */
  async validateAndClean(entries: UnifiedLogEntry[]): Promise<{
    cleanedEntries: UnifiedLogEntry[];
    validationResults: ValidationResult[];
    cleaningResult: CleaningResult;
  }> {
    // 验证所有条目
    const validationResults = entries.map(entry => this.validateEntry(entry));
    
    // 清洗条目
    const cleaningResult = this.cleanEntries(entries);
    
    return {
      cleanedEntries: cleaningResult.cleanedEntries,
      validationResults,
      cleaningResult
    };
  }

  /**
   * 获取验证统计
   */
  getValidationStats(entries: UnifiedLogEntry[]): {
    total: number;
    valid: number;
    invalid: number;
    warnings: number;
    errorTypes: Record<string, number>;
  } {
    const stats = {
      total: entries.length,
      valid: 0,
      invalid: 0,
      warnings: 0,
      errorTypes: {} as Record<string, number>
    };

    for (const entry of entries) {
      const result = this.validateEntry(entry);
      
      if (result.isValid) {
        stats.valid++;
      } else {
        stats.invalid++;
      }
      
      stats.warnings += result.warnings.length;
      
      // 统计错误类型
      for (const error of result.errors) {
        stats.errorTypes[error.type] = (stats.errorTypes[error.type] || 0) + 1;
      }
    }

    return stats;
  }
}

/**
 * 便捷的验证和清洗函数
 */
export async function validateAndCleanLogEntries(
  entries: UnifiedLogEntry[],
  validationOptions?: DataValidationOptions,
  cleaningOptions?: DataCleaningOptions
): Promise<{
  cleanedEntries: UnifiedLogEntry[];
  validationResults: ValidationResult[];
  cleaningResult: CleaningResult;
}> {
  const validator = new DataValidatorAndCleaner(validationOptions, cleaningOptions);
  return validator.validateAndClean(entries);
}

/**
 * 快速验证函数
 */
export function quickValidateLogEntry(entry: unknown): boolean {
  const validator = new DataValidatorAndCleaner({ validationLevel: 'lenient' });
  const result = validator.validateEntry(entry);
  return result.isValid;
}
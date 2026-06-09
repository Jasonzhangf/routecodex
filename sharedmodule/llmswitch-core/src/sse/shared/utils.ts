/**
 * 共享工具函数
 * 提供JSON↔SSE双向转换中常用的工具函数
 */

import { randomUUID } from 'crypto';

/**
 * 字符串工具
 */
export class StringUtils {
  /**
   * 安全地将值转换为字符串
   */
  static safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value ?? {});
    } catch {
      return '{}';
    }
  }

  /**
   * 安全地解析JSON字符串
   */
  static safeParse<T = any>(text: string): T | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * 检查字符串是否为空或只包含空白字符
   */
  static isEmpty(str: string): boolean {
    return !str || str.trim().length === 0;
  }

  /**
   * 检查字符串是否为有效的JSON
   */
  static isValidJson(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 截断字符串到指定长度
   */
  static truncate(str: string, maxLength: number, suffix = '...'): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - suffix.length) + suffix;
  }

  /**
   * 生成随机字符串
   */
  static random(length = 8): string {
    return randomUUID().replace(/-/g, '').slice(0, length);
  }

  /**
   * 分割字符串为块
   */
  static chunkString(text: string, chunkSize: number, boundary: RegExp): string[] {
    const chunks: string[] = [];
    let buf = '';
    const boundaryCharMatcher = /[\s,.!?;:]/;

    const flush = () => {
      if (buf.length) {
        chunks.push(buf);
        buf = '';
      }
    };

    for (const ch of Array.from(text)) {
      buf += ch;
      const matchesBoundary =
        boundaryCharMatcher.test(ch) ||
        (boundary.test(ch) && !/\\b/.test(boundary.source));

      if (buf.length >= chunkSize || (matchesBoundary && buf.length >= Math.max(4, Math.floor(chunkSize / 2)))) {
        flush();
      }
      boundary.lastIndex = 0;
    }
    flush();
    return chunks;
  }
}

/**
 * 时间工具
 */
export class TimeUtils {
  /**
   * 获取当前时间戳（毫秒）
   */
  static now(): number {
    return Date.now();
  }

  /**
   * 获取当前时间戳（秒）
   */
  static nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * 格式化时间戳
   */
  static formatTimestamp(timestamp: number, format = 'ISO'): string {
    const date = new Date(timestamp);
    switch (format) {
      case 'ISO':
        return date.toISOString();
      case 'locale':
        return date.toLocaleString();
      case 'time':
        return date.toTimeString();
      case 'date':
        return date.toDateString();
      default:
        return date.toString();
    }
  }

  /**
   * 延迟指定时间
   */
  static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带超时的Promise
   */
  static timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }
}

/**
 * 验证工具
 */
export class ValidationUtils {
  /**
   * 检查值是否为对象
   */
  static isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * 检查值是否为有效的ID
   */
  static isValidId(value: string, pattern: RegExp): boolean {
    return pattern.test(value);
  }

  /**
   * 验证序列号
   */
  static isValidSequenceNumber(value: number, max = 10000): boolean {
    return Number.isInteger(value) && value >= 0 && value < max;
  }

  /**
   * 验证时间戳
   */
  static isValidTimestamp(value: number): boolean {
    return Number.isInteger(value) && value > 0 && value <= Date.now() + 86400000; // 允许未来1天
  }

  /**
   * 验证JSON结构
   */
  static validateJsonStructure(obj: any, schema: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const validate = (value: any, schemaNode: any, path: string = '') => {
      if (schemaNode.required && (value == null || value === '')) {
        errors.push(`${path}: Required field missing`);
        return;
      }

      if (value == null) return; // 可选字段且为空

      if (schemaNode.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== schemaNode.type) {
          errors.push(`${path}: Expected ${schemaNode.type}, got ${actualType}`);
          return;
        }
      }

      if (schemaNode.properties && typeof value === 'object') {
        Object.entries(schemaNode.properties).forEach(([key, subSchema]: [string, any]) => {
          validate(value[key], subSchema, path ? `${path}.${key}` : key);
        });
      }
    };

    validate(obj, schema);
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

/**
 * ID生成工具
 */
export class IdUtils {
  /**
   * 生成请求ID
   */
  static generateRequestId(): string {
    return `req_${Date.now()}`;
  }

  /**
   * 生成响应ID
   */
  static generateResponseId(): string {
    return `resp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /**
   * 生成推理项目ID
   */
  static generateReasoningId(): string {
    return `rs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /**
   * 生成函数调用ID
   */
  static generateFunctionCallId(): string {
    return `fc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /**
   * 生成工具调用ID
   */
  static generateToolCallId(): string {
    return `call_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  }

  /**
   * 生成消息ID
   */
  static generateMessageId(): string {
    return `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}

/**
 * 错误处理工具
 */
export class ErrorUtils {
  /**
   * 创建标准错误
   */
  static createError(
    message: string,
    code: string,
    context?: any
  ): Error & { code: string; context?: any } {
    const error = new Error(message) as Error & { code: string; context?: any };
    error.code = code;
    error.context = context;
    return error;
  }

  /**
   * 包装错误
   */
  static wrapError(error: unknown, context?: string): Error {
    if (error instanceof Error) {
      if (context) {
        error.message = `${context}: ${error.message}`;
      }
      return error;
    }
    return new Error(`${context || 'Unknown'}: ${String(error)}`);
  }

  /**
   * 判断是否为超时错误
   */
  static isTimeoutError(error: Error): boolean {
    return error.message.toLowerCase().includes('timeout') ||
           error.name === 'TimeoutError' ||
           (error as any).code === 'TIMEOUT';
  }

  /**
   * 判断是否为网络错误
   */
  static isNetworkError(error: Error): boolean {
    return error.message.toLowerCase().includes('network') ||
           error.message.toLowerCase().includes('connection') ||
           (error as any).code === 'ECONNRESET' ||
           (error as any).code === 'ENOTFOUND';
  }
}

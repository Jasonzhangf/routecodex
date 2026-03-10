/**
 * 共享工具函数
 * 提供JSON↔SSE双向转换中常用的工具函数
 */

import { randomUUID } from 'crypto';
import { Readable } from 'stream';

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
 * 对象工具
 */
export class ObjectUtils {
  /**
   * 深度冻结对象
   */
  static deepFreeze<T>(obj: T): T {
    Object.getOwnPropertyNames(obj).forEach(prop => {
      const value = obj[prop as keyof T];
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        ObjectUtils.deepFreeze(value);
      }
    });
    return Object.freeze(obj);
  }

  /**
   * 深度克隆对象
   */
  static deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T;
    if (obj instanceof Array) return obj.map(item => ObjectUtils.deepClone(item)) as unknown as T;
    if (typeof obj === 'object') {
      const cloned = {} as T;
      Object.keys(obj).forEach(key => {
        cloned[key as keyof T] = ObjectUtils.deepClone(obj[key as keyof T]);
      });
      return cloned;
    }
    return obj;
  }

  /**
   * 安全地获取嵌套对象属性
   */
  static get(obj: any, path: string, defaultValue: any = undefined): any {
    const keys = path.split('.');
    let result = obj;
    for (const key of keys) {
      if (result == null || typeof result !== 'object') {
        return defaultValue;
      }
      result = result[key];
    }
    return result !== undefined ? result : defaultValue;
  }

  /**
   * 安全地设置嵌套对象属性
   */
  static set(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] == null || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
  }

  /**
   * 检查对象是否为空
   */
  static isEmpty(obj: any): boolean {
    if (obj == null) return true;
    if (Array.isArray(obj)) return obj.length === 0;
    if (typeof obj === 'object') return Object.keys(obj).length === 0;
    return false;
  }

  /**
   * 合并对象
   */
  static merge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
    return { ...target, ...source };
  }
}

/**
 * 数组工具
 */
export class ArrayUtils {
  /**
   * 数组去重
   */
  static unique<T>(arr: T[]): T[] {
    return [...new Set(arr)];
  }

  /**
   * 分组数组
   */
  static groupBy<T, K extends string | number>(
    arr: T[],
    keyFn: (item: T) => K
  ): Record<K, T[]> {
    return arr.reduce((groups, item) => {
      const key = keyFn(item);
      groups[key] = groups[key] || [];
      groups[key].push(item);
      return groups;
    }, {} as Record<K, T[]>);
  }

  /**
   * 分块数组
   */
  static chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * 扁平化数组
   */
  static flatten<T>(arr: (T | T[])[]): T[] {
    const result: T[] = [];
    for (const item of arr) {
      if (Array.isArray(item)) {
        result.push(...ArrayUtils.flatten(item));
      } else {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * 找到数组中的差异
   */
  static diff<T>(arr1: T[], arr2: T[]): { added: T[]; removed: T[]; common: T[] } {
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);

    return {
      added: arr2.filter(item => !set1.has(item)),
      removed: arr1.filter(item => !set2.has(item)),
      common: arr1.filter(item => set2.has(item))
    };
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
 * 流工具
 */
export class StreamUtils {
  /**
   * 创建可读流
   */
  static createReadable<T>(data: T[]): Readable {
    let index = 0;
    return new Readable({
      objectMode: true,
      read() {
        if (index < data.length) {
          this.push(data[index++]);
        } else {
          this.push(null);
        }
      }
    });
  }

  /**
   * 将异步生成器转换为流
   */
  static asyncGeneratorToStream<T>(
    generator: AsyncGenerator<T>
  ): Readable {
    return new Readable({
      objectMode: true,
      async read() {
        try {
          const { value, done } = await generator.next();
          if (done) {
            this.push(null);
          } else {
            this.push(value);
          }
        } catch (error) {
          this.destroy(error as Error);
        }
      }
    });
  }

  /**
   * 将流转换为数组
   */
  static async streamToArray<T>(stream: Readable): Promise<T[]> {
    const chunks: T[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return chunks;
  }

  /**
   * 管道流超时
   */
  static pipeWithTimeout<T>(
    source: Readable,
    destination: NodeJS.WritableStream,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        source.destroy();
        const destroy = (destination as NodeJS.WritableStream & { destroy?: (error?: Error) => void }).destroy;
        if (typeof destroy === 'function') {
          destroy.call(destination);
        }
        reject(new Error(`Pipe timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      source.pipe(destination);
      destination.on('finish', () => {
        clearTimeout(timeout);
        resolve();
      });
      destination.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
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

/**
 * 正则表达式模式
 */
export const REGEX_PATTERNS = {
  WORD_BOUNDARY: /\s|\b|[,.!?;:]/
} as const;

/**
 * 性能监控工具
 */
export class PerformanceUtils {
  /**
   * 创建性能计时器
   */
  static createTimer(): () => number {
    const start = performance.now();
    return () => performance.now() - start;
  }

  /**
   * 测量函数执行时间
   */
  static async measureTime<T>(
    fn: () => T | Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const timer = PerformanceUtils.createTimer();
    const result = await fn();
    const duration = timer();
    return { result, duration };
  }

  /**
   * 创建内存使用快照
   */
  static createMemorySnapshot(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  } {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external
    };
  }
}

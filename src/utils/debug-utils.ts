/**
 * Debug Utility Functions
 *
 * This file provides utility functions for the RouteCodex debugging system,
 * including data sanitization, formatting, performance measurement, and other helpers.
 */

import type {
  DebugUtils,
  SanitizeOptions,
  FormatOptions,
  PerformanceMarker,
} from '../types/debug-types.js';

/**
 * Debug utility implementation
 */
export class DebugUtilsImpl implements DebugUtils {
  private readonly defaultSensitiveFields = [
    'password',
    'token',
    'secret',
    'key',
    'auth',
    'credential',
    'api_key',
    'apikey',
    'authorization',
    'cookie',
    'session',
    'jwt',
  ];

  /**
   * Sanitize data for logging (remove sensitive information)
   */
  sanitizeData(data: any, options: SanitizeOptions = {}): any {
    const opts: SanitizeOptions = {
      redactFields: this.defaultSensitiveFields,
      maxDepth: 5,
      maxStringLength: 1000,
      maxArrayLength: 50,
      ...options,
    };

    return this.doSanitizeData(data, opts, 0);
  }

  /**
   * Format data for display
   */
  formatData(data: any, options: FormatOptions = {}): string {
    const opts: FormatOptions = {
      format: 'json',
      indent: 2,
      ...options,
    };

    switch (opts.format) {
      case 'json':
        return JSON.stringify(data, null, opts.indent);
      case 'pretty':
        return this.formatPretty(data, opts.indent);
      case 'compact':
        return JSON.stringify(data);
      case 'custom':
        return opts.customFormatter ? opts.customFormatter(data) : JSON.stringify(data);
      default:
        return JSON.stringify(data);
    }
  }

  /**
   * Calculate data size
   */
  calculateDataSize(data: any): number {
    if (data === null || data === undefined) {
      return 0;
    }

    if (typeof data === 'string') {
      return data.length;
    }

    if (typeof data === 'number') {
      return 8;
    }

    if (typeof data === 'boolean') {
      return 1;
    }

    if (Array.isArray(data)) {
      return data.reduce((total, item) => total + this.calculateDataSize(item), 0);
    }

    if (typeof data === 'object') {
      return Object.entries(data).reduce((total, [key, value]) => {
        return total + key.length + this.calculateDataSize(value);
      }, 0);
    }

    return String(data).length;
  }

  /**
   * Deep clone data
   */
  deepClone<T>(data: T): T {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data !== 'object') {
      return data;
    }

    if (data instanceof Date) {
      return new Date(data.getTime()) as T;
    }

    if (data instanceof RegExp) {
      return new RegExp(data.source, data.flags) as T;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.deepClone(item)) as T;
    }

    const cloned: any = {};
    for (const [key, value] of Object.entries(data)) {
      cloned[key] = this.deepClone(value);
    }

    return cloned;
  }

  /**
   * Generate unique identifier
   */
  generateId(prefix: string = ''): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2);
    return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
  }

  /**
   * Measure execution time
   */
  measureTime<T>(fn: () => T): { result: T; time: number } {
    const startTime = process.hrtime.bigint();
    const result = fn();
    const endTime = process.hrtime.bigint();
    const time = Number(endTime - startTime) / 1000000; // Convert to milliseconds

    return { result, time };
  }

  /**
   * Measure async execution time
   */
  async measureTimeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; time: number }> {
    const startTime = process.hrtime.bigint();
    const result = await fn();
    const endTime = process.hrtime.bigint();
    const time = Number(endTime - startTime) / 1000000; // Convert to milliseconds

    return { result, time };
  }

  /**
   * Create performance marker
   */
  createPerformanceMarker(name: string): PerformanceMarker {
    return new PerformanceMarkerImpl(name);
  }

  /**
   * Internal method to sanitize data recursively
   */
  private doSanitizeData(data: any, options: SanitizeOptions, depth: number): any {
    // Check depth limit
    if (depth > (options.maxDepth || 5)) {
      return '[MAX_DEPTH_REACHED]';
    }

    // Handle null/undefined
    if (data === null || data === undefined) {
      return data;
    }

    // Handle primitives
    if (typeof data !== 'object') {
      return data;
    }

    // Handle Date objects
    if (data instanceof Date) {
      return data.toISOString();
    }

    // Handle RegExp objects
    if (data instanceof RegExp) {
      return data.toString();
    }

    // Handle Error objects
    if (data instanceof Error) {
      return {
        name: data.name,
        message: data.message,
        stack: data.stack,
      };
    }

    // Handle Arrays
    if (Array.isArray(data)) {
      if (data.length > (options.maxArrayLength || 50)) {
        return {
          type: 'array',
          length: data.length,
          truncated: true,
          data: data
            .slice(0, options.maxArrayLength)
            .map(item => this.doSanitizeData(item, options, depth + 1)),
        };
      }

      return data.map(item => this.doSanitizeData(item, options, depth + 1));
    }

    // Handle Objects
    const sanitized: any = {};
    let entriesProcessed = 0;
    const maxEntries = options.maxArrayLength || 50;

    for (const [key, value] of Object.entries(data)) {
      // Check field limit
      if (entriesProcessed >= maxEntries) {
        sanitized['_truncated'] = true;
        break;
      }

      // Check for sensitive fields
      if (this.isSensitiveField(key, options.redactFields || [])) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.doSanitizeData(value, options, depth + 1);
      }

      entriesProcessed++;
    }

    return sanitized;
  }

  /**
   * Check if a field is sensitive
   */
  private isSensitiveField(fieldName: string, sensitiveFields: string[]): boolean {
    const normalizedName = fieldName.toLowerCase();
    return sensitiveFields.some(field => normalizedName.includes(field.toLowerCase()));
  }

  /**
   * Format data in pretty print style
   */
  private formatPretty(data: any, indent: number = 2): string {
    if (typeof data !== 'object' || data === null) {
      return String(data);
    }

    const indentStr = ' '.repeat(indent);
    const lines: string[] = [];

    if (Array.isArray(data)) {
      lines.push('[');
      data.forEach((item, index) => {
        const itemStr = this.formatPretty(item, indent + 2);
        lines.push(`${indentStr}  ${itemStr}${index < data.length - 1 ? ',' : ''}`);
      });
      lines.push(`${indentStr}]`);
    } else {
      lines.push('{');
      const entries = Object.entries(data);
      entries.forEach(([key, value], index) => {
        const valueStr = this.formatPretty(value, indent + 2);
        lines.push(`${indentStr}  ${key}: ${valueStr}${index < entries.length - 1 ? ',' : ''}`);
      });
      lines.push(`${indentStr}}`);
    }

    return lines.join('\n');
  }
}

/**
 * Performance marker implementation
 */
class PerformanceMarkerImpl implements PerformanceMarker {
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  duration?: number;

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
  }

  /**
   * Stop the marker and return duration
   */
  stop(): number {
    if (this.endTime === undefined) {
      this.endTime = Date.now();
      this.duration = this.endTime - this.startTime;
    }
    return this.duration || 0;
  }

  /**
   * Get current duration
   */
  getDuration(): number {
    const end = this.endTime || Date.now();
    return end - this.startTime;
  }
}

/**
 * Utility functions for common debug operations
 */
export class DebugUtilsStatic {
  private static instance: DebugUtilsImpl;

  /**
   * Get singleton instance
   */
  static getInstance(): DebugUtilsImpl {
    if (!DebugUtilsStatic.instance) {
      DebugUtilsStatic.instance = new DebugUtilsImpl();
    }
    return DebugUtilsStatic.instance;
  }

  /**
   * Sanitize data for logging
   */
  static sanitizeData(data: any, options?: SanitizeOptions): any {
    return DebugUtilsStatic.getInstance().sanitizeData(data, options);
  }

  /**
   * Format data for display
   */
  static formatData(data: any, options?: FormatOptions): string {
    return DebugUtilsStatic.getInstance().formatData(data, options);
  }

  /**
   * Calculate data size
   */
  static calculateDataSize(data: any): number {
    return DebugUtilsStatic.getInstance().calculateDataSize(data);
  }

  /**
   * Deep clone data
   */
  static deepClone<T>(data: T): T {
    return DebugUtilsStatic.getInstance().deepClone(data);
  }

  /**
   * Generate unique identifier
   */
  static generateId(prefix?: string): string {
    return DebugUtilsStatic.getInstance().generateId(prefix);
  }

  /**
   * Measure execution time
   */
  static measureTime<T>(fn: () => T): { result: T; time: number } {
    return DebugUtilsStatic.getInstance().measureTime(fn);
  }

  /**
   * Measure async execution time
   */
  static measureTimeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; time: number }> {
    return DebugUtilsStatic.getInstance().measureTimeAsync(fn);
  }

  /**
   * Create performance marker
   */
  static createPerformanceMarker(name: string): PerformanceMarker {
    return DebugUtilsStatic.getInstance().createPerformanceMarker(name);
  }

  /**
   * Extract error information safely
   */
  static extractErrorInfo(error: any): {
    message: string;
    stack?: string;
    name?: string;
    code?: string;
  } {
    if (error instanceof Error) {
      return {
        message: error.message,
        stack: error.stack,
        name: error.name,
        code: (error as any).code,
      };
    }

    if (typeof error === 'string') {
      return {
        message: error,
        name: 'StringError',
      };
    }

    if (typeof error === 'object' && error !== null) {
      return {
        message: error.message || String(error),
        stack: error.stack,
        name: error.name || 'ObjectError',
        code: error.code,
      };
    }

    return {
      message: String(error),
      name: 'UnknownError',
    };
  }

  /**
   * Truncate string if too long
   */
  static truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return `${str.substring(0, maxLength - 3)}...`;
  }

  /**
   * Format bytes to human readable format
   */
  static formatBytes(bytes: number, decimals: number = 2): string {
    if (bytes === 0) {
      return '0 Bytes';
    }

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  /**
   * Format duration to human readable format
   */
  static formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) {
      return `${milliseconds.toFixed(0)}ms`;
    }

    const seconds = milliseconds / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }

    const minutes = seconds / 60;
    if (minutes < 60) {
      return `${minutes.toFixed(1)}m`;
    }

    const hours = minutes / 60;
    return `${hours.toFixed(1)}h`;
  }

  /**
   * Get current memory usage
   */
  static getMemoryUsage(): {
    used: number;
    total: number;
    percentage: number;
  } {
    const usage = process.memoryUsage();
    const percentage = (usage.heapUsed / usage.heapTotal) * 100;

    return {
      used: usage.heapUsed,
      total: usage.heapTotal,
      percentage,
    };
  }

  /**
   * Safe JSON parsing
   */
  static safeJsonParse<T = any>(jsonString: string, defaultValue: T): T {
    try {
      return JSON.parse(jsonString);
    } catch {
      return defaultValue;
    }
  }

  /**
   * Safe JSON stringifying
   */
  static safeJsonStringify(data: any, indent?: number): string {
    try {
      return JSON.stringify(data, null, indent);
    } catch {
      return String(data);
    }
  }

  /**
   * Create debounced function
   */
  static debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
  ): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;

    return (...args: Parameters<T>) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  /**
   * Create throttled function
   */
  static throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
  ): (...args: Parameters<T>) => void {
    let inThrottle: boolean;

    return (...args: Parameters<T>) => {
      if (!inThrottle) {
        func(...args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  /**
   * Create retry function
   */
  static async retry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) {
          throw lastError;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Validate and normalize port number
   */
  static normalizePort(port: string | number): number {
    const portNum = typeof port === 'string' ? parseInt(port, 10) : port;

    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid port number: ${port}`);
    }

    return portNum;
  }

  /**
   * Validate URL
   */
  static isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  static getNestedValue(obj: any, path: string, defaultValue?: any): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : defaultValue;
    }, obj);
  }

  /**
   * Set nested value in object using dot notation
   */
  static setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      if (current[key] === undefined) {
        current[key] = {};
      }
      return current[key];
    }, obj);

    target[lastKey] = value;
  }
}

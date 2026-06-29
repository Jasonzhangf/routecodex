/**
 * 字符串工具
 */
export class StringUtils {
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
}

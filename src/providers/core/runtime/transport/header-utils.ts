/**
 * Header Utilities
 *
 * 提供头部操作的工具函数：
 * - 查找、赋值、删除头部字段
 * - 头部 key 标准化
 */

export class HeaderUtils {
  static findHeaderValue(headers: Record<string, string>, target: string): string | undefined {
    const lowered = typeof target === 'string' ? target.toLowerCase() : '';
    if (!lowered) {
      return undefined;
    }
    const normalizedTarget = HeaderUtils.normalizeHeaderKey(lowered);
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      const loweredKey = key.toLowerCase();
      if (loweredKey === lowered) {
        return trimmed;
      }
      if (HeaderUtils.normalizeHeaderKey(loweredKey) === normalizedTarget) {
        return trimmed;
      }
    }
    return undefined;
  }

  static normalizeHeaderKey(value: string): string {
    if (!value) {
      return '';
    }
    return value.replace(/[\s_-]+/g, '');
  }

  static assignHeader(headers: Record<string, string>, target: string, value: string): void {
    if (!value || !value.trim()) {
      return;
    }
    const lowered = target.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowered) {
        headers[key] = value;
        return;
      }
    }
    headers[target] = value;
  }

  static deleteHeader(headers: Record<string, string>, target: string): void {
    const lowered = typeof target === 'string' ? target.toLowerCase() : '';
    if (!lowered) {
      return;
    }
    const normalizedTarget = HeaderUtils.normalizeHeaderKey(lowered);
    for (const key of Object.keys(headers)) {
      const loweredKey = key.toLowerCase();
      if (loweredKey === lowered) {
        delete headers[key];
        continue;
      }
      if (HeaderUtils.normalizeHeaderKey(loweredKey) === normalizedTarget) {
        delete headers[key];
      }
    }
  }

  static setHeaderIfMissing(
    headers: Record<string, string>,
    target: string,
    value: string
  ): void {
    if (HeaderUtils.findHeaderValue(headers, target)) {
      return;
    }
    HeaderUtils.assignHeader(headers, target, value);
  }

  static copyHeaderValue(
    target: Record<string, string>,
    source: Record<string, string>,
    from: string,
    to: string
  ): void {
    if (HeaderUtils.findHeaderValue(target, to)) {
      return;
    }
    const value = HeaderUtils.findHeaderValue(source, from);
    if (value) {
      target[to] = value;
    }
  }
}

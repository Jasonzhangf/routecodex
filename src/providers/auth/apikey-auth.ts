/**
 * API Key Authentication - API Key认证实现
 *
 * 提供标准的API Key认证功能
 */

import type { IAuthProvider, AuthStatus } from './auth-interface.js';
import type { ApiKeyAuth } from '../core/api/provider-config.js';

import type { ApiKeyEntry, ApiKeyAuthConfig } from '../profile/provider-profile.js';

export type ApiKeySelectionMode = 'round-robin' | 'priority';

/**
 * API Key认证提供者
 *
 * 实现标准的API Key认证机制
 */
export class ApiKeyAuthProvider implements IAuthProvider {
 readonly type = 'apikey' as const;

 private config: ApiKeyAuth;
 private status: AuthStatus;
 private isInitialized = false;
  private rotator: ApiKeyRotator | null = null;

  constructor(config: ApiKeyAuth, rotator?: ApiKeyRotator) {
    this.config = config;
    this.rotator = rotator ?? null;
    this.status = {
      isAuthenticated: false,
      isValid: false,
      lastValidated: 0,
      error: undefined
    };
  }

  private isOpenCodeZenPublicKeyMode(): boolean {
    const rawType = typeof this.config.rawType === 'string' ? this.config.rawType.trim().toLowerCase() : '';
    const apiKey = typeof this.config.apiKey === 'string' ? this.config.apiKey.trim() : '';
    return rawType === 'opencode-zen-public' && apiKey === 'public';
  }

  /**
   * 初始化认证
   */
  async initialize(): Promise<void> {
    try {
      // 多 key 模式：初始化时先取当前 key
      if (this.rotator) {
        const currentKey = this.rotator.getCurrentKey();
        this.config.apiKey = currentKey ?? '';
      }

      // Local no-auth: allow empty API key (e.g., LM Studio / localhost endpoints).
      if (typeof this.config.apiKey !== 'string') {
        throw new Error('Invalid API key: must be a string');
      }
      if (!this.config.apiKey.trim()) {
        this.isInitialized = true;
        this.updateStatus(true, true, 'API key is empty (no-auth mode)');
        return;
      }

      // 验证API Key基本格式
      if (this.config.apiKey.length < 10 && !this.isOpenCodeZenPublicKeyMode()) {
        throw new Error('Invalid API key: too short');
      }

      this.isInitialized = true;
      this.updateStatus(true, true, 'API key validated successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateStatus(false, false, errorMessage);
      throw error;
    }
  }

  /**
   * 构建认证头部
   */
  buildHeaders(): Record<string, string> {
    if (!this.isInitialized) {
      throw new Error('ApiKeyAuthProvider is not initialized');
    }
    if (!this.config.apiKey.trim()) {
      return {};
    }

    const headers: Record<string, string> = {};

    // 支持多种header名称
    const headerName = this.config.headerName || 'Authorization';

    if (headerName.toLowerCase() === 'authorization') {
      // 标准Authorization header
      const prefix = this.config.prefix || 'Bearer';
      headers[headerName] = `${prefix} ${this.config.apiKey}`;
    } else {
      // 自定义header名称
      headers[headerName] = this.config.apiKey;
    }

    return headers;
  }

  /**
   * 验证凭证
   */
  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }

    try {
      if (!this.config.apiKey.trim()) {
        this.updateStatus(true, true, 'No-auth credentials validated');
        return true;
      }
      // 基本验证：检查API key是否仍然有效
      const isValid = this.config.apiKey.length >= 10 || this.isOpenCodeZenPublicKeyMode();

      this.updateStatus(true, isValid, isValid ? 'Credentials validated' : 'Invalid credentials');
      return isValid;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation failed';
      this.updateStatus(true, false, errorMessage);
      return false;
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    // 清理API key内存
    this.config.apiKey = '';
    this.isInitialized = false;
    this.updateStatus(false, false, 'Provider cleaned up');
  }

  /**
   * 获取认证状态
   */
  getStatus(): AuthStatus {
    return { ...this.status };
  }

  /**
   * 更新认证状态
   */
  private updateStatus(isAuthenticated: boolean, isValid: boolean, message?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      error: isValid ? undefined : message
    };
  }

  /**
   * 刷新凭证 (API Key认证不支持刷新)
   */
  async refreshCredentials?(): Promise<void> {
    // API Key认证不支持刷新，但可以重新验证
    await this.validateCredentials();
  }

  /**
   * 获取API Key信息（用于调试）
   */
  getApiKeyInfo(): {
    length: number;
    prefix: string;
    hasCustomHeader: boolean;
  } {
    return {
      length: this.config.apiKey.length,
      prefix: this.config.prefix || 'Bearer',
      hasCustomHeader: !!this.config.headerName && this.config.headerName !== 'Authorization'
    };
  }

  /**
   * 轮询到下一个 API Key
   * 仅在多 key 模式下有效
   */
  rotateKey(): boolean {
    if (!this.rotator) {
      return false;
    }
    const nextKey = this.rotator.rotate();
    if (nextKey) {
      this.config.apiKey = nextKey;
      return true;
    }
    return false;
  }

  /**
   * 获取轮询器（用于高级控制）
   */
  getRotator(): ApiKeyRotator | null {
    return this.rotator;
  }
}

/**
 * 多 API Key 轮询器
 * 支持在多个 API Key 之间轮询选择
 */
export class ApiKeyRotator {
  private entries: ApiKeyEntry[] = [];
  private currentIndex = 0;
  private readonly selectionMode: ApiKeySelectionMode;

  constructor(entries: ApiKeyEntry[], selectionMode: ApiKeySelectionMode = 'round-robin') {
    this.entries = entries;
    this.selectionMode = selectionMode;
    if (entries.length > 1) {
      try {
        console.log(`[key-rotator] initialized providerKey=${entries.map(e => e.alias || '?').join(',')}`);
      } catch { /* best-effort */ }
    }
  }


  private isEntryDisabled(entry: ApiKeyEntry): boolean {
    if (!entry) return true;
    if (entry.disabled === true) {
      if (typeof entry.disabledUntil === 'number' && entry.disabledUntil > 0) {
        if (Date.now() >= entry.disabledUntil) {
          entry.disabled = false;
          entry.disabledUntil = 0;
          return false;
        }
      }
      return true;
    }
    if (typeof entry.disabledUntil === 'number' && entry.disabledUntil > Date.now()) {
      return true;
    }
    return false;
  }

  private findNextEnabledIndex(startIndex: number): number {
    if (this.entries.length === 0) return -1;
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (startIndex + i) % this.entries.length;
      const entry = this.entries[idx];
      if (entry && !this.isEntryDisabled(entry)) {
        return idx;
      }
    }
    return -1;
  }

  /**
   * 添加条目
   */
  addEntry(entry: ApiKeyEntry): void {
    this.entries.push(entry);
  }

  /**
   * 获取当前 API Key（已解析环境变量）
   */
  getCurrentKey(): string | undefined {
    const current = this.entries[this.currentIndex];
    if (current && !this.isEntryDisabled(current)) {
      return this.resolveEntry(current);
    }
    const next = this.findNextEnabledIndex(this.currentIndex);
    if (next < 0) {
      return undefined;
    }
    this.currentIndex = next;
    return this.resolveEntry(this.entries[this.currentIndex]);
  }

  /**
   * 轮询切换到下一个 API Key
   */
  rotate(): string | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }
    const next = this.findNextEnabledIndex((this.currentIndex + 1) % this.entries.length);
    if (next < 0) {
      return undefined;
    }
    this.currentIndex = next;
    return this.getCurrentKey();
  }

  /**
   * 选择指定别名的 API Key
   */
  selectByAlias(alias: string): string | undefined {
    const index = this.entries.findIndex(e => e.alias === alias);
    if (index < 0) {
      return undefined;
    }
    this.currentIndex = index;
    return this.getCurrentKey();
  }

  /**
   * 获取当前条目信息
   */
  getCurrentEntry(): ApiKeyEntry | undefined {
    return this.entries[this.currentIndex];
  }

  /**
   * 获取条目数量
   */
  getEntryCount(): number {
    return this.entries.length;
  }


  /**
   * 禁用当前 key（支持永久或冷却）
   */
  disableCurrent(reason: 'permanent' | 'cooldown', cooldownMs = 0): void {
    const entry = this.entries[this.currentIndex];
    if (!entry) return;
    if (reason === 'permanent') {
      entry.disabled = true;
      entry.disabledUntil = Number.MAX_SAFE_INTEGER;
      return;
    }
    const now = Date.now();
    entry.disabled = true;
    entry.disabledUntil = now + Math.max(0, Math.floor(cooldownMs));
  }

  /**
   * 当前可用 key 数
   */
  getEnabledCount(): number {
    return this.entries.filter((e) => e && !this.isEntryDisabled(e)).length;
  }

  /**
   * 解析条目中的 API Key（支持环境变量）
   */
  private resolveEntry(entry: ApiKeyEntry): string | undefined {
    if (entry.apiKey) {
      return this.expandEnvVars(entry.apiKey);
    }
    if (entry.env) {
      return process.env[entry.env];
    }
    return undefined;
  }

  /**
   * 展开环境变量 ${VAR} 格式
   */
  private expandEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      return process.env[name] ?? '';
    });
  }
}

/**
 * 从 ApiKeyAuthConfig 创建 ApiKeyRotator
 */
export function createApiKeyRotator(config: ApiKeyAuthConfig): ApiKeyRotator | null {
  const entries: ApiKeyEntry[] = [];
  
  // 优先使用 entries 数组
  if (config.entries && config.entries.length > 0) {
    entries.push(...config.entries);
  }
  // 兼容单 key 模式
  else if (config.apiKey || config.env) {
    entries.push({
      apiKey: config.apiKey,
      env: config.env,
      secretRef: config.secretRef,
    });
  }
  
  if (entries.length === 0) {
    return null;
  }

  return new ApiKeyRotator(entries, config.selectionMode ?? 'round-robin');
}

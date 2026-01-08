import type { MessageCenter } from '../message-center/index.js';
import type { TokenDescriptor } from './token-types.js';

/**
 * Token Daemon 事件类型定义
 */
export type TokenDaemonEventType =
  | 'token:refreshed'
  | 'token:expired'
  | 'token:refresh-failed'
  | 'token:auto-suspended';

/**
 * Token 刷新成功事件
 */
export interface TokenRefreshedEvent {
  provider: string;
  alias: string;
  filePath: string;
  displayName: string;
  timestamp: number;
  mode: 'auto' | 'manual';
}

/**
 * Token 过期事件
 */
export interface TokenExpiredEvent {
  provider: string;
  alias: string;
  filePath: string;
  displayName: string;
  expiresAt: number | null;
  timestamp: number;
}

/**
 * Token 刷新失败事件
 */
export interface TokenRefreshFailedEvent {
  provider: string;
  alias: string;
  filePath: string;
  displayName: string;
  error: string;
  timestamp: number;
  mode: 'auto' | 'manual';
}

/**
 * Token 自动暂停事件
 */
export interface TokenAutoSuspendedEvent {
  provider: string;
  alias: string;
  filePath: string;
  displayName: string;
  failureStreak: number;
  suspendedAt: number;
  timestamp: number;
}

export type TokenDaemonEventData =
  | TokenRefreshedEvent
  | TokenExpiredEvent
  | TokenRefreshFailedEvent
  | TokenAutoSuspendedEvent;

/**
 * Token Daemon 消息总线集成器
 * 负责将 Token Daemon 的事件发布到系统 MessageCenter
 */
export class TokenDaemonMessageBus {
  private messageCenter: MessageCenter | null = null;
  private enabled = false;
  private subscriptions: Set<string> = new Set();

  /**
   * 附加到 MessageCenter
   */
  attach(messageCenter: MessageCenter): void {
    this.messageCenter = messageCenter;
    this.enabled = true;
  }

  /**
   * 从 MessageCenter 分离
   */
  detach(): void {
    if (this.messageCenter && this.subscriptions.size) {
      for (const id of this.subscriptions) {
        try {
          this.messageCenter.unsubscribe(id);
        } catch {
          /* best-effort */
        }
      }
    }
    this.subscriptions.clear();
    this.messageCenter = null;
    this.enabled = false;
  }

  /**
   * 订阅指定主题，返回订阅 ID
   */
  subscribe(topic: string, handler: (data: unknown) => void): string {
    if (!this.enabled || !this.messageCenter) {
      return '';
    }
    const id = this.messageCenter.subscribe(topic, (message) => {
      try {
        handler(message);
      } catch {
        /* best-effort */
      }
    });
    this.subscriptions.add(id);
    return id;
  }

  /**
   * 取消订阅
   */
  unsubscribe(subscriptionId: string): void {
    if (!this.messageCenter || !subscriptionId) {
      return;
    }
    try {
      this.messageCenter.unsubscribe(subscriptionId);
    } catch {
      /* best-effort */
    }
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * 发布 token 刷新成功事件
   */
  notifyTokenRefreshed(
    token: TokenDescriptor,
    mode: 'auto' | 'manual'
  ): void {
    if (!this.enabled || !this.messageCenter) {
      return;
    }

    const event: TokenRefreshedEvent = {
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      timestamp: Date.now(),
      mode
    };

    this.messageCenter.publish('token:refreshed', event);
  }

  /**
   * 发布 token 过期事件
   */
  notifyTokenExpired(token: TokenDescriptor): void {
    if (!this.enabled || !this.messageCenter) {
      return;
    }

    const event: TokenExpiredEvent = {
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      expiresAt: token.state.expiresAt,
      timestamp: Date.now()
    };

    this.messageCenter.publish('token:expired', event);
  }

  /**
   * 发布 token 刷新失败事件
   */
  notifyTokenRefreshFailed(
    token: TokenDescriptor,
    error: string | Error,
    mode: 'auto' | 'manual'
  ): void {
    if (!this.enabled || !this.messageCenter) {
      return;
    }

    const event: TokenRefreshFailedEvent = {
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
      mode
    };

    this.messageCenter.publish('token:refresh-failed', event);
  }

  /**
   * 发布 token 自动暂停事件
   */
  notifyTokenAutoSuspended(
    token: TokenDescriptor,
    failureStreak: number,
    suspendedAt: number
  ): void {
    if (!this.enabled || !this.messageCenter) {
      return;
    }

    const event: TokenAutoSuspendedEvent = {
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      failureStreak,
      suspendedAt,
      timestamp: Date.now()
    };

    this.messageCenter.publish('token:auto-suspended', event);
  }

  /**
   * 获取当前状态
   */
  get isEnabled(): boolean {
    return this.enabled && this.messageCenter !== null;
  }
}

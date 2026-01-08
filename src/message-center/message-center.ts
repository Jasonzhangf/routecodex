/**
 * MessageCenter - 主题订阅与消息路由系统
 *
 * 提供发布/订阅模式的消息总线，支持主题通配符、
 * 消息过滤、订阅者隔离等功能
 */

export type Topic = string;
export type TopicPattern = string;

export type MessageHandler<T = unknown> = (message: T, topic: string) => void | Promise<void>;

export interface Subscription<T = unknown> {
  id: string;
  pattern: TopicPattern;
  handler: MessageHandler<T>;
  once?: boolean;
}

export interface PublishOptions {
  /**
   * 是否异步执行订阅者回调
   */
  async?: boolean;
  /**
   * 订阅者执行超时时间（毫秒）
   */
  timeout?: number;
}

export interface MessageCenterOptions {
  /**
   * 是否启用调试日志
   */
  debug?: boolean;
  /**
   * 订阅者默认超时时间（毫秒）
   */
  defaultHandlerTimeout?: number;
}

export class MessageCenter {
  private subscriptions: Map<Topic, Set<Subscription<unknown>>> = new Map();
  private subscriptionIdCounter = 0;
  private readonly options: MessageCenterOptions;
  private readonly debug: (msg: string) => void;

  constructor(options?: Partial<MessageCenterOptions>) {
    this.options = {
      debug: false,
      defaultHandlerTimeout: 5000,
      ...options
    };

    this.debug = (msg: string) => {
      if (this.options.debug) {
        console.log(`[MessageCenter] ${msg}`);
      }
    };
  }

  /**
   * 发布消息到指定主题
   */
  async publish<T = unknown>(
    topic: Topic,
    message: T,
    options?: PublishOptions
  ): Promise<void> {
    this.debug(`Publishing to topic: ${topic}`);

    const subscriptions = this.findSubscriptions(topic);

    if (subscriptions.size === 0) {
      this.debug(`No subscribers for topic: ${topic}`);
      return;
    }

    const { async: isAsync, timeout = this.options.defaultHandlerTimeout } = options || {};
    const results: Array<Promise<unknown>> = [];

    for (const subscription of subscriptions) {
      try {
        const handlerPromise = subscription.handler(message, subscription.pattern);
        const wrappedPromise = isAsync
          ? handlerPromise
          : Promise.resolve(handlerPromise);

        const timeoutPromise = new Promise<unknown>((_, reject) => {
          setTimeout(() => reject(new Error(`Handler timeout after ${timeout}ms`)), timeout);
        });

        const result = Promise.race([wrappedPromise, timeoutPromise]);

        results.push(result);

        if (subscription.once) {
          this.unsubscribe(subscription.id);
        }
      } catch (error) {
        this.debug(
          `Handler error for topic ${subscription.pattern}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    Promise.all(results);
    this.debug(`Published to ${subscriptions.size} subscribers for topic: ${topic}`);
  }

  /**
   * 订阅主题（支持通配符）
   *
   * 通配符规则:
   * - `*` 匹配所有主题
   * - `foo:*` 匹配 `foo:` 开头的所有主题
   * - `foo.bar` 精确匹配 `foo.bar`
   */
  subscribe<T = unknown>(
    pattern: TopicPattern,
    handler: MessageHandler<T>,
    options?: { once?: boolean }
  ): string {
    const subscription: Subscription<T> = {
      id: this.generateSubscriptionId(),
      pattern,
      handler,
      once: options?.once
    };

    const { topic, isWildcard } = this.parsePattern(pattern);

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }

    this.subscriptions.get(topic)!.add(subscription as Subscription<unknown>);
    this.debug(
      `Subscribed to pattern: ${pattern} (topic: ${topic}, wildcard: ${isWildcard})`
    );

    return subscription.id;
  }

  /**
   * 取消订阅
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [topic, subscriptions] of this.subscriptions.entries()) {
      for (const subscription of subscriptions) {
        if (subscription.id === subscriptionId) {
          subscriptions.delete(subscription);
          if (subscriptions.size === 0) {
            this.subscriptions.delete(topic);
          }
          this.debug(`Unsubscribed ${subscriptionId} from ${subscription.pattern}`);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 取消指定模式的所有订阅
   */
  unsubscribeByPattern(pattern: TopicPattern): number {
    let count = 0;

    for (const [topic, subscriptions] of this.subscriptions.entries()) {
      const toRemove: Subscription<unknown>[] = [];

      for (const subscription of subscriptions) {
        if (subscription.pattern === pattern) {
          toRemove.push(subscription);
        }
      }

      for (const subscription of toRemove) {
        subscriptions.delete(subscription);
        count++;
      }

      if (subscriptions.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    this.debug(`Unsubscribed ${count} subscriptions for pattern: ${pattern}`);
    return count;
  }

  /**
   * 获取所有订阅信息（用于调试）
   */
  getSubscriptions(): Array<{ topic: Topic; count: number; patterns: TopicPattern[] }> {
    const result: Array<{ topic: Topic; count: number; patterns: TopicPattern[] }> = [];

    for (const [topic, subscriptions] of this.subscriptions.entries()) {
      const patterns: TopicPattern[] = [];
      for (const subscription of subscriptions) {
        patterns.push(subscription.pattern);
      }
      result.push({ topic, count: subscriptions.size, patterns });
    }

    return result;
  }

  /**
   * 清除所有订阅
   */
  clear(): void {
    this.subscriptions.clear();
    this.debug('All subscriptions cleared');
  }

  /**
   * 查找匹配指定主题的订阅
   */
  private findSubscriptions(topic: Topic): Set<Subscription<unknown>> {
    const result = new Set<Subscription<unknown>>();

    for (const [subTopic, subscriptions] of this.subscriptions.entries()) {
      if (this.matchPattern(subTopic, topic)) {
        for (const subscription of subscriptions) {
          result.add(subscription);
        }
      }
    }

    return result;
  }

  /**
   * 判断订阅模式是否匹配目标主题
   */
  private matchPattern(pattern: Topic, target: Topic): boolean {
    if (pattern === '*') {
      return true;
    }

    if (pattern.includes('*')) {
      const prefix = pattern.replace(/\*$/, '');
      return target.startsWith(prefix);
    }

    return pattern === target;
  }

  /**
   * 解析主题模式
   */
  private parsePattern(pattern: TopicPattern): { topic: Topic; isWildcard: boolean } {
    if (pattern === '*') {
      return { topic: '*', isWildcard: true };
    }

    if (pattern.endsWith('*')) {
      return { topic: pattern.replace(/\*$/, ''), isWildcard: true };
    }

    return { topic: pattern, isWildcard: false };
  }

  /**
   * 生成订阅 ID
   */
  private generateSubscriptionId(): string {
    return `sub_${++this.subscriptionIdCounter}_${Date.now()}`;
  }
}

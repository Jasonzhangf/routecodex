/**
 * Tool Call ID Manager
 *
 * 提供统一的工具调用 ID 生成、规范化和风格管理功能。
 * 支持 'fc' (function call) 和 'preserve' 两种风格。
 */

import type { JsonObject } from '../hub/types/json.js';
import {
  createToolCallIdTransformerWithNative,
  enforceToolCallIdStyleWithNative,
  extractToolCallIdWithNative,
  normalizeIdValueWithNative,
  transformToolCallIdWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export type ToolCallIdStyle = 'fc' | 'preserve';

export interface ToolCallIdManagerOptions {
  /**
   * ID 风格
   * - 'fc': 使用 fc_ 前缀的短 ID（如 fc_abc123）
   * - 'preserve': 保留原始 ID
   */
  style?: ToolCallIdStyle;

  /**
   * ID 前缀（仅用于 'fc' 风格）
   * 默认 'fc_'
   */
  prefix?: string;

  /**
   * ID 长度（仅用于 'fc' 风格）
   * 默认 8
   */
  idLength?: number;
}

const DEFAULT_OPTIONS: Required<ToolCallIdManagerOptions> = {
  style: 'fc',
  prefix: 'fc_',
  idLength: 8
};

function assertToolCallIdManagerNativeAvailable(): void {
  if (
    typeof normalizeIdValueWithNative !== 'function' ||
    typeof extractToolCallIdWithNative !== 'function' ||
    typeof createToolCallIdTransformerWithNative !== 'function' ||
    typeof transformToolCallIdWithNative !== 'function' ||
    typeof enforceToolCallIdStyleWithNative !== 'function'
  ) {
    throw new Error('[tool-call-id-manager] native bindings unavailable');
  }
}

/**
 * 工具调用 ID 管理器
 */
export class ToolCallIdManager {
  private options: Required<ToolCallIdManagerOptions>;
  private state: Record<string, unknown>;

  constructor(options?: ToolCallIdManagerOptions) {
    assertToolCallIdManagerNativeAvailable();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = createToolCallIdTransformerWithNative(this.options.style);
  }

  /**
   * 生成新的工具调用 ID
   */
  generateId(): string {
    assertToolCallIdManagerNativeAvailable();
    const output = transformToolCallIdWithNative(this.state, '');
    this.state = output.state;
    return output.id;
  }

  /**
   * 规范化工具调用 ID
   *
   * @param id - 原始 ID
   * @returns 规范化后的 ID
   */
  normalizeId(id: string | undefined | null): string {
    assertToolCallIdManagerNativeAvailable();
    const raw = typeof id === 'string' ? id : '';
    const output = transformToolCallIdWithNative(this.state, raw);
    this.state = output.state;
    return output.id;
  }

  /**
   * 规范化工具调用 ID（带别名注册）
   *
   * @param id - 原始 ID
   * @param aliasMap - 别名映射（用于 preserve 风格）
   * @returns 规范化后的 ID
   */
  normalizeIdWithAlias(
    id: string | undefined | null,
    aliasMap?: Map<string, string>
  ): string {
    assertToolCallIdManagerNativeAvailable();
    const raw = typeof id === 'string' ? id : '';
    const trimmed = raw.trim();
    if (this.options.style === 'preserve' && trimmed && aliasMap?.has(trimmed)) {
      const existing = aliasMap.get(trimmed)!;
      const aliasState = this.state.aliasMap;
      if (aliasState && typeof aliasState === 'object') {
        (aliasState as Record<string, unknown>)[trimmed] = existing;
      }
      return existing;
    }
    const output = transformToolCallIdWithNative(this.state, raw);
    this.state = output.state;
    if (this.options.style === 'preserve' && trimmed && aliasMap) {
      aliasMap.set(trimmed, output.id);
    }
    return output.id;
  }

  /**
   * 批量规范化工具调用 ID
   *
   * @param ids - ID 列表
   * @returns 规范化后的 ID 列表
   */
  normalizeIds(ids: (string | undefined | null)[]): string[] {
    return ids.map((id) => this.normalizeId(id));
  }

  /**
   * 检查 ID 是否为有效的 fc_ 风格
   */
  isValidFcStyle(id: string): boolean {
    return /^fc_[a-z0-9]+$/i.test(id);
  }

  /**
   * 从 ID 中提取基础部分（移除前缀）
   */
  extractBaseId(id: string): string {
    if (this.options.style === 'fc') {
      const match = id.match(/^fc_(.+)$/i);
      return match ? match[1] : id;
    }
    return id;
  }

  /**
   * 重置计数器
   */
  resetCounter(): void {
    this.state = createToolCallIdTransformerWithNative(this.options.style);
  }

  /**
   * 获取当前配置
   */
  getOptions(): ToolCallIdManagerOptions {
    return { ...this.options };
  }

  /**
   * 更新配置
   */
  updateOptions(options: Partial<ToolCallIdManagerOptions>): void {
    this.options = { ...this.options, ...options };
    this.state = createToolCallIdTransformerWithNative(this.options.style);
  }
}

/**
 * 规范化工具调用 ID 值
 *
 * @param value - ID 值（可能是字符串或其他类型）
 * @param forceGenerate - 如果为 true，总是生成新 ID
 * @returns 规范化后的 ID 字符串
 */
export function normalizeIdValue(
  value: unknown,
  forceGenerate: boolean = false
): string {
  assertToolCallIdManagerNativeAvailable();
  return normalizeIdValueWithNative(value, forceGenerate);
}

/**
 * 从对象中提取工具调用 ID
 *
 * @param obj - 包含 ID 的对象
 * @returns 提取的 ID
 */
export function extractToolCallId(obj: unknown): string | undefined {
  assertToolCallIdManagerNativeAvailable();
  return extractToolCallIdWithNative(obj);
}

/**
 * 创建工具调用 ID 转换器（用于 Responses 格式）
 *
 * @param style - ID 风格
 * @returns 转换器函数
 */
export function createToolCallIdTransformer(
  style: ToolCallIdStyle
): ((id: string) => string) | null {
  assertToolCallIdManagerNativeAvailable();
  if (style !== 'fc' && style !== 'preserve') return null;
  const state = createToolCallIdTransformerWithNative(style);
  return (id: string) => {
    const output = transformToolCallIdWithNative(state, id);
    Object.assign(state, output.state);
    return output.id;
  };
}

/**
 * 在消息列表中强制应用工具调用 ID 风格
 *
 * @param messages - 消息列表
 * @param transformer - ID 转换器
 */
export function enforceToolCallIdStyle(
  messages: JsonObject[],
  transformer: (id: string) => string
): void {
  assertToolCallIdManagerNativeAvailable();
  if (!messages || !Array.isArray(messages)) {
    return;
  }

  const state = createToolCallIdTransformerWithNative('fc');
  const updated = enforceToolCallIdStyleWithNative(messages, state);
  const nextMessages = updated.messages as JsonObject[];

  if (transformer && typeof transformer === 'function') {
    for (const message of nextMessages) {
      if (!message || typeof message !== 'object') continue;
      const role = message.role;
      if (role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const id = extractToolCallId(call);
          if (id) {
            (call as JsonObject).id = transformer(id);
          }
        }
      }
      if (role === 'tool') {
        const id = extractToolCallId(message);
        if (id) {
          message.tool_call_id = transformer(id);
        }
      }
    }
  }
  messages.splice(0, messages.length, ...nextMessages);
}

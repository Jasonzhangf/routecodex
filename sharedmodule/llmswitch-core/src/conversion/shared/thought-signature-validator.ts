/**
 * ThoughtSignature Validator
 *
 * 提供严格的 thoughtSignature 验证功能，用于 Claude/Gemini thinking 块的签名验证。
 * 参考 gcli2api 的实现，确保与上游 API 的兼容性。
 */

import type { JsonObject, JsonValue } from '../hub/types/json.js';
import {
  filterInvalidThinkingBlocksWithNative,
  hasValidThoughtSignatureWithNative,
  removeTrailingUnsignedThinkingBlocksWithNative,
  sanitizeThinkingBlockWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export interface ThoughtSignatureValidationOptions {
  /**
   * 最小签名长度（默认 50 个字符）
   */
  minLength?: number;

  /**
   * 是否允许空 thinking + 任意签名（trailing signature case）
   * 默认 true
   */
  allowEmptyThinkingWithSignature?: boolean;

  /**
   * 是否在验证失败时将 thinking 转换为文本
   * 默认 true
   */
  convertToTextOnFailure?: boolean;
}

function assertThoughtSignatureValidatorNativeAvailable(): void {
  if (
    typeof hasValidThoughtSignatureWithNative !== 'function' ||
    typeof sanitizeThinkingBlockWithNative !== 'function' ||
    typeof filterInvalidThinkingBlocksWithNative !== 'function' ||
    typeof removeTrailingUnsignedThinkingBlocksWithNative !== 'function'
  ) {
    throw new Error('[thought-signature-validator] native bindings unavailable');
  }
}

/**
 * 检查 thinking 块是否有有效的 thoughtSignature
 *
 * @param block - thinking 块对象
 * @param options - 验证选项
 * @returns 是否有效
 */
export function hasValidThoughtSignature(
  block: unknown,
  options?: ThoughtSignatureValidationOptions
): boolean {
  assertThoughtSignatureValidatorNativeAvailable();
  return hasValidThoughtSignatureWithNative(block, options as Record<string, unknown> | undefined);
}

/**
 * 清理 thinking 块，移除额外字段，保留有效签名
 *
 * @param block - thinking 块对象
 * @returns 清理后的块
 */
export function sanitizeThinkingBlock(block: unknown): JsonObject {
  assertThoughtSignatureValidatorNativeAvailable();
  return sanitizeThinkingBlockWithNative(block) as JsonObject;
}

/**
 * 过滤消息中的无效 thinking 块
 *
 * @param messages - Anthropic messages 列表（会被修改）
 * @param options - 验证选项
 */
export function filterInvalidThinkingBlocks(
  messages: JsonValue[],
  options?: ThoughtSignatureValidationOptions
): void {
  assertThoughtSignatureValidatorNativeAvailable();
  const normalized = filterInvalidThinkingBlocksWithNative(
    messages,
    options as Record<string, unknown> | undefined
  ) as JsonValue[];
  messages.splice(0, messages.length, ...normalized);
}

/**
 * 移除末尾未签名的 thinking 块
 *
 * @param blocks - content blocks 列表（会被修改）
 * @param options - 验证选项
 */
export function removeTrailingUnsignedThinkingBlocks(
  blocks: JsonValue[],
  options?: ThoughtSignatureValidationOptions
): void {
  assertThoughtSignatureValidatorNativeAvailable();
  const normalized = removeTrailingUnsignedThinkingBlocksWithNative(
    blocks,
    options as Record<string, unknown> | undefined
  ) as JsonValue[];
  blocks.splice(0, blocks.length, ...normalized);
}

/**
 * Tool Argument Repairer
 *
 * Tool calls require `function.arguments` to be a JSON string. Models often emit JSON-ish
 * payloads (single quotes, fenced blocks, comments, trailing commas, etc.).
 *
 * This module provides a deterministic, best-effort repair surface that returns a JSON string
 * or `{}` and never throws.
 */

import {
  repairArgumentsToStringWithNative,
  repairToolCallsWithNative,
  validateToolArgumentsWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export interface RepairResult {
  repaired: string;
  success: boolean;
  error?: string;
}

export class ToolArgumentRepairer {
  repairToString(args: unknown): string {
    if (typeof repairArgumentsToStringWithNative !== 'function') {
      throw new Error('[tool-argument-repairer] native bindings unavailable');
    }
    return repairArgumentsToStringWithNative(args);
  }

  validateAndRepair(toolName: string, args: unknown): RepairResult {
    if (typeof validateToolArgumentsWithNative !== 'function') {
      throw new Error('[tool-argument-repairer] native bindings unavailable');
    }
    const output = validateToolArgumentsWithNative(toolName, args);
    return {
      repaired: output.repaired,
      success: output.success,
      ...(output.error ? { error: output.error } : {})
    };
  }
  
  /**
   * 批量修复工具参数
   *
   * @param toolCalls - 工具调用列表
   * @returns 修复后的工具调用列表
   */
  repairToolCalls(toolCalls: Array<{ name?: string; arguments?: unknown }>): Array<{ name?: string; arguments: string }> {
    if (typeof repairToolCallsWithNative !== 'function') {
      throw new Error('[tool-argument-repairer] native bindings unavailable');
    }
    return repairToolCallsWithNative(toolCalls);
  }
}

/**
 * 快捷函数：修复工具参数
 */
export function repairToolArguments(args: unknown): string {
  return new ToolArgumentRepairer().repairToString(args);
}

/**
 * 快捷函数：验证并修复工具参数
 */
export function validateToolArguments(toolName: string, args: unknown): RepairResult {
  return new ToolArgumentRepairer().validateAndRepair(toolName, args);
}

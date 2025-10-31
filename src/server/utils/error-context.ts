/**
 * Detailed Error Context Builder
 *
 * Implements RouteCodex 9大架构原则中的快速死亡和暴露问题原则
 * 提供完整的错误上下文信息，包括模块、文件、函数、行号等详细信息
 */

import os from 'os';
import { RouteCodexError } from '../types.js';
import { type UnknownObject } from '../../types/common-types.js';

export interface ErrorContext extends UnknownObject {
  module: string;        // 模块名称
  file?: string;         // 文件路径
  function?: string;     // 函数名称
  line?: number;         // 行号
  requestId?: string;    // 请求ID
  additional?: any;      // 额外上下文
}

export interface SystemEnvironment {
  nodeVersion: string;
  platform: string;
  arch: string;
  memory: NodeJS.MemoryUsage;
  uptime: number;
  loadAverage: number[];
}

export interface DetailedError {
  error: {
    code: string;
    message: string;
    type: string;
    context: {
      module: string;
      file: string;
      function: string;
      line: number;
      requestId: string;
      timestamp: string;
      environment: SystemEnvironment;
      stack?: string;
      additional?: any;
    };
  };
  debug: string[];
  source: string;
  remediation: {
    immediate: string;
    documentation: string;
    support: string;
  };
}

/**
 * 错误上下文构建器
 * 符合原则4(快速死亡)和原则5(暴露问题)
 */
export class ErrorContextBuilder {

  /**
   * 构建详细的错误上下文
   */
  static buildErrorContext(error: Error, context: ErrorContext): DetailedError {

    return {
      error: {
        code: this.getErrorCode(error),
        message: error.message,
        type: error.constructor.name,

        // 完整的上下文信息 - 符合暴露问题原则
        context: {
          module: context.module,
          file: context.file || 'unknown',
          function: context.function || 'unknown',
          line: context.line || 0,
          requestId: context.requestId || 'unknown',
          timestamp: new Date().toISOString(),

          // 系统环境信息
          environment: this.getSystemEnvironment(),

          // 错误堆栈追踪 - 快速死亡原则要求完整信息
          stack: error.stack,

          // 额外调试信息
          additional: context.additional
        }
      },

      // 调试建议
      debug: this.generateDebugSuggestions(error, context),

      // 明确错误来源
      source: 'RouteCodex-Enhanced',

      // 修复建议
      remediation: {
        immediate: this.getImmediateAction(error),
        documentation: '参考CLAUDE.md中的9大架构原则和错误处理章节',
        support: '如需进一步帮助，请提供完整的错误信息和requestId'
      }
    };
  }

  /**
   * 获取系统环境信息
   */
  private static getSystemEnvironment(): SystemEnvironment {
    return {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      memory: process.memoryUsage(),
      uptime: os.uptime(),
      loadAverage: os.loadavg()
    };
  }

  /**
   * 获取标准化错误代码
   */
  private static getErrorCode(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('parse function arguments')) {
      return 'TOOL_ARGUMENT_PARSE_ERROR';
    }
    if (message.includes('500') || message.includes('internal server error')) {
      return 'INTERNAL_SERVER_ERROR';
    }
    if (message.includes('timeout')) {
      return 'TIMEOUT_ERROR';
    }
    if (message.includes('connection')) {
      return 'CONNECTION_ERROR';
    }
    if (message.includes('validation')) {
      return 'VALIDATION_ERROR';
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * 生成调试建议
   * 基于错误类型和上下文提供具体建议
   */
  private static generateDebugSuggestions(error: Error, context: ErrorContext): string[] {
    const suggestions = [];
    const message = error.message.toLowerCase();

    // 工具调用参数解析错误
    if (message.includes('parse function arguments') || message.includes('expected a sequence')) {
      suggestions.push('检查工具调用参数格式是否符合OpenAI规范');
      suggestions.push('确认llmswitch-core参数处理逻辑');
      suggestions.push('验证shell工具的command参数是否为数组格式');
      suggestions.push('检查是否存在参数重复编码问题');
    }

    // 500错误
    if (message.includes('500') || message.includes('operation failed')) {
      suggestions.push('检查Provider连接状态和配置');
      suggestions.push('查看Provider错误日志');
      suggestions.push('验证网络连接和API密钥');
      suggestions.push('检查请求频率是否超过限制');
    }

    // 连接错误
    if (message.includes('connection') || message.includes('connect')) {
      suggestions.push('检查目标服务是否运行');
      suggestions.push('验证端口是否正确');
      suggestions.push('检查防火墙设置');
      suggestions.push('确认网络可达性');
    }

    // 验证错误
    if (message.includes('validation')) {
      suggestions.push('检查请求参数格式');
      suggestions.push('验证必需字段是否缺失');
      suggestions.push('确认参数类型是否正确');
    }

    // 超时错误
    if (message.includes('timeout')) {
      suggestions.push('增加超时时间配置');
      suggestions.push('检查网络延迟');
      suggestions.push('优化处理逻辑减少执行时间');
    }

    // 模块特定建议
    if (context.module === 'GLMCompatibility') {
      suggestions.push('检查GLM特定的字段标准化逻辑');
      suggestions.push('确认reasoning_content处理');
      suggestions.push('验证schema字段转换');
    }

    if (context.module === 'ChatCompletionsHandler') {
      suggestions.push('检查OpenAI请求格式验证');
      suggestions.push('确认流式响应处理逻辑');
      suggestions.push('验证工具调用参数序列化');
    }

    return suggestions;
  }

  /**
   * 获取立即行动建议
   */
  private static getImmediateAction(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('parse function arguments')) {
      return '检查工具调用参数格式，确保command为数组类型';
    }

    if (message.includes('500')) {
      return '检查Provider服务状态和网络连接';
    }

    if (message.includes('connection')) {
      return '检查目标服务是否运行在正确端口';
    }

    return '查看详细错误上下文和调试建议';
  }

  /**
   * 从错误堆栈中提取行号
   */
  static extractLineNumber(error: Error): number {
    if (!error.stack) return 0;

    const stackLines = error.stack.split('\n');
    for (const line of stackLines) {
      const match = line.match(/:(\d+):\d+\)?$/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    return 0;
  }

  /**
   * 安全地序列化对象（限制大小）
   */
  static safeStringify(obj: any, maxSize: number = 1000): string {
    try {
      const str = JSON.stringify(obj, null, 2);
      return str.length > maxSize ? str.substring(0, maxSize) + '...' : str;
    } catch {
      return '[无法序列化的对象]';
    }
  }
}

/**
 * 增强的RouteCodex错误类
 */
export class EnhancedRouteCodexError extends RouteCodexError {
  public readonly detailedError: DetailedError;

  constructor(error: Error, context: ErrorContext) {
    super(error.message, 'ENHANCED_ERROR', 500, context as Record<string, UnknownObject>);
    this.detailedError = ErrorContextBuilder.buildErrorContext(error, context);
  }

  toJSON(): DetailedError {
    return this.detailedError;
  }
}
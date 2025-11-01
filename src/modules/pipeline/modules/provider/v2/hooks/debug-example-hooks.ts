/**
 * 调试示例Hooks - 演示双向数据流监控功能
 *
 * 展示如何在各个数据变化点读取和写入数据，提供详细的调试信息
 */

import type { BidirectionalHook, HookExecutionContext, HookDataPacket, DataChange } from '../config/provider-debug-hooks.js';
import { HookStage } from '../config/provider-debug-hooks.js';

/**
 * 请求监控Hook - 监控请求预处理和验证阶段的数据变化
 */
export const requestMonitoringHook: BidirectionalHook = {
  name: 'request-monitoring',
  stage: HookStage.REQUEST_PREPROCESSING,
  target: 'request',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const metrics: Record<string, unknown> = {};

    // 记录请求基本信息
    const request = data.data as any;
    observations.push(`📥 请求监控: 模型=${request.model}, 消息数量=${request.messages?.length || 0}`);

    // 记录工具信息
    if (request.tools && request.tools.length > 0) {
      observations.push(`🔧 请求包含 ${request.tools.length} 个工具`);
      metrics.toolCount = request.tools.length;
    }

    // 记录请求大小
    metrics.requestSize = data.metadata.size;
    observations.push(`📊 请求数据大小: ${data.metadata.size} bytes`);

    return { observations, metrics };
  },

  transform(data: HookDataPacket, context: HookExecutionContext): {
    data: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  } {
    const observations: string[] = [];
    const changes: DataChange[] = [];
    const modifiedData = data.data;

    // 添加调试时间戳
    const debugData = modifiedData as any;
    const originalTimestamp = debugData._debugTimestamp;
    const newTimestamp = Date.now();

    if (originalTimestamp !== newTimestamp) {
      changes.push({
        type: 'modified',
        path: '_debugTimestamp',
        oldValue: originalTimestamp,
        newValue: newTimestamp,
        reason: '添加调试时间戳'
      });

      debugData._debugTimestamp = newTimestamp;
      observations.push(`⏰ 添加调试时间戳: ${newTimestamp}`);
    }

    // 添加请求追踪ID
    if (!debugData._traceId) {
      changes.push({
        type: 'added',
        path: '_traceId',
        newValue: context.executionId,
        reason: '添加请求追踪ID'
      });

      debugData._traceId = context.executionId;
      observations.push(`🆔 添加追踪ID: ${context.executionId}`);
    }

    return {
      data: debugData,
      changes,
      observations,
      metrics: { timestamp: newTimestamp, traceId: context.executionId }
    };
  }
};

/**
 * 认证监控Hook - 监控认证过程
 */
export const authenticationMonitoringHook: BidirectionalHook = {
  name: 'authentication-monitoring',
  stage: HookStage.AUTHENTICATION,
  target: 'auth',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const auth = data.data as any;

    // 检查认证类型
    if (auth.Authorization) {
      const tokenType = auth.Authorization.split(' ')[0];
      const tokenLength = auth.Authorization.length;
      observations.push(`🔑 认证类型: ${tokenType}, Token长度: ${tokenLength}`);

      // 安全检查：不记录完整token
      if (tokenLength > 100) {
        observations.push(`⚠️ Token长度异常: ${tokenLength} 字符`);
      }
    }

    return { observations };
  },

  write(data: HookDataPacket, context: HookExecutionContext): {
    modifiedData: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  } {
    const observations: string[] = [];
    const changes: DataChange[] = [];
    const modifiedData = data.data as any;

    // 添加认证时间戳
    if (!modifiedData._authTimestamp) {
      changes.push({
        type: 'added',
        path: '_authTimestamp',
        newValue: Date.now(),
        reason: '记录认证时间'
      });

      modifiedData._authTimestamp = Date.now();
      observations.push(`⏰ 记录认证时间戳`);
    }

    return {
      modifiedData,
      changes,
      observations
    };
  }
};

/**
 * HTTP请求监控Hook - 监控实际HTTP请求前的数据状态
 */
export const httpRequestMonitoringHook: BidirectionalHook = {
  name: 'http-request-monitoring',
  stage: HookStage.HTTP_REQUEST,
  target: 'request',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const request = data.data as any;
    const metrics: Record<string, unknown> = {};

    // 记录最终请求信息
    observations.push(`🌐 HTTP请求准备: 模型=${request.model}`);

    // 检查是否有streaming
    if (request.stream === true) {
      observations.push(`📡 流式请求已启用`);
      metrics.streaming = true;
    }

    // 检查max_tokens设置
    if (request.max_tokens) {
      observations.push(`🎯 最大Token限制: ${request.max_tokens}`);
      metrics.maxTokens = request.max_tokens;
    }

    // 记录请求头大小估算
    metrics.estimatedHeadersSize = JSON.stringify(request).length * 0.1; // 粗略估算

    return { observations, metrics };
  },

  transform(data: HookDataPacket, context: HookExecutionContext): {
    data: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  } {
    const observations: string[] = [];
    const changes: DataChange[] = [];
    const modifiedData = data.data as any;

    // 添加请求发送时间戳
    changes.push({
      type: 'added',
      path: '_httpRequestTimestamp',
      newValue: Date.now(),
      reason: '记录HTTP请求发送时间'
    });

    modifiedData._httpRequestTimestamp = Date.now();
    observations.push(`📤 记录HTTP请求发送时间`);

    return {
      data: modifiedData,
      changes,
      observations,
      metrics: { httpRequestTimestamp: Date.now() }
    };
  }
};

/**
 * HTTP响应监控Hook - 监控HTTP响应数据
 */
export const httpResponseMonitoringHook: BidirectionalHook = {
  name: 'http-response-monitoring',
  stage: HookStage.HTTP_RESPONSE,
  target: 'response',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const response = data.data as any;
    const metrics: Record<string, unknown> = {};

    // 记录响应基本信息
    if (response.status) {
      observations.push(`📥 HTTP响应状态: ${response.status}`);
      metrics.httpStatus = response.status;
    }

    // 检查响应数据结构
    if (response.data) {
      const responseData = response.data;

      if (responseData.choices && responseData.choices.length > 0) {
        const choice = responseData.choices[0];
        observations.push(`💬 响应包含 ${responseData.choices.length} 个选择`);

        if (choice.finish_reason) {
          observations.push(`🏁 完成原因: ${choice.finish_reason}`);
          metrics.finishReason = choice.finish_reason;
        }

        if (choice.message) {
          const message = choice.message;
          if (message.content) {
            const contentLength = message.content.length;
            observations.push(`📝 响应内容长度: ${contentLength} 字符`);
            metrics.contentLength = contentLength;
          }

          if (message.tool_calls && message.tool_calls.length > 0) {
            observations.push(`🔧 响应包含 ${message.tool_calls.length} 个工具调用`);
            metrics.toolCallCount = message.tool_calls.length;
          }
        }
      }

      // 记录使用情况
      if (responseData.usage) {
        const usage = responseData.usage;
        observations.push(`📊 Token使用 - 输入: ${usage.prompt_tokens}, 输出: ${usage.completion_tokens}, 总计: ${usage.total_tokens}`);
        metrics.tokenUsage = usage;
      }
    }

    // 记录响应大小
    metrics.responseSize = data.metadata.size;
    observations.push(`📊 响应数据大小: ${data.metadata.size} bytes`);

    return { observations, metrics };
  }
};

/**
 * 响应后处理监控Hook - 监控最终响应处理
 */
export const responsePostProcessingMonitoringHook: BidirectionalHook = {
  name: 'response-post-processing-monitoring',
  stage: HookStage.RESPONSE_POSTPROCESSING,
  target: 'response',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const response = data.data as any;
    const metrics: Record<string, unknown> = {};

    // 计算总处理时间
    const totalTime = Date.now() - _context.startTime;
    observations.push(`⏱️ 总处理时间: ${totalTime}ms`);
    metrics.totalProcessingTime = totalTime;

    // 检查是否有元数据
    if (response.metadata) {
      observations.push(`📋 响应包含元数据`);

      if (response.metadata.requestId) {
        observations.push(`🆔 请求ID: ${response.metadata.requestId}`);
      }

      if (response.metadata.usage) {
        const usage = response.metadata.usage;
        observations.push(`📊 元数据Token使用 - 输入: ${usage.prompt_tokens}, 输出: ${usage.completion_tokens}`);
      }

      if (response.metadata.hookMetrics) {
        const hookMetrics = response.metadata.hookMetrics;
        observations.push(`🔧 Hook执行指标已记录`);
        metrics.hookMetrics = hookMetrics;
      }
    }

    // 性能警告
    if (totalTime > 5000) {
      observations.push(`⚠️ 处理时间过长: ${totalTime}ms`);
    }

    return { observations, metrics };
  },

  transform(data: HookDataPacket, context: HookExecutionContext): {
    data: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  } {
    const observations: string[] = [];
    const changes: DataChange[] = [];
    const modifiedData = data.data as any;

    // 添加最终处理时间戳
    changes.push({
      type: 'added',
      path: 'metadata.finalProcessingTimestamp',
      newValue: Date.now(),
      reason: '记录最终处理时间戳'
    });

    if (!modifiedData.metadata) {
      modifiedData.metadata = {};
    }

    modifiedData.metadata.finalProcessingTimestamp = Date.now();
    observations.push(`🏁 添加最终处理时间戳`);

    // 添加性能指标
    const totalTime = Date.now() - context.startTime;
    changes.push({
      type: 'added',
      path: 'metadata.performanceMetrics',
      newValue: {
        totalProcessingTime: totalTime,
        dataSize: data.metadata.size,
        executionId: context.executionId
      },
      reason: '记录性能指标'
    });

    modifiedData.metadata.performanceMetrics = {
      totalProcessingTime: totalTime,
      dataSize: data.metadata.size,
      executionId: context.executionId
    };

    observations.push(`📊 添加性能指标: ${totalTime}ms`);

    return {
      data: modifiedData,
      changes,
      observations,
      metrics: { finalTimestamp: Date.now(), totalTime }
    };
  }
};

/**
 * 错误处理监控Hook - 监控错误处理过程
 */
export const errorHandlingMonitoringHook: BidirectionalHook = {
  name: 'error-handling-monitoring',
  stage: HookStage.ERROR_HANDLING,
  target: 'error',
  priority: 100,
  isDebugHook: true,

  read(data: HookDataPacket, _context: HookExecutionContext): {
    observations: string[];
    metrics?: Record<string, unknown>;
    shouldContinue?: boolean;
  } {
    const observations: string[] = [];
    const errorData = data.data as any;
    const metrics: Record<string, unknown> = {};

    observations.push(`❌ 错误处理监控启动`);

    if (errorData.error) {
      const error = errorData.error;
      observations.push(`🚨 错误类型: ${error.constructor?.name || 'Unknown'}`);
      observations.push(`📝 错误消息: ${error.message}`);

      if (error.status) {
        observations.push(`🌐 HTTP状态码: ${error.status}`);
        metrics.httpStatus = error.status;
      }

      if (error.code) {
        observations.push(`🔢 错误代码: ${error.code}`);
        metrics.errorCode = error.code;
      }
    }

    // 记录错误发生时的上下文信息
    observations.push(`📋 错误发生阶段: ${_context.stage}`);
    observations.push(`🆔 错误执行ID: ${_context.executionId}`);

    // 计算错误发生时间
    const errorTime = Date.now() - _context.startTime;
    observations.push(`⏰ 错误发生时间: ${errorTime}ms`);
    metrics.errorOccurrenceTime = errorTime;

    return { observations, metrics };
  },

  write(data: HookDataPacket, context: HookExecutionContext): {
    modifiedData: unknown;
    changes: DataChange[];
    observations: string[];
    metrics?: Record<string, unknown>;
  } {
    const observations: string[] = [];
    const changes: DataChange[] = [];
    const modifiedData = data.data as any;

    // 添加错误处理时间戳
    changes.push({
      type: 'added',
      path: '_errorHandlingTimestamp',
      newValue: Date.now(),
      reason: '记录错误处理时间戳'
    });

    modifiedData._errorHandlingTimestamp = Date.now();
    observations.push(`⏰ 记录错误处理时间戳`);

    // 添加错误追踪信息
    changes.push({
      type: 'added',
      path: '_errorTrace',
      newValue: {
        executionId: context.executionId,
        stage: context.stage,
        timestamp: Date.now()
      },
      reason: '添加错误追踪信息'
    });

    modifiedData._errorTrace = {
      executionId: context.executionId,
      stage: context.stage,
      timestamp: Date.now()
    };

    observations.push(`🔍 添加错误追踪信息`);

    return {
      modifiedData,
      changes,
      observations
    };
  }
};

/**
 * 注册所有调试示例Hooks
 */
export function registerDebugExampleHooks(): void {
  const { BidirectionalHookManager } = require('../config/provider-debug-hooks.js');

  // 注册所有监控Hook
  BidirectionalHookManager.registerHook(requestMonitoringHook);
  BidirectionalHookManager.registerHook(authenticationMonitoringHook);
  BidirectionalHookManager.registerHook(httpRequestMonitoringHook);
  BidirectionalHookManager.registerHook(httpResponseMonitoringHook);
  BidirectionalHookManager.registerHook(responsePostProcessingMonitoringHook);
  BidirectionalHookManager.registerHook(errorHandlingMonitoringHook);

  console.log('🔍 已注册所有调试示例Hooks');
}

/**
 * 启用调试模式
 */
export function enableDebugMode(level: 'basic' | 'detailed' | 'verbose' = 'detailed'): void {
  const { BidirectionalHookManager } = require('../config/provider-debug-hooks.js');

  BidirectionalHookManager.setDebugConfig({
    enabled: true,
    level,
    maxDataSize: level === 'verbose' ? 2048 : 1024,
    stages: Object.values(HookStage),
    outputFormat: 'structured',
    outputTargets: ['console'],
    performanceThresholds: {
      maxHookExecutionTime: level === 'verbose' ? 50 : 100,
      maxTotalExecutionTime: level === 'verbose' ? 500 : 1000,
      maxDataSize: level === 'verbose' ? 1024 * 1024 : 512 * 1024
    }
  });

  console.log(`✨ 调试模式已启用 (级别: ${level})`);
}

/**
 * 禁用调试模式
 */
export function disableDebugMode(): void {
  const { BidirectionalHookManager } = require('../config/provider-debug-hooks.js');

  BidirectionalHookManager.setDebugConfig({
    enabled: false,
    level: 'basic',
    maxDataSize: 1024 * 1024,
    stages: Object.values(HookStage),
    outputFormat: 'structured',
    outputTargets: ['console'],
    performanceThresholds: {
      maxHookExecutionTime: 100,
      maxTotalExecutionTime: 1000,
      maxDataSize: 512 * 1024
    }
  });

  console.log('❌ 调试模式已禁用');
}
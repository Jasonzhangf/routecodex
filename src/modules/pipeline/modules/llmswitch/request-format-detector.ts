/**
 * 请求格式检测器
 * 根据HTTP请求内容自动检测Anthropic或OpenAI格式
 */

import type { Request } from 'express';

export interface RequestFormat {
  type: 'anthropic' | 'openai' | 'unknown';
  confidence: number;
  indicators: string[];
}

/**
 * Anthropic格式检测器
 */
export class AnthropicFormatDetector {
  /**
   * 检测请求是否为Anthropic格式
   */
  static detect(request: any): RequestFormat {
    const indicators: string[] = [];
    let confidence = 0;

    // 1. 检查系统消息字段
    if ('system' in request) {
      indicators.push('system_field_present');
      confidence += 40;
    }

    // 2. 检查工具定义格式
    if (request.tools && Array.isArray(request.tools)) {
      if (request.tools.length > 0) {
        const firstTool = request.tools[0];
        if (firstTool && 'input_schema' in firstTool) {
          indicators.push('anthropic_tool_format');
          confidence += 30;
        }
      }
    }

    // 3. 检查消息结构
    if (request.messages && Array.isArray(request.messages)) {
      // Anthropic通常有特定的content结构
      const hasAnthropicContent = request.messages.some((msg: any) => 
        msg.content && typeof msg.content === 'object' && 
        !Array.isArray(msg.content) && msg.content.type
      );
      
      if (hasAnthropicContent) {
        indicators.push('anthropic_content_structure');
        confidence += 20;
      }
    }

    // 4. 检查元数据字段
    if (request.metadata && typeof request.metadata === 'object') {
      indicators.push('anthropic_metadata');
      confidence += 10;
    }

    return {
      type: confidence >= 50 ? 'anthropic' : 'unknown',
      confidence: Math.min(confidence, 100),
      indicators
    };
  }
}

/**
 * OpenAI格式检测器
 */
export class OpenAIFormatDetector {
  /**
   * 检测请求是否为OpenAI格式
   */
  static detect(request: any): RequestFormat {
    const indicators: string[] = [];
    let confidence = 0;

    // 1. 检查函数调用字段
    if (request.messages && Array.isArray(request.messages)) {
      const hasFunctionCalls = request.messages.some((msg: any) => 
        msg.tool_calls || msg.function_call
      );
      
      if (hasFunctionCalls) {
        indicators.push('openai_function_calls');
        confidence += 40;
      }
    }

    // 2. 检查工具定义格式
    if (request.tools && Array.isArray(request.tools)) {
      if (request.tools.length > 0) {
        const firstTool = request.tools[0];
        if (firstTool && firstTool.type === 'function' && 'function' in firstTool) {
          indicators.push('openai_tool_format');
          confidence += 30;
        }
      }
    }

    // 3. 检查响应格式字段
    if (request.response_format && typeof request.response_format === 'object') {
      indicators.push('openai_response_format');
      confidence += 20;
    }

    // 4. 检查频率惩罚等OpenAI特有参数
    if ('frequency_penalty' in request || 'presence_penalty' in request) {
      indicators.push('openai_penalty_params');
      confidence += 10;
    }

    // 5. 检查消息角色和内容结构
    if (request.messages && Array.isArray(request.messages)) {
      const validOpenAIMessages = request.messages.every((msg: any) => 
        msg.role && ['system', 'user', 'assistant', 'tool'].includes(msg.role) &&
        (typeof msg.content === 'string' || msg.content === null || msg.content === undefined)
      );
      
      if (validOpenAIMessages) {
        indicators.push('openai_message_structure');
        confidence += 15;
      }
    }

    return {
      type: confidence >= 50 ? 'openai' : 'unknown',
      confidence: Math.min(confidence, 100),
      indicators
    };
  }
}

/**
 * 智能请求格式检测器
 */
export class SmartRequestFormatDetector {
  /**
   * 智能检测请求格式
   */
  static detect(request: any): RequestFormat {
    const anthropicResult = AnthropicFormatDetector.detect(request);
    const openaiResult = OpenAIFormatDetector.detect(request);

    // 如果两者都检测到，选择置信度更高的
    if (anthropicResult.confidence > 0 && openaiResult.confidence > 0) {
      if (anthropicResult.confidence > openaiResult.confidence) {
        return anthropicResult;
      } else {
        return openaiResult;
      }
    }

    // 如果只有一种格式检测到，返回该格式
    if (anthropicResult.confidence > 0) {
      return anthropicResult;
    }

    if (openaiResult.confidence > 0) {
      return openaiResult;
    }

    // 如果都没检测到，基于URL路径做最后判断
    return this.fallbackDetection(request);
  }

  /**
   * 回退检测（基于URL或其他上下文）
   */
  private static fallbackDetection(request: any): RequestFormat {
    // 这里可以添加基于URL路径的回退逻辑
    // 例如：如果请求来自 /v1/anthropic，则认为是Anthropic格式
    
    return {
      type: 'unknown',
      confidence: 0,
      indicators: ['no_clear_indicators']
    };
  }

  /**
   * 从HTTP请求中提取格式信息
   */
  static detectFromHttpRequest(req: Request): RequestFormat {
    const requestData = req.body;
    
    // 首先尝试智能检测
    const formatResult = this.detect(requestData);
    
    // 如果是未知格式，基于URL路径做最后判断
    if (formatResult.type === 'unknown' && formatResult.confidence === 0) {
      const url = req.url || req.path;
      
      if (url.includes('/anthropic')) {
        return {
          type: 'anthropic',
          confidence: 30,
          indicators: ['url_path_indicates_anthropic']
        };
      } else if (url.includes('/openai')) {
        return {
          type: 'openai',
          confidence: 30,
          indicators: ['url_path_indicates_openai']
        };
      }
    }
    
    return formatResult;
  }
}

/**
 * LLMSwitch选择器
 */
export class LLMSwitchSelector {
  /**
   * 根据请求格式选择适当的LLMSwitch类型
   */
  static selectLLMSwitchType(requestFormat: RequestFormat, endpointType: 'anthropic' | 'openai' | 'auto'): string {
    // 如果指定了端点类型，优先使用端点类型
    if (endpointType !== 'auto') {
      return endpointType === 'anthropic' ? 'anthropic-openai-converter' : 'openai-passthrough';
    }

    // 基于检测到的格式选择
    switch (requestFormat.type) {
      case 'anthropic':
        return 'anthropic-openai-converter';
      case 'openai':
        return 'openai-passthrough';
      default:
        // 如果无法确定格式，默认使用passthrough
        return 'openai-passthrough';
    }
  }

  /**
   * 根据路由配置和请求格式确定LLMSwitch配置
   */
  static getLLMSwitchConfig(
    routeConfig: any,
    requestFormat: RequestFormat,
    endpointType: 'anthropic' | 'openai' | 'auto'
  ): { type: string; config: any } {
    const switchType = this.selectLLMSwitchType(requestFormat, endpointType);
    
    // 基础配置
    const baseConfig: any = {
      type: switchType,
      config: {
        enableStreaming: routeConfig.enableStreaming ?? true,
        enableTools: routeConfig.enableTools ?? true,
        conversionMappings: routeConfig.conversionMappings || {},
        detectedFormat: '',
        confidence: 0,
        formatIndicators: []
      }
    };

    // 如果是转换器类型，添加额外的配置
    if (switchType === 'anthropic-openai-converter') {
      baseConfig.config.detectedFormat = requestFormat.type;
      baseConfig.config.confidence = requestFormat.confidence;
      baseConfig.config.formatIndicators = requestFormat.indicators;
    }

    return baseConfig;
  }
}
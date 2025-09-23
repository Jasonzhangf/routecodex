/**
 * Anthropic ↔ OpenAI 转换配置
 * 配置驱动的字段映射定义
 */

export interface ConversionConfig {
  // 请求转换映射
  requestMappings: RequestMappingConfig;
  // 响应转换映射  
  responseMappings: ResponseMappingConfig;
  // 流式转换映射
  streamMappings: StreamMappingConfig;
  // 工具转换映射
  toolMappings: ToolMappingConfig;
}

export interface RequestMappingConfig {
  // 消息结构转换
  messages: {
    sourcePath: string;
    targetPath: string;
    transform: 'direct' | 'systemExtraction' | 'contentArray';
  };
  // 系统消息处理
  systemMessage: {
    sourcePath: string; // Anthropic: "system"
    targetPath: string; // OpenAI: "messages[0]"
    transform: 'extractToMessage' | 'direct';
  };
  // 工具定义转换
  tools: {
    sourcePath: string;
    targetPath: string;
    transform: 'anthropicToOpenAI' | 'openaiToAnthropic';
  };
  // 通用参数字段
  parameters: {
    maxTokens: { source: string; target: string };
    temperature: { source: string; target: string };
    topP: { source: string; target: string };
    stopSequences: { source: string; target: string };
    stream: { source: string; target: string };
  };
}

export interface ResponseMappingConfig {
  // 基本响应结构
  content: {
    sourcePath: string; // OpenAI: "choices[0].message.content"
    targetPath: string; // Anthropic: "content"
    transform: 'choiceToContent' | 'contentToChoice';
  };
  // 角色映射
  role: {
    sourcePath: string;
    targetPath: string;
    transform: 'direct';
  };
  // 完成原因映射
  finishReason: {
    sourcePath: string; // OpenAI: "choices[0].finish_reason"
    targetPath: string; // Anthropic: "stop_reason"
    mapping: Record<string, string>;
  };
  // 使用统计
  usage: {
    sourcePath: string;
    targetPath: string;
    fieldMapping: Record<string, string>;
  };
}

export interface StreamMappingConfig {
  // 内容增量映射
  contentDelta: {
    openaiEvent: string;
    anthropicEvent: string;
    transform: 'contentDelta' | 'toolDelta';
  };
  // 工具调用增量
  toolCallDelta: {
    openaiPath: string; // "choices[0].delta.tool_calls[0]"
    anthropicPath: string; // "delta.type"
    argumentTransform: 'jsonDelta' | 'direct';
  };
  // 完成事件
  finishEvents: {
    openai: string;
    anthropic: string;
    reasonMapping: Record<string, string>;
  };
}

export interface ToolMappingConfig {
  // 工具定义格式
  definition: {
    anthropic: {
      name: string;
      description: string;
      input_schema: any;
    };
    openai: {
      type: 'function';
      function: {
        name: string;
        description: string;
        parameters: any;
      };
    };
  };
  // 工具调用格式
  call: {
    anthropic: {
      type: 'tool_use';
      id: string;
      name: string;
      input: any;
    };
    openai: {
      type: 'function';
      id: string;
      function: {
        name: string;
        arguments: string;
      };
    };
  };
  // 工具结果格式
  result: {
    anthropic: {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    };
    openai: {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };
  };
}

/**
 * 默认转换配置
 */
export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  requestMappings: {
    messages: {
      sourcePath: 'messages',
      targetPath: 'messages',
      transform: 'direct'
    },
    systemMessage: {
      sourcePath: 'system',
      targetPath: 'messages',
      transform: 'extractToMessage'
    },
    tools: {
      sourcePath: 'tools',
      targetPath: 'tools',
      transform: 'anthropicToOpenAI'
    },
    parameters: {
      maxTokens: { source: 'max_tokens', target: 'max_tokens' },
      temperature: { source: 'temperature', target: 'temperature' },
      topP: { source: 'top_p', target: 'top_p' },
      stopSequences: { source: 'stop_sequences', target: 'stop' },
      stream: { source: 'stream', target: 'stream' }
    }
  },
  responseMappings: {
    content: {
      sourcePath: 'choices[0].message.content',
      targetPath: 'content',
      transform: 'choiceToContent'
    },
    role: {
      sourcePath: 'choices[0].message.role',
      targetPath: 'role',
      transform: 'direct'
    },
    finishReason: {
      sourcePath: 'choices[0].finish_reason',
      targetPath: 'stop_reason',
      mapping: {
        'stop': 'end_turn',
        'length': 'max_tokens',
        'tool_calls': 'tool_use',
        'content_filter': 'content_filter'
      }
    },
    usage: {
      sourcePath: 'usage',
      targetPath: 'usage',
      fieldMapping: {
        'prompt_tokens': 'input_tokens',
        'completion_tokens': 'output_tokens',
        'total_tokens': 'total_tokens'
      }
    }
  },
  streamMappings: {
    contentDelta: {
      openaiEvent: 'content.delta',
      anthropicEvent: 'content_block_delta',
      transform: 'contentDelta'
    },
    toolCallDelta: {
      openaiPath: 'choices[0].delta.tool_calls[0]',
      anthropicPath: 'delta',
      argumentTransform: 'jsonDelta'
    },
    finishEvents: {
      openai: 'finish_reason',
      anthropic: 'message_delta',
      reasonMapping: {
        'stop': 'end_turn',
        'length': 'max_tokens',
        'tool_calls': 'tool_use'
      }
    }
  },
  toolMappings: {
    definition: {
      anthropic: {
        name: 'name',
        description: 'description',
        input_schema: 'input_schema'
      },
      openai: {
        type: 'function',
        function: {
          name: 'name',
          description: 'description',
          parameters: 'input_schema'
        }
      }
    },
    call: {
      anthropic: {
        type: 'tool_use',
        id: 'id',
        name: 'name',
        input: 'input'
      },
      openai: {
        type: 'function',
        id: 'id',
        function: {
          name: 'name',
          arguments: 'input'
        }
      }
    },
    result: {
      anthropic: {
        type: 'tool_result',
        tool_use_id: 'tool_use_id',
        content: 'content'
      },
      openai: {
        role: 'tool',
        tool_call_id: 'tool_call_id',
        content: 'content'
      }
    }
  }
};

/**
 * 请求格式检测
 */
export function detectRequestFormat(request: any): 'anthropic' | 'openai' | 'unknown' {
  // Anthropic 特征检测
  if (request && typeof request === 'object') {
    // Anthropic 有 system 字段在顶层
    if ('system' in request) {
      return 'anthropic';
    }
    
    // Anthropic 工具定义格式
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && 'input_schema' in firstTool) {
        return 'anthropic';
      }
    }
    
    // OpenAI 消息结构检测
    if (request.messages && Array.isArray(request.messages)) {
      // 检查是否有函数调用相关字段
      for (const message of request.messages) {
        if (message.tool_calls || message.function_call) {
          return 'openai';
        }
      }
    }
    
    // OpenAI 工具定义格式
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && firstTool.type === 'function' && 'function' in firstTool) {
        return 'openai';
      }
    }
  }
  
  return 'unknown';
}

/**
 * 响应格式检测
 */
export function detectResponseFormat(response: any): 'anthropic' | 'openai' | 'unknown' {
  if (response && typeof response === 'object') {
    // OpenAI 响应特征
    if ('choices' in response && Array.isArray(response.choices)) {
      return 'openai';
    }
    
    // Anthropic 响应特征
    if ('content' in response && 'role' in response) {
      return 'anthropic';
    }
    
    // 流式响应检测
    if (response.object === 'chat.completion.chunk') {
      return 'openai';
    }
  }
  
  return 'unknown';
}
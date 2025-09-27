/**
 * Anthropic ↔ OpenAI 转换配置
 * 配置驱动的字段映射定义
 */

export interface ConversionConfig {
  requestMappings: RequestMappingConfig;
  responseMappings: ResponseMappingConfig;  
  streamMappings: StreamMappingConfig;
  toolMappings: ToolMappingConfig;
}

export interface RequestMappingConfig {
  messages: {
    sourcePath: string;
    targetPath: string;
    transform: 'direct' | 'systemExtraction' | 'contentArray';
  };
  systemMessage: {
    sourcePath: string;
    targetPath: string;
    transform: 'extractToMessage' | 'direct';
  };
  tools: {
    sourcePath: string;
    targetPath: string;
    transform: 'anthropicToOpenAI' | 'openaiToAnthropic';
  };
  parameters: {
    maxTokens: { source: string; target: string };
    temperature: { source: string; target: string };
    topP: { source: string; target: string };
    stopSequences: { source: string; target: string };
    stream: { source: string; target: string };
  };
}

export interface ResponseMappingConfig {
  content: {
    sourcePath: string;
    targetPath: string;
    transform: 'choiceToContent' | 'contentToChoice';
  };
  role: {
    sourcePath: string;
    targetPath: string;
    transform: 'direct';
  };
  finishReason: {
    sourcePath: string;
    targetPath: string;
    mapping: Record<string, string>;
  };
  usage: {
    sourcePath: string;
    targetPath: string;
    fieldMapping: Record<string, string>;
  };
}

export interface StreamMappingConfig {
  contentDelta: {
    openaiEvent: string;
    anthropicEvent: string;
    transform: 'contentDelta' | 'toolDelta';
  };
  toolCallDelta: {
    openaiPath: string;
    anthropicPath: string;
    argumentTransform: 'jsonDelta' | 'direct';
  };
  finishEvents: {
    openai: string;
    anthropic: string;
    reasonMapping: Record<string, string>;
  };
}

export interface ToolMappingConfig {
  definition: {
    anthropic: { name: string; description: string; input_schema: any };
    openai: { type: 'function'; function: { name: string; description: string; parameters: any } };
  };
  call: {
    anthropic: { type: 'tool_use'; id: string; name: string; input: any };
    openai: { type: 'function'; id: string; function: { name: string; arguments: string } };
  };
  result: {
    anthropic: { type: 'tool_result'; tool_use_id: string; content: string };
    openai: { role: 'tool'; tool_call_id: string; content: string };
  };
}

export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  requestMappings: {
    messages: { sourcePath: 'messages', targetPath: 'messages', transform: 'direct' },
    systemMessage: { sourcePath: 'system', targetPath: 'messages', transform: 'extractToMessage' },
    tools: { sourcePath: 'tools', targetPath: 'tools', transform: 'anthropicToOpenAI' },
    parameters: {
      maxTokens: { source: 'max_tokens', target: 'max_tokens' },
      temperature: { source: 'temperature', target: 'temperature' },
      topP: { source: 'top_p', target: 'top_p' },
      stopSequences: { source: 'stop_sequences', target: 'stop' },
      stream: { source: 'stream', target: 'stream' }
    },
  },
  responseMappings: {
    content: { sourcePath: 'choices[0].message.content', targetPath: 'content', transform: 'choiceToContent' },
    role: { sourcePath: 'choices[0].message.role', targetPath: 'role', transform: 'direct' },
    finishReason: {
      sourcePath: 'choices[0].finish_reason',
      targetPath: 'stop_reason',
      mapping: { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'content_filter' },
    },
    usage: {
      sourcePath: 'usage',
      targetPath: 'usage',
      fieldMapping: { prompt_tokens: 'input_tokens', completion_tokens: 'output_tokens', total_tokens: 'total_tokens' },
    },
  },
  streamMappings: {
    contentDelta: { openaiEvent: 'content.delta', anthropicEvent: 'content_block_delta', transform: 'contentDelta' },
    toolCallDelta: { openaiPath: 'choices[0].delta.tool_calls[0]', anthropicPath: 'delta', argumentTransform: 'jsonDelta' },
    finishEvents: {
      openai: 'finish_reason',
      anthropic: 'message_delta',
      reasonMapping: { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' },
    },
  },
  toolMappings: {
    definition: {
      anthropic: { name: 'name', description: 'description', input_schema: 'input_schema' },
      openai: { type: 'function', function: { name: 'name', description: 'description', parameters: 'input_schema' } },
    },
    call: {
      anthropic: { type: 'tool_use', id: 'id', name: 'name', input: 'input' },
      openai: { type: 'function', id: 'id', function: { name: 'name', arguments: 'input' } },
    },
    result: {
      anthropic: { type: 'tool_result', tool_use_id: 'tool_use_id', content: 'content' },
      openai: { role: 'tool', tool_call_id: 'tool_call_id', content: 'content' },
    },
  },
};

export function detectRequestFormat(request: any): 'anthropic' | 'openai' | 'unknown' {
  if (request && typeof request === 'object') {
    if ('system' in request) { return 'anthropic'; }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && 'input_schema' in firstTool) { return 'anthropic'; }
    }
    if (request.messages && Array.isArray(request.messages)) {
      for (const message of request.messages) {
        if (message.tool_calls || message.function_call) { return 'openai'; }
      }
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && firstTool.type === 'function' && 'function' in firstTool) { return 'openai'; }
    }
  }
  return 'unknown';
}

export function detectResponseFormat(response: any): 'anthropic' | 'openai' | 'unknown' {
  if (response && typeof response === 'object') {
    if ('choices' in response && Array.isArray(response.choices)) { return 'openai'; }
    if ('content' in response && 'role' in response) { return 'anthropic'; }
    if (response.object === 'chat.completion.chunk') { return 'openai'; }
  }
  return 'unknown';
}


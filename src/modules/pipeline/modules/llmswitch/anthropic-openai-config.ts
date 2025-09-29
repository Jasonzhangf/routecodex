export interface ConversionConfig {
  requestMappings: any;
  responseMappings: any;  
  streamMappings: any;
  toolMappings: any;
}

export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  requestMappings: {
    parameters: {
      maxTokens: { source: 'max_tokens', target: 'max_tokens' },
      temperature: { source: 'temperature', target: 'temperature' },
      topP: { source: 'top_p', target: 'top_p' },
      stopSequences: { source: 'stop_sequences', target: 'stop' },
      stream: { source: 'stream', target: 'stream' }
    }
  },
  responseMappings: {
    finishReason: {
      mapping: { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'content_filter' },
    },
    usage: {
      fieldMapping: { prompt_tokens: 'input_tokens', completion_tokens: 'output_tokens', total_tokens: 'total_tokens' },
    },
  },
  streamMappings: {},
  toolMappings: {},
};

export function detectRequestFormat(request: any): 'anthropic' | 'openai' | 'unknown' {
  if (request && typeof request === 'object') {
    if ('system' in request) {return 'anthropic';}
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && 'input_schema' in firstTool) {return 'anthropic';}
    }
    if (request.messages && Array.isArray(request.messages)) {
      for (const message of request.messages) {
        if (message.tool_calls || message.function_call) {return 'openai';}
      }
    }
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      const firstTool = request.tools[0];
      if (firstTool && firstTool.type === 'function' && 'function' in firstTool) {return 'openai';}
    }
  }
  return 'unknown';
}

export function detectResponseFormat(response: any): 'anthropic' | 'openai' | 'unknown' {
  if (response && typeof response === 'object') {
    if ('choices' in response && Array.isArray(response.choices)) {return 'openai';}
    if ('content' in response && 'role' in response) {return 'anthropic';}
    if (response.object === 'chat.completion.chunk') {return 'openai';}
  }
  return 'unknown';
}


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

export function detectRequestFormat(request: unknown): 'anthropic' | 'openai' | 'unknown' {
  if (request && typeof request === 'object') {
    if ('system' in request) {return 'anthropic';}
    const tools = (request as Record<string, unknown>).tools;
    if (tools && Array.isArray(tools) && tools.length > 0) {
      const firstTool = tools[0];
      if (firstTool && typeof firstTool === 'object' && firstTool !== null && 'input_schema' in firstTool) {return 'anthropic';}
    }
    const messages = (request as Record<string, unknown>).messages;
    if (messages && Array.isArray(messages)) {
      for (const message of messages) {
        if (message && typeof message === 'object' && ((message as Record<string, unknown>).tool_calls || (message as Record<string, unknown>).function_call)) {return 'openai';}
      }
    }
    if ('model' in request && 'messages' in request) {
      if (typeof (request as Record<string, unknown>).max_tokens === 'number') {return 'anthropic';}
      return 'openai';
    }
  }
  return 'unknown';
}

export function detectResponseFormat(response: unknown): 'anthropic' | 'openai' | 'unknown' {
  if (response && typeof response === 'object') {
    if ('choices' in response && Array.isArray((response as Record<string, unknown>).choices)) {return 'openai';}
    if ('content' in response && 'role' in response) {return 'anthropic';}
    if ((response as Record<string, unknown>).object === 'chat.completion.chunk') {return 'openai';}
  }
  return 'unknown';
}


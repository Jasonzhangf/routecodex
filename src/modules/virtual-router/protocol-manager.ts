/**
 * Protocol Manager
 * 协议管理和转换
 */

export class ProtocolManager {
  private outputProtocol: string = 'openai';
  private converters: Map<string, ProtocolConverter> = new Map();

  constructor() {
    this.initializeConverters();
  }

  /**
   * 初始化协议转换器
   */
  private initializeConverters(): void {
    // 注册协议转换器
    this.converters.set('openai->anthropic', new OpenAIToAnthropicConverter());
    this.converters.set('anthropic->openai', new AnthropicToOpenAIConverter());
  }

  /**
   * 设置协议
   */
  setProtocols(_inputProtocol: string, outputProtocol: string): void {
    // inputProtocol 已废弃，仅保留 outputProtocol 供状态输出使用
    this.outputProtocol = outputProtocol;
  }

  /**
   * 转换请求
   */
  async convertRequest(request: Record<string, unknown>, fromProtocol: string, toProtocol: string): Promise<Record<string, unknown>> {
    if (fromProtocol === toProtocol) {
      return request;
    }

    const converterKey = `${fromProtocol}->${toProtocol}`;
    const converter = this.converters.get(converterKey);

    if (!converter) {
      throw new Error(`No converter found for ${fromProtocol} -> ${toProtocol}`);
    }

    return await converter.convertRequest(request);
  }

  /**
   * 转换响应
   */
  async convertResponse(response: Record<string, unknown>, fromProtocol: string, toProtocol: string): Promise<Record<string, unknown>> {
    if (fromProtocol === toProtocol) {
      return response;
    }

    const converterKey = `${fromProtocol}->${toProtocol}`;
    const converter = this.converters.get(converterKey);

    if (!converter) {
      throw new Error(`No converter found for ${fromProtocol} -> ${toProtocol}`);
    }

    return await converter.convertResponse(response);
  }

  /**
   * 获取支持的协议转换
   */
  getSupportedConversions(): string[] {
    return Array.from(this.converters.keys());
  }

  /**
   * 获取状态
   */
  getStatus(): ProtocolManagerStatus {
    return {
      outputProtocol: this.outputProtocol,
      supportedConversions: this.getSupportedConversions()
    };
  }
}

// 协议转换器接口
interface ProtocolConverter {
  convertRequest(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  convertResponse(response: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// OpenAI to Anthropic 转换器
class OpenAIToAnthropicConverter implements ProtocolConverter {
  async convertRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 将OpenAI格式转换为Anthropic格式
    const messages = (request['messages'] as Array<Record<string, unknown>> | undefined) || [];
    const anthropicRequest: Record<string, unknown> = {
      model: request['model'],
      max_tokens: (request['max_tokens'] as number) || 1024,
      messages: messages.map((msg) => ({
        role: msg['role'] === 'system' ? 'assistant' : msg['role'],
        content: msg['content']
      }))
    };

    console.log('🔄 Converted OpenAI request to Anthropic format');
    return anthropicRequest;
  }

  async convertResponse(response: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 将Anthropic格式转换为OpenAI格式
    const contentArr = (response['content'] as Array<Record<string, unknown>> | undefined) || [];
    const openaiResponse: Record<string, unknown> = {
      id: response['id'],
      object: 'chat.completion',
      created: Date.now(),
      model: response['model'],
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: (contentArr[0]?.['text'] as string) || ''
        },
        finish_reason: response['stop_reason']
      }]
    };

    console.log('🔄 Converted Anthropic response to OpenAI format');
    return openaiResponse;
  }
}

// Anthropic to OpenAI 转换器
class AnthropicToOpenAIConverter implements ProtocolConverter {
  async convertRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 将Anthropic格式转换为OpenAI格式
    const messages = (request['messages'] as Array<Record<string, unknown>> | undefined) || [];
    const openaiRequest: Record<string, unknown> = {
      model: request['model'],
      max_tokens: (request['max_tokens'] as number) || 1024,
      messages: messages.map((msg) => ({
        role: msg['role'] === 'assistant' ? 'system' : msg['role'],
        content: typeof msg['content'] === 'string' ? msg['content'] : (msg['content'] as Record<string, unknown>)?.['text']
      }))
    };

    console.log('🔄 Converted Anthropic request to OpenAI format');
    return openaiRequest;
  }

  async convertResponse(response: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 将OpenAI格式转换为Anthropic格式
    const choices = (response['choices'] as Array<Record<string, unknown>> | undefined) || [];
    const choice0 = choices[0] || {};
    const message = (choice0['message'] as Record<string, unknown>) || {};
    const anthropicResponse: Record<string, unknown> = {
      id: response['id'],
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: (message['content'] as string) || '' }],
      model: response['model'],
      stop_reason: choice0['finish_reason']
    };

    console.log('🔄 Converted OpenAI response to Anthropic format');
    return anthropicResponse;
  }
}

// 类型定义
interface ProtocolManagerStatus {
  outputProtocol: string;
  supportedConversions: string[];
}

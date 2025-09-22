/**
 * Protocol Manager
 * 协议管理和转换
 */

export class ProtocolManager {
  private inputProtocol: string = 'openai';
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
  setProtocols(inputProtocol: string, outputProtocol: string): void {
    this.inputProtocol = inputProtocol;
    this.outputProtocol = outputProtocol;
  }

  /**
   * 转换请求
   */
  async convertRequest(request: any, fromProtocol: string, toProtocol: string): Promise<any> {
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
  async convertResponse(response: any, fromProtocol: string, toProtocol: string): Promise<any> {
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
      inputProtocol: this.inputProtocol,
      outputProtocol: this.outputProtocol,
      supportedConversions: this.getSupportedConversions()
    };
  }
}

// 协议转换器接口
interface ProtocolConverter {
  convertRequest(request: any): Promise<any>;
  convertResponse(response: any): Promise<any>;
}

// OpenAI to Anthropic 转换器
class OpenAIToAnthropicConverter implements ProtocolConverter {
  async convertRequest(request: any): Promise<any> {
    // 将OpenAI格式转换为Anthropic格式
    const anthropicRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 1024,
      messages: request.messages.map((msg: any) => ({
        role: msg.role === 'system' ? 'assistant' : msg.role,
        content: msg.content
      }))
    };

    console.log('🔄 Converted OpenAI request to Anthropic format');
    return anthropicRequest;
  }

  async convertResponse(response: any): Promise<any> {
    // 将Anthropic格式转换为OpenAI格式
    const openaiResponse = {
      id: response.id,
      object: 'chat.completion',
      created: Date.now(),
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response.content[0]?.text || ''
        },
        finish_reason: response.stop_reason
      }]
    };

    console.log('🔄 Converted Anthropic response to OpenAI format');
    return openaiResponse;
  }
}

// Anthropic to OpenAI 转换器
class AnthropicToOpenAIConverter implements ProtocolConverter {
  async convertRequest(request: any): Promise<any> {
    // 将Anthropic格式转换为OpenAI格式
    const openaiRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 1024,
      messages: request.messages.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'system' : msg.role,
        content: typeof msg.content === 'string' ? msg.content : msg.content.text
      }))
    };

    console.log('🔄 Converted Anthropic request to OpenAI format');
    return openaiRequest;
  }

  async convertResponse(response: any): Promise<any> {
    // 将OpenAI格式转换为Anthropic格式
    const anthropicResponse = {
      id: response.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: response.choices[0]?.message?.content || '' }],
      model: response.model,
      stop_reason: response.choices[0]?.finish_reason
    };

    console.log('🔄 Converted OpenAI response to Anthropic format');
    return anthropicResponse;
  }
}

// 类型定义
interface ProtocolManagerStatus {
  inputProtocol: string;
  outputProtocol: string;
  supportedConversions: string[];
}

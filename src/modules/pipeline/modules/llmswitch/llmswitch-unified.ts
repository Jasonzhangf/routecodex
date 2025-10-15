/**
 * Unified LLMSwitch Module
 * 统一的LLMSwitch模块，根据请求端点动态选择协议转换器
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { OpenAINormalizerLLMSwitch } from './llmswitch-openai-openai.js';
import { AnthropicOpenAIConverter } from './llmswitch-anthropic-openai.js';

/**
 * 统一LLMSwitch配置
 */
export interface UnifiedLLMSwitchConfig {
  protocolDetection: 'endpoint-based' | 'content-based' | 'header-based';
  defaultProtocol: 'anthropic' | 'openai';
  endpointMapping?: {
    anthropic: string[];
    openai: string[];
  };
}

/**
 * 统一LLMSwitch模块
 * 根据请求端点自动选择合适的协议转换器
 */
export class UnifiedLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-unified';
  readonly protocol = 'unified';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private openaiSwitch: OpenAINormalizerLLMSwitch;
  private anthropicSwitch: AnthropicOpenAIConverter;
  private switchConfig: UnifiedLLMSwitchConfig;
  private protocolByRequestId: Map<string, 'anthropic' | 'openai'> = new Map();

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `llmswitch-unified-${Date.now()}`;
    this.config = config;
    const provided = (config.config as UnifiedLLMSwitchConfig | undefined);
    if (!provided || !provided.endpointMapping) {
      throw new Error('llmswitch-unified requires endpointMapping in module config (no defaults in code).');
    }
    this.switchConfig = provided;

    // 创建两个转换器实例
    this.openaiSwitch = new OpenAINormalizerLLMSwitch(
      { type: 'llmswitch-openai-openai', config: {} },
      dependencies
    );
    
    this.anthropicSwitch = new AnthropicOpenAIConverter(
      { type: 'llmswitch-anthropic-openai', config: {} },
      dependencies
    );
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // 初始化两个转换器
    await this.openaiSwitch.initialize();
    await this.anthropicSwitch.initialize();

    this.isInitialized = true;
  }

  /**
   * Process incoming request as DTO
   */
  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 根据协议检测选择转换器
    const protocol = this.detectProtocol(request);
    try {
      // Remember decision for response stage using requestId
      const reqId = request?.route?.requestId;
      if (reqId) { this.protocolByRequestId.set(reqId, protocol); }
    } catch { /* non-blocking */ }
    const selectedSwitch = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;

    // 使用选中的转换器处理请求
    return await selectedSwitch.processIncoming(request);
  }

  /**
   * Transform request to target protocol
   */
  async transformRequest(request: any): Promise<unknown> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 根据协议检测选择转换器
    const protocol = this.detectProtocol(request);
    const selectedSwitch = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;

    // 使用选中的转换器转换请求
    return await selectedSwitch.transformRequest(request);
  }

  /**
   * Process outgoing response
   */
  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 根据请求ID回忆协议选择，若缺失则回退检测
    let protocol: 'anthropic' | 'openai' = this.switchConfig.defaultProtocol;
    try {
      const reqId = (response && typeof response === 'object' && 'metadata' in response)
        ? (response as { metadata?: { requestId?: string } }).metadata?.requestId
        : undefined;
      if (reqId && this.protocolByRequestId.has(reqId)) {
        protocol = this.protocolByRequestId.get(reqId)!;
        // cleanup to avoid memory leaks
        this.protocolByRequestId.delete(reqId);
      } else {
        protocol = this.detectProtocol(response);
      }
    } catch {
      protocol = this.detectProtocol(response);
    }
    const selectedSwitch = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;

    // 使用选中的转换器处理响应
    return await selectedSwitch.processOutgoing(response);
  }

  /**
   * Transform response from target protocol
   */
  async transformResponse(response: any): Promise<unknown> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 根据协议检测选择转换器
    const protocol = this.detectProtocol(response);
    const selectedSwitch = protocol === 'anthropic' ? this.anthropicSwitch : this.openaiSwitch;

    // 使用选中的转换器转换响应
    return await selectedSwitch.transformResponse(response);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.openaiSwitch) {
      await this.openaiSwitch.cleanup();
    }
    if (this.anthropicSwitch) {
      await this.anthropicSwitch.cleanup();
    }
    this.isInitialized = false;
  }

  /**
   * 检测请求协议
   */
  private detectProtocol(request: any): 'anthropic' | 'openai' {
    const detectionMethod = this.switchConfig.protocolDetection;
    
    switch (detectionMethod) {
      case 'endpoint-based':
        return this.detectProtocolByEndpoint(request);
      case 'content-based':
        return this.detectProtocolByContent(request);
      case 'header-based':
        return this.detectProtocolByHeaders(request);
      default:
        return this.switchConfig.defaultProtocol;
    }
  }

  /**
   * 基于端点检测协议
   */
  private detectProtocolByEndpoint(request: any): 'anthropic' | 'openai' {
    // 优先使用显式目标协议
    const explicit = (request?._metadata?.targetProtocol || request?.metadata?.targetProtocol) as string | undefined;
    if (explicit && (explicit === 'anthropic' || explicit === 'openai')) {
      return explicit;
    }

    // 尝试从多个位置获取端点信息
    const endpoint = request._metadata?.endpoint ||
                     request.endpoint ||
                     request.metadata?.endpoint ||
                     request.metadata?.url ||
                     request.url ||
                     '';
    
    console.log(`[UnifiedLLMSwitch] DEBUG - Endpoint detection: endpoint="${endpoint}"`);
    
    const mapping = this.switchConfig.endpointMapping;
    if (!mapping) {
      throw new Error('llmswitch-unified endpointMapping missing');
    }
    
    if (mapping.anthropic.some(ep => endpoint.includes(ep))) {
      console.log(`[UnifiedLLMSwitch] DEBUG - Detected anthropic protocol for endpoint: ${endpoint}`);
      return 'anthropic';
    }
    
    if (mapping.openai.some(ep => endpoint.includes(ep))) {
      console.log(`[UnifiedLLMSwitch] DEBUG - Detected openai protocol for endpoint: ${endpoint}`);
      return 'openai';
    }
    
    console.log(`[UnifiedLLMSwitch] DEBUG - No protocol matched for endpoint: ${endpoint}, using default: ${this.switchConfig.defaultProtocol}`);
    return this.switchConfig.defaultProtocol;
  }

  /**
   * 基于内容检测协议
   */
  private detectProtocolByContent(request: any): 'anthropic' | 'openai' {
    // 根据请求内容特征检测协议
    if (request.messages && Array.isArray(request.messages)) {
      // OpenAI格式通常有messages数组
      return 'openai';
    }
    
    if (request.max_tokens !== undefined && request.model !== undefined) {
      // Anthropic格式通常有max_tokens和model
      return 'anthropic';
    }
    
    return this.switchConfig.defaultProtocol;
  }

  /**
   * 基于请求头检测协议
   */
  private detectProtocolByHeaders(request: any): 'anthropic' | 'openai' {
    const headers = request._metadata?.headers || request.headers || {};
    
    if (headers['anthropic-version']) {
      return 'anthropic';
    }
    
    if (headers['content-type'] === 'application/json' && 
        (headers['authorization'] || '').startsWith('Bearer ')) {
      return 'openai';
    }
    
    return this.switchConfig.defaultProtocol;
  }

  /**
   * 获取状态信息
   */
  getStats(): any {
    return {
      type: this.type,
      protocol: this.protocol,
      isInitialized: this.isInitialized,
      switchConfig: this.switchConfig
    };
  }
}

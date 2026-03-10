/**
 * 配置管理模块
 * 
 * 提供统一的配置读取、设置和管理功能
 */

// llmswitch-core 只维护内存中的转换配置快照，
// 不负责任何配置文件的读取或写入。所有配置加载、
// 合并与持久化都必须由上层 config-engine 或宿主进程完成。

/**
 * 配置接口定义
 */
export interface ConversionConfig {
  /** HTTP服务器配置 */
  httpserver?: {
    port: number;
    host: string;
  };
  
  /** 虚拟路由器配置 */
  virtualrouter?: {
    inputProtocol?: string;
    outputProtocol?: string;
    providers?: Record<string, ProviderConfig>;
    routing?: {
      default?: string[];
      [key: string]: string[];
    };
  };
  
  /** 服务工具配置 */
  serverTools?: {
    replace?: Record<string, { enabled: boolean }>;
    enabled?: boolean;
  };

  /** 转换配置（V2/V3 版本切换相关） */
  conversion?: {
    /** 默认使用的转换版本 */
    defaultVersion?: 'v2' | 'v3' | 'auto';
    /** 允许附加自定义配置字段 */
    [key: string]: unknown;
  };
}

/**
 * Provider 配置接口
 */
export interface ProviderConfig {
  id: string;
  enabled: boolean;
  // 协议类型：仅表示 wire protocol，而非具体 Provider 家族名。
  //  - 'openai'    → OpenAI Chat 兼容协议族（包含 OpenAI / 第三方 Chat-completions）
  //  - 'responses' → OpenAI Responses wire（/v1/responses）
  //  - 'anthropic' → Anthropic Messages wire（/v1/messages）
  //  - 'gemini'    → Gemini Chat wire（未来扩展）
  //  - 'custom'    → 由宿主解释的自定义协议
  type: 'openai' | 'anthropic' | 'responses' | 'gemini' | 'custom';
  baseUrl?: string;
  apiKey?: string[];
  auth?: {
    type: 'apikey' | 'oauth';
    apiKey?: string;
  };
  models?: Record<string, ModelConfig>;
}

/**
 * 模型配置接口
 */
export interface ModelConfig {
  supportsStreaming?: boolean;
  compatibility?: {
    type?: string;
    config?: any;
 };
}

/**
 * 配置管理器类
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: ConversionConfig | null = null;

  private constructor() {
    // 不在构造函数中建立任何默认配置，必须由外部显式调用 setConfig
    // 注入配置，避免 llmswitch-core 内部产生隐式默认行为。
  }
  
  /**
   * 获取单例实例
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }
  
  /**
   * 设置配置
   * 
   * @param config 要设置的配置
   * @param options 选项
   */
  static setConfig(
    config: Partial<ConversionConfig>,
    options: {
      merge?: boolean;
      validate?: boolean;
      save?: boolean;
      source?: string;
    } = {}
  ): void {
    const manager = ConfigManager.getInstance();
 
    try {
      // 合并配置
      const base = manager.config ?? {};
      manager.config = options.merge === false
        ? ({ ...base, ...config } as ConversionConfig)
        : (manager.deepMerge(base, config) as ConversionConfig);
      
      // 验证配置
      if (options.validate !== false) {
        manager.validateConfig(manager.config);
      }
      
      console.log(`Config updated successfully (source: ${options.source || 'manual'})`);
    } catch (error) {
      console.error('Failed to set config:', error);
      throw new Error(`Failed to set config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
 
  /**
   * 获取配置
   * 
   * @param path 指定配置路径（可选）
   * @returns 配置对象
   */
  static async getConfig(path?: string): Promise<ConversionConfig> {
    const manager = ConfigManager.getInstance();
    // 为保持签名兼容，保留 path 参数但忽略它；
    // 真正的配置加载应由上层完成后通过 setConfig 注入。
    if (!manager.config) {
      throw new Error(
        'Conversion config has not been initialized. Use ConfigManager.setConfig() before getConfig().'
      );
    }
    return manager.config;
  }
 
  /**
   * 重新加载配置
   */
  static async reloadConfig(): Promise<ConversionConfig> {
    // 不再尝试从磁盘重载配置，仅简单委托给 getConfig，
    // 由外部在调用前决定是否需要更新内存中的配置快照。
    return ConfigManager.getConfig();
  }
 
  /**
   * 验证配置
   */
  private validateConfig(config: ConversionConfig): void {
    if (!config) {
      throw new Error('Config cannot be null');
    }
    
    // 验证虚拟路由器配置
    if (config.virtualrouter) {
      if (!config.virtualrouter.outputProtocol) {
        throw new Error('virtualrouter.outputProtocol is required');
      }
      
      if (!config.virtualrouter.providers) {
        throw new Error('virtualrouter.providers is required');
      }
      
      // 验证每个 provider 配置
      for (const [name, provider] of Object.entries(config.virtualrouter.providers)) {
        if (!provider.id) {
          throw new Error(`Provider ${name} missing id`);
        }
        if (typeof provider.type !== 'string') {
          throw new Error(`Provider ${name} type must be a string`);
        }
      }
    }
  }
 
  /**
   * 深度合并对象（仅在内存中操作，不做任何持久化）
   */
  private deepMerge(target: any, source: any): any {
    if (!source) return target;
    const result = { ...target };
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /**
   * 获取配置摘要
   */
  static getConfigSummary(): {
    totalProviders: number;
    enabledProviders: string[];
    outputProtocol: string;
    inputProtocol: string;
    routingDefaults: string[];
    hasConversionConfig: boolean;
  }
  {
    const manager = ConfigManager.getInstance();
    const config = manager.config || {};
    
    const providers = config.virtualrouter?.providers || {};
    const enabled = Object.entries(providers)
      .filter(([_, provider]) => provider.enabled)
      .map(([name, _]) => name);
    
    return {
      totalProviders: Object.keys(providers).length,
      enabledProviders: enabled,
      outputProtocol: config.virtualrouter?.outputProtocol || 'unknown',
      inputProtocol: config.virtualrouter?.inputProtocol || 'unknown',
      routingDefaults: config.virtualrouter?.routing?.default || [],
      hasConversionConfig: !!config.conversion
    };
  }
  
  /**
   * 获取 provider 配置
   */
  static getProviderConfig(providerName: string): ProviderConfig | null {
    const manager = ConfigManager.getInstance();
    return manager.config?.virtualrouter?.providers?.[providerName] || null;
  }
  
  /**
   * 检查 provider 是否可用
   */
  static isProviderEnabled(providerName: string): boolean {
    const provider = ConfigManager.getProviderConfig(providerName);
    return provider?.enabled || false;
  }
  
  /**
   * 设置 provider 启用状态
   */
  static setProviderEnabled(providerName: string, enabled: boolean): void {
    const manager = ConfigManager.getInstance();
    
    if (!manager.config || !manager.config.virtualrouter?.providers?.[providerName]) {
      return;
    }
    manager.config.virtualrouter.providers[providerName].enabled = enabled;
  }
 
  /**
  /**
   * 获取输出协议
   */
  static getOutputProtocol(): string {
    const manager = ConfigManager.getInstance();
    return manager.config?.virtualrouter?.outputProtocol || 'openai';
  }
  
  /**
   * 设置输出协议
   */
  static setOutputProtocol(protocol: string): void {
    const manager = ConfigManager.getInstance();
    
    if (!manager.config) {
      manager.config = {};
    }
    if (!manager.config.virtualrouter) {
      manager.config.virtualrouter = {};
    }
    
    manager.config.virtualrouter.outputProtocol = protocol;
    
    console.log(`Output protocol changed to: ${protocol}`);
  }
  
  /**
   * 获取输入协议
   */
  static getInputProtocol(): string {
    const manager = ConfigManager.getInstance();
    return manager.config?.virtualrouter?.inputProtocol || 'openai';
  }
  
  /**
   * 设置输入协议
   */
  static setInputProtocol(protocol: string): void {
    const manager = ConfigManager.getInstance();
    
    if (!manager.config) {
      manager.config = {};
    }
    if (!manager.config.virtualrouter) {
      manager.config.virtualrouter = {};
    }
    
    manager.config.virtualrouter.inputProtocol = protocol;
    
    console.log(`Input protocol changed to: ${protocol}`);
  }
  
  /**
 * 获取路由配置
   */
  static getRoutingConfig(): any {
    const manager = ConfigManager.getInstance();
    return manager.config?.virtualrouter?.routing || {};
  }
 
  /**
 * 设置路由配置
   */
  static setRoutingConfig(routing: any): void {
    const manager = ConfigManager.getInstance();
    
    if (!manager.config) {
      manager.config = {};
    }
    if (!manager.config.virtualrouter) {
      manager.config.virtualrouter = {};
    }
    
    manager.config.virtualrouter.routing = routing;
    
    console.log('Routing config updated');
  }
  
  /**
 * 获取 V3 转换配置
   */
  static getConversionConfig(): any {
    const manager = ConfigManager.getInstance();
    return manager.config?.conversion || {};
  }
  
  /**
  * 设置 V3 转换配置
   */
  static setConversionConfig(conversion: any): void {
    const manager = ConfigManager.getInstance();
    
    if (!manager.config) {
      manager.config = {};
    }
    if (!manager.config.conversion) {
      manager.config.conversion = {};
    }
    
    manager.config.conversion = manager.deepMerge(manager.config.conversion, conversion);
    
    console.log('Conversion config updated');
  }
 
}

/**
 * 便捷函数：设置配置
 */
export function setConfig(
  config: Partial<ConversionConfig>,
  options?: {
    merge?: boolean;
    validate?: boolean;
    save?: boolean;
    source?: string;
  }
): void {
  ConfigManager.setConfig(config, options);
}

/**
 * 便捷函数：获取配置
 */
export async function getConfig(path?: string): Promise<ConversionConfig> {
  return ConfigManager.getConfig(path);
}

/**
 * 便捷函数：重新加载配置
 */
export async function reloadConfig(): Promise<ConversionConfig> {
  return ConfigManager.reloadConfig();
}

/**
 * 便捷函数：获取配置摘要
 */
export function getConfigSummary(): ReturnType<typeof ConfigManager.getConfigSummary> {
  return ConfigManager.getConfigSummary();
}

/**
 * 便捷函数：获取 Provider 配置
 */
export function getProviderConfig(providerName: string): ProviderConfig | null {
  return ConfigManager.getProviderConfig(providerName);
}

/**
 * 便捷函数：检查 Provider 状态
 */
export function isProviderEnabled(providerName: string): boolean {
  return ConfigManager.isProviderEnabled(providerName);
}

/**
 * 便捷函数：设置 Provider 状态
 */
export function setProviderEnabled(providerName: string, enabled: boolean): void {
  ConfigManager.setProviderEnabled(providerName, enabled);
}

/**
 * 便捷函数：获取输出协议
 */
export function getOutputProtocol(): string {
  return ConfigManager.getOutputProtocol();
}

/**
 * 便捷函数：设置输出协议
 */
export function setOutputProtocol(protocol: string): void {
  ConfigManager.setOutputProtocol(protocol);
}

/**
 * 便捷函数：获取输入协议
 */
export function getInputProtocol(): string {
  return ConfigManager.getInputProtocol();
}
/**
 * 便捷函数：设置输入协议
 */
export function setInputProtocol(protocol: string): void {
  ConfigManager.setInputProtocol(protocol);
}

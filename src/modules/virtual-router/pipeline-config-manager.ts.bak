/**
 * Pipeline Configuration Manager
 * 流水线配置管理
 */

export class PipelineConfigManager {
  private configs: Map<string, PipelineConfig> = new Map();
  private configCache: Map<string, unknown> = new Map();

  /**
   * 添加流水线配置
   */
  addPipelineConfig(key: string, config: PipelineConfig): void {
    this.configs.set(key, config);
    this.configCache.delete(key); // 清除缓存
  }

  /**
   * 批量添加流水线配置
   */
  addPipelineConfigs(configs: Record<string, PipelineConfig>): void {
    for (const [key, config] of Object.entries(configs)) {
      this.addPipelineConfig(key, config);
    }
  }

  /**
   * 获取流水线配置
   */
  getPipelineConfig(key: string): PipelineConfig | undefined {
    return this.configs.get(key);
  }

  /**
   * 获取或创建流水线实例
   */
  async getPipelineInstance(key: string): Promise<unknown> {
    // 检查缓存
    if (this.configCache.has(key)) {
      return this.configCache.get(key);
    }

    const config = this.getPipelineConfig(key);
    if (!config) {
      throw new Error(`Pipeline config not found: ${key}`);
    }

    // 创建流水线实例
    const pipeline = await this.createPipelineInstance(config);

    // 缓存实例
    this.configCache.set(key, pipeline);

    return pipeline;
  }

  /**
   * 移除流水线配置
   */
  removePipelineConfig(key: string): void {
    this.configs.delete(key);
    this.configCache.delete(key);
  }

  /**
   * 清除所有配置
   */
  clearConfigs(): void {
    this.configs.clear();
    this.configCache.clear();
  }

  /**
   * 获取配置统计信息
   */
  getStatistics(): PipelineConfigStatistics {
    const stats: PipelineConfigStatistics = {
      totalConfigs: this.configs.size,
      cachedInstances: this.configCache.size,
      providerTypes: {},
      protocolTypes: { input: {}, output: {} }
    };

    for (const config of this.configs.values()) {
      // 统计provider类型
      const providerType = config.provider.type;
      stats.providerTypes[providerType] = (stats.providerTypes[providerType] || 0) + 1;

      // 统计协议类型
      const inputProtocol = config.protocols.input;
      const outputProtocol = config.protocols.output;

      stats.protocolTypes.input[inputProtocol] =
        (stats.protocolTypes.input[inputProtocol] || 0) + 1;
      stats.protocolTypes.output[outputProtocol] =
        (stats.protocolTypes.output[outputProtocol] || 0) + 1;
    }

    return stats;
  }

  /**
   * 创建流水线实例
   */
  private async createPipelineInstance(config: PipelineConfig): Promise<unknown> {
    // TODO: 实现实际的流水线创建逻辑
    console.log(`🔄 Creating pipeline instance for ${config.provider.type}`);

    return {
      provider: config.provider,
      model: config.model,
      protocols: config.protocols,
      execute: async (_request: unknown) => {
        // 模拟流水线执行
        return {
          id: `pipeline-response-${  Date.now()}`,
          success: true
        };
      }
    };
  }
}

// 类型定义
interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
  };
  protocols: {
    input: string;
    output: string;
  };
}

interface PipelineConfigStatistics {
  totalConfigs: number;
  cachedInstances: number;
  providerTypes: Record<string, number>;
  protocolTypes: {
    input: Record<string, number>;
    output: Record<string, number>;
  };
}

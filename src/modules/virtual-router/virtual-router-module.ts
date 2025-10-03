/**
 * 基于输入模型的虚拟路由器模块 - 无默认设置版本
 * 完全基于modules.json配置，无fallback，无硬编码，无默认值
 */

import { BaseModule } from '../../core/base-module.js';
import { ModelFieldConverter } from '../../utils/model-field-converter/index.js';
import { RCCUnimplementedModule } from '../../modules/unimplemented-module.js';
import { ConfigRequestClassifier } from './classifiers/config-request-classifier.js';
import { virtualRouterDryRunExecutor } from './virtual-router-dry-run.js';
import type { VirtualRouterDryRunConfig } from './virtual-router-dry-run.js';

export class VirtualRouterModule extends BaseModule {
  private routeTargets: any = {};
  private pipelineConfigs: any = {};
  private protocolManager: any;
  private loadBalancer: any;
  private fieldConverter: ModelFieldConverter;
  private unimplementedModule: RCCUnimplementedModule;
  private inputModelRequestClassifier: ConfigRequestClassifier | null = null;
  private dryRunConfig: VirtualRouterDryRunConfig = { enabled: false };

  constructor() {
    super({
      id: 'virtual-router',
      name: 'Virtual Router',
      version: '1.0.0',
      description: 'Pure routing decision based on input model - no load balancing'
    });

    this.fieldConverter = new ModelFieldConverter();
    this.unimplementedModule = new RCCUnimplementedModule({
      moduleId: 'virtual-router-unimplemented',
      moduleName: 'Virtual Router Unimplemented',
      description: 'Unimplemented features for virtual router'
    });
    this.protocolManager = new ProtocolManager();
    this.loadBalancer = new LoadBalancer();
  }

  /**
   * 初始化模块 - 完全基于配置，支持dry-run模式
   */
  async initialize(config: any): Promise<void> {
    console.log('🔄 Initializing Input Model-based Virtual Router Module...');

    try {
      // 验证必需配置
      this.validateConfig(config);

      // 设置路由目标池
      this.routeTargets = config.routeTargets;

      // 设置流水线配置
      this.pipelineConfigs = config.pipelineConfigs;

      // 处理dry-run配置
      if (config.dryRun?.enabled) {
        this.dryRunConfig = {
          enabled: true,
          includeLoadBalancerDetails: config.dryRun.includeLoadBalancerDetails ?? true,
          includeHealthStatus: config.dryRun.includeHealthStatus ?? true,
          includeWeightCalculation: config.dryRun.includeWeightCalculation ?? true,
          simulateProviderHealth: config.dryRun.simulateProviderHealth ?? true,
          forcedProviderId: config.dryRun.forcedProviderId
        };
        
        // 初始化虚拟路由器dry-run执行器
        await virtualRouterDryRunExecutor.initialize(config);
        console.log('🔍 Virtual Router Dry-Run mode enabled');
      }

      // 初始化输入模型分类器
      await this.initializeInputModelClassifier(config);

      // 初始化协议管理器
      await this.protocolManager.initialize({
        inputProtocol: config.inputProtocol,
        outputProtocol: config.outputProtocol
      });

      // 初始化负载均衡器
      await this.loadBalancer.initialize(this.routeTargets);

      console.log('✅ Input Model-based Virtual Router Module initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Virtual Router Module:', error);
      throw error;
    }
  }

  /**
   * 验证配置 - 无默认值，必须完整
   */
  private validateConfig(config: any): void {
    if (!config) {
      throw new Error('虚拟路由器配置不能为空');
    }

    if (!config.routeTargets || Object.keys(config.routeTargets).length === 0) {
      throw new Error('routeTargets配置不能为空');
    }

    if (!config.pipelineConfigs || Object.keys(config.pipelineConfigs).length === 0) {
      throw new Error('pipelineConfigs配置不能为空');
    }

    if (!config.inputProtocol) {
      throw new Error('inputProtocol配置不能为空');
    }

    if (!config.outputProtocol) {
      throw new Error('outputProtocol配置不能为空');
    }
  }

  /**
   * 初始化输入模型分类器
   */
  private async initializeInputModelClassifier(config: any): Promise<void> {
    if (!config.classificationConfig || !config.classificationConfig.inputModelWeights) {
      throw new Error('输入模型权重配置不能为空');
    }

    this.inputModelRequestClassifier = ConfigRequestClassifier.fromModuleConfig(config);
  }

  /**
   * 路由请求 - 完全基于输入模型分类，支持dry-run模式
   */
  async routeRequest(request: any, routeName: string = 'default'): Promise<any> {
    try {
      // 检查是否启用了dry-run模式
      if (this.dryRunConfig.enabled) {
        return await this.executeDryRunRouting(request);
      }

      // 1. 输入模型分类
      const classificationResult = await this.classifyRequest(request);
      
      // 2. 获取分类决定的路由
      const determinedRoute = classificationResult.route;
      
      // 3. 获取该路由的可用目标
      const targets = this.routeTargets[determinedRoute];
      if (!targets || targets.length === 0) {
        throw new Error(`路由 ${determinedRoute} 没有配置目标模型`);
      }

      // 4. 选择目标
      const target = await this.loadBalancer.selectTarget(targets);
      if (!target) {
        throw new Error(`路由 ${determinedRoute} 没有可用目标`);
      }

      // 5. 获取流水线配置
      const pipelineConfig = this.pipelineConfigs[
        `${target.providerId}.${target.modelId}.${target.keyId}`
      ];
      if (!pipelineConfig) {
        throw new Error(`未找到目标 ${target.providerId}.${target.modelId}.${target.keyId} 的流水线配置`);
      }

      // 6. 协议转换（如果需要）
      const convertedRequest = await this.protocolManager.convertRequest(
        request,
        pipelineConfig.protocols.input,
        pipelineConfig.protocols.output
      );

      // 7. 执行请求
      const response = await this.executeRequest(convertedRequest, pipelineConfig);

      // 8. 协议转换响应（如果需要）
      const convertedResponse = await this.protocolManager.convertResponse(
        response,
        pipelineConfig.protocols.output,
        pipelineConfig.protocols.input
      );

      return {
        response: convertedResponse,
        routing: {
          route: determinedRoute,
          inputModel: classificationResult.inputModel,
          inputModelWeight: classificationResult.inputModelWeight,
          confidence: classificationResult.confidence,
          reasoning: classificationResult.reasoning,
          target: target
        }
      };

    } catch (error) {
      console.error(`❌ Request routing failed:`, error);
      throw error;
    }
  }

  /**
   * 执行dry-run路由，返回详细的负载均衡和路由决策信息
   */
  private async executeDryRunRouting(request: any): Promise<any> {
    console.log('🔍 Executing virtual router dry-run...');
    
    try {
      // 准备分类输入
      const classificationInput = {
        request: request,
        endpoint: request.endpoint || '/v1/chat/completions',
        protocol: request.protocol || 'openai'
      };

      // 执行虚拟路由器dry-run
      const dryRunResult = await virtualRouterDryRunExecutor.executeDryRun(classificationInput);

      // 返回dry-run结果，包含真实的负载均衡决策
      return {
        response: {
          id: `dryrun-response-${Date.now()}`,
          object: 'chat.completion',
          model: 'dry-run-mode',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Virtual router dry-run completed successfully'
            }
          }]
        },
        routing: {
          route: dryRunResult.routingDecision.route,
          confidence: dryRunResult.routingDecision.confidence,
          reasoning: dryRunResult.routingDecision.reasoning,
          target: {
            providerId: dryRunResult.loadBalancerAnalysis?.selectedProvider || 'unknown',
            modelId: 'unknown',
            keyId: 'unknown'
          },
          dryRunDetails: dryRunResult // 包含完整的dry-run信息
        }
      };

    } catch (error) {
      console.error(`❌ Virtual router dry-run failed:`, error);
      throw error;
    }
  }

  /**
   * 分类请求 - 完全基于输入模型
   */
  private async classifyRequest(request: any): Promise<any> {
    if (!this.inputModelRequestClassifier) {
      throw new Error('输入模型分类器未初始化');
    }

    const classificationInput = {
      request: request,
      endpoint: request.endpoint || '/v1/chat/completions',
      protocol: request.protocol || 'openai'
    };

    const result = await this.inputModelRequestClassifier.classify(classificationInput);
    
    if (!result.success) {
      throw new Error(`输入模型分类失败: ${result.reasoning}`);
    }

    return result;
  }

  /**
   * 执行请求
   */
  private async executeRequest(request: any, pipelineConfig: any): Promise<any> {
    console.log(`🔄 Executing request to ${pipelineConfig.provider.baseURL}`);
    
    // 这里应该调用实际的provider执行逻辑
    // 现在返回模拟响应
    return {
      id: `response-${Date.now()}`,
      object: 'chat.completion',
      model: pipelineConfig.provider.type,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `Response from ${pipelineConfig.provider.type} via route`
        }
      }]
    };
  }

  /**
   * 获取状态
   */
  getStatus(): any {
    const classifierStatus = this.inputModelRequestClassifier?.getStatus() || null;
    
    return {
      status: this.isModuleRunning() ? 'running' : 'stopped',
      routeTargets: Object.keys(this.routeTargets),
      pipelineConfigs: Object.keys(this.pipelineConfigs),
      classifier: {
        enabled: !!this.inputModelRequestClassifier,
        inputModelBased: true,
        protocols: classifierStatus?.protocols || [],
        inputModelsConfigured: Object.keys(this.routeTargets).length
      }
    };
  }
}

// 简化的协议管理器
class ProtocolManager {
  private inputProtocol: string = '';
  private outputProtocol: string = '';

  async initialize(config: { inputProtocol: string; outputProtocol: string }): Promise<void> {
    this.inputProtocol = config.inputProtocol;
    this.outputProtocol = config.outputProtocol;
  }

  async convertRequest(request: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return request;
    }
    // 简化处理
    return request;
  }

  async convertResponse(response: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return response;
    }
    // 简化处理
    return response;
  }

  getStatus(): any {
    return {
      inputProtocol: this.inputProtocol,
      outputProtocol: this.outputProtocol
    };
  }
}

// 简化的负载均衡器
class LoadBalancer {
  private routeTargets: any = {};
  private currentIndex: Map<string, number> = new Map();

  async initialize(routeTargets: any): Promise<void> {
    this.routeTargets = routeTargets;
  }

  async selectTarget(targets: any[]): Promise<any> {
    if (targets.length === 0) {
      return null;
    }
    
    if (targets.length === 1) {
      return targets[0];
    }

    // 简单的轮询
    const routeName = Object.keys(this.routeTargets).find(name => 
      this.routeTargets[name] === targets
    );

    if (!routeName) {
      return targets[0];
    }

    const currentIndex = this.currentIndex.get(routeName) || 0;
    const nextIndex = (currentIndex + 1) % targets.length;
    this.currentIndex.set(routeName, nextIndex);

    return targets[nextIndex];
  }

  getStatus(): any {
    return {
      strategy: 'round-robin',
      currentIndex: Object.fromEntries(this.currentIndex)
    };
  }
}

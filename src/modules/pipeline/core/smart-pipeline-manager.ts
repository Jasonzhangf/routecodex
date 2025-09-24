/**
 * 智能流水线配置管理器
 * 根据请求格式动态选择LLMSwitch类型
 */

import type { PipelineConfig, ModuleConfig } from '../interfaces/pipeline-interfaces.js';
import { SmartRequestFormatDetector, LLMSwitchSelector } from '../modules/llmswitch/request-format-detector.js';
import { detectRequestFormat } from '../modules/llmswitch/anthropic-openai-config.js';
import { DebugEventBus, DebugCenter } from '../../../utils/external-mocks.js';
import { DebugEnhancementManager } from '../../debug/debug-enhancement-manager.js';

/**
 * 智能流水线配置
 */
export interface SmartPipelineConfig extends PipelineConfig {
  /**
   * 端点类型，用于确定默认的LLMSwitch行为
   * anthropic: 使用anthropic-openai-converter
   * openai: 使用openai-passthrough
   * auto: 根据请求格式自动检测
   */
  endpointType?: 'anthropic' | 'openai' | 'auto';
  
  /**
   * LLMSwitch选择策略
   */
  llmSwitchStrategy?: {
    /**
     * 是否启用智能格式检测
     */
    enableSmartDetection: boolean;
    
    /**
     * 置信度阈值
     */
    confidenceThreshold: number;
    
    /**
     * 回退类型（当检测失败时）
     */
    fallbackType: 'anthropic-openai-converter' | 'openai-passthrough';
    
    /**
     * 自定义转换配置
     */
    conversionMappings?: any;
  };
}

/**
 * 智能流水线工厂
 */
export class SmartPipelineFactory {
  // Debug enhancement properties
  public static debugEventBus: DebugEventBus | null = null;
  public static isDebugEnhanced = false;
  public static pipelineMetrics: Map<string, any> = new Map();
  public static formatDetectionStats: Map<string, any> = new Map();
  public static configHistory: any[] = [];
  public static maxHistorySize = 100;

  // Initialize debug enhancements
  static {
    SmartPipelineFactory.initializeDebugEnhancements();
  }

  /**
   * Initialize debug enhancements
   */
  private static initializeDebugEnhancements(): void {
    try {
      SmartPipelineFactory.debugEventBus = DebugEventBus.getInstance();
      SmartPipelineFactory.isDebugEnhanced = true;
      console.log('Smart Pipeline Factory debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Smart Pipeline Factory debug enhancements:', error);
      SmartPipelineFactory.isDebugEnhanced = false;
    }
  }

  /**
   * 根据请求创建流水线配置
   */
  static createPipelineConfigForRequest(
    baseConfig: SmartPipelineConfig,
    request: any
  ): PipelineConfig {
    const startTime = Date.now();
    const configId = `pipeline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record config creation start
    if (SmartPipelineFactory.isDebugEnhanced) {
      (SmartPipelineFactory as any).recordPipelineMetric('config_creation_start', {
        configId,
        baseConfigId: baseConfig.id,
        timestamp: startTime
      });
      (SmartPipelineFactory as any).publishDebugEvent('config_creation_start', {
        configId,
        baseConfigId: baseConfig.id,
        requestType: typeof request,
        timestamp: startTime
      });
    }

    // 检测请求格式
    const formatDetection = SmartRequestFormatDetector.detect(request);

    // 确定端点类型
    const endpointType = baseConfig.endpointType || 'auto';

    // Debug: Record format detection
    if (SmartPipelineFactory.isDebugEnhanced) {
      (SmartPipelineFactory as any).recordFormatDetectionMetric(formatDetection.type, {
        confidence: formatDetection.confidence,
        indicators: formatDetection.indicators,
        endpointType
      });
      (SmartPipelineFactory as any).publishDebugEvent('format_detection_complete', {
        configId,
        formatDetection,
        endpointType,
        processingTime: Date.now() - startTime
      });
    }

    // 选择LLMSwitch类型
    const llmSwitchType = LLMSwitchSelector.selectLLMSwitchType(formatDetection, endpointType);

    // Debug: Record LLMSwitch selection
    if (SmartPipelineFactory.isDebugEnhanced) {
      (SmartPipelineFactory as any).recordPipelineMetric('llm_switch_selected', {
        configId,
        selectedType: llmSwitchType,
        formatDetection,
        endpointType,
        decision: llmSwitchType === 'anthropic-openai-converter' ? 'CONVERT' : 'PASSTHROUGH'
      });
      (SmartPipelineFactory as any).publishDebugEvent('llm_switch_selected', {
        configId,
        llmSwitchType,
        formatDetection,
        endpointType,
        processingTime: Date.now() - startTime
      });
    }
    
    // 获取LLMSwitch配置
    const llmSwitchConfig = LLMSwitchSelector.getLLMSwitchConfig(
      baseConfig.modules.llmSwitch.config || {},
      formatDetection,
      endpointType
    );
    
    // 创建新的流水线配置
    const pipelineConfig: PipelineConfig = {
      ...baseConfig,
      modules: {
        ...baseConfig.modules,
        llmSwitch: {
          ...baseConfig.modules.llmSwitch,
          type: llmSwitchType,
          config: {
            ...baseConfig.modules.llmSwitch.config,
            ...llmSwitchConfig.config,
            // 添加格式检测元数据
            _formatDetection: {
              detectedFormat: formatDetection.type,
              confidence: formatDetection.confidence,
              indicators: formatDetection.indicators,
              endpointType: endpointType
            }
          }
        }
      }
    };

    // Debug: Record config creation completion
    if (SmartPipelineFactory.isDebugEnhanced) {
      const totalTime = Date.now() - startTime;
      (SmartPipelineFactory as any).recordPipelineMetric('config_creation_complete', {
        configId,
        success: true,
        totalTime,
        llmSwitchType,
        endpointType
      });
      (SmartPipelineFactory as any).addToConfigHistory({
        configId,
        baseConfigId: baseConfig.id,
        llmSwitchType,
        endpointType,
        formatDetection,
        startTime,
        endTime: Date.now(),
        totalTime,
        success: true
      });
      (SmartPipelineFactory as any).publishDebugEvent('config_creation_complete', {
        configId,
        pipelineConfig,
        totalTime,
        success: true
      });
    }

    return pipelineConfig;
  }
  
  /**
   * 从HTTP请求创建流水线配置
   */
  static createPipelineConfigFromHttpRequest(
    baseConfig: SmartPipelineConfig,
    httpRequest: any
  ): PipelineConfig {
    const requestData = httpRequest.body;
    
    // 从URL路径推断端点类型
    const url = httpRequest.url || httpRequest.path;
    let inferredEndpointType: 'anthropic' | 'openai' | 'auto' = 'auto';
    
    if (url.includes('/anthropic')) {
      inferredEndpointType = 'anthropic';
    } else if (url.includes('/openai')) {
      inferredEndpointType = 'openai';
    }
    
    // 使用推断的端点类型创建配置
    const configWithEndpoint = {
      ...baseConfig,
      endpointType: baseConfig.endpointType || inferredEndpointType
    };
    
    return this.createPipelineConfigForRequest(configWithEndpoint, requestData);
  }
  
  /**
   * 验证LLMSwitch配置
   */
  static validateLLMSwitchConfig(config: ModuleConfig): boolean {
    const validTypes = ['anthropic-openai-converter', 'openai-passthrough'];
    
    if (!validTypes.includes(config.type)) {
      console.warn(`Invalid LLMSwitch type: ${config.type}. Valid types are: ${validTypes.join(', ')}`);
      return false;
    }
    
    return true;
  }
  
  /**
   * 获取LLMSwitch选择日志
   */
  static getLLMSwitchSelectionLog(
    formatDetection: any,
    endpointType: string,
    selectedType: string
  ): any {
    return {
      timestamp: Date.now(),
      formatDetection,
      endpointType,
      selectedType,
      decision: selectedType === 'anthropic-openai-converter' ? 'CONVERT' : 'PASSTHROUGH'
    };
  }
}

/**
 * 动态流水线管理器
 */
export class DynamicPipelineManager {
  private pipelineConfigs: Map<string, SmartPipelineConfig> = new Map();

  // Debug enhancement properties - unified approach
  private debugEnhancementManager: DebugEnhancementManager | null = null;
  private debugEnhancement: any = null;

  // Legacy debug properties for backward compatibility
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private managerMetrics: Map<string, any> = new Map();
  private configAccessHistory: any[] = [];
  private maxHistorySize = 50;

  constructor() {
    // Initialize unified debug enhancements
    this.initializeUnifiedDebugEnhancements();

    // Initialize legacy debug enhancements for backward compatibility
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize unified debug enhancements
   */
  private initializeUnifiedDebugEnhancements(): void {
    try {
      const debugCenter = DebugCenter.getInstance();
      this.debugEnhancementManager = DebugEnhancementManager.getInstance(debugCenter);

      // Register enhancement for this manager
      this.debugEnhancement = this.debugEnhancementManager.registerEnhancement('dynamic-pipeline-manager', {
        enabled: true,
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        maxHistorySize: this.maxHistorySize
      });

      console.log('Dynamic Pipeline Manager unified debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Dynamic Pipeline Manager unified debug enhancements:', error);
      this.debugEnhancementManager = null;
    }
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      console.log('Dynamic Pipeline Manager debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Dynamic Pipeline Manager debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }
  
  /**
   * 注册流水线配置模板
   */
  registerPipelineConfig(config: SmartPipelineConfig): void {
    const startTime = Date.now();

    // Debug: Record config registration - unified approach
    if (this.debugEnhancement && this.debugEnhancement.recordMetric) {
      this.debugEnhancement.recordMetric('config_registration', Date.now() - startTime, {
        configId: config.id,
        endpointType: config.endpointType,
        action: 'register_pipeline_config'
      });
    }

    // Fallback to legacy implementation
    if (this.isDebugEnhanced) {
      this.recordManagerMetric('config_registration', {
        configId: config.id,
        endpointType: config.endpointType,
        timestamp: startTime
      });
      this.publishDebugEvent('config_registered', {
        configId: config.id,
        config,
        timestamp: startTime
      });
    }

    this.pipelineConfigs.set(config.id, config);

    // Debug: Record registration completion - unified approach
    if (this.debugEnhancement && this.debugEnhancement.recordMetric) {
      const totalTime = Date.now() - startTime;
      this.debugEnhancement.recordMetric('config_registration_complete', totalTime, {
        configId: config.id,
        success: true,
        action: 'register_pipeline_config_complete'
      });
    }

    // Fallback to legacy implementation
    if (this.isDebugEnhanced) {
      const totalTime = Date.now() - startTime;
      this.recordManagerMetric('config_registration_complete', {
        configId: config.id,
        success: true,
        totalTime
      });
    }
  }
  
  /**
   * 根据请求获取流水线配置
   */
  getPipelineConfigForRequest(pipelineId: string, request: any): PipelineConfig | null {
    const startTime = Date.now();
    const accessId = `access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record config access start
    if (this.isDebugEnhanced) {
      this.recordManagerMetric('config_access_start', {
        accessId,
        pipelineId,
        timestamp: startTime
      });
      this.publishDebugEvent('config_access_start', {
        accessId,
        pipelineId,
        requestType: typeof request,
        timestamp: startTime
      });
    }

    const baseConfig = this.pipelineConfigs.get(pipelineId);
    if (!baseConfig) {
      // Debug: Record config not found
      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordManagerMetric('config_not_found', {
          accessId,
          pipelineId,
          totalTime
        });
        this.addToConfigAccessHistory({
          accessId,
          pipelineId,
          success: false,
          error: 'Config not found',
          startTime,
          endTime: Date.now(),
          totalTime
        });
      }
      return null;
    }

    const result = SmartPipelineFactory.createPipelineConfigForRequest(baseConfig, request);

    // Debug: Record config access completion
    if (this.isDebugEnhanced) {
      const totalTime = Date.now() - startTime;
      this.recordManagerMetric('config_access_complete', {
        accessId,
        pipelineId,
        success: true,
        totalTime
      });
      this.addToConfigAccessHistory({
        accessId,
        pipelineId,
        success: true,
        result,
        startTime,
        endTime: Date.now(),
        totalTime
      });
      this.publishDebugEvent('config_access_complete', {
        accessId,
        pipelineId,
        result,
        totalTime,
        success: true
      });
    }

    return result;
  }
  
  /**
   * 根据HTTP请求获取流水线配置
   */
  getPipelineConfigFromHttpRequest(pipelineId: string, httpRequest: any): PipelineConfig | null {
    const baseConfig = this.pipelineConfigs.get(pipelineId);
    if (!baseConfig) {
      return null;
    }
    
    return SmartPipelineFactory.createPipelineConfigFromHttpRequest(baseConfig, httpRequest);
  }
  
  /**
   * 获取所有可用的流水线配置模板
   */
  getAvailablePipelineConfigs(): SmartPipelineConfig[] {
    return Array.from(this.pipelineConfigs.values());
  }

  /**
   * Record manager metric
   */
  private recordManagerMetric(operation: string, data: any): void {
    if (!this.managerMetrics.has(operation)) {
      this.managerMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.managerMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to config access history
   */
  private addToConfigAccessHistory(access: any): void {
    this.configAccessHistory.push(access);

    // Keep only recent history
    if (this.configAccessHistory.length > this.maxHistorySize) {
      this.configAccessHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'smart-pipeline-manager',
        operationId: type,
        timestamp: Date.now(),
        type: 'debug',
        position: 'middle',
        data: {
          ...data,
          managerId: 'smart-pipeline-manager',
          source: 'smart-pipeline-manager'
        }
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      registeredConfigs: this.pipelineConfigs.size,
      isEnhanced: this.isDebugEnhanced
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      managerMetrics: this.getManagerMetrics(),
      factoryMetrics: (SmartPipelineFactory as any).getPipelineMetrics(),
      formatDetectionStats: (SmartPipelineFactory as any).getFormatDetectionStats(),
      configAccessHistory: [...this.configAccessHistory.slice(-10)], // Last 10 accesses
      configHistory: (SmartPipelineFactory as any).getConfigHistory().slice(-10) // Last 10 configs
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): any {
    return {
      managerId: 'smart-pipeline-manager',
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      registeredConfigsCount: this.pipelineConfigs.size,
      configAccessHistorySize: this.configAccessHistory.length,
      factoryEnhanced: (SmartPipelineFactory as any).isDebugEnhanced
    };
  }

  /**
   * Get manager metrics
   */
  private getManagerMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.managerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }
}

/**
 * Static debug helper methods for SmartPipelineFactory
 */
(SmartPipelineFactory as any).recordPipelineMetric = function(operation: string, data: any): void {
  if (!SmartPipelineFactory.pipelineMetrics.has(operation)) {
    SmartPipelineFactory.pipelineMetrics.set(operation, {
      values: [],
      lastUpdated: Date.now()
    });
  }

  const metric = SmartPipelineFactory.pipelineMetrics.get(operation)!;
  metric.values.push(data);
  metric.lastUpdated = Date.now();

  // Keep only last 50 measurements
  if (metric.values.length > 50) {
    metric.values.shift();
  }
};

(SmartPipelineFactory as any).recordFormatDetectionMetric = function(formatType: string, data: any): void {
  if (!SmartPipelineFactory.formatDetectionStats.has(formatType)) {
    SmartPipelineFactory.formatDetectionStats.set(formatType, {
      count: 0,
      totalConfidence: 0,
      detections: []
    });
  }

  const stats = SmartPipelineFactory.formatDetectionStats.get(formatType)!;
  stats.count++;
  stats.totalConfidence += data.confidence;
  stats.detections.push(data);

  // Keep only last 100 detections
  if (stats.detections.length > 100) {
    stats.detections.shift();
  }
};

(SmartPipelineFactory as any).addToConfigHistory = function(config: any): void {
  SmartPipelineFactory.configHistory.push(config);

  // Keep only recent history
  if (SmartPipelineFactory.configHistory.length > SmartPipelineFactory.maxHistorySize) {
    SmartPipelineFactory.configHistory.shift();
  }
};

(SmartPipelineFactory as any).publishDebugEvent = function(type: string, data: any): void {
  if (!SmartPipelineFactory.isDebugEnhanced || !SmartPipelineFactory.debugEventBus) {return;}

  try {
    SmartPipelineFactory.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'smart-pipeline-factory',
      operationId: type,
      timestamp: Date.now(),
      type: 'debug',
      position: 'middle',
      data: {
        ...data,
        factoryId: 'smart-pipeline-factory',
        source: 'smart-pipeline-factory'
      }
    });
  } catch (error) {
    // Silent fail if debug event bus is not available
  }
};

(SmartPipelineFactory as any).getPipelineMetrics = function(): any {
  const metrics: any = {};

  for (const [operation, metric] of SmartPipelineFactory.pipelineMetrics.entries()) {
    metrics[operation] = {
      count: metric.values.length,
      lastUpdated: metric.lastUpdated,
      recentValues: metric.values.slice(-5) // Last 5 values
    };
  }

  return metrics;
};

(SmartPipelineFactory as any).getFormatDetectionStats = function(): any {
  const stats: any = {};

  for (const [formatType, data] of SmartPipelineFactory.formatDetectionStats.entries()) {
    stats[formatType] = {
      count: data.count,
      avgConfidence: Math.round(data.totalConfidence / data.count),
      recentDetections: data.detections.slice(-5) // Last 5 detections
    };
  }

  return stats;
};

(SmartPipelineFactory as any).getConfigHistory = function(): any[] {
  return [...SmartPipelineFactory.configHistory];
};
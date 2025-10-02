/**
 * Config Manager Module
 * 配置管理模块 - 管理配置文件和重载
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { BaseModule } from '../../core/base-module.js';
import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
import { DebugEventBus } from 'rcc-debugcenter';
import type {
  ModulesConfig,
  UserConfig,
  MergedConfig
} from '../../config/merged-config-types.js';

export class ConfigManagerModule extends BaseModule {
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;
  private configParser: ConfigParser;
  private compatibilityEngine: CompatibilityEngine;
  private authFileResolver: AuthFileResolver;
  private configWatcher: any;

  // Debug enhancement properties - now inherited from BaseModule
  private configMetrics: Map<string, any> = new Map();
  private loadingHistory: any[] = [];
  private mergeHistory: any[] = [];
  private validationHistory: any[] = [];
  // maxHistorySize is now inherited from BaseModule

  constructor(configPath?: string) {
    super({
      id: 'config-manager',
      name: 'Configuration Manager',
      version: '1.0.0',
      description: 'Manages configuration files and reloading'
    });

    // Default to user home directory config
    this.configPath = configPath || path.join(homedir(), '.routecodex', 'config.json');
    this.systemConfigPath = './config/modules.json';
    this.mergedConfigPath = './config/merged-config.json';

    this.configParser = new ConfigParser();
    this.compatibilityEngine = new CompatibilityEngine();
    this.authFileResolver = new AuthFileResolver();

    // Initialize debug enhancements
    // Debug enhancements are now initialized in BaseModule constructor
  }

  /**
   * Record config metric
   */
  public recordConfigMetric(operation: string, data: any): void {
    if (!this.configMetrics.has(operation)) {
      this.configMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.configMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to loading history
   */
  public addToLoadingHistory(operation: any): void {
    this.loadingHistory.push(operation);

    // Keep only recent history
    if (this.loadingHistory.length > this.maxHistorySize) {
      this.loadingHistory.shift();
    }
  }

  /**
   * Add to merge history
   */
  public addToMergeHistory(operation: any): void {
    this.mergeHistory.push(operation);

    // Keep only recent history
    if (this.mergeHistory.length > this.maxHistorySize) {
      this.mergeHistory.shift();
    }
  }

  /**
   * Add to validation history
   */
  public addToValidationHistory(operation: any): void {
    this.validationHistory.push(operation);

    // Keep only recent history
    if (this.validationHistory.length > this.maxHistorySize) {
      this.validationHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  public publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'config-manager',
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          managerId: 'config-manager',
          source: 'config-manager'
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
      id: this.info.id,
      name: this.info.name,
      isRunning: this.isRunning,
      configPath: this.configPath,
      systemConfigPath: this.systemConfigPath,
      mergedConfigPath: this.mergedConfigPath,
      isEnhanced: this.isDebugEnhanced
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      configMetrics: this.getConfigMetrics(),
      loadingHistory: [...this.loadingHistory.slice(-10)], // Last 10 operations
      mergeHistory: [...this.mergeHistory.slice(-10)], // Last 10 operations
      validationHistory: [...this.validationHistory.slice(-5)] // Last 5 validations
    };
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): any {
    return {
      managerId: 'config-manager',
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      loadingHistorySize: this.loadingHistory.length,
      mergeHistorySize: this.mergeHistory.length,
      validationHistorySize: this.validationHistory.length,
      configMetricsSize: this.configMetrics.size,
      maxHistorySize: this.maxHistorySize
    };
  }

  /**
   * Get config metrics
   */
  public getConfigMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.configMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * 初始化模块
   */
  async initialize(config?: any): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record initialization start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('initialization_start', {
        initId,
        config,
        timestamp: startTime
      });
      this.publishDebugEvent('initialization_start', {
        initId,
        config,
        timestamp: startTime
      });
    }

    console.log('🔄 Initializing Config Manager Module...');

    try {
      this.configPath = config?.configPath || this.configPath;
      this.mergedConfigPath = config?.mergedConfigPath || this.mergedConfigPath;
      // Allow passing the same modules config path used by HttpServer to avoid fallback warnings
      if (config?.systemModulesPath) {
        this.systemConfigPath = config.systemModulesPath;
      }

      // Debug: Record configuration setup
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('config_setup', {
          initId,
          configPath: this.configPath,
          systemConfigPath: this.systemConfigPath,
          mergedConfigPath: this.mergedConfigPath
        });
      }

      // 若用户配置不存在，生成默认GLM单供应商配置
      await this.ensureDefaultUserConfig();

      // 确保Auth目录存在
      await this.authFileResolver.ensureAuthDir();

      // 生成初始合并配置
      await this.generateMergedConfig();

      // 启动配置监听
      if (config.autoReload) {
        await this.startConfigWatcher();
      }

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          autoReload: config?.autoReload || false
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          autoReload: config?.autoReload || false
        });
      }

      console.log('✅ Config Manager Module initialized successfully');
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record initialization failure
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.publishDebugEvent('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      console.error('❌ Failed to initialize Config Manager Module:', error);
      throw error;
    }
  }

  /**
   * 若用户配置文件不存在，生成默认GLM配置（单一供应商、glm-4.6、thinking开启、内联API Key）
   */
  private async ensureDefaultUserConfig(): Promise<void> {
    try {
      const expandHome = (p: string) => (p.startsWith('~') ? p.replace('~', homedir()) : p);
      const filePath = expandHome(this.configPath);
      try {
        const s = await fs.stat(filePath);
        if (s.isFile()) { return; }
        // If path exists but not a file, fall through to write file
      } catch {
        // not exists -> create
      }

      const dir = filePath.split('/').slice(0, -1).join('/');
      await fs.mkdir(dir, { recursive: true });

      const glmApiKey = (process.env.GLM_API_KEY && String(process.env.GLM_API_KEY).trim()) || 'REPLACE_WITH_YOUR_GLM_API_KEY';
      const defaultConfig = {
        version: '1.0.0',
        description: 'Auto-generated default config (GLM single provider)',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            glm: {
              type: 'glm',
              baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
              apiKey: [glmApiKey],
              // Provider-level compatibility is optional; model-level override below is applied
              models: {
                'glm-4.6': {
                  maxContext: 200000,
                  maxTokens: 8192,
                  // 开启思考（thinking）
                  compatibility: {
                    type: 'glm-compatibility',
                    config: {
                      thinking: { enabled: true, payload: { type: 'enabled' } }
                    }
                  }
                }
              }
            }
          },
          routing: {
            default: ['glm.glm-4.6']
          }
        },
        httpserver: {
          port: 5513
        }
      } as any;

      const content = JSON.stringify(defaultConfig, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`🆕 Created default user config at ${filePath}`);
    } catch (error) {
      // Do not block initialization if default generation fails
      console.warn('Failed to create default user config:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 生成合并配置
   */
  async generateMergedConfig(): Promise<void> {
    const startTime = Date.now();
    const mergeId = `merge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record merge start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('merge_start', {
        mergeId,
        timestamp: startTime
      });
      this.publishDebugEvent('merge_start', {
        mergeId,
        timestamp: startTime
      });
    }

    try {
      console.log('🔄 Generating merged configuration with new configuration engine...');

      // 加载系统配置
      const systemConfig = await this.loadSystemConfig();

      // 加载用户配置
      const userConfig = await this.loadUserConfig();

      // 使用新配置引擎解析用户配置
      let parsedUserConfig;
      let compatibilityConfig = null;

      try {
        // 1. 先使用CompatibilityEngine处理兼容性（包含预处理）
        const compatResult = await this.compatibilityEngine.processCompatibility(
          JSON.stringify(userConfig)
        );

        if (!compatResult.isValid) {
          throw new Error(`Compatibility processing failed: ${compatResult.errors?.map(e => e.message).join(', ')}`);
        }

        // 2. 对兼容性引擎输出做一次轻量归一化，确保 provider 家族类型符合解析器枚举
        const normalizedInput: any = JSON.parse(
          JSON.stringify(compatResult.compatibilityConfig?.normalizedConfig || userConfig)
        );

        // 归一化 providers.*.type: 将模块实现名映射为提供商家族名
        // glm-http-provider -> glm, openai-provider -> openai, lmstudio-http -> lmstudio, qwen-provider -> qwen, iflow-provider -> iflow, generic-http -> custom
        const familyTypeMap: Record<string, string> = {
          'glm-http-provider': 'glm',
          'openai-provider': 'openai',
          'lmstudio-http': 'lmstudio',
          'qwen-provider': 'qwen',
          'iflow-provider': 'iflow',
          'generic-http': 'custom',
        };
        try {
          const provs = normalizedInput?.virtualrouter?.providers || {};
          Object.keys(provs).forEach((pid) => {
            const t = String(provs[pid]?.type || '').toLowerCase();
            if (familyTypeMap[t]) {
              provs[pid].type = familyTypeMap[t];
            }
          });
        } catch { /* noop */ }

        // 3. 使用ConfigParser解析处理后的配置
        const parseResult = await this.configParser.parseFromString(
          JSON.stringify(normalizedInput)
        );

        if (!parseResult.isValid) {
          throw new Error(`Configuration validation failed: ${parseResult.errors?.map(e => e.message).join(', ')}`);
        }

        // 4. 提取解析后的配置和兼容性配置
        parsedUserConfig = parseResult.normalized || normalizedInput;
        compatibilityConfig = compatResult.compatibilityConfig;

        console.log('✅ Configuration processed successfully with new engine');
        console.log('🔍 Debug: Processed config structure:');
        console.log('- parsedUserConfig keys:', Object.keys(parsedUserConfig));
        console.log('- virtualrouter providers:', Object.keys(parsedUserConfig.virtualrouter?.providers || {}));
        console.log('- routing default:', parsedUserConfig.virtualrouter?.routing?.default);

      } catch (error) {
        console.error('❌ New configuration engine failed:', error instanceof Error ? error.message : String(error));

        // 如果新引擎失败，检查是否允许回退到legacy模式
        if (String(process.env.ALLOW_LEGACY_FALLBACK || '').toLowerCase() === 'true') {
          console.log('⚠️  Falling back to legacy configuration engine...');
          // 这里可以保留原有的legacy逻辑作为回退方案
          // 但为了鼓励迁移，默认不启用回退
          throw new Error('Configuration processing failed and legacy fallback is disabled');
        } else {
          throw error;
        }
      }

      // Debug: Record config loading completion
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('configs_loaded', {
          mergeId,
          systemConfigSize: Object.keys(systemConfig).length,
          userConfigSize: Object.keys(userConfig).length,
          parsedConfigSize: Object.keys(parsedUserConfig).length,
          compatibilityConfigSize: compatibilityConfig ? Object.keys(compatibilityConfig).length : 0
        });
      }

      // 创建新的合并配置 - 使用处理后的配置作为基础
      const mergedConfig = {
        ...systemConfig,
        ...parsedUserConfig,  // 使用解析后的配置（已经过compatibility处理）
        compatibilityConfig,
        _metadata: {
          version: '2.0.0',
          engine: 'routecodex-config-engine',
          timestamp: Date.now(),
          configPath: this.configPath
        }
      };

      // 附加版本元信息（便于宿主断言契约）
      (mergedConfig as any).schemaVersion = '1.0.0';
      (mergedConfig as any).engineVersion = String(process.env.USE_NEW_CONFIG_ENGINE ? 'sharedmodule' : 'legacy');

      // 验证合并配置 - 使用新引擎验证
      const finalValidation = await this.configParser.parseFromString(JSON.stringify(mergedConfig));
      if (!finalValidation.isValid) {
        // Debug: Record validation failure
        if (this.isDebugEnhanced) {
          this.addToValidationHistory({
            mergeId,
            success: false,
            errors: finalValidation.errors,
            timestamp: Date.now()
          });
          this.recordConfigMetric('validation_failed', {
            mergeId,
            errors: finalValidation.errors
          });
        }
        throw new Error(`Configuration validation failed: ${finalValidation.errors.map(e => e.message).join(', ')}`);
      }

      // Debug: Record validation success
      if (this.isDebugEnhanced) {
        this.addToValidationHistory({
          mergeId,
          success: true,
          mergedConfigSize: Object.keys(mergedConfig).length,
          timestamp: Date.now()
        });
        this.recordConfigMetric('validation_success', {
          mergeId,
          mergedConfigSize: Object.keys(mergedConfig).length
        });
      }

      // 保存合并配置
      await this.saveMergedConfig(mergedConfig);

      const totalTime = Date.now() - startTime;

      // Debug: Record merge completion
      if (this.isDebugEnhanced) {
        this.addToMergeHistory({
          mergeId,
          success: true,
          totalTime,
          mergedConfigSize: Object.keys(mergedConfig).length,
          timestamp: Date.now()
        });
        this.recordConfigMetric('merge_complete', {
          mergeId,
          success: true,
          totalTime,
          mergedConfigSize: Object.keys(mergedConfig).length
        });
        this.publishDebugEvent('merge_complete', {
          mergeId,
          success: true,
          totalTime,
          mergedConfigSize: Object.keys(mergedConfig).length
        });
      }

      console.log('✅ Merged configuration generated successfully');
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record merge failure
      if (this.isDebugEnhanced) {
        this.addToMergeHistory({
          mergeId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          totalTime,
          timestamp: Date.now()
        });
        this.recordConfigMetric('merge_failed', {
          mergeId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.publishDebugEvent('merge_failed', {
          mergeId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      console.error('❌ Failed to generate merged configuration:', error);
      throw error;
    }
  }

  
  /**
   * 重新加载配置
   */
  async reloadConfig(): Promise<void> {
    console.log('🔄 Reloading configuration...');
    await this.generateMergedConfig();
    console.log('✅ Configuration reloaded successfully');
  }

  /**
   * 加载系统配置
   */
  private async loadSystemConfig(): Promise<any> {
    const startTime = Date.now();
    const loadId = `load_system_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record system config load start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('system_config_load_start', {
        loadId,
        configPath: this.systemConfigPath,
        timestamp: startTime
      });
    }

    try {
      const systemStats = await fs.stat(this.systemConfigPath);
      if (!systemStats.isFile()) {
        throw new Error(`System configuration path must be a file: ${this.systemConfigPath}`);
      }

      const configContent = await fs.readFile(this.systemConfigPath, 'utf-8');
      const config = JSON.parse(configContent);
      const totalTime = Date.now() - startTime;

      // Debug: Record system config load success
      if (this.isDebugEnhanced) {
        this.addToLoadingHistory({
          loadId,
          type: 'system',
          configPath: this.systemConfigPath,
          success: true,
          configSize: Object.keys(config).length,
          totalTime,
          timestamp: Date.now()
        });
        this.recordConfigMetric('system_config_load_success', {
          loadId,
          configSize: Object.keys(config).length,
          totalTime
        });
      }

      return config;
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record system config load failure
      if (this.isDebugEnhanced) {
        this.addToLoadingHistory({
          loadId,
          type: 'system',
          configPath: this.systemConfigPath,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          totalTime,
          timestamp: Date.now()
        });
        this.recordConfigMetric('system_config_load_failed', {
          loadId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      console.error(`Failed to load system config from ${this.systemConfigPath}:`, error);
      throw error;
    }
  }

  /**
   * 加载用户配置
   */
  private async loadUserConfig(): Promise<any> {
    const startTime = Date.now();
    const loadId = `load_user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record user config load start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('user_config_load_start', {
        loadId,
        configPath: this.configPath,
        timestamp: startTime
      });
    }

    try {
      const expandHome = (p: string) => (p.startsWith('~') ? p.replace('~', homedir()) : p);
      const configPath = expandHome(this.configPath);

      // Ensure file exists and is a regular file
      let stats;
      try {
        stats = await fs.stat(configPath);
      } catch {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      if (!stats.isFile()) {
        throw new Error(`Configuration path must be a file: ${configPath}`);
      }

      // 读取配置文件
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);

      const totalTime = Date.now() - startTime;

      // Debug: Record user config load success
      if (this.isDebugEnhanced) {
        this.addToLoadingHistory({
          loadId,
          type: 'user',
          configPath: this.configPath,
          success: true,
          configSize: Object.keys(config).length,
          totalTime,
          timestamp: Date.now()
        });
        this.recordConfigMetric('user_config_load_success', {
          loadId,
          configSize: Object.keys(config).length,
          totalTime
        });
      }

      return config;
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record user config load failure
      if (this.isDebugEnhanced) {
        this.addToLoadingHistory({
          loadId,
          type: 'user',
          configPath: this.configPath,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          totalTime,
          timestamp: Date.now()
        });
        this.recordConfigMetric('user_config_load_failed', {
          loadId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      throw error;
    }
  }

  /**
   * 保存合并配置
   */
  private async saveMergedConfig(mergedConfig: any): Promise<void> {
    const startTime = Date.now();
    const saveId = `save_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record save start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('save_start', {
        saveId,
        configPath: this.mergedConfigPath,
        configSize: Object.keys(mergedConfig).length,
        timestamp: startTime
      });
    }

    try {
      // 保持与 modules.json 同目录（允许相对路径）
      const expandedPath = this.mergedConfigPath.startsWith('~')
        ? this.mergedConfigPath.replace('~', homedir())
        : this.mergedConfigPath;

      const configDir = expandedPath.split('/').slice(0, -1).join('/');
      await fs.mkdir(configDir, { recursive: true });

      const configContent = JSON.stringify(mergedConfig, null, 2);
      await fs.writeFile(expandedPath, configContent, 'utf-8');

      const totalTime = Date.now() - startTime;

      // Debug: Record save success
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('save_success', {
          saveId,
          configSize: Object.keys(mergedConfig).length,
          contentLength: configContent.length,
          totalTime
        });
        this.publishDebugEvent('save_complete', {
          saveId,
          success: true,
          configPath: this.mergedConfigPath,
          configSize: Object.keys(mergedConfig).length,
          totalTime
        });
      }

      console.log(`💾 Merged configuration saved to ${this.mergedConfigPath}`);
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record save failure
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('save_failed', {
          saveId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.publishDebugEvent('save_failed', {
          saveId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      console.error(`Failed to save merged config to ${this.mergedConfigPath}:`, error);
      throw error;
    }
  }

  /**
   * 启动配置监听
   */
  private async startConfigWatcher(): Promise<void> {
    // TODO: 实现配置文件监听
    console.log('👀 Starting configuration watcher...');
  }

  /**
   * 获取状态
   */
  getStatus(): any {
    const baseStatus = {
      id: this.info.id,
      name: this.info.name,
      status: this.isRunning ? 'running' : 'stopped',
      configPath: this.configPath,
      systemConfigPath: this.systemConfigPath,
      mergedConfigPath: this.mergedConfigPath,
      lastUpdated: new Date().toISOString(),
      isEnhanced: this.isDebugEnhanced
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      configMetrics: this.getConfigMetrics(),
      loadingHistory: [...this.loadingHistory.slice(-5)], // Last 5 loading operations
      mergeHistory: [...this.mergeHistory.slice(-3)], // Last 3 merge operations
      validationHistory: [...this.validationHistory.slice(-3)] // Last 3 validations
    };
  }
}

/**
 * Config Manager Module
 * 配置管理模块 - 管理配置文件和重载
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { BaseModule } from 'rcc-basemodule';
import type { UnknownObject } from '../../types/common-types.js';
import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
// import { DebugEventBus } from 'rcc-debugcenter';
import type {
  // ModulesConfig,
  // UserConfig,
  // MergedConfig
} from '../../config/merged-config-types.js';

export class ConfigManagerModule extends BaseModule {
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;
  private configParser: ConfigParser;
  private compatibilityEngine: CompatibilityEngine;
  private authFileResolver: AuthFileResolver;
  private configWatcher: unknown;

  // Debug enhancement properties - now inherited from BaseModule
  private configMetrics: Map<string, { values: unknown[]; lastUpdated: number }> = new Map();
  private loadingHistory: unknown[] = [];
  private mergeHistory: unknown[] = [];
  private validationHistory: unknown[] = [];
  // maxHistorySize is now inherited from BaseModule
  // Provide minimal local debug props to satisfy usage after core merge
  private isDebugEnhanced: boolean = false;
  private debugEventBus: unknown = null;
  private maxHistorySize: number = 100;

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
    // Use non-sanitizing output for runtime so that key mappings retain real values
    this.compatibilityEngine = new CompatibilityEngine({ sanitizeOutput: false });
    this.authFileResolver = new AuthFileResolver();

    // Initialize debug enhancements
    // Debug enhancements are now initialized in BaseModule constructor
  }

  /**
   * Record config metric
   */
  public recordConfigMetric(operation: string, data: unknown): void {
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
  public addToLoadingHistory(operation: unknown): void {
    this.loadingHistory.push(operation);

    // Keep only recent history
    if (this.loadingHistory.length > this.maxHistorySize) {
      this.loadingHistory.shift();
    }
  }

  /**
   * Add to merge history
   */
  public addToMergeHistory(operation: unknown): void {
    this.mergeHistory.push(operation);

    // Keep only recent history
    if (this.mergeHistory.length > this.maxHistorySize) {
      this.mergeHistory.shift();
    }
  }

  /**
   * Add to validation history
   */
  public addToValidationHistory(operation: unknown): void {
    this.validationHistory.push(operation);

    // Keep only recent history
    if (this.validationHistory.length > this.maxHistorySize) {
      this.validationHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  public publishDebugEvent(type: string, data: Record<string, unknown>): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      (this.debugEventBus as any).publish({
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
      } as unknown);
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): UnknownObject {
    const info = this.getInfo();
    const baseStatus = {
      id: info.id,
      name: info.name,
      isRunning: this.isRunning(),
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
  public getDebugInfo(): UnknownObject {
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
  public getConfigMetrics(): Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> {
    const metrics: Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> = {};

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
  async initialize(config?: unknown): Promise<void> {
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
      const cfg = config as Record<string, unknown> | undefined;
      this.configPath = (cfg?.['configPath'] as string) || this.configPath;
      this.mergedConfigPath = (cfg?.['mergedConfigPath'] as string) || this.mergedConfigPath;
      // Allow passing the same modules config path used by HttpServer to avoid fallback warnings
      if (cfg?.['systemModulesPath']) {
        this.systemConfigPath = cfg['systemModulesPath'] as string;
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

      // 不再自动生成默认用户配置；缺失用户配置应视为错误并由上层处理

      // 确保Auth目录存在
      await this.authFileResolver.ensureAuthDir();

      // 生成初始合并配置（本地最小构造器，V1/V2 双栈一致，后续再迁移到 config-core）
      await this.generateMergedConfigCanonicalMinimal();

      // 启动配置监听
      if ((cfg?.['autoReload'] as boolean) === true) {
        await this.startConfigWatcher();
      }

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          autoReload: Boolean(cfg?.['autoReload'])
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          autoReload: Boolean(cfg?.['autoReload'])
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
   * 新构建器：完全去除 legacy 路径，只依据用户配置生成 merged-config 与 pac
   */
  private async generateMergedConfigCanonicalMinimal(): Promise<void> {
    const startTime = Date.now();
    const mergeId = `merge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {
      console.log('🔄 Generating merged configuration (canonical minimal, legacy removed)...');
      const { writeConfigSnapshot } = await import('./utils/config-snapshot-writer.js');
      const userConfig = await this.loadUserConfig();
      await writeConfigSnapshot({ phase: 'user-parsed', data: userConfig, metadata: { mergeId } });
      const u: any = JSON.parse(JSON.stringify(userConfig || {}));
      const vr: any = (u && u.virtualrouter) ? u.virtualrouter : {};
      const providersIn: Record<string, any> = (vr.providers && typeof vr.providers === 'object') ? vr.providers : {};

      const providers: Record<string, any> = {};
      const keyVault: Record<string, Record<string, any>> = {};
      for (const [pid, raw] of Object.entries(providersIn)) {
        const p: any = JSON.parse(JSON.stringify(raw || {}));
        if (!p.id) p.id = pid;
        if (p.baseURL && !p.baseUrl) p.baseUrl = p.baseURL;
        providers[pid] = p;
        let apiKey = (p.auth && typeof p.auth.apiKey === 'string') ? p.auth.apiKey : '';
        if (!apiKey) {
          const arr = Array.isArray(p.apiKey) ? p.apiKey : (typeof p.apiKey === 'string' ? [p.apiKey] : []);
          apiKey = arr[0] || '';
        }
        if (apiKey) {
          keyVault[pid] = keyVault[pid] || {};
          keyVault[pid]['key1'] = { type: 'apikey', value: apiKey, enabled: true };
        }
      }

      const cats = ['default','coding','longcontext','tools','thinking','vision','websearch','background'];
      const routingIn: Record<string, string[]> = (vr.routing && typeof vr.routing === 'object') ? vr.routing : {} as any;
      const routePools: Record<string, string[]> = {};
      for (const c of cats) {
        const arr = Array.isArray(routingIn[c]) ? routingIn[c] : [];
        const out: string[] = [];
        for (const rid of arr) {
          const s = String(rid || '').trim();
          if (!s) continue;
          const dot = s.indexOf('.');
          if (dot <= 0 || dot >= s.length - 1) { out.push(s); continue; }
          const providerId = s.slice(0, dot);
          const modelId = s.slice(dot + 1);
          const vault = keyVault[providerId] || {};
          const keyIds = Object.keys(vault).filter(k => vault[k]?.enabled !== false);
          if (keyIds.length === 0) { out.push(s); continue; }
          for (const kid of keyIds) out.push(`${providerId}.${modelId}__${kid}`);
        }
        routePools[c] = Array.from(new Set(out));
      }

      const routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string | null }> = {};
      for (const arr of Object.values(routePools)) {
        for (const id of arr) {
          const base = String(id);
          const parts = base.split('__');
          const pv = parts[0];
          const keyId = parts.length > 1 ? parts.slice(1).join('__') : null;
          const dot = pv.indexOf('.');
          if (dot > 0) {
            const providerId = pv.slice(0, dot);
            const modelId = pv.slice(dot + 1);
            routeMeta[base] = { providerId, modelId, keyId };
          }
        }
      }

      const httpserver = (u && u.httpserver && typeof u.httpserver === 'object') ? u.httpserver : {};
      const modules: any = {};
      if (httpserver && (typeof httpserver.port === 'number' || typeof httpserver.host === 'string')) {
        modules.httpserver = { enabled: true, config: { ...httpserver } };
      }

      // Build pipelines explicitly to avoid relying on any legacy synthesis
      const pipelinesArr: any[] = [];
      const added = new Set<string>();
      const baseUrlOf = (provId: string) => {
        try { return String(providers[provId]?.baseUrl || providers[provId]?.baseURL || ''); } catch { return ''; }
      };
      const apiKeyOf = (provId: string) => {
        try { return String(keyVault[provId]?.key1?.value || ''); } catch { return ''; }
      };
      for (const ids of Object.values(routePools)) {
        for (const id of ids) {
          if (added.has(id)) continue;
          added.add(id);
          const dot = String(id).indexOf('.');
          const provId = String(id).slice(0, dot);
          const rest = String(id).slice(dot + 1);
          const keyParts = rest.split('__');
          const modelId = keyParts[0];
          const keyId = keyParts[1] || 'key1';
          const baseUrl = baseUrlOf(provId);
          const apiKey = apiKeyOf(provId);
          // Derive auth from provider config: prefer explicit OAuth; else use apikey if present
          const providerAuth = (() => {
            try {
              const a = (providers[provId] && (providers[provId] as any).auth) ? (providers[provId] as any).auth : undefined;
              if (a && typeof a === 'object' && typeof a.type === 'string') {
                const t = String(a.type).toLowerCase();
                if (t === 'oauth') {
                  return {
                    type: 'oauth',
                    clientId: a.clientId || 'iflow-desktop-client',
                    tokenUrl: a.tokenUrl || 'https://iflow.cn/oauth/token',
                    deviceCodeUrl: a.deviceCodeUrl || 'https://iflow.cn/oauth/device/code',
                    scopes: Array.isArray(a.scopes) ? a.scopes : ['openid','profile','email','api'],
                    tokenFile: a.tokenFile || `${homedir()}/.routecodex/tokens/iflow-default.json`
                  } as any;
                }
                if (t === 'apikey' && typeof a.apiKey === 'string' && a.apiKey) {
                  return { type: 'apikey', apiKey: a.apiKey } as any;
                }
              }
            } catch { /* ignore */ }
            if (apiKey) { return { type: 'apikey', apiKey } as any; }
            return undefined;
          })();
          // 读取用户配置中的超时（优先级：模型级 > Provider级），否则不设置，让下游使用全局/默认
          let userTimeout: number | undefined = undefined;
          try {
            const pCfg = providers[provId] || {};
            const mdlCfg = (pCfg.models && typeof pCfg.models === 'object') ? (pCfg.models as any)[modelId] : undefined;
            if (mdlCfg && typeof mdlCfg.timeout === 'number') {
              userTimeout = Number(mdlCfg.timeout);
            } else if (typeof pCfg.timeout === 'number') {
              userTimeout = Number(pCfg.timeout);
            }
          } catch { /* ignore */ }

          const providerModuleConfig: any = { baseUrl, ...(providerAuth ? { auth: providerAuth } : {}) };
          if (typeof userTimeout === 'number') {
            providerModuleConfig.timeout = userTimeout;
          }

          // Decide compatibility module by provider id
          const compatType = (() => {
            const idLower = String(provId || '').toLowerCase();
            if (idLower.includes('lmstudio')) return 'lmstudio-compatibility';
            if (idLower.includes('glm')) return 'glm';
            return 'passthrough-compatibility';
          })();

          const pipeline = {
            id,
            provider: { type: 'openai' },
            modules: {
              provider: { type: 'openai', config: providerModuleConfig },
              compatibility: { type: compatType, config: {} },
              llmSwitch: { type: 'llmswitch-conversion-router', config: {} },
              workflow: { type: 'streaming-control', config: {} }
            },
            settings: { debugEnabled: true },
            authRef: { mode: 'perKey', providerId: provId, keyId }
          };
          pipelinesArr.push(pipeline);
        }
      }

      // 使用 config-core 生成 V2 装配输入（pac）；严格禁止回退
      const core = await import('llmswitch-config-core');
      const canonicalLike: any = {
        providers,
        keyVault,
        pipelines: pipelinesArr,
        routing: routePools,
        routeMeta,
        _metadata: { version: '0.1.0', builtAt: Date.now(), keyDimension: 'perKey' }
      };
      await writeConfigSnapshot({ phase: 'canonical', data: canonicalLike, metadata: { mergeId } });
      const assemblerConfig = core.exportAssemblerConfigV2(canonicalLike);
      await writeConfigSnapshot({ phase: 'assembler', data: assemblerConfig, metadata: { mergeId } });

      const mergedConfig: any = {
        providers,
        keyVault,
        pipelines: pipelinesArr,
        routing: routePools,
        routeMeta,
        ...(httpserver ? { httpserver } : {}),
        ...(modules.httpserver ? { modules } : {}),
        _metadata: { version: '0.1.0', builtAt: Date.now(), keyDimension: 'perKey' },
        pipeline_assembler: assemblerConfig
      };

      await this.saveMergedConfig(mergedConfig);
      try { await writeConfigSnapshot({ phase: 'merged', data: mergedConfig, metadata: { mergeId, path: this.mergedConfigPath } }); } catch {}

      if (this.isDebugEnhanced) {
        this.addToMergeHistory({ mergeId, success: true, totalTime: Date.now()-startTime, mergedConfigSize: Object.keys(mergedConfig).length, timestamp: Date.now() });
        this.recordConfigMetric('merge_complete', { mergeId, success: true });
      }
      console.log('✅ Merged configuration generated successfully (canonical minimal)');
    } catch (error) {
      if (this.isDebugEnhanced) {
        this.recordConfigMetric('merge_failed', { error: error instanceof Error ? error.message : String(error) });
      }
      console.error('❌ Failed to generate merged configuration (canonical minimal):', error);
      throw error;
    }
  }

  /**
   * 使用 sharedmodule/config-core 统一生成 merged-config 与 V2 装配输入
   * - 顶层 pipelines: 供 V1 静态流水线使用
   * - pipeline_assembler.config: 供 V2 动态流水线使用
   */
  // 预留：后续切换到 config-core 生成 merged-config
  // private async generateMergedConfigViaCore(): Promise<void> { /* not used in Option B */ }

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

      const defaultConfig = {
        version: '1.0.0',
        description: 'Auto-generated default config (GLM single provider)',
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            glm: {
              type: 'openai',
              // Do not hardcode upstream endpoint or credentials in default config
              // Require explicit configuration or environment variables
              apiKey: [],
              // Provider-level compatibility is optional; model-level override below is applied
              models: {
                'glm-4.6': {
                  maxContext: 200000,
                  maxTokens: 8192,
                  // 显式使用标准 V2 兼容包装器
                  compatibility: {
                    type: 'compatibility',
                    config: {
                      moduleType: 'glm',
                      moduleConfig: {
                        thinking: { enabled: true, payload: { type: 'enabled' } }
                      }
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
          // Align default port with system defaults
          port: 5506
        }
      } as Record<string, unknown>;

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
        // 1. 先做一次轻量预归一化，避免兼容性引擎因类型枚举/必填字段缺失而拒绝
        const preNormalized = JSON.parse(JSON.stringify(userConfig)) as Record<string, any>;
        // 顶层必填：version
        if (typeof preNormalized.version !== 'string' || !preNormalized.version.trim()) {
          preNormalized.version = '1.0.0';
        }
        // virtualrouter 节点与必需字段
        preNormalized.virtualrouter = preNormalized.virtualrouter && typeof preNormalized.virtualrouter === 'object'
          ? preNormalized.virtualrouter
          : {};
        const vrPrim = preNormalized.virtualrouter as Record<string, any>;
        if (!vrPrim.inputProtocol) { vrPrim.inputProtocol = 'openai'; }
        if (!vrPrim.outputProtocol) { vrPrim.outputProtocol = 'openai'; }
        if (!vrPrim.providers || typeof vrPrim.providers !== 'object') { vrPrim.providers = {}; }
        // 将顶层 providers 合并进 virtualrouter.providers（若存在）
        if (preNormalized.providers && typeof preNormalized.providers === 'object') {
          for (const [pid, prov] of Object.entries(preNormalized.providers as Record<string, any>)) {
            const p = JSON.parse(JSON.stringify(prov || {}));
            if (!p.id) p.id = pid;
            // responses 类型不被解析器枚举接受，统一映射到 openai 家族；
            const t = String(p.type || '').toLowerCase();
            if (t === 'responses') { p.type = 'openai'; }
            if (p.baseURL && !p.baseUrl) { p.baseUrl = p.baseURL; }
            // 确保 models 节点存在
            if (!p.models || typeof p.models !== 'object') {
              const modelId = (preNormalized.routeMeta && preNormalized.routeMeta['fc.gpt-5']?.modelId) || 'gpt-5';
              p.models = { [modelId]: { supportsStreaming: true } };
            }
            (vrPrim.providers as Record<string, any>)[pid] = p;
          }
          delete preNormalized.providers;
        }
        // routing 键存在（允许空数组）
        if (!vrPrim.routing || typeof vrPrim.routing !== 'object') {
          vrPrim.routing = { default: [], coding: [], longcontext: [], tools: [], thinking: [], vision: [], websearch: [], background: [] };
        }
        try {
          const vrNode = (preNormalized as Record<string, unknown>)?.['virtualrouter'] as Record<string, unknown> | undefined;
          const provs = (vrNode && typeof vrNode['providers'] === 'object' && vrNode['providers'] !== null)
            ? (vrNode['providers'] as Record<string, any>)
            : {};
          Object.keys(provs).forEach((pid) => {
            const p = provs[pid] || {};
            // 保持用户声明的 provider.type，不做 family 猜测或覆写（避免破坏后续兼容层/组装推导）
            // const family = String(p?.type || '').toLowerCase();
            // if (family === 'glm') { p.type = 'custom'; }
            // Provide schema-friendly defaults expected by downstream engines
            if (!p.id) { p.id = pid; }
            if (typeof p.enabled === 'undefined') { p.enabled = true; }
            if (p.baseURL && !p.baseUrl) { p.baseUrl = p.baseURL; }
            // Normalize apiKey into auth block if needed; also mirror auth.apiKey back to apiKey array for schema
            let apiKeyArr = Array.isArray(p.apiKey) ? p.apiKey : (typeof p.apiKey === 'string' && p.apiKey ? [p.apiKey] : []);
            if ((!apiKeyArr || apiKeyArr.length === 0) && p.auth && typeof p.auth.apiKey === 'string' && p.auth.apiKey) {
              apiKeyArr = [p.auth.apiKey];
            }

            // API Key inheritance: if provider-level apiKey is empty, inherit from parent levels
            if (apiKeyArr.length === 0) {
              // Try to inherit from parent virtualrouter providers level
              const vrNode = (preNormalized as Record<string, unknown>)?.['virtualrouter'] as Record<string, unknown> | undefined;
              const parentProviderConfig = (vrNode?.providers as Record<string, any>)?.[pid] as any;
              if (parentProviderConfig?.apiKey) {
                const parentKeys = Array.isArray(parentProviderConfig.apiKey)
                  ? parentProviderConfig.apiKey
                  : (typeof parentProviderConfig.apiKey === 'string' ? [parentProviderConfig.apiKey] : []);
                if (parentKeys.length > 0) {
                  apiKeyArr = parentKeys;
                  console.log(`🔧 Inherited ${apiKeyArr.length} API keys from parent provider level for ${pid}`);
                }
              }

              // If still empty, try to inherit from top-level apiKey
              if (apiKeyArr.length === 0 && preNormalized.apiKey) {
                const topLevelKeys = Array.isArray(preNormalized.apiKey)
                  ? preNormalized.apiKey
                  : (typeof preNormalized.apiKey === 'string' ? [preNormalized.apiKey] : []);
                if (topLevelKeys.length > 0) {
                  apiKeyArr = topLevelKeys;
                  console.log(`🔧 Inherited ${apiKeyArr.length} API keys from top-level for ${pid}`);
                }
              }

              // Update provider config with inherited keys
              if (apiKeyArr.length > 0) {
                p.apiKey = apiKeyArr;
              }
            }

            if (!p.auth && apiKeyArr.length > 0) {
              p.auth = { type: 'apikey', apiKey: apiKeyArr[0] };
              console.log(`🔧 Created auth block for ${pid} with API key: ${apiKeyArr[0].slice(0, 4)}****`);
            }
            // Mirror back apiKey array for schema validation
            if ((!Array.isArray(p.apiKey) || p.apiKey.length === 0) && apiKeyArr.length > 0) {
              p.apiKey = apiKeyArr;
            }
            if (!Array.isArray(p.keyAliases) || p.keyAliases.length === 0) {
              p.keyAliases = ['key1'];
            }
            provs[pid] = p;
          });

          // Note: 不在配置管理层做 provider 定制化的 routing 改写
          // keyAlias 与 OAuth 兼容统一交由 compatibility 引擎处理
          // 这里仅保持轻量的 family/type 归一化，避免侵入式回退逻辑
        } catch { /* noop */ }

        // 2.a 预补齐 routing 缺省数组字段，避免老版本校验因缺失分类报错
        try {
          const vrNode = (preNormalized as Record<string, unknown>)?.['virtualrouter'] as Record<string, unknown> | undefined;
          if (vrNode && typeof vrNode === 'object') {
            const routing = (vrNode['routing'] as Record<string, unknown>) || {};
            const categories = ['default','coding','longcontext','tools','thinking','vision','websearch','background'];
            for (const cat of categories) {
              if (!Array.isArray((routing as any)[cat])) {
                (routing as any)[cat] = [];
              }
            }
            (vrNode as any)['routing'] = routing;
          }
        } catch { /* ignore; compatibility engine will handle further */ }

        // 2.b 使用CompatibilityEngine处理兼容性（包含引擎内预处理）
        const compatResult = await this.compatibilityEngine.processCompatibility(
          JSON.stringify(preNormalized)
        );

        if (!compatResult.isValid) {
          throw new Error(`Compatibility processing failed: ${compatResult.errors?.map((e: any) => e.message).join(', ')}`);
        }

        // 3. 对兼容性引擎输出做一次轻量归一化，确保 provider 家族类型符合解析器枚举
        const normalizedInput = JSON.parse(
          JSON.stringify(compatResult.compatibilityConfig?.normalizedConfig || userConfig)
        ) as Record<string, unknown>;

        // 归一化 providers.*.type: 将模块实现名映射为提供商家族名
        // glm-http-provider -> glm, openai-provider -> openai, lmstudio-http -> lmstudio, qwen-provider -> qwen, iflow-provider -> iflow, generic-http -> custom
        const familyTypeMap: Record<string, string> = {
          'openai-provider': 'openai',
          'generic-openai-provider': 'openai',
          'lmstudio-http': 'lmstudio',
          'qwen-provider': 'qwen',
          'iflow-provider': 'iflow',
          'generic-http': 'custom',
          // 统一第三方 OpenAI 兼容：glm-http-provider 也归入 openai 家族
          'glm-http-provider': 'openai',
        };
        try {
          const vrNode = (normalizedInput as Record<string, unknown>)?.['virtualrouter'] as Record<string, unknown> | undefined;
          const provs = (vrNode && typeof vrNode['providers'] === 'object' && vrNode['providers'] !== null)
            ? (vrNode['providers'] as Record<string, any>)
            : {};
          Object.keys(provs).forEach((pid) => {
            const t = String(provs[pid]?.type || '').toLowerCase();
            if (familyTypeMap[t]) {
              provs[pid].type = familyTypeMap[t];
            }
            // Normalize unsupported family names to allowed enum for parser
            // The parser only allows: openai | anthropic | qwen | lmstudio | iflow | custom
            // Accept legacy 'glm' family by mapping to 'custom' here; assembler will still detect pid==='glm'
            // 不再将 glm 作为单独 family；统一归入 openai 家族
          });
        } catch { /* noop */ }

        // 4. 使用ConfigParser解析处理后的配置
        const parseResult = await this.configParser.parseFromString(
          JSON.stringify(normalizedInput)
        );

        if (!parseResult.isValid) {
          throw new Error(`Configuration validation failed: ${parseResult.errors?.map((e: any) => e.message).join(', ')}`);
        }

        // 5. 提取解析后的配置和兼容性配置
        parsedUserConfig = parseResult.normalized || normalizedInput;
        compatibilityConfig = compatResult.compatibilityConfig || {};

        // 严格模式：确保 compatibilityConfig 中包含 routeTargets 与 pipelineConfigs
        try {
          const ccAny = compatibilityConfig as Record<string, any>;
          // pipelineConfigs 映射：优先使用 compatibility 引擎的输出；若缺失，则从用户配置的显式字段映射
          const userPipelineConfigs = (parsedUserConfig as any)?.pipelineConfigs
            || (parsedUserConfig as any)?.modules?.virtualrouter?.config?.pipelineConfigs
            || {};
          // 如果兼容性引擎没有产生 pipelineConfigs，则直接采用用户的；
          // 如果已存在（通常只包含 endpoint-based），合并用户的逐目标配置（provider.model.key）
          const ensureObj = (o: any) => (o && typeof o === 'object') ? o : {};
          ccAny.pipelineConfigs = ensureObj(ccAny.pipelineConfigs);
          const upc = ensureObj(userPipelineConfigs);
          // 仅挑选逐目标键（包含点号的键），避免覆盖 endpoint-based 等分组键
        // 挑选逐目标键：既支持直接位于 pipelineConfigs 下，也支持位于 endpoint-based 分组内
        const perTargetEntries: Array<[string, any]> = [
          ...Object.entries(upc).filter(([k]) => k.includes('.')),
          ...Object.entries(ensureObj(upc['endpoint-based'] || {})).filter(([k]) => k.includes('.')),
        ];
          if (Object.keys(ccAny.pipelineConfigs).length === 0) {
            // 为空则直接赋值完整用户配置
            ccAny.pipelineConfigs = upc;
          } else if (perTargetEntries.length > 0) {
            for (const [k, v] of perTargetEntries) {
              ccAny.pipelineConfigs[k] = v;
            }
          }
          // routeTargets 映射：若缺失，从用户配置映射；否则保留（由导出器做兜底合成）
          const userRouteTargets = (parsedUserConfig as any)?.modules?.virtualrouter?.config?.routeTargets
            || (parsedUserConfig as any)?.virtualrouter?.config?.routeTargets
            || {};
          if (!ccAny.routeTargets || Object.keys(ccAny.routeTargets || {}).length === 0) {
            if (userRouteTargets && Object.keys(userRouteTargets).length > 0) {
              ccAny.routeTargets = userRouteTargets;
            } else {
              // leave empty; exporter can still build pipelines from provider models if needed
              ccAny.routeTargets = {};
            }
          }
          compatibilityConfig = ccAny;
        } catch (strictMapError) {
          throw strictMapError;
        }

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

      // 生成 pipeline_assembler.config 作为流水线唯一出口
      try {
        const compatModule = await import('routecodex-config-compat');
        const buildPipelineAssemblerConfig = (compatModule as any).buildPipelineAssemblerConfig;

        const ensureObj = (o: any) => (o && typeof o === 'object') ? o : {};
        const ccAny = ensureObj(compatibilityConfig) as Record<string, any>;
        const userPipelineConfigs = (parsedUserConfig as any)?.pipelineConfigs
          || (parsedUserConfig as any)?.modules?.virtualrouter?.config?.pipelineConfigs
          || {};
        const ccPc = ensureObj(ccAny.pipelineConfigs);
        const upc = ensureObj(userPipelineConfigs);
        const perTargetOnly: Record<string, any> = {};
        for (const [k, v] of Object.entries(upc)) {
          if (k.includes('.')) { perTargetOnly[k] = v; }
        }

        const compatForExport = {
          ...ccAny,
          pipelineConfigs: { ...ccPc, ...perTargetOnly },
          routeTargets: ccAny.routeTargets || {}
        } as Record<string, any>;

        let pac: any | null = null;
        if (typeof buildPipelineAssemblerConfig === 'function') {
          pac = buildPipelineAssemblerConfig(compatForExport as any);
        } else {
          // 内置最小构造器（无 compat 导出时）
          pac = this.buildMinimalAssemblerConfig(parsedUserConfig as any, compatibilityConfig as any);
        }

        // 🔧 修复alias解析：对buildPipelineAssemblerConfig生成的pipelines进行alias解析
        if (pac && pac.pipelines && Array.isArray(pac.pipelines)) {
          const keyMappings = ccAny.keyMappings || {};
          const authMappings = ccAny.authMappings || {};

          for (const pipeline of pac.pipelines) {
            const modules = pipeline.modules as any;
            if (modules?.provider?.config?.auth?.alias) {
              const aliasKey = modules.provider.config.auth.alias;
              const actualKey = keyMappings.global?.[aliasKey]
                || (keyMappings.providers?.[(pipeline as any).providerId || ''] || {})[aliasKey]
                || authMappings[aliasKey];

              if (actualKey && typeof actualKey === 'string') {
                modules.provider.config.auth.apiKey = actualKey;
                delete modules.provider.config.auth.alias;
              }
            }
          }
        }

        (mergedConfig as any).pipeline_assembler = { config: pac };
      } catch (e) {
        // 尝试使用内置最小构造器作为兜底（配置生成层可兜底，不涉及协议推断）
        try {
          const pac = this.buildMinimalAssemblerConfig(parsedUserConfig as any, compatibilityConfig as any);
          (mergedConfig as any).pipeline_assembler = { config: pac };
        } catch (ee) {
          throw new Error(`Failed to produce pipeline_assembler.config via compatibility module: ${e instanceof Error ? e.message : String(e)}. Provide explicit pipeline definitions.`);
        }
      }

      // 附加版本元信息（便于宿主断言契约）
      const mergedRec = mergedConfig as Record<string, unknown>;
      mergedRec['schemaVersion'] = '1.0.0';
      mergedRec['engineVersion'] = String(process.env.USE_NEW_CONFIG_ENGINE ? 'sharedmodule' : 'legacy');

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
        throw new Error(`Configuration validation failed: ${finalValidation.errors.map((e: any) => e.message).join(', ')}`);
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

      // Ensure httpserver.port/host is determined by user config if provided
      try {
        const uHttp = (userConfig as Record<string, any>)?.httpserver || (parsedUserConfig as Record<string, any>)?.httpserver || {};
        const mergedAny = mergedConfig as Record<string, any>;
        if (!mergedAny.modules) { mergedAny.modules = {}; }
        const mModules = mergedAny.modules as Record<string, any>;
        if (!mModules.httpserver) { mModules.httpserver = { enabled: true, config: {} }; }
        const mHttp = mModules.httpserver as Record<string, any>;
        if (!mHttp.config) { mHttp.config = {}; }
        const mHttpCfg = mHttp.config as Record<string, any>;
        // Only project user-provided values; do NOT apply implicit defaults here
        if (typeof uHttp.port === 'number' && uHttp.port > 0) {
          mHttpCfg.port = uHttp.port;
        }
        if (typeof uHttp.host === 'string' && uHttp.host.trim()) {
          mHttpCfg.host = uHttp.host.trim();
        }
      } catch { /* ignore normalization errors */ }

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
   * 内置最小 pipeline_assembler.config 构造：
   * - 从 parsedUserConfig.routeTargets / pipelineConfigs 生成 pipelines
   * - 为 provider.type=glm 使用 'glm-compatibility'，其它使用 'passthrough-compatibility'
   * - llmSwitch 固定使用 'llmswitch-conversion-router'
   */
  private buildMinimalAssemblerConfig(parsed: any, compat: any): Record<string, unknown> {
    const ensureObj = (o: any) => (o && typeof o === 'object') ? o : {};
    const routeTargets: Record<string, Array<any>> = ensureObj(parsed?.routeTargets);
    const pipelineConfigs: Record<string, any> = ensureObj(parsed?.pipelineConfigs);
    const pipelines: any[] = [];
    const routePools: Record<string, string[]> = {};
    const routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string }> = {};

    const addPipeline = (providerId: string, modelId: string, keyId?: string) => {
      const key = [providerId, modelId, keyId].filter(Boolean).join('.');
      const pc = ensureObj(pipelineConfigs[key]);
      const provType = String(pc?.provider?.type || providerId || 'openai');
      const pid = keyId ? `${providerId}_${keyId}.${modelId}` : `${providerId}.${modelId}`;
      const providerCfg: Record<string, unknown> = { type: provType, config: { ...(pc?.provider || {}) } } as any;
      const compatibilityCfg = (() => {
        // 仅在显式配置时附加标准兼容模块
        const c = (pc?.compatibility && typeof pc.compatibility === 'object') ? (pc.compatibility as Record<string, unknown>) : undefined;
        if (c && typeof (c as any).type === 'string') {
          // 透传 modules.compatibility（建议使用 { type:'compatibility', config:{ moduleType, moduleConfig } }）
          return c;
        }
        return undefined;
      })();
      const llmSwitchCfg = { type: 'llmswitch-conversion-router', config: {} };
      const workflowCfg = { type: 'streaming-control', config: {} };

      const modules: any = { provider: providerCfg, llmSwitch: llmSwitchCfg, workflow: workflowCfg };
      if (compatibilityCfg) { modules.compatibility = compatibilityCfg; }
      pipelines.push({ id: pid, modules });
      routeMeta[pid] = { providerId, modelId, keyId } as any;
      return pid;
    };

    for (const [routeName, targets] of Object.entries(routeTargets)) {
      routePools[routeName] = [];
      for (const t of (targets as any[])) {
        const providerId = String(t.providerId || 'openai');
        const modelId = String(t.modelId || 'gpt-4');
        const keyId = t.keyId ? String(t.keyId) : undefined;
        const pid = addPipeline(providerId, modelId, keyId);
        routePools[routeName].push(pid);
      }
    }

    // 如无 routeTargets，尝试从 parsed.virtualrouter.routing 重建 default 路由
    if (Object.keys(routePools).length === 0 && parsed?.virtualrouter?.routing) {
      const routing = ensureObj(parsed.virtualrouter.routing) as Record<string, string[]>;
      for (const [routeName, refs] of Object.entries(routing)) {
        routePools[routeName] = [];
        for (const ref of refs || []) {
          const segs = String(ref).split('.');
          const providerId = segs[0];
          const modelId = segs[1] || 'gpt-4';
          const keyId = segs[2];
          const pid = addPipeline(providerId, modelId, keyId);
          routePools[routeName].push(pid);
        }
      }
    }

    return { pipelines, routePools, routeMeta } as Record<string, unknown>;
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
  private async loadSystemConfig(): Promise<Record<string, unknown>> {
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
      const config = JSON.parse(configContent) as Record<string, unknown>;
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
  private async loadUserConfig(): Promise<Record<string, unknown>> {
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
      const config = JSON.parse(configContent) as Record<string, unknown>;

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
  private async saveMergedConfig(mergedConfig: unknown): Promise<void> {
    const startTime = Date.now();
    const saveId = `save_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record save start
    if (this.isDebugEnhanced) {
      this.recordConfigMetric('save_start', {
        saveId,
        configPath: this.mergedConfigPath,
        configSize: Object.keys(mergedConfig as Record<string, unknown>).length,
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
          configSize: Object.keys(mergedConfig as Record<string, unknown>).length,
          contentLength: configContent.length,
          totalTime
        });
        this.publishDebugEvent('save_complete', {
          saveId,
          success: true,
          configPath: this.mergedConfigPath,
          configSize: Object.keys(mergedConfig as Record<string, unknown>).length,
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
      // Do not block server startup on save errors (e.g., oversized config); continue without persisting.
      try {
        this.publishDebugEvent('save_skipped', { saveId, reason: 'persist_failed_but_non_fatal', totalTime });
      } catch { /* ignore */ }
      return; // best-effort: skip writing to disk
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
  // Provide detailed module status separate from BaseModule's minimal status
  getStatus(): UnknownObject {
    const info = this.getInfo();
    const baseStatus = {
      id: info.id,
      name: info.name,
      status: this.isRunning() ? 'running' : 'stopped',
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

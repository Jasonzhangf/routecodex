/**
 * Merged Configuration Types
 * 合并配置类型定义 - 支持虚拟路由系统的完整类型定义
 */

/**
 * 路由目标接口
 */
export interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: 'openai' | 'anthropic';
  outputProtocol: 'openai' | 'anthropic';
}

/**
 * 路由信息接口
 */
export interface RoutingInfo {
  route: string;
  providerId: string;
  modelId: string;
  keyId: string;
  selectedTarget?: RouteTarget;
  selectionTime?: number;
}

/**
 * 路由目标池
 */
export interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}

/**
 * 流水线配置
 */
export interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
    actualModelId?: string;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
    keyType: 'apiKey' | 'authFile';
  };
  protocols: {
    input: 'openai' | 'anthropic';
    output: 'openai' | 'anthropic';
  };
}

/**
 * 流水线配置集合
 */
export interface PipelineConfigs {
  [providerModelKey: string]: PipelineConfig;
}

/**
 * 虚拟路由模块配置
 */
export interface VirtualRouterConfig {
  moduleType: 'virtual-router';
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  authMappings: Record<string, string>;
  inputProtocol: 'openai' | 'anthropic';
  outputProtocol: 'openai' | 'anthropic';
  timeout: number;
  userConfigDefaults?: {
    maxContext: number;
    maxTokens: number;
  };
}

/**
 * HTTP服务器模块配置
 */
export interface HttpServerConfig {
  moduleType: 'http-server';
  port: number;
  host: string;
  cors?: {
    origin: string | string[];
    credentials: boolean;
  };
  timeout?: number;
  bodyLimit?: string;
  enableMetrics?: boolean;
  enableHealthChecks?: boolean;
}

/**
 * 配置管理模块配置
 */
export interface ConfigManagerConfig {
  moduleType: 'config-manager';
  configPath: string;
  mergedConfigPath: string;
  autoReload: boolean;
  watchInterval: number;
}

/**
 * 调试中心模块配置
 */
export interface DebugCenterConfig {
  moduleType: 'debug-center';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableConsole: boolean;
  enableFile: boolean;
  eventQueueSize?: number;
  filePath?: string;
}

/**
 * 通用模块配置
 */
export interface ModuleConfig {
  enabled: boolean;
  config: VirtualRouterConfig | HttpServerConfig | ConfigManagerConfig | DebugCenterConfig | any;
}

/**
 * 模块配置集合
 */
export interface ModuleConfigs {
  [moduleName: string]: ModuleConfig;
}

/**
 * 用户配置接口 - 兼容现有 ~/.routecodex/config.json 格式
 */
export interface UserConfig {
  version?: string;
  description?: string;
  user?: {
    name: string;
    email: string;
  };
  virtualrouter: {
    inputProtocol: 'openai' | 'anthropic';
    outputProtocol: 'openai' | 'anthropic';
    providers: Record<string, {
      type: string;
      baseURL: string;
      apiKey: string[];
      auth?: Record<string, string>;
      models: Record<string, {
        maxContext?: number;
        maxTokens?: number;
      }>;
    }>;
    routing: Record<string, string[]>;
  };
  httpserver?: {
    port?: number;
    host?: string;
    cors?: {
      origin?: string | string[];
      credentials?: boolean;
    };
    timeout?: number;
    bodyLimit?: string;
  };
  debugcenter?: {
    logLevel?: string;
    enableConsole?: boolean;
    enableFile?: boolean;
  };
  configmanager?: {
    mergedConfigPath?: string;
    autoReload?: boolean;
    watchInterval?: number;
  };
  [key: string]: any;
}

/**
 * 系统配置接口 - 兼容现有 ./config/modules.json 格式
 */
export interface ModulesConfig {
  modules: Record<string, ModuleConfig>;
}

/**
 * 合并后的配置接口
 */
export interface MergedConfig {
  version: string;
  mergedAt: string;
  modules: ModuleConfigs;
}

/**
 * 配置解析结果
 */
export interface ConfigParseResult {
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  moduleConfigs: ModuleConfigs;
}

/**
 * 配置验证结果
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
  config?: MergedConfig;
}

/**
 * 协议转换器接口
 */
export interface ProtocolConverter {
  convertRequest(request: any): Promise<any>;
  convertResponse(response: any): Promise<any>;
}

/**
 * 负载均衡器接口
 */
export interface LoadBalancer {
  selectTarget(targets: RouteTarget[]): Promise<RouteTarget | null>;
  updateMetrics(targetId: string, success: boolean): void;
  getStatus(): any;
}

/**
 * 密钥解析器接口
 */
export interface KeyResolver {
  resolveKey(keyId: string): Promise<string>;
  resolveKeys(keyIds: string[]): Promise<Map<string, string>>;
  clearCache(): void;
}

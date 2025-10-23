/**
 * 配置对象类型定义
 * 用于定义RouteCodex中各种配置的类型
 */

/**
 * 未知对象类型，用于替代any类型
 */
export type UnknownObject = Record<string, unknown>;

/**
 * 基础模块配置接口
 */
export interface BaseModuleConfig {
  /** 模块ID */
  id?: string;
  /** 模块名称 */
  name?: string;
  /** 模块类型 */
  type: string;
  /** 模块是否启用 */
  enabled?: boolean;
  /** 模块配置数据 */
  config?: UnknownObject;
  /** 模块元数据 */
  metadata?: UnknownObject;
}

/**
 * 服务器配置
 */
export interface ServerConfig {
  /** 服务器端口 */
  port: number;
  /** 服务器主机名 */
  host: string;
  /** 是否启用HTTPS */
  https?: boolean;
  /** HTTPS配置 */
  httpsOptions?: {
    /** 证书路径 */
    cert?: string;
    /** 私钥路径 */
    key?: string;
  };
}

/**
 * 提供商配置
 */
export interface ProviderConfig {
  /** 提供商类型 */
  type: string;
  /** 提供商基础URL */
  baseUrl: string;
  /** API密钥 */
  apiKey?: string;
  /** 认证配置 */
  auth?: {
    /** 认证类型 */
    type: 'bearer' | 'oauth' | 'apikey' | 'none';
    /** OAuth配置 */
    oauth?: OAuthConfig;
  };
  /** 提供商特定配置 */
  [key: string]: unknown;
}

/**
 * OAuth配置
 */
export interface OAuthConfig {
  /** 客户端ID */
  clientId: string;
  /** 客户端密钥 */
  clientSecret: string;
  /** 授权URL */
  authUrl: string;
  /** 令牌URL */
  tokenUrl: string;
  /** 重定向URL */
  redirectUri?: string;
  /** 作用域 */
  scope?: string;
}

/**
 * 路由配置
 */
export interface RoutingConfig {
  /** 默认提供商 */
  default: string;
  /** 路由规则 */
  rules?: RoutingRule[];
  /** 模型映射 */
  modelMapping?: Record<string, string>;
}

/**
 * 路由规则
 */
export interface RoutingRule {
  /** 匹配条件 */
  condition: string;
  /** 目标提供商 */
  provider: string;
  /** 优先级 */
  priority?: number;
}

/**
 * 兼容性配置
 */
export interface CompatibilityConfig {
  /** 兼容性类型 */
  type: string;
  /** 转换规则 */
  transformations?: Record<string, unknown>;
}

/**
 * 日志配置
 */
export interface LogConfig {
  /** 日志级别 */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 日志输出格式 */
  format: 'json' | 'text';
  /** 是否输出到文件 */
  file?: boolean;
  /** 日志文件路径 */
  filePath?: string;
}

/**
 * 调试配置
 */
export interface DebugConfig {
  /** 是否启用调试 */
  enabled: boolean;
  /** 调试级别 */
  level: 'basic' | 'detailed' | 'verbose';
  /** 输出目录 */
  outputDir?: string;
}

/**
 * 流水线配置
 */
export interface PipelineConfig {
  /** 流水线ID */
  id: string;
  /** 流水线名称 */
  name: string;
  /** 流水线模块 */
  modules: BaseModuleConfig[];
  /** 流水线配置 */
  config?: UnknownObject;
}

/**
 * 根配置对象
 */
export interface RootConfig {
  /** 服务器配置 */
  server: ServerConfig;
  /** 提供商配置 */
  providers: Record<string, ProviderConfig>;
  /** 路由配置 */
  routing: RoutingConfig;
  /** 兼容性配置 */
  compatibility: string | CompatibilityConfig;
  /** 日志配置 */
  logging?: LogConfig;
  /** 调试配置 */
  debug?: DebugConfig;
  /** 流水线配置 */
  pipelines?: PipelineConfig[];
  /** 其他配置 */
  [key: string]: unknown;
}

/**
 * 用户配置对象
 */
export interface UserConfig extends RootConfig {
  /** 配置版本 */
  version?: string;
  /** 配置描述 */
  description?: string;
}

/**
 * 合并后的配置对象
 */
export interface MergedConfig extends RootConfig {
  /** 配置源信息 */
  sources: string[];
  /** 配置合并时间 */
  mergedAt: string;
}
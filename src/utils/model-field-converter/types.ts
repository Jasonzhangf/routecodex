/**
 * Model Field Converter Types
 * 模型字段转换器类型定义
 */

import type {
  PipelineConfig,
  RouteTarget,
  RoutingInfo
} from '../../config/merged-config-types.js';

/**
 * 转换器配置
 */
export interface ModelFieldConverterConfig {
  debugMode?: boolean;               // 调试模式
  enableTracing?: boolean;           // 启用轨迹跟踪
  strictValidation?: boolean;       // 严格验证模式
  maxConversionDepth?: number;       // 最大转换深度
  enableMetrics?: boolean;           // 启用指标收集
  traceSampling?: number;            // 轨迹采样率 (0-1)
  defaultMaxTokens?: number;         // 默认最大Token数量
  defaultModel?: string;             // 默认目标模型
  pipelineConfigs?: any;             // 流水线配置（用于动态提取默认值）
}

/**
 * 模型映射规则
 */
export interface ModelMappingRule {
  pattern: string;                   // 模型匹配模式
  targetModel: string;               // 目标模型
  provider: string;                  // Provider类型
  priority: number;                  // 优先级
  conditions?: MappingCondition[];   // 映射条件
}

/**
 * 映射条件
 */
export interface MappingCondition {
  field: string;                     // 条件字段
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains'; // 操作符
  value: any;                        // 条件值
}

/**
 * 参数映射规则
 */
export interface ParameterMappingRule {
  sourceField: string;               // 源字段名
  targetField?: string;              // 目标字段名 (可选，默认同源字段)
  transformer?: ParamTransformer;    // 参数转换器
  validator?: ParamValidator;        // 参数验证器
  defaultValue?: any;                // 默认值
}

/**
 * 参数转换器
 */
export interface ParamTransformer {
  (value: any, context: ConversionContext): any;
}

/**
 * 参数验证器
 */
export interface ParamValidator {
  (value: any, context: ConversionContext): ValidationResult;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  isValid: boolean;                  // 是否有效
  errors?: string[];                 // 错误信息
  warnings?: string[];               // 警告信息
}

/**
 * 转换上下文
 */
export interface ConversionContext {
  pipelineConfig: PipelineConfig;    // 流水线配置
  routingInfo: RoutingInfo;          // 路由信息
  originalRequest: any;              // 原始请求
  metadata?: Record<string, any>;    // 额外元数据
}

/**
 * 转换步骤
 */
export interface ConversionStep {
  step: string;                      // 转换步骤名称
  description: string;               // 步骤描述
  input: any;                        // 输入数据
  output: any;                       // 输出数据
  timestamp: Date;                   // 时间戳
  rules: string[];                   // 应用的规则
  duration: number;                  // 执行时间 (ms)
}

/**
 * 转换结果
 */
export interface ConversionResult {
  convertedRequest: any;             // 转换后的请求
  debugInfo: ConversionDebugInfo;    // 调试信息
  success: boolean;                  // 是否成功
  errors?: string[];                 // 错误信息
  warnings?: string[];               // 警告信息
}

/**
 * 转换调试信息
 */
export interface ConversionDebugInfo {
  conversionId: string;              // 转换ID
  originalRequest: any;              // 原始请求
  routingInfo: RoutingInfo;          // 路由信息
  pipelineConfig: PipelineConfig;    // 使用的流水线配置
  conversionTrace: ConversionStep[];  // 转换轨迹
  appliedRules: string[];             // 应用的规则列表
  metrics: ConversionMetrics;         // 转换指标
  meta: Record<string, any>;          // 额外元数据
}

/**
 * 转换指标
 */
export interface ConversionMetrics {
  totalSteps: number;                // 总转换步骤
  totalDuration: number;            // 总转换时间 (ms)
  averageStepTime: number;           // 平均步骤时间
  memoryUsage: number;               // 内存使用 (bytes)
  ruleUsage: Record<string, number>;  // 规则使用统计
}

/**
 * 批量转换结果
 */
export interface BatchConversionResult {
  successful: ConversionResult[];    // 成功的转换
  failed: FailedConversion[];        // 失败的转换
  summary: BatchConversionSummary;    // 批量转换摘要
}

/**
 * 失败的转换
 */
export interface FailedConversion {
  request: any;                      // 原始请求
  error: ConversionError;             // 转换错误
  timestamp: Date;                   // 时间戳
}

/**
 * 转换错误
 */
export interface ConversionError {
  code: string;                       // 错误代码
  message: string;                    // 错误消息
  details?: any;                      // 错误详情
  step?: string;                      // 失败步骤
  recovery?: RecoverySuggestion;      // 恢复建议
}

/**
 * 恢复建议
 */
export interface RecoverySuggestion {
  action: string;                     // 建议操作
  description: string;                // 操作描述
  priority: 'low' | 'medium' | 'high'; // 优先级
}

/**
 * 批量转换摘要
 */
export interface BatchConversionSummary {
  totalRequests: number;             // 总请求数
  successfulCount: number;            // 成功数量
  failedCount: number;               // 失败数量
  successRate: number;                // 成功率
  averageTime: number;                // 平均转换时间
  totalTime: number;                  // 总转换时间
  errorDistribution: Record<string, number>; // 错误分布
}

/**
 * 转换器状态
 */
export interface ConverterStatus {
  isInitialized: boolean;             // 是否已初始化
  config: ModelFieldConverterConfig;  // 当前配置
  metrics: ConverterMetrics;          // 性能指标
  health: HealthStatus;               // 健康状态
  lastConversion?: ConversionResult;  // 最后一次转换结果
}

/**
 * 转换器性能指标
 */
export interface ConverterMetrics {
  totalConversions: number;           // 总转换次数
  successfulConversions: number;     // 成功转换次数
  failedConversions: number;         // 失败转换次数
  averageConversionTime: number;      // 平均转换时间
  lastConversionTime?: Date;          // 最后转换时间
  uptime: number;                    // 运行时间 (ms)
  memoryUsage: number;                // 内存使用 (bytes)
  ruleUsage: Record<string, number>;  // 规则使用统计
}

/**
 * 健康状态
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'; // 健康状态
  checks: HealthCheck[];             // 健康检查结果
  lastCheck: Date;                   // 最后检查时间
}

/**
 * 健康检查
 */
export interface HealthCheck {
  name: string;                       // 检查名称
  status: 'pass' | 'fail' | 'warn';   // 检查状态
  message?: string;                   // 检查消息
  duration?: number;                  // 检查耗时 (ms)
}

/**
 * OpenAI请求格式
 */
export interface OpenAIRequest {
  model: string;                     // 模型名称
  messages: OpenAIMessage[];          // 消息列表
  max_tokens?: number;                // 最大token数
  temperature?: number;               // 温度参数
  top_p?: number;                     // 采样参数
  stream?: boolean;                   // 是否流式响应
  stop?: string[];                    // 停止序列
  _meta?: RequestMeta;                // 请求元数据
}

/**
 * OpenAI消息格式
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'; // 角色
  content: string;                     // 内容
  name?: string;                     // 名称 (可选)
}

/**
 * 请求元数据
 */
export interface RequestMeta {
  sourceProtocol?: string;            // 源协议类型
  requestId?: string;                // 请求ID
  timestamp?: Date;                   // 时间戳
  routing?: {                        // 路由信息
    route: string;                    // 路由名称
    providerId: string;               // Provider ID
    modelId: string;                  // 模型ID
    keyId: string;                    // 密钥ID
    provider?: any;                   // Provider配置
    modelConfig?: any;                // 模型配置
  };
  originalModel?: string;             // 原始模型
  conversionId?: string;              // 转换ID
  conversion?: {                     // 转换信息
    convertedAt?: string;            // 转换时间
    converter?: string;               // 转换器
    originalModel?: string;           // 原始模型
    targetModel?: string;             // 目标模型
  };
}

/**
 * 扩展的路由信息
 */
export interface ExtendedRoutingInfo extends RoutingInfo {
  selectedTarget?: RouteTarget;       // 选择的目标
  loadBalancerInfo?: {               // 负载均衡信息
    strategy: string;                 // 负载均衡策略
    selectedIndex: number;            // 选择的索引
    availableTargets: number;         // 可用目标数量
  };
  conversionMetrics?: {              // 转换指标
    selectionTime: number;            // 选择时间
    conversionTime: number;           // 转换时间
  };
}
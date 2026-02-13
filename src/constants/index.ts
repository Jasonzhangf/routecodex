/**
 * RouteCodex 统一常量定义
 * 所有硬编码值应在此处集中管理
 */

// API 服务端点
export const API_ENDPOINTS = {
  // OpenAI
  OPENAI: 'https://api.openai.com/v1',
  OPENAI_BASE: 'https://api.openai.com',
  
  // Anthropic  
  ANTHROPIC: 'https://api.anthropic.com',
  
  // 其他服务可根据需要添加
} as const;

// 本地开发地址
export const LOCAL_HOSTS = {
  IPV4: '127.0.0.1',
  IPV6: '::1',
  LOCALHOST: 'localhost',
  
  // 特殊的IPv4映射
  IPV4_MAPPED_IPV6: '::ffff:127.0.0.1',
  ANY: '0.0.0.0',
} as const;

// 默认配置值
export const DEFAULT_CONFIG = {
  // 服务器配置
  HOST: LOCAL_HOSTS.IPV4,
  PORT: 5506,
  
  // 网络配置
  TIMEOUT: 30000,
  
  // OAuth 配置
  OAUTH_CALLBACK_PORT: 8080,
  OAUTH_CALLBACK_HOST: LOCAL_HOSTS.LOCALHOST,
  
  // LM Studio 默认配置
  LM_STUDIO_HOST: LOCAL_HOSTS.LOCALHOST,
  LM_STUDIO_PORT: 1234,
} as const;

// 默认超时（毫秒）
// 说明：
// - ProviderTimeout：provider 层整体请求超时（由 service profile / provider overrides 决定）
// - Stream*Cap：provider 层 SSE 的 headers/idle 默认上限；实际默认取 min(cap, providerTimeout)
// - HTTP_SSE_*：server 层向客户端桥接 SSE 的 idle/total 默认值
export const DEFAULT_TIMEOUTS = {
  // Provider → upstream (SSE headers/idle)
  PROVIDER_STREAM_HEADERS_CAP_MS: 900_000, // 15 min cap（避免长 prompt 初始化被 5min 默认截断）
  PROVIDER_STREAM_IDLE_CAP_MS: 900_000,    // 15 min cap（避免长时间无字节输出导致中途断流）

  // Host → client (SSE bridge)
  HTTP_SSE_IDLE_MS: 900_000,               // 15 min（与 provider idle cap 对齐）
  HTTP_SSE_TOTAL_MS: 1_000_000,            // 16.6 min（覆盖 LM Studio 默认 1000s provider timeout）
} as const;

// HTTP 协议前缀
export const HTTP_PROTOCOLS = {
  HTTP: 'http://',
  HTTPS: 'https://',
} as const;

// 常用路径
export const API_PATHS = {
  // OpenAI API 路径
  OPENAI_CHAT: '/v1/chat/completions',
  OPENAI_COMPLETIONS: '/v1/completions',
  OPENAI_MODELS: '/v1/models',
  
  // Anthropic API 路径
  ANTHROPIC_MESSAGES: '/v1/messages',
  
  // 内部 API 路径
  HEALTH: '/health',
  SHUTDOWN: '/shutdown',
  CONFIG: '/config',
  OAUTH_CALLBACK: '/oauth2callback',
} as const;

// Provider 默认配置
export const DEFAULT_PROVIDER = {
  // 默认 User-Agent (用于风控识别)
  USER_AGENT: 'codex_cli_rs/0.73.0 (Mac OS 15.6.1; arm64) iTerm.app/3.6.5',

  // 请求超时和重试
  TIMEOUT_MS: 500_000,        // 500 秒 (可通过 config/profile 覆盖)
  MAX_RETRIES: 3,             // 默认最大重试次数

  // SSE 流式响应超时
  STREAM_IDLE_TIMEOUT_MS: 900_000,   // 15 分钟
  STREAM_HEADERS_TIMEOUT_MS: 900_000,  // 15 分钟

  // iFlow 签名配置
  IFLOW_SIGNATURE_ALGORITHM: 'sha256',
} as const;

// Token Daemon 默认配置
export const DEFAULT_TOKEN_DAEMON = {
  // 轮询间隔
  INTERVAL_MS: 60_000,              // 60 秒

  // ���新窗口：在 token 到期前多久开始刷新
  REFRESH_AHEAD_MINUTES: 30,        // 30 分钟

  // 最小刷新间隔：避免频繁刷新
  MIN_REFRESH_INTERVAL_MS: 5 * 60_000,  // 5 分钟

  // Antigravity metadata 确保间隔
  ANTIGRAVITY_METADATA_ENSURE_INTERVAL_MS: 10 * 60_000,  // 10 分钟
} as const;

// Pipeline Health Manager 默认配置
export const DEFAULT_PIPELINE_HEALTH = {
  // 健康检查间隔
  CHECK_INTERVAL_MS: 30 * 1000,          // 30 秒

  // 错误阈值
  MAX_CONSECUTIVE_ERRORS: 3,              // 连续错误多少次后禁用
  ERROR_THRESHOLD: 5,                     // 累积多少错误后禁用

  // 恢复配置
  SUCCESS_THRESHOLD: 3,                     // 成功多少次后认为恢复
  RECOVERY_INTERVAL_MS: 5 * 60 * 1000,  // 5 分钟后尝试恢复

  // 健康检查超时
  CHECK_TIMEOUT_MS: 10 * 1000,            // 10 秒
} as const;

// Key429 Tracker 默认配置
export const DEFAULT_KEY_429_TRACKER = {
  // 黑名单触发条件
  MAX_CONSECUTIVE_ERRORS: 3,              // 连续 3 次 429
  MIN_INTERVAL_MS: 60 * 1000,            // 间隔 >1 分钟

  // 黑名单时长
  BLACKLIST_DURATION_MS: 30 * 60 * 1000,  // 30 分钟

  // 清理配置
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000,     // 5 分钟清理一次
  MAX_RECORD_AGE_MS: 2 * 60 * 60 * 1000,  // 保留 2 小时的记录
} as const;

// Provider Factory 缓存配置
export const PROVIDER_CACHE = {
  // 最大缓存实例数量 (LRU)
  MAX_INSTANCES: 100,

  // InstanceId hash 长度
  INSTANCE_ID_HASH_LENGTH: 16,
} as const;

// 代码标识符长度限制
export const CODEX_IDENTIFIER_MAX_LENGTH = 64;

// 类型定义
export type ApiEndpoint = typeof API_ENDPOINTS[keyof typeof API_ENDPOINTS];
export type LocalHost = typeof LOCAL_HOSTS[keyof typeof LOCAL_HOSTS];
export type ApiPath = typeof API_PATHS[keyof typeof API_PATHS];

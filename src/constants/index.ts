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

// 类型定义
export type ApiEndpoint = typeof API_ENDPOINTS[keyof typeof API_ENDPOINTS];
export type LocalHost = typeof LOCAL_HOSTS[keyof typeof LOCAL_HOSTS];
export type ApiPath = typeof API_PATHS[keyof typeof API_PATHS];

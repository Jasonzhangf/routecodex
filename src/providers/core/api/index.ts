/**
 * Provider V2 API - 统一对外接口
 *
 * 提供V2版本的统一对外接口，确保与V1版本完全兼容
 */

// 核心实现
export { ChatHttpProvider } from '../runtime/chat-http-provider.js';
export { ProviderFactory, createChatHttpProvider } from '../runtime/provider-factory.js';

// 配置类型
export type { OpenAIStandardConfig } from './provider-config.js';
export type { ApiKeyAuth, OAuthAuth } from './provider-config.js';

// 接口类型
export type { IProviderV2, ProviderType, ProviderError, ProviderMetrics, ServiceProfile } from './provider-types.js';

// V1兼容转换
// V1 转换器不再对外暴露；保持 v2 纯净引用路径

// 认证模块
export { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
export { OAuthAuthProvider } from '../../auth/oauth-auth.js';

// 工具模块
export { HttpClient } from '../utils/http-client.js';
export { SERVICE_PROFILES, ServiceProfileValidator } from '../config/service-profiles.js';

// 重新导出V1兼容接口
export type {
  ProviderModule,
  ModuleConfig,
  ModuleDependencies
} from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

export type { UnknownObject } from '../../../types/common-types.js';

/**
 * V2主要导出摘要：
 *
 * 1. ChatHttpProvider - 统一的 OpenAI Chat 兼容 Provider 实现
 * 2. ProviderFactory - Provider实例工厂
 * 3. createChatHttpProvider - 便捷创建函数
 * 4. OpenAIStandardConfig - 统一配置接口
 * 5. fromV1Config - V1到V2配置转换
 * 6. ApiKeyAuthProvider/OAuthAuthProvider - 认证模块
 * 7. SERVICE_PROFILES - 服务配置档案
 */

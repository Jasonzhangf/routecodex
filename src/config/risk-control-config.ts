/**
 * Risk Control Configuration
 * 
 * 提供风控策略的配置管理，包括封禁错误码、重试策略、冷却时间等。
 * 通过 ProviderQuotaView 接口与 llmswitch-core 集成。
 */

export interface BanErrorCodesConfig {
  /**
   * 是否启用自动封禁
   */
  enabled: boolean;
  
  /**
   * 触发封禁的错误码列表
   */
  errorCodes: number[];
  
  /**
   * 连续错误次数阈值（达到该次数后封禁）
   */
  consecutiveErrorThreshold?: number;
}

export interface RetryConfig {
  /**
   * 是否启用 429 错误重试
   */
  enabled: boolean;
  
  /**
   * 最大重试次数
   */
  maxRetries: number;
  
  /**
   * 重试间隔（毫秒）
   */
  interval: number;
}

export interface CooldownConfig {
  /**
   * 默认冷却时间（毫秒）
   */
  defaultMs: number;
  
  /**
   * 致命错误冷却时间（毫秒）
   */
  fatalMs: number;
  
  /**
   * 429 错误阶梯退避策略（毫秒）
   * 例如：[5min, 1h, 6h, 24h]
   */
  rateLimitSchedule: number[];
  
  /**
   * 错误计数重置窗口（毫秒）
   * 默认 24 小时
   */
  resetWindowMs: number;
}

export interface RiskControlConfig {
  /**
   * 封禁错误码配置
   */
  banErrorCodes: BanErrorCodesConfig;
  
  /**
   * 重试配置
   */
  retry: RetryConfig;
  
  /**
   * 冷却配置
   */
  cooldown: CooldownConfig;
  
  /**
   * Provider 级别的覆盖配置
   * key: providerKey, value: RiskControlConfig
   */
  providerOverrides?: Record<string, Partial<RiskControlConfig>>;
}

export const DEFAULT_RISK_CONTROL_CONFIG: RiskControlConfig = {
  banErrorCodes: {
    enabled: true,
    errorCodes: [403],
    consecutiveErrorThreshold: 3
  },
  retry: {
    enabled: true,
    maxRetries: 5,
    interval: 100
  },
  cooldown: {
    defaultMs: 30_000,
    fatalMs: 120_000,
    rateLimitSchedule: [
      5 * 60_000,      // 5 分钟
      60 * 60_000,     // 1 小时
      6 * 60 * 60_000, // 6 小时
      24 * 60 * 60_000 // 24 小时
    ],
    resetWindowMs: 24 * 60 * 60_000 // 24 小时
  }
};

/**
 * 解析环境变量中的配置
 */
export function parseEnvConfig(): Partial<RiskControlConfig> {
  const config: Partial<RiskControlConfig> = {};
  
  // AUTO_BAN_ENABLED
  const autoBanEnv = process.env.AUTO_BAN_ENABLED || process.env.RCC_AUTO_BAN_ENABLED;
  if (autoBanEnv) {
    config.banErrorCodes = {
      enabled: autoBanEnv.toLowerCase() === 'true' || autoBanEnv === '1',
      errorCodes: DEFAULT_RISK_CONTROL_CONFIG.banErrorCodes.errorCodes
    };
  }
  
  // AUTO_BAN_ERROR_CODES
  const banCodesEnv = process.env.AUTO_BAN_ERROR_CODES || process.env.RCC_AUTO_BAN_ERROR_CODES;
  if (banCodesEnv) {
    try {
      const codes = banCodesEnv.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (codes.length) {
        config.banErrorCodes = {
          enabled: true,
          errorCodes: codes
        };
      }
    } catch {
      console.warn('[RiskControlConfig] Failed to parse AUTO_BAN_ERROR_CODES');
    }
  }
  
  // RETRY_429_ENABLED
  const retryEnv = process.env.RETRY_429_ENABLED || process.env.RCC_RETRY_429_ENABLED;
  if (retryEnv) {
    config.retry = {
      ...DEFAULT_RISK_CONTROL_CONFIG.retry,
      enabled: retryEnv.toLowerCase() === 'true' || retryEnv === '1'
    };
  }
  
  // RETRY_429_MAX_RETRIES
  const maxRetriesEnv = process.env.RETRY_429_MAX_RETRIES || process.env.RCC_RETRY_429_MAX_RETRIES;
  if (maxRetriesEnv) {
    const maxRetries = parseInt(maxRetriesEnv);
    if (!isNaN(maxRetries)) {
      config.retry = {
        ...DEFAULT_RISK_CONTROL_CONFIG.retry,
        maxRetries
      };
    }
  }
  
  // RETRY_429_INTERVAL
  const intervalEnv = process.env.RETRY_429_INTERVAL || process.env.RCC_RETRY_429_INTERVAL;
  if (intervalEnv) {
    const interval = parseFloat(intervalEnv);
    if (!isNaN(interval)) {
      config.retry = {
        ...DEFAULT_RISK_CONTROL_CONFIG.retry,
        interval: interval * 1000
      };
    }
  }
  
  // ROUTECODEX_RL_SCHEDULE
  const scheduleEnv = process.env.ROUTECODEX_RL_SCHEDULE || process.env.RCC_RL_SCHEDULE;
  if (scheduleEnv) {
    try {
      const schedule = scheduleEnv.split(',').map(s => {
        const match = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
        if (match) {
          const amount = parseFloat(match[1]);
          const unit = match[2].toLowerCase();
          const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
          return amount * multiplier;
        }
        return 0;
      }).filter(n => n > 0);
      
      if (schedule.length) {
        config.cooldown = {
          ...DEFAULT_RISK_CONTROL_CONFIG.cooldown,
          rateLimitSchedule: schedule
        };
      }
    } catch {
      console.warn('[RiskControlConfig] Failed to parse ROUTECODEX_RL_SCHEDULE');
    }
  }
  
  return config;
}

/**
 * 合并配置（默认配置 + 环境变量配置 + 用户配置）
 */
export function mergeRiskControlConfig(
  userConfig?: Partial<RiskControlConfig>
): RiskControlConfig {
  const envConfig = parseEnvConfig();
  
  return {
    banErrorCodes: {
      ...DEFAULT_RISK_CONTROL_CONFIG.banErrorCodes,
      ...envConfig.banErrorCodes,
      ...userConfig?.banErrorCodes
    },
    retry: {
      ...DEFAULT_RISK_CONTROL_CONFIG.retry,
      ...envConfig.retry,
      ...userConfig?.retry
    },
    cooldown: {
      ...DEFAULT_RISK_CONTROL_CONFIG.cooldown,
      ...envConfig.cooldown,
      ...userConfig?.cooldown
    },
    providerOverrides: {
      ...envConfig.providerOverrides,
      ...userConfig?.providerOverrides
    }
  };
}

/**
 * 获取指定 provider 的配置
 */
export function getProviderRiskControlConfig(
  providerKey: string,
  config: RiskControlConfig
): RiskControlConfig {
  const overrides = config.providerOverrides?.[providerKey];
  if (!overrides) {
    return config;
  }
  
  return {
    banErrorCodes: {
      ...config.banErrorCodes,
      ...overrides.banErrorCodes
    },
    retry: {
      ...config.retry,
      ...overrides.retry
    },
    cooldown: {
      ...config.cooldown,
      ...overrides.cooldown
    },
    providerOverrides: config.providerOverrides
  };
}

/**
 * 检查错误码是否应该触发封禁
 */
export function shouldBanByErrorCode(
  statusCode: number,
  config: RiskControlConfig
): boolean {
  if (!config.banErrorCodes.enabled) {
    return false;
  }
  
  return config.banErrorCodes.errorCodes.includes(statusCode);
}

/**
 * 计算冷却时间（基于错误类型和配置）
 */
export function computeCooldownMs(
  statusCode: number,
  consecutiveErrors: number,
  config: RiskControlConfig
): number {
  // 429 错误：使用阶梯退避策略
  if (statusCode === 429) {
    const schedule = config.cooldown.rateLimitSchedule;
    if (!Array.isArray(schedule) || schedule.length === 0) {
      return config.cooldown.defaultMs;
    }
    const index = Math.max(0, Math.min(consecutiveErrors - 1, schedule.length - 1));
    return schedule[index];
  }
  
  // 致命错误（403 等）：使用致命冷却时间
  if (shouldBanByErrorCode(statusCode, config)) {
    return config.cooldown.fatalMs;
  }
  
  // 其他错误：使用默认冷却时间
  return config.cooldown.defaultMs;
}

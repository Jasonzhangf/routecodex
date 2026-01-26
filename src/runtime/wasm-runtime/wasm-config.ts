/**
 * WASM 运行时配置与运行模式开关
 *
 * 责任边界：
 * - Host：开关读取、影子请求分发、指标上报
 * - Core（WASM/TS）：canonicalization、routing、tools、compat、diff 协议
 *
 * 开关优先级矩阵（高 → 低）：
 * - 全局（进程级）：ROUTECODEX_HUB_PIPELINE_IMPL
 * - 租户级：config.virtualRouter.*（暂未实现）
 * - 路由级：metadata.routeHint（暂未实现）
 * - 请求级：header X-RC-Pipeline-Impl（暂未实现）
 */

/**
 * HubPipeline 实现类型
 */
export type HubPipelineImpl = 'ts' | 'wasm';

/**
 * 运行模式
 */
export type HubPipelineMode =
  | 'ts_primary' // 主路 TS，无影子（默认）
  | 'wasm_primary' // 主路 WASM，无影子
  | 'shadow_ts' // 主路 TS，WASM 影子
  | 'shadow_wasm' // 主路 WASM，TS 影子
  | 'split'; // 比例分流（根据 ROUTECODEX_HUB_PIPELINE_SPLIT_RATIO）

/**
 * 运行模式配置
 */
export interface HubPipelineRuntimeConfig {
  /**
   * 运行模式
   */
  mode: HubPipelineMode;

  /**
   * 分流比例（仅 split 模式有效）
   * - 0.0 = 全部走 TS
   * - 1.0 = 全部走 WASM
   * - 0.5 = 50% TS / 50% WASM
   */
  splitRatio?: number;

  /**
   * 是否启用影子 diff 记录
   */
  enableShadowDiff?: boolean;

  /**
   * 影子失败是否回退到主路（false = 影子失败不影响主路）
   */
  shadowFallback?: boolean;
}

/**
 * 解析运行模式（从环境变量）
 */
export function resolveHubPipelineMode(): HubPipelineMode {
  const raw = String(process.env.ROUTECODEX_HUB_PIPELINE_IMPL || 'ts_primary').trim().toLowerCase();

  const validModes: HubPipelineMode[] = [
    'ts_primary',
    'wasm_primary',
    'shadow_ts',
    'shadow_wasm',
    'split'
  ];

  if (validModes.includes(raw as HubPipelineMode)) {
    return raw as HubPipelineMode;
  }

  // 兼容旧环境变量
  if (raw === 'ts') {
    return 'ts_primary';
  }
  if (raw === 'wasm' || raw === 'engine') {
    return 'wasm_primary';
  }
  if (raw === 'shadow') {
    return 'shadow_ts';
  }

  console.warn(`[wasm-config] Invalid ROUTECODEX_HUB_PIPELINE_IMPL: ${raw}, fallback to ts_primary`);
  return 'ts_primary';
}

/**
 * 解析分流比例
 */
export function resolveSplitRatio(): number {
  const raw = process.env.ROUTECODEX_HUB_PIPELINE_SPLIT_RATIO;
  if (!raw) {
    return 0.5; // 默认 50/50
  }

  const ratio = parseFloat(raw);
  if (isNaN(ratio) || ratio < 0 || ratio > 1) {
    console.warn(`[wasm-config] Invalid ROUTECODEX_HUB_PIPELINE_SPLIT_RATIO: ${raw}, fallback to 0.5`);
    return 0.5;
  }

  return ratio;
}

/**
 * 解析运行时配置
 */
export function resolveHubPipelineRuntimeConfig(): HubPipelineRuntimeConfig {
  const mode = resolveHubPipelineMode();
  const splitRatio = mode === 'split' ? resolveSplitRatio() : undefined;
  const enableShadowDiff = process.env.ROUTECODEX_HUB_PIPELINE_SHADOW_DIFF !== '0';
  const shadowFallback = process.env.ROUTECODEX_HUB_PIPELINE_SHADOW_FALLBACK !== '0';

  return {
    mode,
    splitRatio,
    enableShadowDiff,
    shadowFallback
  };
}

/**
 * 判断是否应该使用 WASM 作为主路
 */
export function shouldUseWasmPrimary(config: HubPipelineRuntimeConfig): boolean {
  if (config.mode === 'wasm_primary' || config.mode === 'shadow_wasm') {
    return true;
  }
  if (config.mode === 'split' && config.splitRatio !== undefined) {
    // 使用 requestId 的哈希值进行一致性分流
    return false; // 在请求分发时动态决定
  }
  return false;
}

/**
 * 判断是否应该运行影子管道
 */
export function shouldRunShadow(config: HubPipelineRuntimeConfig): boolean {
  return config.mode === 'shadow_ts' || config.mode === 'shadow_wasm';
}

/**
 * 获取影子管道的实现类型
 */
export function getShadowImpl(config: HubPipelineRuntimeConfig): HubPipelineImpl {
  if (config.mode === 'shadow_ts') {
    return 'wasm';
  }
  if (config.mode === 'shadow_wasm') {
    return 'ts';
  }
  return 'ts'; // 默认
}

/**
 * 根据分流比例决定使用哪种实现
 */
export function selectImplBySplitRatio(requestId: string, splitRatio: number): HubPipelineImpl {
  // 使用 requestId 的哈希值进行一致性分流
  const hash = simpleHash(requestId);
  const threshold = Math.floor(hash * 1000) / 1000;
  return threshold < splitRatio ? 'wasm' : 'ts';
}

/**
 * 简单哈希函数（用于一致性分流）
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) / Math.pow(2, 31); // Normalize to [0, 1]
}

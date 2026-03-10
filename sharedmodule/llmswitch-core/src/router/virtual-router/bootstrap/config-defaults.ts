import type {
  LoadBalancingPolicy,
  ProviderHealthConfig,
  VirtualRouterClassifierConfig,
  VirtualRouterContextRoutingConfig
} from '../types.js';

export const DEFAULT_CLASSIFIER: Required<VirtualRouterClassifierConfig> = {
  longContextThresholdTokens: 180000,
  thinkingKeywords: ['think step', 'analysis', 'reasoning', '仔细分析', '深度思考'],
  codingKeywords: ['apply_patch', 'write_file', 'create_file', 'shell', '修改文件', '写入文件'],
  backgroundKeywords: ['background', 'context dump', '上下文'],
  visionKeywords: ['vision', 'image', 'picture', 'photo']
};

export const DEFAULT_LOAD_BALANCING: LoadBalancingPolicy = { strategy: 'round-robin' };
export const DEFAULT_HEALTH: ProviderHealthConfig = { failureThreshold: 3, cooldownMs: 30_000, fatalCooldownMs: 300_000 };
export const DEFAULT_CONTEXT_ROUTING: VirtualRouterContextRoutingConfig = {
  warnRatio: 0.9,
  hardLimit: false
};

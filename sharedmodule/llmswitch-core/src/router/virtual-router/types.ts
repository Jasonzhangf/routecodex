/**
 * Virtual Router 类型定义
 */

import type { StandardizedRequest } from '../../conversion/hub/types/standardized.js';

export const DEFAULT_MODEL_CONTEXT_TOKENS = 200_000;

export const DEFAULT_ROUTE = 'default';
export const ROUTE_PRIORITY: string[] = [
  'multimodal',
  'vision',
  'longcontext',
  'web_search',
  'thinking',
  'coding',
  'search',
  'tools',
  'background',
  DEFAULT_ROUTE
];

export type RoutingInstructionMode = 'force' | 'sticky' | 'none';

export type RoutePoolMode = 'round-robin' | 'priority';

export interface RoutePoolLoadBalancingPolicy {
  /**
   * Optional pool-level override for provider selection strategy.
   * When omitted, Virtual Router falls back to the global loadBalancing.strategy.
   */
  strategy?: 'round-robin' | 'weighted' | 'sticky';
  /**
   * Optional pool-local weights. Keys may target runtime keys, provider.model groups, or provider ids.
   */
  weights?: Record<string, number>;
  responsesResume?: {
    previousRequestId?: string;
    restoredFromResponseId?: string;
    [key: string]: unknown;
  };
}

export interface RoutePoolTier {
  id: string;
  targets: string[];
  priority: number;
  /**
   * Pool-level routing mode:
   * - round-robin: force round-robin selection inside this pool (ignores global loadBalancing strategy)
   * - priority: always pick highest-priority key first, only fallback when unavailable
   */
  mode?: RoutePoolMode;
  backup?: boolean;
  /**
   * Optional force flag for this route pool.
   * Currently interpreted for:
   * - routing.vision: force dedicated vision backend handling.
   * - routing.web_search: force server-side web_search flow.
   */
  force?: boolean;
  /**
   * Optional pool-scoped load-balancing override. This lets different route pools
   * use different strategies/weights without mutating the global policy.
   */
  loadBalancing?: RoutePoolLoadBalancingPolicy;
}

export type RoutingPools = Record<string, RoutePoolTier[]>;

export type StreamingPreference = 'auto' | 'always' | 'never';

export interface ProviderAuthConfig {
  type: 'apiKey' | 'oauth';
  secretRef?: string;
  value?: string;
  tokenFile?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  authorizationUrl?: string;
  userInfoUrl?: string;
  refreshUrl?: string;
  oauthProviderId?: string;
  rawType?: string;
}

export interface DeepSeekCompatRuntimeOptions {
  strictToolRequired?: boolean;
  toolProtocol?: 'native' | 'text';
}

export interface ProviderProfile {
  providerKey: string;
  providerType: string;
  endpoint: string;
  auth: ProviderAuthConfig;
  enabled?: boolean;
  outboundProfile: string;
  compatibilityProfile?: string;
  runtimeKey?: string;
  modelId?: string;
  processMode?: 'chat' | 'passthrough';
  responsesConfig?: ResponsesProviderConfig;
  streaming?: StreamingPreference;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  deepseek?: DeepSeekCompatRuntimeOptions;
  /**
   * When true, this provider must be skipped for any request that
   * requires server-side tool orchestration (e.g. web_search).
   * Normal chat routing (without servertool injection) may still
   * use this provider as usual.
   */
  serverToolsDisabled?: boolean;
}

export interface ProviderRuntimeProfile {
  runtimeKey: string;
  providerId: string;
  keyAlias: string;
  providerType: string;
  endpoint: string;
  headers?: Record<string, string>;
  auth: ProviderAuthConfig;
  enabled?: boolean;
  outboundProfile: string;
  compatibilityProfile?: string;
  modelId?: string;
  processMode?: 'chat' | 'passthrough';
  responsesConfig?: ResponsesProviderConfig;
  streaming?: StreamingPreference;
  modelStreaming?: Record<string, StreamingPreference>;
  modelOutputTokens?: Record<string, number>;
  defaultOutputTokens?: number;
  modelContextTokens?: Record<string, number>;
  defaultContextTokens?: number;
  maxContextTokens?: number;
  deepseek?: DeepSeekCompatRuntimeOptions;
  /**
   * Provider-level flag propagated from virtualrouter.providers[*].
   * When true, VirtualRouterEngine will skip this runtime for any
   * request that declares serverToolRequired=true in routing metadata.
   */
  serverToolsDisabled?: boolean;
}

export interface VirtualRouterClassifierConfig {
  longContextThresholdTokens?: number;
  thinkingKeywords?: string[];
  codingKeywords?: string[];
  backgroundKeywords?: string[];
  visionKeywords?: string[];
}

export interface LoadBalancingPolicy {
  strategy: 'round-robin' | 'weighted' | 'sticky';
  weights?: Record<string, number>;
  /**
   * Alias-level selection strategy (provider auth aliases).
   *
   * Use this when a provider exposes multiple auth aliases for the same model, and the upstream
   * gateway behaves poorly when requests rapidly switch across keys (e.g. repeated 429 "no capacity"
   * despite quota). Strategies are applied inside VirtualRouter selection only; providers remain
   * transport-only.
   */
  aliasSelection?: AliasSelectionConfig;
  /**
   * AWRR: health-weighted selection.
   * - Deterministic (no randomness)
   * - Penalizes recently failing keys but never to zero
   * - Gradually recovers weights as time passes without errors
   */
  healthWeighted?: HealthWeightedLoadBalancingConfig;
  /**
   * Context-aware weighting (best-fit under safe window):
   * - Prefer smaller effective context windows early, to preserve larger windows for later.
   * - Uses ContextAdvisor's warnRatio to compute an "effective safe window" per model.
   * - Caps comparisons by client context (e.g. 200k).
   */
  contextWeighted?: ContextWeightedLoadBalancingConfig;
}

export interface HealthWeightedLoadBalancingConfig {
  /**
   * When false, health-weighted logic is disabled and the engine uses legacy behavior.
   * When true/undefined, the engine uses health-weighted behavior if quotaView provides error metadata.
   */
  enabled?: boolean;
  /**
   * Weight resolution. Higher values increase granularity but not semantics.
   */
  baseWeight?: number;
  /**
   * Lower bound for the health multiplier (0 < minMultiplier <= 1).
   * Example: 0.5 means a key's share won't be penalized below ~50% baseline within the same pool.
   */
  minMultiplier?: number;
  /**
   * Penalty slope. Larger beta penalizes errors more aggressively.
   */
  beta?: number;
  /**
   * Half-life for time-based recovery after the last error.
   */
  halfLifeMs?: number;
  /**
   * When true, a router-level retry attempt (excludedProviderKeys non-empty) prefers the healthiest candidate first.
   */
  recoverToBestOnRetry?: boolean;
}

export type AliasSelectionStrategy = 'none' | 'sticky-queue';

export interface AliasSelectionConfig {
  /**
   * Global on/off switch. When false, no alias-level selection is applied.
   */
  enabled?: boolean;
  /**
   * Default strategy used when a provider has no explicit override.
   */
  defaultStrategy?: AliasSelectionStrategy;
  /**
   * Per-provider overrides keyed by providerId (e.g. "antigravity").
   */
  providers?: Record<string, AliasSelectionStrategy>;
  /**
   * Antigravity session isolation cooldown window (ms).
   * Within this window, the same Antigravity auth alias must not be reused by a different session.
   * Default: 300000 (5 minutes).
   */
  sessionLeaseCooldownMs?: number;
  /**
   * Antigravity multi-alias session binding policy.
   * - "lease" (default): prefer the session's last used alias, but can rotate to another alias when needed.
   * - "strict": once a session binds to an alias, it will not switch to another alias; on failure it must
   *   fall back to other providers/routes rather than trying a different Antigravity alias.
   */
  antigravitySessionBinding?: 'lease' | 'strict';
}

export interface ContextWeightedLoadBalancingConfig {
  /**
   * When false, context-weighted logic is disabled.
   * When true/undefined, context-weighted logic applies within the same pool bucket,
   * and only for candidates that are considered "safe" by ContextAdvisor.
   */
  enabled?: boolean;
  /**
   * Client-side maximum usable context (tokens). Models above this are capped.
   * Example: 200000 for Codex/Claude Code style clients.
   */
  clientCapTokens?: number;
  /**
   * Exponent for the compensation ratio. Use 1 for proportional compensation.
   */
  gamma?: number;
  /**
   * Upper bound for the multiplier to avoid extreme skew.
   */
  maxMultiplier?: number;
}

export interface ProviderHealthConfig {
  failureThreshold: number;
  cooldownMs: number;
  fatalCooldownMs?: number;
}

export type VirtualRouterWebSearchExecutionMode = 'servertool' | 'direct';
export type VirtualRouterWebSearchDirectActivation = 'route' | 'builtin';

export interface VirtualRouterWebSearchEngineConfig {
  id: string;
  providerKey: string;
  description?: string;
  default?: boolean;
  /**
   * Search execution mode:
   * - servertool: expose canonical web_search tool and execute through servertool engine.
   * - direct: route to a search-capable model/provider directly; servertool injection must skip it.
   */
  executionMode?: VirtualRouterWebSearchExecutionMode;
  /**
   * When executionMode=direct, controls how the upstream search capability is activated.
   * - route: route selection itself enables native search behavior (e.g. deepseek-web search route).
   * - builtin: upstream requires a provider-native builtin search tool/schema.
   */
  directActivation?: VirtualRouterWebSearchDirectActivation;
  /**
   * Optional target model id for direct-mode matching when request/compat layers need to detect
   * which routed provider payload should receive native web search activation.
   */
  modelId?: string;
  /**
   * Optional builtin max-uses hint for providers that support builtin web search tools.
   */
  maxUses?: number;
  /**
   * When true, this engine will never be used by server-side tools
   * (e.g. web_search). It will also be omitted from injected tool
   * schemas so main models cannot select it for servertool flows.
   */
  serverToolsDisabled?: boolean;
}

export interface VirtualRouterWebSearchConfig {
  engines: VirtualRouterWebSearchEngineConfig[];
  injectPolicy?: 'always' | 'selective';
  /**
   * When true, always prefer server-side web_search orchestration
   * over upstream builtin behaviours (e.g. OpenAI Responses builtin web_search).
   */
  force?: boolean;
}

export interface VirtualRouterExecCommandGuardConfig {
  enabled: boolean;
  /**
   * Optional JSON policy file path for additional deny rules.
   * When enabled=true but policyFile is missing/empty/unreadable,
   * llmswitch-core will still apply baseline "must-deny" rules.
   */
  policyFile?: string;
}

export interface VirtualRouterClockConfig {
  enabled: boolean;
  /**
   * Task retention after dueAt (ms). Tasks older than (dueAt + retentionMs)
   * are eligible for cleanup.
   */
  retentionMs?: number;
  /**
   * "Due window" in ms. A task is considered due when now >= dueAt - dueWindowMs.
   */
  dueWindowMs?: number;
  /**
   * Daemon tick interval (ms). 0 disables background cleanup tick (still cleans on load).
   */
  tickMs?: number;
  /**
   * Allow clock hold flow for non-streaming (JSON) requests.
   * Default: true.
   */
  holdNonStreaming?: boolean;
  /**
   * Maximum time (ms) a request is allowed to hold waiting for due window.
   * Default: 60s.
   */
  holdMaxMs?: number;
}

export interface VirtualRouterConfig {
  routing: RoutingPools;
  providers: Record<string, ProviderProfile>;
  classifier: VirtualRouterClassifierConfig;
  loadBalancing?: LoadBalancingPolicy;
  health?: ProviderHealthConfig;
  contextRouting?: VirtualRouterContextRoutingConfig;
  webSearch?: VirtualRouterWebSearchConfig;
  execCommandGuard?: VirtualRouterExecCommandGuardConfig;
  clock?: VirtualRouterClockConfig;
}

export interface VirtualRouterContextRoutingConfig {
  warnRatio: number;
  hardLimit?: boolean;
}

export type VirtualRouterProviderDefinition = Record<string, unknown>;

export interface VirtualRouterBootstrapInput extends Record<string, unknown> {
  virtualrouter?: Record<string, unknown>;
  providers?: Record<string, VirtualRouterProviderDefinition>;
  routing?: Record<string, unknown>;
  classifier?: VirtualRouterClassifierConfig;
  loadBalancing?: LoadBalancingPolicy;
  health?: ProviderHealthConfig;
  contextRouting?: VirtualRouterContextRoutingConfig;
  webSearch?: VirtualRouterWebSearchConfig | Record<string, unknown>;
  execCommandGuard?: VirtualRouterExecCommandGuardConfig | Record<string, unknown>;
  clock?: VirtualRouterClockConfig | Record<string, unknown>;
}

export type ProviderRuntimeMap = Record<string, ProviderRuntimeProfile>;

export interface VirtualRouterBootstrapResult {
  config: VirtualRouterConfig;
  runtime: ProviderRuntimeMap;
  targetRuntime: Record<string, ProviderRuntimeProfile>;
  providers: Record<string, ProviderProfile>;
  routing: RoutingPools;
}

export interface RouterMetadataInput {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat' | 'passthrough';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol?: string;
  stage?: 'inbound' | 'outbound' | 'response';
  routeHint?: string;
  /**
   * Antigravity-Manager alignment: stable sessionId derived from the first user message text.
   * Used for Antigravity alias/session binding and thoughtSignature persistence.
   */
  antigravitySessionId?: string;
  /**
   * Indicates that current routing decision is for a request which
   * expects server-side tools orchestration (e.g. web_search).
   * Virtual Router should skip providers that opt out via
   * serverToolsDisabled when this flag is true.
   */
  serverToolRequired?: boolean;
  /**
   * 强制路由模式，从消息中的 <**...**> 指令解析得出
   */
  routingMode?: RoutingInstructionMode;
  /**
   * 当 disableStickyRoutes=true 时，本次请求仍使用 sticky session 状态，
   * 但不继承 sticky target，允许后续路由重新选择 provider。
   */
  disableStickyRoutes?: boolean;
  /**
   * 允许的 provider 白名单
   */
  allowedProviders?: string[];
  /**
   * 强制使用的 provider model (格式: provider.model)
   */
  forcedProviderModel?: string;
  /**
   * 强制使用的 provider keyAlias
   */
  forcedProviderKeyAlias?: string;
  /**
   * 强制使用的 provider keyIndex (从 1 开始)
   */
  forcedProviderKeyIndex?: number;
  /**
   * 禁用的 provider model 列表
   */
  disabledProviderModels?: string[];
  /**
   * 禁用的 provider keyAlias 列表
   */
  disabledProviderKeyAliases?: string[];
  /**
   * 禁用的 provider keyIndex 列表 (从 1 开始)
   */
  disabledProviderKeyIndexes?: number[];
  /**
   * 本次请求内需要临时排除的 providerKey 列表。
   * 与 disabledProviders/disabledKeys 不同，这些 key 仅对当前路由决策生效，
   * 不会写入或持久化到 RoutingInstructionState/sticky 存储中。
   */
  excludedProviderKeys?: string[];
  sessionId?: string;
  conversationId?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  responsesResume?: {
    previousRequestId?: string;
    restoredFromResponseId?: string;
    [key: string]: unknown;
  };
}

export interface RoutingFeatures {
  requestId: string;
  model: string;
  totalMessages: number;
  userTextSample: string;
  toolCount: number;
  hasTools: boolean;
  hasToolCallResponses: boolean;
  hasVisionTool: boolean;
  hasImageAttachment: boolean;
  hasVideoAttachment?: boolean;
  hasRemoteVideoAttachment?: boolean;
  hasLocalVideoAttachment?: boolean;
  hasWebTool: boolean;
  hasWebSearchToolDeclared?: boolean;
  hasCodingTool: boolean;
  hasThinkingKeyword: boolean;
  estimatedTokens: number;
  lastAssistantToolCategory?: 'read' | 'write' | 'search' | 'websearch' | 'other';
  lastAssistantToolSnippet?: string;
  lastAssistantToolLabel?: string;
  latestMessageFromUser?: boolean;
  metadata: RouterMetadataInput;
}

export interface ClassificationResult {
  routeName: string;
  confidence: number;
  reasoning: string;
  fallback: boolean;
  candidates?: string[];
}

export interface RoutingDecision {
  routeName: string;
  providerKey: string;
  confidence: number;
  reasoning: string;
  fallback: boolean;
  pool: string[];
  poolId?: string;
}

export interface TargetMetadata {
  providerKey: string;
  providerType: string;
  outboundProfile: string;
  compatibilityProfile?: string;
  runtimeKey?: string;
  modelId: string;
  processMode?: 'chat' | 'passthrough';
  responsesConfig?: ResponsesProviderConfig;
  streaming?: StreamingPreference;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  deepseek?: DeepSeekCompatRuntimeOptions;
  /**
   * Route-level flags propagated from the virtual router.
   * These are derived from routing pools and webSearch config and
   * are used by hub pipeline/process layers (web_search / vision).
   */
  forceWebSearch?: boolean;
  forceVision?: boolean;
}

export interface ResponsesProviderConfig {
  toolCallIdStyle?: 'fc' | 'preserve';
}

export enum VirtualRouterErrorCode {
  NO_STANDARDIZED_REQUEST = 'NO_STANDARDIZED_REQUEST',
  ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND',
  PROVIDER_NOT_AVAILABLE = 'PROVIDER_NOT_AVAILABLE',
  CONFIG_ERROR = 'CONFIG_ERROR'
}

export class VirtualRouterError extends Error {
  constructor(
    message: string,
    public readonly code: VirtualRouterErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VirtualRouterError';
  }
}

export interface RoutingDiagnostics {
  routeName: string;
  providerKey: string;
  reasoning: string;
  fallback: boolean;
  pool: string[];
  poolId?: string;
  confidence: number;
}

export interface StopMessageStateSnapshot {
  stopMessageText?: string;
  stopMessageMaxRepeats: number;
   /**
    * stopMessage 来源：
    * - 'explicit'：来自用户显式指令
    * - 'auto'：系统基于空响应/错误自动推导
    */
   stopMessageSource?: string;
  stopMessageUsed?: number;
  stopMessageUpdatedAt?: number;
  stopMessageLastUsedAt?: number;
  stopMessageStageMode?: 'on' | 'off' | 'auto';
  stopMessageAiMode?: 'on' | 'off';
  stopMessageAiSeedPrompt?: string;
  stopMessageAiHistory?: Array<Record<string, unknown>>;
}

export interface PreCommandStateSnapshot {
  preCommandScriptPath: string;
  preCommandSource?: string;
  preCommandUpdatedAt?: number;
}

export interface RoutingStatusSnapshot {
  routes: Record<
    string,
    {
      providers: string[];
      hits: number;
      lastUsedProvider?: string;
      lastHit?: {
        timestampMs: number;
        reason?: string;
        requestTokens?: number;
        selectionPenalty?: number;
        stopMessageActive: boolean;
        stopMessageMode?: 'on' | 'off' | 'auto';
        stopMessageRemaining?: number;
      };
    }
  >;
  health: ProviderHealthState[];
}

export interface ProviderHealthState {
  providerKey: string;
  state: 'healthy' | 'tripped';
  failureCount: number;
  cooldownExpiresAt?: number;
  reason?: string;
}

export interface ProviderFailureEvent {
  providerKey: string;
  routeName?: string;
  reason?: string;
  fatal?: boolean;
  statusCode?: number;
  errorCode?: string;
  retryable?: boolean;
  affectsHealth?: boolean;
  cooldownOverrideMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderErrorRuntimeMetadata {
  requestId: string;
  routeName?: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerProtocol?: string;
  pipelineId?: string;
  target?: TargetMetadata | Record<string, unknown>;
}

export interface ProviderErrorEvent {
  code: string;
  message: string;
  stage: string;
  status?: number;
  recoverable?: boolean;
  affectsHealth?: boolean;
  runtime: ProviderErrorRuntimeMetadata;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface ProviderSuccessRuntimeMetadata {
  requestId: string;
  routeName?: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerProtocol?: string;
  pipelineId?: string;
  target?: TargetMetadata | Record<string, unknown>;
}

export interface ProviderSuccessEvent {
  runtime: ProviderSuccessRuntimeMetadata;
  timestamp: number;
  /**
   * Optional request metadata snapshot (e.g. sessionId / conversationId).
   * This must not contain provider-specific payload semantics.
   */
  metadata?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface FeatureBuilder {
  build(request: StandardizedRequest, metadata: RouterMetadataInput): RoutingFeatures;
}

export interface ProviderCooldownState {
  providerKey: string;
  cooldownExpiresAt: number;
  reason?: string;
}

export interface VirtualRouterHealthSnapshot {
  providers: ProviderHealthState[];
  cooldowns: ProviderCooldownState[];
}

export interface VirtualRouterHealthStore {
  /**
   * 在 VirtualRouterEngine 初始化时提供上一次持久化的健康快照。
   * 调用方应仅返回仍在有效期内的 cooldown/熔断信息，或返回 null 表示无可恢复状态。
   */
  loadInitialSnapshot(): VirtualRouterHealthSnapshot | null;

  /**
   * 当 VirtualRouterEngine 更新 provider 健康状态或 cooldown 时，可选地持久化最新快照。
   * 实现应保证内部吞掉 I/O 错误，不影响路由主流程。
   */
  persistSnapshot?(snapshot: VirtualRouterHealthSnapshot): void;

  /**
   * 可选：记录原始 ProviderErrorEvent，便于后续离线统计与诊断。
   */
  recordProviderError?(event: ProviderErrorEvent): void;
}

export interface ProviderQuotaViewEntry {
  providerKey: string;
  inPool: boolean;
  reason?: string;
  priorityTier?: number;
  /**
   * Optional soft penalty hint for selection ordering.
   * - 0 / undefined means no penalty
   * - higher means less preferred (e.g. recent transient errors)
   *
   * This does NOT exclude the provider from the pool; exclusion is controlled by
   * inPool/cooldownUntil/blacklistUntil.
   */
  selectionPenalty?: number;
  /**
   * Optional per-providerKey timestamp of the last error. Used for time-decayed recovery.
   */
  lastErrorAtMs?: number | null;
  /**
   * Optional per-providerKey consecutive error count. Resets to 0 on success.
   */
  consecutiveErrorCount?: number;
  cooldownUntil?: number | null;
  blacklistUntil?: number | null;
}

export type ProviderQuotaView = (providerKey: string) => ProviderQuotaViewEntry | null;

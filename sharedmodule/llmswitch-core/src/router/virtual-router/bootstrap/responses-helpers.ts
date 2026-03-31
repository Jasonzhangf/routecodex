import {
  type AnthropicThinkingBudgetMap,
  type AnthropicThinkingConfig,
  type ModelCapability,
  type ResponsesProviderConfig,
  type StreamingPreference
} from '../types.js';
import { asRecord } from './utils.js';

// native-router-hotpath contract:
// normalized provider/model capability shape is consumed by Rust virtual router engine
// (router_hotpath_napi) during selection + pool eligibility evaluation.

/**
 * Normalize responses provider config.
 */
export function normalizeResponsesConfig(
  options: {
    providerId: string;
    providerType: string;
    compatibilityProfile: string;
    provider: Record<string, unknown>;
    node?: Record<string, unknown>;
  }
): ResponsesProviderConfig | undefined {
  const source = options.node ?? asRecord(options.provider.responses);
  const rawStyle =
    typeof source.toolCallIdStyle === 'string' ? source.toolCallIdStyle.trim().toLowerCase() : undefined;
  if (rawStyle === 'fc' || rawStyle === 'preserve') {
    return { toolCallIdStyle: rawStyle as 'fc' | 'preserve' };
  }
  const providerType = typeof options.providerType === 'string' ? options.providerType.trim().toLowerCase() : '';
  if (!providerType.includes('responses')) {
    return undefined;
  }
  const providerId = typeof options.providerId === 'string' ? options.providerId.trim().toLowerCase() : '';
  const compat = typeof options.compatibilityProfile === 'string' ? options.compatibilityProfile.trim().toLowerCase() : '';
  // Default tool-call id style:
  // - Standard OpenAI /v1/responses requires function_call ids to start with "fc_".
  // - LM Studio (OpenAI-compatible) often emits `call_*` ids and expects them to be preserved.
  const isLmstudio = providerId === 'lmstudio' || compat === 'chat:lmstudio';
  return { toolCallIdStyle: isLmstudio ? 'preserve' : 'fc' };
}

/**
 * Resolve provider-level streaming preference.
 */
export function resolveProviderStreamingPreference(
  provider: Record<string, unknown>,
  responsesNode?: Record<string, unknown>
): StreamingPreference | undefined {
  const configNode = asRecord(provider.config);
  const configResponses = configNode ? asRecord(configNode.responses) : undefined;
  return (
    coerceStreamingPreference(
      provider.streaming ?? provider.stream ?? provider.supportsStreaming ?? provider.streamingPreference
    ) ??
    coerceStreamingPreference(responsesNode?.streaming ?? responsesNode?.stream ?? responsesNode?.supportsStreaming) ??
    coerceStreamingPreference(configResponses?.streaming ?? configResponses?.stream)
  );
}

/**
 * Coerce various value types to StreamingPreference.
 */
function coerceStreamingPreference(value: unknown): StreamingPreference | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'always' || normalized === 'auto' || normalized === 'never') {
      return normalized;
    }
    if (normalized === 'true') {
      return 'always';
    }
    if (normalized === 'false') {
      return 'never';
    }
  }
  if (typeof value === 'boolean') {
    return value ? 'always' : 'never';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.mode !== undefined) {
      return coerceStreamingPreference(record.mode);
    }
    if (record.value !== undefined) {
      return coerceStreamingPreference(record.value);
    }
    if (record.enabled !== undefined) {
      return coerceStreamingPreference(record.enabled);
    }
  }
  return undefined;
}

export function normalizeModelCapabilities(
  provider: Record<string, unknown>
): Record<string, ModelCapability[]> | undefined {
  const models = provider.models;
  const result: Record<string, ModelCapability[]> = {};

  const pushCapabilities = (modelId: string, capabilities: unknown) => {
    if (!modelId || !Array.isArray(capabilities)) return;
    const validSet = new Set<ModelCapability>();
    for (const cap of capabilities) {
      const normalized = typeof cap === 'string' ? cap.trim().toLowerCase() : '';
      const mapped =
        normalized === 'multimodal' || normalized === 'vision'
          ? 'multimodal'
          : ['websearch', 'web-search', 'search'].includes(normalized)
            ? 'web_search'
            : normalized;
      if (['text', 'reasoning', 'multimodal', 'video', 'thinking', 'web_search'].includes(mapped)) {
        validSet.add(mapped as ModelCapability);
      }
    }
    const valid = Array.from(validSet);
    if (valid.length > 0) result[modelId] = valid;
  };

  if (Array.isArray(models)) {
    for (const model of models) {
      if (!model || typeof model !== 'object') {
        continue;
      }
      const modelObj = model as Record<string, unknown>;
      const modelId = typeof modelObj.id === 'string' ? modelObj.id.trim() : '';
      pushCapabilities(modelId, modelObj.capabilities);
    }
  } else if (models && typeof models === 'object') {
    const modelsNode = models as Record<string, unknown>;
    for (const [modelName, modelConfigRaw] of Object.entries(modelsNode)) {
      const modelId = typeof modelName === 'string' ? modelName.trim() : '';
      const modelConfig =
        typeof modelConfigRaw === 'object' && modelConfigRaw
          ? (modelConfigRaw as Record<string, unknown>)
          : {};
      pushCapabilities(modelId, modelConfig.capabilities);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export interface NormalizedAnthropicThinkingResult {
  modelAnthropicThinkingConfig?: Record<string, AnthropicThinkingConfig>;
  defaultAnthropicThinkingConfig?: AnthropicThinkingConfig;
  modelAnthropicThinking?: Record<string, string>;
  defaultAnthropicThinking?: string;
  modelAnthropicThinkingBudgets?: Record<string, AnthropicThinkingBudgetMap>;
  defaultAnthropicThinkingBudgets?: AnthropicThinkingBudgetMap;
}

export function normalizeAnthropicThinking(
  provider: Record<string, unknown>,
  providerType: string
): NormalizedAnthropicThinkingResult {
  if (providerType.trim().toLowerCase() !== 'anthropic') {
    return {};
  }
  const configNode = asRecord<Record<string, unknown>>(provider.config);
  const defaultsNode = asRecord<Record<string, unknown>>(configNode.userConfigDefaults);
  const modelAnthropicThinkingConfig: Record<string, AnthropicThinkingConfig> = {};
  const modelAnthropicThinking: Record<string, string> = {};
  const modelAnthropicThinkingBudgets: Record<string, AnthropicThinkingBudgetMap> = {};

  const addModelThinking = (modelId: string, modelRaw: unknown): void => {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId || !modelRaw || typeof modelRaw !== 'object') {
      return;
    }
    const configuredConfig = readAnthropicThinkingConfig(modelRaw as Record<string, unknown>);
    if (configuredConfig) {
      modelAnthropicThinkingConfig[normalizedModelId] = configuredConfig;
    }
    const configuredBudgets = readAnthropicThinkingBudgets(modelRaw as Record<string, unknown>);
    if (configuredBudgets) {
      modelAnthropicThinkingBudgets[normalizedModelId] = configuredBudgets;
    }
    const configured = readAnthropicThinkingLevel(modelRaw as Record<string, unknown>);
    if (configured) {
      modelAnthropicThinking[normalizedModelId] = configured;
    }
  };

  const modelsNode = provider.models;
  if (Array.isArray(modelsNode)) {
    for (const modelRaw of modelsNode) {
      if (!modelRaw || typeof modelRaw !== 'object') {
        continue;
      }
      const modelRecord = modelRaw as Record<string, unknown>;
      const modelId = typeof modelRecord.id === 'string' ? modelRecord.id : '';
      addModelThinking(modelId, modelRecord);
    }
  } else {
    for (const [modelId, modelRaw] of Object.entries(asRecord<Record<string, unknown>>(modelsNode))) {
      addModelThinking(modelId, modelRaw);
    }
  }

  const defaultAnthropicThinkingConfig =
    readAnthropicThinkingConfig(provider) ??
    readAnthropicThinkingConfig(configNode) ??
    readAnthropicThinkingConfig(defaultsNode);
  const defaultAnthropicThinking =
    readAnthropicThinkingLevel(provider) ??
    readAnthropicThinkingLevel(configNode) ??
    readAnthropicThinkingLevel(defaultsNode);
  const defaultAnthropicThinkingBudgets =
    readAnthropicThinkingBudgets(provider) ??
    readAnthropicThinkingBudgets(configNode) ??
    readAnthropicThinkingBudgets(defaultsNode);

  return {
    ...(Object.keys(modelAnthropicThinkingConfig).length ? { modelAnthropicThinkingConfig } : {}),
    ...(defaultAnthropicThinkingConfig ? { defaultAnthropicThinkingConfig } : {}),
    ...(Object.keys(modelAnthropicThinking).length ? { modelAnthropicThinking } : {}),
    ...(defaultAnthropicThinking ? { defaultAnthropicThinking } : {}),
    ...(Object.keys(modelAnthropicThinkingBudgets).length ? { modelAnthropicThinkingBudgets } : {}),
    ...(defaultAnthropicThinkingBudgets ? { defaultAnthropicThinkingBudgets } : {})
  };
}

function normalizeAnthropicThinkingMode(value: unknown): AnthropicThinkingConfig['mode'] | undefined {
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['off', 'none', 'disabled', 'false'].includes(normalized)) {
    return 'disabled';
  }
  if (normalized === 'enabled' || normalized === 'adaptive') {
    return normalized;
  }
  return undefined;
}

function normalizeAnthropicThinkingEffort(
  value: unknown
): AnthropicThinkingConfig['effort'] | undefined {
  if (typeof value === 'boolean') {
    return value ? 'medium' : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'minimal') {
    return 'low';
  }
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'max') {
    return normalized;
  }
  return undefined;
}

function normalizeAnthropicThinkingBudget(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const budget = Math.floor(value);
  if (budget <= 0) {
    return undefined;
  }
  return Math.max(1024, budget);
}

function normalizeAnthropicThinkingBudgetMap(value: unknown): AnthropicThinkingBudgetMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: AnthropicThinkingBudgetMap = {};
  for (const [key, raw] of Object.entries(record)) {
    const effort = normalizeAnthropicThinkingEffort(key);
    if (!effort) {
      continue;
    }
    const budget = normalizeAnthropicThinkingBudget(raw);
    if (budget !== undefined) {
      out[effort] = budget;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function readAnthropicThinkingBudgets(record?: Record<string, unknown>): AnthropicThinkingBudgetMap | undefined {
  if (!record) {
    return undefined;
  }
  const candidates = [
    record.anthropicThinkingBudgets,
    record.anthropic_thinking_budgets,
    record.thinkingBudgets,
    record.thinking_budgets,
    record.reasoningBudgets
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAnthropicThinkingBudgetMap(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeAnthropicThinkingConfigValue(value: unknown): AnthropicThinkingConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value ? { mode: 'enabled', effort: 'medium' } : { mode: 'disabled' };
  }
  if (typeof value === 'string') {
    const mode = normalizeAnthropicThinkingMode(value);
    const effort = normalizeAnthropicThinkingEffort(value);
    if (mode || effort) {
      return {
        ...(mode ? { mode } : {}),
        ...(effort ? { effort } : {})
      };
    }
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const node = value as Record<string, unknown>;
  const mode =
    normalizeAnthropicThinkingMode(node.mode) ??
    normalizeAnthropicThinkingMode(node.type) ??
    normalizeAnthropicThinkingMode(node.enabled);
  const effort =
    normalizeAnthropicThinkingEffort(node.effort) ??
    normalizeAnthropicThinkingEffort(node.level);
  const budgetTokens =
    normalizeAnthropicThinkingBudget(node.budgetTokens) ??
    normalizeAnthropicThinkingBudget(node.budget_tokens) ??
    normalizeAnthropicThinkingBudget(node.budget);
  if (!mode && !effort && budgetTokens === undefined) {
    return undefined;
  }
  return {
    ...(mode ? { mode } : {}),
    ...(effort ? { effort } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {})
  };
}

function readAnthropicThinkingConfig(record?: Record<string, unknown>): AnthropicThinkingConfig | undefined {
  if (!record) {
    return undefined;
  }
  const directCandidates = [
    record.anthropicThinkingConfig,
    record.anthropic_thinking_config,
    record.anthropicThinking,
    record.anthropic_thinking,
    record.reasoning,
    record.thinking
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeAnthropicThinkingConfigValue(candidate);
    if (normalized) {
      return normalized;
    }
  }
  const outputConfig = asRecord<Record<string, unknown>>(record.output_config ?? record.outputConfig);
  const normalizedOutput = normalizeAnthropicThinkingConfigValue({
    effort: outputConfig.effort
  });
  if (normalizedOutput) {
    return normalizedOutput;
  }
  return undefined;
}

function readAnthropicThinkingLevel(record?: Record<string, unknown>): string | undefined {
  const config = readAnthropicThinkingConfig(record);
  if (!config) {
    return undefined;
  }
  if (config.effort) {
    return config.effort;
  }
  if (config.mode) {
    return config.mode;
  }
  return undefined;
}

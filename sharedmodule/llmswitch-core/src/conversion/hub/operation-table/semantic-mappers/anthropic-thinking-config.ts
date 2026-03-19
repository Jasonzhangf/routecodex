import type { AdapterContext } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';

export interface AnthropicThinkingConfig {
  mode?: 'disabled' | 'enabled' | 'adaptive';
  budgetTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

type AnthropicThinkingEffort = 'low' | 'medium' | 'high' | 'max';
type AnthropicThinkingBudgetMap = Partial<Record<AnthropicThinkingEffort, number>>;

function normalizeAnthropicThinkingBudget(value: number): number {
  const budget = Math.max(0, Math.floor(value));
  if (budget <= 0) {
    return 0;
  }
  return Math.max(1024, budget);
}

function normalizeAnthropicThinkingMode(value: unknown): AnthropicThinkingConfig['mode'] | undefined {
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) {
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

function normalizeAnthropicEffort(value: unknown): AnthropicThinkingConfig['effort'] | undefined {
  if (typeof value === 'boolean') {
    return value ? 'medium' : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) {
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

export function normalizeAnthropicThinkingConfigFromUnknown(
  value: unknown,
  options?: { effortDefaultsToAdaptive?: boolean }
): AnthropicThinkingConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value ? { mode: 'enabled', budgetTokens: 1024 } : { mode: 'disabled' };
  }
  if (typeof value === 'string') {
    const mode = normalizeAnthropicThinkingMode(value);
    const effort = normalizeAnthropicEffort(value);
    if (!mode && !effort) {
      return undefined;
    }
    return {
      ...(mode ? { mode } : {}),
      ...(!mode && effort && options?.effortDefaultsToAdaptive ? { mode: 'adaptive' as const } : {}),
      ...(effort ? { effort } : {})
    };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const budget = normalizeAnthropicThinkingBudget(value);
    return budget > 0 ? { mode: 'enabled', budgetTokens: budget } : { mode: 'disabled' };
  }
  if (!isJsonObject(value as JsonValue)) {
    return undefined;
  }
  const node = value as Record<string, unknown>;
  const mode =
    normalizeAnthropicThinkingMode(node.mode) ??
    normalizeAnthropicThinkingMode(node.type) ??
    normalizeAnthropicThinkingMode(node.enabled);
  const effort =
    normalizeAnthropicEffort(node.effort) ??
    normalizeAnthropicEffort(node.level);
  const budgetTokens =
    typeof node.budgetTokens === 'number'
      ? normalizeAnthropicThinkingBudget(node.budgetTokens)
      : typeof node.budget_tokens === 'number'
        ? normalizeAnthropicThinkingBudget(node.budget_tokens)
        : typeof node.budget === 'number'
          ? normalizeAnthropicThinkingBudget(node.budget)
          : typeof node.max_tokens === 'number'
            ? normalizeAnthropicThinkingBudget(node.max_tokens)
            : undefined;
  if (!mode && !effort && budgetTokens === undefined) {
    return undefined;
  }
  return {
    ...(mode ? { mode } : {}),
    ...(!mode && effort && options?.effortDefaultsToAdaptive ? { mode: 'adaptive' as const } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(effort ? { effort } : {})
  };
}

export function mergeAnthropicThinkingConfig(
  base: AnthropicThinkingConfig | undefined,
  override: AnthropicThinkingConfig | undefined
): AnthropicThinkingConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {})
  };
}

function normalizeAnthropicBudgetValue(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return normalizeAnthropicThinkingBudget(parsed);
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return normalizeAnthropicThinkingBudget(value);
}

function normalizeAnthropicThinkingBudgetMap(value: unknown): AnthropicThinkingBudgetMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: AnthropicThinkingBudgetMap = {};
  for (const [key, raw] of Object.entries(record)) {
    const effort = normalizeAnthropicEffort(key) as AnthropicThinkingEffort | undefined;
    if (!effort) {
      continue;
    }
    const budget = normalizeAnthropicBudgetValue(raw);
    if (budget !== undefined) {
      out[effort] = budget;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function resolveConfiguredAnthropicThinkingBudgets(ctx: AdapterContext | undefined): AnthropicThinkingBudgetMap | undefined {
  if (!ctx || typeof ctx !== 'object') {
    return undefined;
  }
  const raw = (ctx as Record<string, unknown>).anthropicThinkingBudgets;
  return normalizeAnthropicThinkingBudgetMap(raw);
}

export function applyEffortBudget(
  config: AnthropicThinkingConfig | undefined,
  budgets: AnthropicThinkingBudgetMap | undefined
): AnthropicThinkingConfig | undefined {
  if (!config || !budgets) {
    return config;
  }
  if (config.mode === 'disabled' || config.budgetTokens !== undefined) {
    return config;
  }
  const effort = config.effort;
  if (!effort) {
    return config;
  }
  const budget = budgets[effort];
  if (budget === undefined) {
    return config;
  }
  const next: AnthropicThinkingConfig = { ...config, budgetTokens: budget };
  if (!next.mode || next.mode === 'adaptive') {
    next.mode = 'enabled';
  }
  return next;
}

export function buildAnthropicThinkingFromConfig(config: AnthropicThinkingConfig | undefined): JsonObject | undefined {
  if (!config) {
    return undefined;
  }
  const mode = config.mode;
  if (mode === 'disabled') {
    return { type: 'disabled' };
  }
  if (mode === 'adaptive') {
    return { type: 'adaptive' };
  }
  if (mode === 'enabled') {
    return {
      type: 'enabled',
      budget_tokens: normalizeAnthropicThinkingBudget(config.budgetTokens ?? 1024)
    };
  }
  if (config.budgetTokens !== undefined) {
    return {
      type: 'enabled',
      budget_tokens: normalizeAnthropicThinkingBudget(config.budgetTokens)
    };
  }
  return undefined;
}

export function mergeAnthropicOutputConfig(
  existing: JsonValue | undefined,
  effort: 'low' | 'medium' | 'high' | 'max' | undefined
): JsonObject | undefined {
  const base = isJsonObject(existing) ? (jsonClone(existing) as JsonObject) : {};
  if (effort) {
    base.effort = effort;
  }
  return Object.keys(base).length ? base : undefined;
}

export function resolveConfiguredAnthropicThinkingConfig(ctx: AdapterContext | undefined): AnthropicThinkingConfig | undefined {
  if (!ctx || typeof ctx !== 'object') {
    return undefined;
  }
  const config = normalizeAnthropicThinkingConfigFromUnknown(
    (ctx as Record<string, unknown>).anthropicThinkingConfig
  );
  if (config) {
    return config;
  }
  const candidates = [
    (ctx as Record<string, unknown>).anthropicThinking,
    (ctx as Record<string, unknown>).reasoningEffort,
    (ctx as Record<string, unknown>).reasoning_effort
  ];
  for (const candidate of candidates) {
    const legacy = normalizeAnthropicThinkingConfigFromUnknown(candidate, {
      effortDefaultsToAdaptive: true
    });
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

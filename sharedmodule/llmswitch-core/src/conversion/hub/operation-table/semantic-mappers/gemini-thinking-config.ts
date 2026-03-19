import { isJsonObject, type JsonObject, type JsonValue } from '../../types/json.js';
import {
  GEMINI_FLASH_DEFAULT_THINKING_BUDGET,
  type GeminiPayload
} from './gemini-antigravity-request.js';

export const GENERATION_CONFIG_KEYS: Array<{ source: string; target: string }> = [
  { source: 'temperature', target: 'temperature' },
  { source: 'topP', target: 'top_p' },
  { source: 'topK', target: 'top_k' },
  { source: 'maxOutputTokens', target: 'max_output_tokens' },
  { source: 'candidateCount', target: 'candidate_count' },
  { source: 'responseMimeType', target: 'response_mime_type' },
  { source: 'stopSequences', target: 'stop_sequences' }
];

export function buildGenerationConfigFromParameters(parameters: JsonObject): JsonObject {
  const config: JsonObject = {};
  for (const { source, target } of GENERATION_CONFIG_KEYS) {
    const value = parameters[target] ?? (target === 'max_output_tokens' ? parameters.max_tokens : undefined);
    if (value !== undefined) {
      config[source] = value as JsonValue;
    }
  }
  const reasoningRaw = parameters.reasoning;
  const applyThinkingDisabled = (): void => {
    config.thinkingConfig = {
      includeThoughts: false,
      thinkingBudget: 0
    } as JsonObject;
  };
  const applyThinkingEnabled = (budget?: number): void => {
    const next: JsonObject = {
      includeThoughts: true
    };
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
      next.thinkingBudget = Math.floor(budget) as unknown as JsonValue;
    }
    config.thinkingConfig = next;
  };
  if (typeof reasoningRaw === 'boolean') {
    if (reasoningRaw) {
      applyThinkingEnabled();
    } else {
      applyThinkingDisabled();
    }
  } else if (typeof reasoningRaw === 'string') {
    const normalized = reasoningRaw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'none' || normalized === 'disabled' || normalized === 'false') {
      applyThinkingDisabled();
    } else if (normalized.length) {
      const effortBudget: Record<string, number> = {
        minimal: 1024,
        low: 1024,
        medium: 4096,
        high: 8192
      };
      applyThinkingEnabled(effortBudget[normalized]);
    }
  } else if (typeof reasoningRaw === 'number' && Number.isFinite(reasoningRaw)) {
    if (reasoningRaw <= 0) {
      applyThinkingDisabled();
    } else {
      applyThinkingEnabled(reasoningRaw);
    }
  } else if (isJsonObject(reasoningRaw as JsonValue)) {
    const node = reasoningRaw as Record<string, unknown>;
    const enabled = node.enabled;
    if (enabled === false) {
      applyThinkingDisabled();
    } else {
      const effort =
        typeof node.effort === 'string'
          ? node.effort.trim().toLowerCase()
          : typeof node.level === 'string'
            ? node.level.trim().toLowerCase()
            : '';
      const budget =
        typeof node.budget_tokens === 'number'
          ? node.budget_tokens
          : typeof node.budget === 'number'
            ? node.budget
            : typeof node.max_tokens === 'number'
              ? node.max_tokens
              : undefined;
      if (typeof budget === 'number' && Number.isFinite(budget)) {
        if (budget <= 0) {
          applyThinkingDisabled();
        } else {
          applyThinkingEnabled(budget);
        }
      } else if (effort === 'off' || effort === 'none' || effort === 'disabled') {
        applyThinkingDisabled();
      } else if (effort.length) {
        const effortBudget: Record<string, number> = {
          minimal: 1024,
          low: 1024,
          medium: 4096,
          high: 8192
        };
        applyThinkingEnabled(effortBudget[effort]);
      } else if (enabled === true) {
        applyThinkingEnabled();
      }
    }
  }
  return config;
}

export function applyAntigravityThinkingConfig(requestPayload: GeminiPayload, mappedLower: string): void {
  const isFlashModel = mappedLower.includes('flash');
  const isFlash3Model = mappedLower.includes('gemini-3') && isFlashModel;
  const isImageModel = requestPayload.requestType === 'image_gen' || mappedLower.includes('image');
  const isThinkingModel = !isImageModel && (mappedLower.includes('think') || mappedLower.includes('pro') || isFlash3Model);

  if (isThinkingModel && (!requestPayload.generationConfig || !isJsonObject(requestPayload.generationConfig as JsonValue))) {
    requestPayload.generationConfig = {};
  }
  const generationConfig = requestPayload.generationConfig;

  if (isFlashModel && isJsonObject(generationConfig as JsonValue)) {
    const gc = generationConfig as JsonObject;
    const thinkingConfigRaw = (gc as { thinkingConfig?: JsonValue }).thinkingConfig as JsonValue;
    const thinkingConfig = isJsonObject(thinkingConfigRaw) ? (thinkingConfigRaw as JsonObject) : undefined;
    if (isFlash3Model && !thinkingConfig) {
      (gc as { thinkingConfig?: JsonObject }).thinkingConfig = {
        thinkingBudget: GEMINI_FLASH_DEFAULT_THINKING_BUDGET,
        includeThoughts: true
      };
    }

    const budgetRaw = thinkingConfig && (thinkingConfig as { thinkingBudget?: unknown }).thinkingBudget;
    const budget = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
    if (thinkingConfig && budget !== undefined && budget > GEMINI_FLASH_DEFAULT_THINKING_BUDGET) {
      (thinkingConfig as { thinkingBudget?: number }).thinkingBudget = GEMINI_FLASH_DEFAULT_THINKING_BUDGET;
      (gc as { thinkingConfig?: JsonObject }).thinkingConfig = thinkingConfig;
    }
  }

  if (isThinkingModel && isJsonObject(generationConfig as JsonValue)) {
    const gc = generationConfig as JsonObject;
    const thinkingConfig = isJsonObject((gc as { thinkingConfig?: JsonValue }).thinkingConfig as JsonValue)
      ? ((gc as { thinkingConfig?: JsonObject }).thinkingConfig as JsonObject)
      : {};
    const existingBudget = typeof (thinkingConfig as { thinkingBudget?: unknown }).thinkingBudget === 'number'
      ? ((thinkingConfig as { thinkingBudget?: number }).thinkingBudget as number)
      : undefined;
    const shouldApply = existingBudget !== undefined ? existingBudget !== 0 : true;
    if (shouldApply) {
      if (typeof (thinkingConfig as { thinkingBudget?: unknown }).thinkingBudget !== 'number') {
        (thinkingConfig as { thinkingBudget?: number }).thinkingBudget = 1024;
      }
      if (Object.prototype.hasOwnProperty.call(thinkingConfig, 'thinkingLevel')) {
        delete (thinkingConfig as { thinkingLevel?: unknown }).thinkingLevel;
      }
      (thinkingConfig as { includeThoughts?: boolean }).includeThoughts = true;
      const isClaude = mappedLower.includes('claude');
      if (isClaude) {
        const contentsArray = Array.isArray(requestPayload.contents) ? requestPayload.contents : [];
        const hasToolCalls = contentsArray.some((content) => {
          if (!isJsonObject(content as JsonValue)) return false;
          const parts = (content as { parts?: unknown }).parts;
          if (!Array.isArray(parts)) return false;
          return parts.some((part) => isJsonObject(part as JsonValue) &&
            ('functionCall' in (part as JsonObject) || 'function_call' in (part as JsonObject)));
        });
        if (hasToolCalls) {
          delete (gc as { thinkingConfig?: unknown }).thinkingConfig;
        } else {
          (gc as { thinkingConfig?: JsonObject }).thinkingConfig = thinkingConfig;
        }
      } else {
        (gc as { thinkingConfig?: JsonObject }).thinkingConfig = thinkingConfig;
      }
    }
  }
}

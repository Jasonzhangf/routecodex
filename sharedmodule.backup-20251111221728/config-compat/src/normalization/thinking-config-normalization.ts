/**
 * Thinking Configuration Normalization
 * Handles thinking configuration merging based on existing logic
 */

// import { ThinkingConfigMerge } from '../types/compatibility-types.js';

/**
 * Merge provider-level thinking config with model-level override
 * Extracted from existing UserConfigParser logic
 */
export function mergeThinkingConfig(
  providerThinking: any,
  modelOverride: any
): Record<string, any> | null {
  const norm = (v: any): Record<string, any> | null => {
    if (!v || typeof v !== 'object') {
      return null;
    }

    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return { ...v };
    }
  };

  const base = norm(providerThinking) || {};
  const over = norm(modelOverride) || null;

  // If no override and base is empty, return null
  if (!over && Object.keys(base).length === 0) {
    return null;
  }

  const result: Record<string, any> = { ...base };

  if (over) {
    // Override enabled flag if provided
    if (typeof over.enabled === 'boolean') {
      result.enabled = over.enabled;
    }

    // Override payload if provided
    if (over.payload && typeof over.payload === 'object') {
      result.payload = over.payload;
    }

    // Override models if provided
    if (over.models && typeof over.models === 'object') {
      result.models = over.models;
    }

    // Copy any additional properties
    for (const [key, value] of Object.entries(over)) {
      if (!['enabled', 'payload', 'models'].includes(key)) {
        result[key] = value;
      }
    }
  }

  // Provide minimal default payload if enabled and no payload given
  if (result.enabled && !result.payload) {
    result.payload = { type: 'enabled' };
  }

  return result;
}

/**
 * Extract thinking config from different configuration sources
 */
export function extractThinkingConfig(
  providerConfig: any,
  modelConfig: any,
  _compatibilityType?: string
): {
  providerThinking: any;
  modelThinking: any;
  legacyModelThinking: any;
} {
  let providerThinking: any = undefined;
  let modelThinking: any = undefined;
  let legacyModelThinking: any = undefined;

  // Extract provider-level thinking config
  if (providerConfig?.compatibility?.type === 'glm-compatibility') {
    providerThinking = providerConfig.compatibility.config?.thinking;
  }

  // Extract model-level thinking config from compatibility
  if (modelConfig?.compatibility?.type === 'glm-compatibility') {
    modelThinking = modelConfig.compatibility.config?.thinking;
  }

  // Extract legacy model-level thinking config (direct property)
  legacyModelThinking = modelConfig?.thinking;

  return {
    providerThinking,
    modelThinking,
    legacyModelThinking
  };
}

/**
 * Merge thinking configurations with GLM compatibility
 */
export function mergeGLMThinkingConfig(
  providerConfig: any,
  modelConfig: any,
  existingCompatibility?: any
): any {
  const { providerThinking, modelThinking, legacyModelThinking } = extractThinkingConfig(
    providerConfig,
    modelConfig,
    existingCompatibility?.type
  );

  // Merge thinking configs: model override takes precedence over provider
  const mergedThinking = mergeThinkingConfig(
    providerThinking,
    modelThinking || legacyModelThinking
  );

  if (mergedThinking) {
    // Create or update compatibility config with merged thinking
    const compatibility = existingCompatibility || {
      type: 'glm-compatibility',
      config: {}
    };

    compatibility.config = {
      ...(compatibility.config || {}),
      thinking: mergedThinking
    };

    return compatibility;
  }

  return existingCompatibility;
}

/**
 * Validate thinking configuration structure
 */
export function validateThinkingConfig(thinking: any): boolean {
  if (!thinking || typeof thinking !== 'object') {
    return false;
  }

  // Check if enabled is a boolean if provided
  if ('enabled' in thinking && typeof thinking.enabled !== 'boolean') {
    return false;
  }

  // Check payload structure if provided
  if (thinking.payload && typeof thinking.payload === 'object') {
    const payload = thinking.payload;
    if ('type' in payload && !['enabled', 'disabled', 'custom'].includes(payload.type)) {
      return false;
    }
  }

  // Check models structure if provided
  if (thinking.models && typeof thinking.models === 'object') {
    // Models can be any object structure, no specific validation needed
  }

  return true;
}

/**
 * Normalize thinking configuration to standard format
 */
export function normalizeThinkingConfig(thinking: any): any {
  if (!thinking) {
    return null;
  }

  const normalized: any = {};

  // Normalize enabled flag
  if (typeof thinking.enabled === 'boolean') {
    normalized.enabled = thinking.enabled;
  } else {
    // Default to enabled if not specified
    normalized.enabled = true;
  }

  // Normalize payload
  if (thinking.payload && typeof thinking.payload === 'object') {
    normalized.payload = { ...thinking.payload };
  } else if (normalized.enabled) {
    // Provide default payload if enabled
    normalized.payload = { type: 'enabled' };
  }

  // Copy models if present
  if (thinking.models && typeof thinking.models === 'object') {
    normalized.models = { ...thinking.models };
  }

  // Copy any additional properties
  for (const [key, value] of Object.entries(thinking)) {
    if (!['enabled', 'payload', 'models'].includes(key)) {
      normalized[key] = value;
    }
  }

  return normalized;
}

/**
 * Apply thinking configuration defaults
 */
export function applyThinkingDefaults(thinking: any): any {
  const defaults = {
    enabled: true,
    payload: {
      type: 'enabled'
    }
  };

  if (!thinking || typeof thinking !== 'object') {
    return defaults;
  }

  return {
    enabled: thinking.enabled ?? defaults.enabled,
    payload: thinking.payload ?? defaults.payload,
    models: thinking.models,
    ...thinking // Preserve any additional properties
  };
}
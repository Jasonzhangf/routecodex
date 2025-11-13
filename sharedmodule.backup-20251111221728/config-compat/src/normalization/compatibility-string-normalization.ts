/**
 * Compatibility String Normalization
 * Handles parsing of simple string format compatibility fields
 */

/**
 * Parse simple string format compatibility field
 * Supports formats like "iflow/qwen/lmstudio" or "passthrough"
 * Extracted from existing UserConfigParser logic
 */
export function parseCompatibilityString(compatString: string): {
  type: string;
  config: Record<string, any>;
} {
  if (!compatString || compatString.trim() === '' || compatString === 'passthrough') {
    return { type: 'passthrough-compatibility', config: {} };
  }

  const types = compatString.split('/').map(t => t.trim().toLowerCase());
  const primaryType = types[0];

  const typeMap: Record<string, string> = {
    lmstudio: 'lmstudio-compatibility',
    qwen: 'qwen-compatibility',
    iflow: 'iflow-compatibility',
    passthrough: 'passthrough-compatibility',
    'field-mapping': 'field-mapping',
    glm: 'glm-compatibility',
    'glm-compatibility': 'glm-compatibility',
    'openai-normalizer': 'openai-normalizer',
    'anthropic-openai-converter': 'anthropic-openai-converter'
  };

  const mappedType = typeMap[primaryType] || 'passthrough-compatibility';

  // For GLM compatibility, check for additional configuration in the string
  if (mappedType === 'glm-compatibility' && types.length > 1) {
    const config: Record<string, any> = {};

    // Parse additional options from the string
    for (let i = 1; i < types.length; i++) {
      const part = types[i];

      // Handle thinking configuration
      if (part.startsWith('thinking:')) {
        const thinkingValue = part.substring('thinking:'.length);
        if (thinkingValue === 'enabled' || thinkingValue === 'disabled') {
          config.thinking = {
            enabled: thinkingValue === 'enabled',
            payload: { type: thinkingValue }
          };
        }
      }

      // Handle tool configuration
      else if (part.startsWith('tools:')) {
        const toolsValue = part.substring('tools:'.length);
        config.tools = {
          enabled: toolsValue === 'enabled'
        };
      }

      // Handle model-specific configuration
      else if (part.includes(':')) {
        const [key, value] = part.split(':', 2);
        if (key && value) {
          config[key] = value;
        }
      }
    }

    return {
      type: mappedType,
      config
    };
  }

  return {
    type: mappedType,
    config: {}
  };
}

/**
 * Normalize compatibility type to standard format
 */
export function normalizeCompatibilityType(type: string): string {
  const normalized = type.toLowerCase();

  const typeMap: Record<string, string> = {
    'lmstudio': 'lmstudio-compatibility',
    'lmstudio-compatibility': 'lmstudio-compatibility',
    'qwen': 'qwen-compatibility',
    'qwen-compatibility': 'qwen-compatibility',
    'iflow': 'iflow-compatibility',
    'iflow-compatibility': 'iflow-compatibility',
    'passthrough': 'passthrough-compatibility',
    'passthrough-compatibility': 'passthrough-compatibility',
    'glm': 'glm-compatibility',
    'glm-compatibility': 'glm-compatibility',
    'field-mapping': 'field-mapping',
    'openai-normalizer': 'openai-normalizer',
    'anthropic-openai-converter': 'anthropic-openai-converter'
  };

  return typeMap[normalized] || type;
}

/**
 * Convert compatibility object to string representation
 */
export function compatibilityToString(compatibility: {
  type: string;
  config: Record<string, any>;
}): string {
  if (!compatibility || !compatibility.type) {
    return 'passthrough';
  }

  const type = compatibility.type.toLowerCase().replace('-compatibility', '');
  const parts = [type];

  // Add config options to the string
  if (compatibility.config && typeof compatibility.config === 'object') {
    const config = compatibility.config;

    // Add thinking configuration
    if (config.thinking && typeof config.thinking === 'object') {
      if (config.thinking.enabled === false) {
        parts.push('thinking:disabled');
      } else if (config.thinking.enabled !== undefined) {
        parts.push('thinking:enabled');
      }
    }

    // Add tools configuration
    if (config.tools && typeof config.tools === 'object') {
      if (config.tools.enabled === false) {
        parts.push('tools:disabled');
      } else if (config.tools.enabled !== undefined) {
        parts.push('tools:enabled');
      }
    }

    // Add other simple string configurations
    for (const [key, value] of Object.entries(config)) {
      if (key !== 'thinking' && key !== 'tools' && typeof value === 'string') {
        parts.push(`${key}:${value}`);
      }
    }
  }

  return parts.join('/');
}

/**
 * Merge compatibility configurations with precedence
 */
export function mergeCompatibilityConfigs(
  userConfig?: string,
  modelConfig?: { type?: string; config?: Record<string, any> },
  providerConfig?: { type?: string; config?: Record<string, any> }
): { type: string; config: Record<string, any> } | undefined {
  // Start with user config (highest precedence)
  let compatibility: { type: string; config: Record<string, any> } | undefined;

  if (userConfig && typeof userConfig === 'string') {
    compatibility = parseCompatibilityString(userConfig);
  }

  // Apply model-level compatibility
  if (modelConfig?.type) {
    if (!compatibility) {
      compatibility = {
        type: normalizeCompatibilityType(modelConfig.type),
        config: { ...(modelConfig.config || {}) }
      };
    } else {
      // Merge configs, model config overwrites base
      compatibility.config = {
        ...(compatibility.config || {}),
        ...(modelConfig.config || {})
      };
    }
  }

  // Apply provider-level compatibility (lowest precedence)
  if (providerConfig?.type) {
    if (!compatibility) {
      compatibility = {
        type: normalizeCompatibilityType(providerConfig.type),
        config: { ...(providerConfig.config || {}) }
      };
    } else {
      // Provider config only fills in missing values
      compatibility.config = {
        ...(providerConfig.config || {}),
        ...(compatibility.config || {})
      };
    }
  }

  return compatibility;
}

/**
 * Validate compatibility configuration
 */
export function validateCompatibilityConfig(compatibility: {
  type: string;
  config: Record<string, any>;
}): boolean {
  if (!compatibility || !compatibility.type) {
    return false;
  }

  // Validate type format
  const validTypes = [
    'lmstudio-compatibility',
    'qwen-compatibility',
    'iflow-compatibility',
    'passthrough-compatibility',
    'glm-compatibility',
    'field-mapping',
    'openai-normalizer',
    'anthropic-openai-converter'
  ];

  if (!validTypes.includes(compatibility.type)) {
    return false;
  }

  // Validate config structure if present
  if (compatibility.config && typeof compatibility.config === 'object') {
    // Basic validation - config can be any object structure
    // Additional type-specific validation could be added here
  }

  return true;
}
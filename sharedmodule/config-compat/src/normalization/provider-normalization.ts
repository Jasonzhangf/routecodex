/**
 * Provider Type Normalization
 * Handles provider type normalization and mapping based on existing logic
 */

// import { ProviderConfig } from 'routecodex-config-engine';
import { ProviderNormalizationRule } from '../types/compatibility-types.js';

/**
 * Provider type normalization rules extracted from existing UserConfigParser
 */
export const PROVIDER_NORMALIZATION_RULES: ProviderNormalizationRule[] = [
  // GLM provider always maps to glm-http-provider
  {
    inputPattern: 'glm',
    normalizedType: 'glm-http-provider',
    conditions: {
      providerId: 'glm'
    }
  },

  // LM Studio provider normalization
  {
    inputPattern: 'lmstudio',
    normalizedType: 'lmstudio-http',
    transformations: {
      baseURL: (url: string) => {
        // Apply environment variable overrides for LM Studio
        const envBase = process.env.LMSTUDIO_BASE_URL || process.env.LM_STUDIO_BASE_URL;
        if (envBase && typeof envBase === 'string' && envBase.trim()) {
          return envBase.trim();
        }
        return url;
      }
    }
  },

  // Qwen provider with OAuth -> qwen-provider
  {
    inputPattern: 'qwen',
    normalizedType: 'qwen-provider',
    conditions: {
      hasOAuth: true
    }
  },

  // Qwen provider without OAuth -> openai-provider
  {
    inputPattern: 'qwen',
    normalizedType: 'openai-provider',
    conditions: {
      hasOAuth: false
    }
  },

  // OpenAI provider normalization
  {
    inputPattern: 'openai',
    normalizedType: 'openai-provider'
  },

  // iFlow provider with OAuth -> iflow-provider
  {
    inputPattern: /^(iflow|iflow-http)$/,
    normalizedType: 'iflow-provider',
    conditions: {
      hasOAuth: true
    }
  },

  // iFlow provider without OAuth -> generic-http
  {
    inputPattern: /^(iflow|iflow-http)$/,
    normalizedType: 'generic-http',
    conditions: {
      hasOAuth: false
    }
  }
];

/**
 * Normalize provider type based on configuration and existing rules
 */
export function normalizeProviderType(
  providerId: string,
  rawType: string,
  providerConfig: any
): string {
  const normalizedInput = rawType.toLowerCase();
  const hasOAuth = Boolean(
    providerConfig?.oauth ||
    providerConfig?.auth?.oauth ||
    (providerConfig as any)?.auth?.oauth
  );

  // Heuristics first: detect GLM Coding Plan by providerId/baseUrl and force glm-http-provider
  try {
    const id = String(providerId || '').toLowerCase();
    const base = String(providerConfig?.baseURL || providerConfig?.baseUrl || '').toLowerCase();
    if (id.includes('glm') || /open\.bigmodel\.cn\/api\/coding\/paas/i.test(base)) {
      return 'glm-http-provider';
    }
  } catch { /* ignore heuristic errors */ }

  // Find matching rule
  for (const rule of PROVIDER_NORMALIZATION_RULES) {
    let matches = false;

    if (typeof rule.inputPattern === 'string') {
      matches = normalizedInput === rule.inputPattern;
    } else if (rule.inputPattern instanceof RegExp) {
      matches = rule.inputPattern.test(normalizedInput);
    }

    if (matches) {
      // Check conditions
      const conditions = rule.conditions || {};
      let conditionsMet = true;

      if (conditions.hasOAuth !== undefined) {
        conditionsMet = conditionsMet && (conditions.hasOAuth === hasOAuth);
      }

      if (conditions.providerId !== undefined) {
        conditionsMet = conditionsMet && (conditions.providerId === providerId);
      }

      if (conditionsMet) {
        return rule.normalizedType;
      }
    }
  }

  // No matching rule found, return original type
  return rawType;
}

/**
 * Apply provider-specific transformations
 */
export function applyProviderTransformations(
  _providerId: string,
  normalizedType: string,
  providerConfig: any
): any {
  const rule = PROVIDER_NORMALIZATION_RULES.find(r => r.normalizedType === normalizedType);

  if (!rule || !rule.transformations) {
    // Generic hardening: normalize baseURL for common third-party gateways
    const out = { ...providerConfig };
    try {
      const raw = String(out.baseURL || out.baseUrl || '');
      const url = raw.replace(/\/+$/, '');
      // GLM Coding Plan: ensure no trailing /v1 to hit /chat/completions directly
      if (/open\.bigmodel\.cn\/api\/coding\/paas/i.test(url)) {
        const hardened = url.replace(/\/?v1$/i, '');
        if (out.baseURL) out.baseURL = hardened;
        if (out.baseUrl) out.baseUrl = hardened;
      }
    } catch { /* ignore baseURL hardening errors */ }
    return out;
  }

  const transformed = { ...providerConfig };

  // Apply baseURL transformation
  if (rule.transformations.baseURL && transformed.baseURL) {
    transformed.baseURL = rule.transformations.baseURL(transformed.baseURL);
  }

  // Apply auth transformation
  if (rule.transformations.auth) {
    transformed.auth = rule.transformations.auth(transformed);
  }

  return transformed;
}

/**
 * Generate provider auth configuration based on normalized type
 */
export function generateProviderAuth(
  normalizedType: string,
  providerConfig: any,
  apiKey?: string
): any {
  // Check for explicit auth configuration
  const explicitAuth = providerConfig?.auth;
  const useExplicitApiKey = (
    ['openai-provider', 'lmstudio-http', 'glm-http-provider'].includes(normalizedType) &&
    explicitAuth &&
    typeof explicitAuth === 'object' &&
    typeof (explicitAuth as any).apiKey === 'string' &&
    String((explicitAuth as any).apiKey).trim().length > 0
  );

  if (useExplicitApiKey) {
    return { type: 'apikey', apiKey: String(explicitAuth.apiKey).trim() };
  }

  // Generate auth based on provider type
  switch (normalizedType) {
    case 'lmstudio-http':
      return { type: 'apikey', ...(apiKey ? { apiKey } : {}) };

    case 'openai-provider':
      return { type: 'bearer', ...(apiKey ? { apiKey } : {}) };

    case 'glm-http-provider':
      return { type: 'apikey', ...(apiKey ? { apiKey } : {}) };

    case 'qwen-provider':
    case 'iflow-provider':
      // These providers prefer OAuth
      const oauthCfg = providerConfig?.oauth || providerConfig?.auth?.oauth;
      if (oauthCfg && typeof oauthCfg === 'object') {
        const oc = (oauthCfg as any).default || oauthCfg;
        return {
          type: 'oauth',
          oauth: {
            clientId: oc.clientId,
            deviceCodeUrl: oc.deviceCodeUrl,
            tokenUrl: oc.tokenUrl,
            scopes: oc.scopes,
            tokenFile: oc.tokenFile,
          }
        };
      }
      return undefined;

    default:
      return undefined;
  }
}

/**
 * LLM Switch type normalization
 */
export function normalizeLLMSwitchType(type?: string): string | undefined {
  if (!type) {
    return undefined;
  }

  const normalized = type.toLowerCase();

  // Map legacy type names to standardized names
  const typeMap: Record<string, string> = {
    'openai-normalizer': 'llmswitch-openai-openai',
    'llm-switch-openai-openai': 'llmswitch-openai-openai',
    'anthropic-openai-converter': 'llmswitch-anthropic-openai',
    'llm-switch-anthropic-openai': 'llmswitch-anthropic-openai'
  };

  return typeMap[normalized] || type;
}

/**
 * Get default LLM switch type based on input protocol
 */
export function getDefaultLLMSwitchType(inputProtocol: string): string {
  const normalizedProtocol = inputProtocol.toLowerCase();
  return normalizedProtocol === 'anthropic'
    ? 'llmswitch-anthropic-openai'
    : 'llmswitch-openai-openai';
}

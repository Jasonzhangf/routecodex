/**
 * Provider normalization logic for Virtual Router bootstrap.
 * Extracted from bootstrap.ts to improve modularity and testability.
 */
import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderAuthConfig,
  type ProviderRuntimeProfile,
  type DeepSeekCompatRuntimeOptions,
  type ResponsesProviderConfig,
  type ModelCapability
} from '../types.js';
import {
  CLAUDE_CODE_DEFAULT_USER_AGENT,
  CLAUDE_CODE_DEFAULT_X_APP,
  CLAUDE_CODE_DEFAULT_ANTHROPIC_BETA,
  parseClaudeCodeAppVersionFromUserAgent
} from './claude-code-helpers.js';
import { normalizeResponsesConfig, resolveProviderStreamingPreference } from './responses-helpers.js';
import { normalizeModelStreaming, normalizeModelContextTokens, normalizeModelOutputTokens } from './streaming-helpers.js';

const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS = 8192;

export interface ProviderAuthEntry {
  keyAlias: string;
  auth: ProviderAuthConfig;
}

export interface NormalizedProvider {
  providerId: string;
  providerType: string;
  endpoint: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  outboundProfile: string;
  compatibilityProfile: string;
  processMode: 'chat' | 'passthrough';
  responsesConfig?: ResponsesProviderConfig;
  streaming?: 'always' | 'auto' | 'never';
  modelStreaming?: Record<string, 'always' | 'auto' | 'never'>;
  modelOutputTokens?: Record<string, number>;
  defaultOutputTokens?: number;
  modelContextTokens?: Record<string, number>;
  defaultContextTokens?: number;
  deepseek?: DeepSeekCompatRuntimeOptions;
  serverToolsDisabled?: boolean;
  modelCapabilities?: Record<string, ModelCapability[]>;
}

export interface ProviderRuntimeBuildResult {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, { declared: boolean; models: string[] }>;
}

/**
 * Normalize a raw provider configuration into a NormalizedProvider.
 */
export function normalizeProvider(providerId: string, raw: unknown): NormalizedProvider {
  const provider = asRecord(raw);
  const enabled =
    typeof provider.enabled === 'boolean'
      ? provider.enabled
      : typeof provider.enabled === 'string'
        ? provider.enabled.trim().toLowerCase() !== 'false'
        : undefined;
  const providerType = detectProviderType(provider);
  const endpoint =
    typeof provider.endpoint === 'string' && provider.endpoint.trim()
      ? provider.endpoint.trim()
      : typeof provider.baseURL === 'string' && provider.baseURL.trim()
        ? provider.baseURL.trim()
        : typeof provider.baseUrl === 'string' && provider.baseUrl.trim()
          ? provider.baseUrl.trim()
          : '';
  const compatibilityProfile = resolveCompatibilityProfile(providerId, provider);
  const headers = maybeInjectClaudeCodeHeaders(
    providerId,
    providerType,
    compatibilityProfile,
    normalizeHeaders(provider.headers)
  );
  const responsesNode = asRecord(provider.responses);
  const responsesConfig = normalizeResponsesConfig({
    providerId,
    providerType,
    compatibilityProfile,
    provider,
    node: responsesNode
  });
  const processMode = normalizeProcessMode(provider.process);
  const streaming = resolveProviderStreamingPreference(provider, responsesNode);
  const modelStreaming = normalizeModelStreaming(provider);
  const { modelContextTokens, defaultContextTokens } = normalizeModelContextTokens(provider);
  const { modelOutputTokens, defaultOutputTokens: explicitDefaultOutputTokens } = normalizeModelOutputTokens(provider);
  const defaultOutputTokens =
    explicitDefaultOutputTokens ??
    (processMode === 'passthrough' ? undefined : DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS);
  const deepseek = normalizeDeepSeekOptions(provider);
  const serverToolsDisabled =
    provider.serverToolsDisabled === true ||
    (typeof provider.serverToolsDisabled === 'string' &&
      provider.serverToolsDisabled.trim().toLowerCase() === 'true') ||
    (provider.serverTools &&
      typeof provider.serverTools === 'object' &&
      (provider.serverTools as Record<string, unknown>).enabled === false);
  const modelCapabilities = normalizeModelCapabilities(provider);
  return {
    providerId,
    providerType,
    endpoint,
    headers,
    ...(enabled !== undefined ? { enabled } : {}),
    outboundProfile: mapOutboundProfile(providerType),
    compatibilityProfile,
    processMode,
    responsesConfig,
    streaming,
    modelStreaming,
    modelOutputTokens,
    defaultOutputTokens,
    modelContextTokens,
    defaultContextTokens,
    ...(deepseek ? { deepseek } : {}),
    ...(serverToolsDisabled ? { serverToolsDisabled: true } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {})
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const lowered = name.trim().toLowerCase();
  if (!lowered) {
    return false;
  }
  for (const key of Object.keys(headers)) {
    if (key.trim().toLowerCase() === lowered) {
      const value = headers[key];
      if (typeof value === 'string' && value.trim()) {
        return true;
      }
    }
  }
  return false;
}

function maybeInjectClaudeCodeHeaders(
  _providerId: string,
  providerType: string,
  compatibilityProfile: string,
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  const profile = typeof compatibilityProfile === 'string' ? compatibilityProfile.trim().toLowerCase() : '';
  if (!profile || (profile !== 'anthropic:claude-code' && profile !== 'chat:claude-code')) {
    return headers;
  }
  if (!String(providerType).toLowerCase().includes('anthropic')) {
    return headers;
  }
  const base: Record<string, string> = { ...(headers ?? {}) };
  if (!hasHeader(base, 'User-Agent')) {
    base['User-Agent'] = CLAUDE_CODE_DEFAULT_USER_AGENT;
  }
  if (!hasHeader(base, 'X-App')) {
    base['X-App'] = CLAUDE_CODE_DEFAULT_X_APP;
  }
  if (!hasHeader(base, 'X-App-Version')) {
    const version = parseClaudeCodeAppVersionFromUserAgent(base['User-Agent'] ?? '');
    if (version) {
      base['X-App-Version'] = version;
    }
  }
  if (!hasHeader(base, 'anthropic-beta')) {
    base['anthropic-beta'] = CLAUDE_CODE_DEFAULT_ANTHROPIC_BETA;
  }
  return base;
}

function normalizeDeepSeekOptions(
  provider: Record<string, unknown>
): DeepSeekCompatRuntimeOptions | undefined {
  const direct = asRecord(provider.deepseek);
  const ext = asRecord(asRecord(provider.extensions)?.deepseek);
  const source = Object.keys(direct).length ? direct : ext;
  if (!source || !Object.keys(source).length) {
    return undefined;
  }
  const strictToolRequired =
    typeof source.strictToolRequired === 'boolean'
      ? source.strictToolRequired
      : typeof source.strictToolRequired === 'string'
        ? source.strictToolRequired.trim().toLowerCase() === 'true'
        : undefined;
  const toolProtocolRaw =
    typeof source.toolProtocol === 'string' ? source.toolProtocol.trim().toLowerCase() : '';
  let toolProtocol: DeepSeekCompatRuntimeOptions['toolProtocol'];
  if (toolProtocolRaw === 'text' || toolProtocolRaw === 'native') {
    toolProtocol = toolProtocolRaw;
  }
  const legacyTextToolFallback =
    typeof source.textToolFallback === 'boolean'
      ? source.textToolFallback
      : typeof source.textToolFallback === 'string'
        ? source.textToolFallback.trim().toLowerCase() === 'true'
        : undefined;
  if (toolProtocol === undefined && legacyTextToolFallback !== undefined) {
    toolProtocol = legacyTextToolFallback ? 'text' : 'native';
  }
  if (strictToolRequired === undefined && toolProtocol === undefined) {
    return undefined;
  }
  return {
    ...(strictToolRequired !== undefined ? { strictToolRequired } : {}),
    ...(toolProtocol !== undefined ? { toolProtocol } : {})
  };
}

function resolveCompatibilityProfile(providerId: string, provider: Record<string, unknown>): string {
  if (typeof provider.compatibilityProfile === 'string' && provider.compatibilityProfile.trim()) {
    return provider.compatibilityProfile.trim();
  }
  const legacyFields: string[] = [];
  if (typeof provider.compat === 'string') {
    legacyFields.push('compat');
  }
  if (typeof provider.compatibility_profile === 'string') {
    legacyFields.push('compatibility_profile');
  }
  if (legacyFields.length > 0) {
    throw new VirtualRouterError(
      `Provider "${providerId}" uses legacy compatibility field(s): ${legacyFields.join(
        ', '
      )}. Rename to "compatibilityProfile".`,
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  const normalizedId = providerId.trim().toLowerCase();
  const providerType = String(provider.providerType ?? provider.type ?? provider.protocol ?? '').toLowerCase();
  if (
    normalizedId === 'antigravity' ||
    normalizedId === 'gemini-cli' ||
    providerType.includes('antigravity') ||
    providerType.includes('gemini-cli')
  ) {
    return 'chat:gemini-cli';
  }
  return 'compat:passthrough';
}

function normalizeProcessMode(value: unknown): 'chat' | 'passthrough' {
  if (typeof value !== 'string') {
    return 'chat';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'passthrough') {
    return 'passthrough';
  }
  return 'chat';
}

export function detectProviderType(provider: Record<string, unknown>): string {
  const raw = (provider.providerType || provider.protocol || provider.type || '').toString().toLowerCase();
  const id = (provider.providerId || provider.id || '').toString().toLowerCase();
  const match = (value: string, keyword: string) => value.includes(keyword);
  const source = `${raw}|${id}`;
  const normalized = (src: string): string => (src && src.trim() ? src.trim() : '');
  const lexicon = normalized(source);
  if (!lexicon) return 'openai';
  if (match(lexicon, 'anthropic') || match(lexicon, 'claude')) return 'anthropic';
  if (match(lexicon, 'responses')) return 'responses';
  if (match(lexicon, 'gemini')) return 'gemini';
  if (match(lexicon, 'iflow')) return 'iflow';
  if (match(lexicon, 'qwen')) return 'qwen';
  if (match(lexicon, 'glm')) return 'glm';
  if (match(lexicon, 'lmstudio')) return 'lmstudio';
  return raw || 'openai';
}

export function mapOutboundProfile(providerType: string): string {
  const value = providerType.toLowerCase();
  if (value === 'anthropic') return 'anthropic-messages';
  if (value === 'responses') return 'openai-responses';
  if (value === 'gemini') return 'gemini-chat';
  return 'openai-chat';
}

export function normalizeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      entries[key] = value;
    }
  }
  return Object.keys(entries).length ? entries : undefined;
}

function asRecord<T extends Record<string, unknown>>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T;
}

function normalizeModelCapabilities(provider: Record<string, unknown>): Record<string, ModelCapability[]> | undefined {
  const models = provider.models;
  const result: Record<string, ModelCapability[]> = {};

  const pushCapabilities = (modelId: string, capabilities: unknown) => {
    if (!modelId) return;
    if (!Array.isArray(capabilities)) return;
    const valid: ModelCapability[] = [];
    for (const cap of capabilities) {
      if (typeof cap === 'string' && ['text', 'reasoning', 'vision', 'thinking', 'web_search'].includes(cap)) {
        valid.push(cap as ModelCapability);
      }
    }
    if (valid.length > 0) {
      result[modelId] = valid;
    }
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
      const modelConfig = typeof modelConfigRaw === 'object' && modelConfigRaw ? (modelConfigRaw as Record<string, unknown>) : {};
      pushCapabilities(modelId, modelConfig.capabilities);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ServiceProfile } from '../api/provider-types.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { DEFAULT_PROVIDER } from '../../../constants/index.js';
import { isCodexUaMode } from './provider-runtime-utils.js';
import { HeaderUtils, RequestHeaderBuilder, SessionHeaderUtils } from './transport/index.js';

type ProviderConfigInternal = OpenAIStandardConfig['config'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isOpenCodeZenRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
  const providerId = String(runtimeMetadata?.providerId || runtimeMetadata?.providerKey || '').trim().toLowerCase();
  return providerId === 'opencode-zen' || providerId === 'opencode-zen-free' || providerId.startsWith('opencode-zen-');
}

function isAssistantToolCallMessage(message: unknown): message is Record<string, unknown> {
  const row = asRecord(message);
  return row.role === 'assistant' && asArray(row.tool_calls ?? row.toolCalls).length > 0;
}

function hasOriginalReasoningContent(message: Record<string, unknown>): boolean {
  const value = message.reasoning_content ?? message.reasoningContent;
  return typeof value === 'string' && value.trim().length > 0;
}

function opencodeZenThinkingHistoryLacksReasoning(request: UnknownObject): boolean {
  return asArray(asRecord(request).messages).some((message) => {
    if (!isAssistantToolCallMessage(message)) {
      return false;
    }
    return !hasOriginalReasoningContent(message);
  });
}

function suppressOpenCodeZenSessionIfHistoryLacksReasoning(
  headers: Record<string, string>,
  request: UnknownObject,
  runtimeMetadata?: ProviderRuntimeMetadata
): void {
  if (!runtimeMetadata || !isOpenCodeZenRuntime(runtimeMetadata) || !opencodeZenThinkingHistoryLacksReasoning(request)) {
    return;
  }
  if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
    runtimeMetadata.metadata = {};
  }
  runtimeMetadata.metadata.opencodeSuppressSession = true;
  HeaderUtils.deleteHeader(headers, 'x-opencode-session');
}

function resolveEffectiveProviderTimeoutMs(config: ProviderConfigInternal, serviceProfile: ServiceProfile): number | undefined {
  const envTimeout = Number(process.env.ROUTECODEX_PROVIDER_TIMEOUT_MS || process.env.RCC_PROVIDER_TIMEOUT_MS || NaN);
  const effectiveTimeout = Number.isFinite(envTimeout) && envTimeout > 0
    ? envTimeout
    : (config.overrides?.timeout ?? serviceProfile.timeout ?? DEFAULT_PROVIDER.TIMEOUT_MS);
  return Number.isFinite(effectiveTimeout) && Number(effectiveTimeout) > 0
    ? Math.floor(Number(effectiveTimeout))
    : undefined;
}

export async function buildProviderRequestHeaders(options: {
  config: ProviderConfigInternal;
  authProvider: IAuthProvider | null;
  serviceProfile: ServiceProfile;
  runtimeMetadata?: ProviderRuntimeMetadata;
  runtimeHeaders?: Record<string, string>;
  familyProfile?: ProviderFamilyProfile;
  isGeminiFamily: boolean;
  providerType: string;
}): Promise<Record<string, string>> {
  const {
    config,
    authProvider,
    serviceProfile,
    runtimeMetadata,
    runtimeHeaders = {},
    familyProfile,
    isGeminiFamily,
    providerType
  } = options;

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const codexUaMode = isCodexUaMode({ runtime: runtimeMetadata, providerType });
  if (codexUaMode) {
    SessionHeaderUtils.ensureCodexSessionMetadata(runtimeMetadata);
  }
  const inboundMetadata = runtimeMetadata?.metadata;
  const inboundUserAgent =
    typeof inboundMetadata?.userAgent === 'string' && inboundMetadata.userAgent.trim()
      ? inboundMetadata.userAgent.trim()
      : undefined;
  const inboundOriginator =
    typeof inboundMetadata?.clientOriginator === 'string' && inboundMetadata.clientOriginator.trim()
      ? inboundMetadata.clientOriginator.trim()
      : undefined;
  const inboundClientHeaders = SessionHeaderUtils.extractClientHeaders(runtimeMetadata);
  const normalizedClientHeaders = SessionHeaderUtils.normalizeCodexClientHeaders(inboundClientHeaders, codexUaMode);

  const serviceHeaders = serviceProfile.headers || {};
  const overrideHeaders = config.overrides?.headers || {};
  if (isGeminiFamily) {
    RequestHeaderBuilder.buildGeminiDefaultHeaders(baseHeaders, runtimeMetadata);
  }

  const authHeaders = authProvider?.buildHeaders() || {};

  return RequestHeaderBuilder.buildHeaders({
    baseHeaders,
    serviceHeaders,
    overrideHeaders,
    runtimeHeaders,
    authHeaders,
    normalizedClientHeaders,
    inboundMetadata: inboundMetadata as Record<string, unknown> | undefined,
    inboundUserAgent,
    inboundOriginator,
    runtimeMetadata,
    familyProfile,
    defaultUserAgent: DEFAULT_PROVIDER.USER_AGENT,
    isGeminiFamily,
    codexUaMode
  });
}

export async function finalizeProviderRequestHeaders(options: {
  headers: Record<string, string>;
  request: UnknownObject;
  finalizeHeaders: (
    headers: Record<string, string>,
    request: UnknownObject
  ) => Record<string, string> | Promise<Record<string, string>>;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
  providerType: string;
}): Promise<Record<string, string>> {
  const { headers, request, finalizeHeaders, runtimeMetadata, familyProfile, providerType } = options;
  suppressOpenCodeZenSessionIfHistoryLacksReasoning(headers, request, runtimeMetadata);
  const finalized = await finalizeHeaders(headers, request);
  suppressOpenCodeZenSessionIfHistoryLacksReasoning(finalized, request, runtimeMetadata);

  const profileResolvedUa = await familyProfile?.resolveUserAgent?.({
    uaFromConfig: HeaderUtils.findHeaderValue(finalized, 'User-Agent'),
    uaFromService: undefined,
    inboundUserAgent: undefined,
    defaultUserAgent: DEFAULT_PROVIDER.USER_AGENT,
    runtimeMetadata
  });
  if (typeof profileResolvedUa === 'string' && profileResolvedUa.trim()) {
    HeaderUtils.assignHeader(finalized, 'User-Agent', profileResolvedUa.trim());
  }

  const profileAdjustedHeaders = familyProfile?.applyRequestHeaders?.({
    headers: finalized,
    request,
    runtimeMetadata,
    isCodexUaMode: isCodexUaMode({ runtime: runtimeMetadata, providerType })
  });
  if (profileAdjustedHeaders && typeof profileAdjustedHeaders === 'object') {
    return profileAdjustedHeaders;
  }

  return finalized;
}

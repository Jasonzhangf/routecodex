import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ServiceProfile } from '../api/provider-types.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { DEFAULT_PROVIDER } from '../../../constants/index.js';
import { isCodexUaMode } from './provider-runtime-utils.js';
import { HeaderUtils, OAuthHeaderPreflight, RequestHeaderBuilder, SessionHeaderUtils } from './transport/index.js';

type ProviderConfigInternal = OpenAIStandardConfig['config'];

function isQwenHeaderProfile(options: {
  config: ProviderConfigInternal;
  familyProfile?: ProviderFamilyProfile;
  oauthProviderId?: string;
}): boolean {
  const { config, familyProfile, oauthProviderId } = options;
  if (familyProfile?.providerFamily === 'qwen') {
    return true;
  }
  if (typeof oauthProviderId === 'string' && oauthProviderId.trim().toLowerCase() === 'qwen') {
    return true;
  }
  const providerId =
    typeof (config as { providerId?: unknown }).providerId === 'string'
      ? String((config as { providerId?: string }).providerId).trim().toLowerCase()
      : '';
  return providerId === 'qwen' || providerId.startsWith('qwen-');
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
  oauthProviderId?: string;
  serviceProfile: ServiceProfile;
  runtimeMetadata?: ProviderRuntimeMetadata;
  runtimeHeaders?: Record<string, string>;
  familyProfile?: ProviderFamilyProfile;
  isGeminiFamily: boolean;
  isAntigravity: boolean;
  providerType: string;
}): Promise<Record<string, string>> {
  const {
    config,
    authProvider,
    oauthProviderId,
    serviceProfile,
    runtimeMetadata,
    runtimeHeaders = {},
    familyProfile,
    isGeminiFamily,
    isAntigravity,
    providerType
  } = options;

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (isQwenHeaderProfile({ config, familyProfile, oauthProviderId })) {
    const timeoutMs = resolveEffectiveProviderTimeoutMs(config, serviceProfile);
    if (timeoutMs) {
      baseHeaders['X-Stainless-Timeout'] = String(Math.trunc(timeoutMs / 1000));
    }
  }
  const codexUaMode = isCodexUaMode({ runtime: runtimeMetadata, providerType });
  if (codexUaMode && !isAntigravity) {
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
  if (isGeminiFamily && !isAntigravity) {
    RequestHeaderBuilder.buildGeminiDefaultHeaders(baseHeaders, runtimeMetadata);
  }

  try {
    await OAuthHeaderPreflight.ensureTokenReady({
      auth: config.auth,
      authProvider,
      oauthProviderId
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { __routecodexAuthPreflightFatal?: unknown }).__routecodexAuthPreflightFatal === true
    ) {
      throw error;
    }
  }

  const authRawType =
    typeof (config.auth as { rawType?: unknown }).rawType === 'string'
      ? String((config.auth as { rawType?: string }).rawType).trim().toLowerCase()
      : '';
  if (authRawType === 'deepseek-account' && authProvider?.validateCredentials) {
    await authProvider.validateCredentials();
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
    isAntigravity,
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
  const finalized = await finalizeHeaders(headers, request);

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

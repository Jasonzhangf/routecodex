import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IAuthProvider } from '../../auth/auth-interface.js';
import { DeepSeekAccountAuthProvider } from '../../auth/deepseek-account-auth.js';
import { ensureCamoufoxFingerprintForToken, getCamoufoxProfileDir } from '../config/camoufox-launcher.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ApiKeyAuth, OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  DEEPSEEK_ERROR_CODES,
  normalizeDeepSeekProviderRuntimeOptions
} from '../contracts/deepseek-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import {
  createProviderError,
  extractPromptFromPayload,
  extractSessionIdFromMetadata,
  isRecord,
  mapPlatformToClientPlatform,
  normalizeString,
  parseCamoufoxConfig,
  readEnvBoolean,
  readStreamIntent,
  shouldForceUpstreamSseForSearch,
  type CamoufoxFingerprintSnapshot,
  type DeepSeekCompletionBody
} from './deepseek-http-provider-helpers.js';
import { DeepSeekSessionPowManager } from './deepseek-session-pow.js';

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_COMPLETION_ENDPOINT = '/api/v0/chat/completion';
const DEFAULT_CAMOUFOX_PROVIDER = 'deepseek';
const DEFAULT_DEEPSEEK_USER_AGENT = 'DeepSeek/1.0.13 Android/35';

type DeepSeekApiKeyAuth = ApiKeyAuth & {
  rawType?: string;
  accountAlias?: string;
};

type DeepSeekSessionPow = Pick<DeepSeekSessionPowManager, 'ensureChatSession' | 'createPowResponse' | 'cleanup'>;

export class DeepSeekHttpProvider extends HttpTransportProvider {
  private deepseekSessionPow: DeepSeekSessionPow | null = null;
  private pendingSessionId: string | null = null;
  private readonly camoufoxHeaderCache = new Map<string, Record<string, string>>();

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'deepseek',
        baseUrl: normalizeString(config.config.baseUrl) || DEFAULT_BASE_URL,
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: normalizeString(config.config.overrides?.endpoint) || DEFAULT_COMPLETION_ENDPOINT
        }
      }
    };
    super(cfg, dependencies, 'deepseek-http-provider');
  }

  protected override createAuthProvider(): IAuthProvider {
    const auth = this.config.config.auth as DeepSeekApiKeyAuth;
    if (this.isDeepSeekAccountAuth(auth)) {
      return new DeepSeekAccountAuthProvider({
        ...auth,
        type: 'apikey',
        rawType: 'deepseek-account'
      });
    }
    return super.createAuthProvider();
  }

  protected override async onInitialize(): Promise<void> {
    await super.onInitialize();
    if (this.isDeepSeekAccountAuth(this.config.config.auth as DeepSeekApiKeyAuth)) {
      this.deepseekSessionPow = this.buildDeepSeekSessionPowManager();
    }
  }

  protected override async onCleanup(): Promise<void> {
    try {
      if (this.deepseekSessionPow) {
        await this.deepseekSessionPow.cleanup();
      }
      this.deepseekSessionPow = null;
      this.pendingSessionId = null;
      this.camoufoxHeaderCache.clear();
    } finally {
      await super.onCleanup();
    }
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    if (readStreamIntent(request) || shouldForceUpstreamSseForSearch(request)) {
      return true;
    }
    return super.wantsUpstreamSse(request, context);
  }

  protected override prepareSseRequestBody(body: UnknownObject, context?: ProviderContext): void {
    if (isRecord(body)) {
      body.stream = true;
    }
    super.prepareSseRequestBody(body, context);
  }

  protected override async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    let finalized = await super.finalizeRequestHeaders(headers, request);
    const camoufoxHeaders = await this.resolveCamoufoxDeepSeekHeaders();
    if (camoufoxHeaders) {
      finalized = {
        ...finalized,
        ...camoufoxHeaders
      };
    }

    if (!this.deepseekSessionPow) {
      return finalized;
    }

    const sessionHeaders = {
      ...finalized
    };

    const sessionId = await this.deepseekSessionPow.ensureChatSession(sessionHeaders);
    const powResponse = await this.deepseekSessionPow.createPowResponse(sessionHeaders);
    this.pendingSessionId = sessionId;

    return {
      ...finalized,
      'x-ds-pow-response': powResponse
    };
  }

  protected override buildHttpRequestBody(request: UnknownObject): UnknownObject {
    const body = this.extractCompatPayload(request);
    if (!isRecord(body)) {
      return body;
    }

    if (this.isCompletionPayload(body)) {
      return body;
    }

    const prompt = extractPromptFromPayload(body, request);
    if (!prompt) {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.COMPLETION_FAILED,
        'DeepSeek provider expects compat payload with prompt field',
        400,
        {
          hint: 'Set compatibilityProfile=chat:deepseek-web to generate DeepSeek prompt payload'
        }
      );
    }

    const sessionId =
      normalizeString(body.chat_session_id) ||
      this.pendingSessionId ||
      extractSessionIdFromMetadata(request);

    if (!sessionId) {
      throw createProviderError(
        DEEPSEEK_ERROR_CODES.SESSION_CREATE_FAILED,
        'DeepSeek session id is missing before completion request',
        500
      );
    }

    const normalized: DeepSeekCompletionBody = {
      chat_session_id: sessionId,
      parent_message_id: normalizeString(body.parent_message_id) || null,
      prompt,
      ref_file_ids: Array.isArray(body.ref_file_ids) ? body.ref_file_ids : [],
      thinking_enabled: Boolean(body.thinking_enabled),
      search_enabled: Boolean(body.search_enabled),
      ...(readStreamIntent(request) ? { stream: true } : {})
    };

    this.pendingSessionId = null;
    return normalized;
  }

  private extractCompatPayload(request: UnknownObject): UnknownObject {
    if (isRecord(request) && isRecord(request.data)) {
      return request.data;
    }
    return request;
  }

  protected buildDeepSeekSessionPowManager(): DeepSeekSessionPowManager {
    const options = normalizeDeepSeekProviderRuntimeOptions(this.config.config.extensions?.deepseek);
    return new DeepSeekSessionPowManager({
      baseUrl: this.getDeepSeekBaseUrl(),
      sessionReuseTtlMs: options.sessionReuseTtlMs,
      powTimeoutMs: options.powTimeoutMs,
      powMaxAttempts: options.powMaxAttempts,
      logger: this.dependencies.logger,
      logId: this.id
    });
  }

  private isDeepSeekAccountAuth(auth: DeepSeekApiKeyAuth): boolean {
    const rawType = normalizeString(auth.rawType)?.toLowerCase();
    const directType = normalizeString(auth.type)?.toLowerCase();
    return rawType === 'deepseek-account' || directType === 'deepseek-account';
  }

  private getDeepSeekBaseUrl(): string {
    return normalizeString(this.config.config.baseUrl) || DEFAULT_BASE_URL;
  }

  private isCompletionPayload(body: Record<string, unknown>): body is DeepSeekCompletionBody {
    return Boolean(
      normalizeString(body.chat_session_id) &&
      typeof body.parent_message_id !== 'undefined' &&
      normalizeString(body.prompt)
    );
  }

  private resolveDeepSeekRuntimeAlias(): string | undefined {
    const runtime = this.getRuntimeProfile();
    const explicit = normalizeString((runtime as { keyAlias?: unknown } | undefined)?.keyAlias);
    if (explicit) {
      return explicit;
    }

    const parseFromKey = (value: unknown): string | undefined => {
      const raw = normalizeString(value);
      if (!raw) {
        return undefined;
      }
      const parts = raw.split('.').filter(Boolean);
      if (parts.length < 2) {
        return undefined;
      }
      return normalizeString(parts[1]);
    };

    return parseFromKey(runtime?.runtimeKey) || parseFromKey(runtime?.providerKey);
  }

  private shouldUseCamoufoxFingerprint(): boolean {
    return readEnvBoolean([
      'ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT',
      'RCC_DEEPSEEK_CAMOUFOX_FINGERPRINT'
    ], true);
  }

  private shouldAutoGenerateCamoufoxFingerprint(): boolean {
    return readEnvBoolean([
      'ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE',
      'RCC_DEEPSEEK_CAMOUFOX_AUTO_GENERATE'
    ], true);
  }

  private resolveCamoufoxProviderFamily(): string {
    return normalizeString(
      process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER ||
      process.env.RCC_DEEPSEEK_CAMOUFOX_PROVIDER
    ) || DEFAULT_CAMOUFOX_PROVIDER;
  }

  private async resolveCamoufoxDeepSeekHeaders(): Promise<Record<string, string> | undefined> {
    if (!this.shouldUseCamoufoxFingerprint()) {
      return undefined;
    }

    const alias = this.resolveDeepSeekRuntimeAlias();
    if (!alias) {
      return undefined;
    }

    const cacheKey = alias.toLowerCase();
    const cached = this.camoufoxHeaderCache.get(cacheKey);
    if (cached) {
      return { ...cached };
    }

    const providerFamily = this.resolveCamoufoxProviderFamily();
    const fingerprint = await this.loadCamoufoxFingerprint(providerFamily, alias);
    const headers = this.buildDeepSeekBrowserHeaders(fingerprint);
    this.camoufoxHeaderCache.set(cacheKey, headers);
    return { ...headers };
  }

  private async loadCamoufoxFingerprint(providerFamily: string, alias: string): Promise<CamoufoxFingerprintSnapshot | null> {
    if (this.shouldAutoGenerateCamoufoxFingerprint()) {
      ensureCamoufoxFingerprintForToken(providerFamily, alias);
    }

    const profileDir = getCamoufoxProfileDir(providerFamily, alias);
    const profileId = path.basename(profileDir);
    if (!profileId) {
      return null;
    }

    const filePath = path.join((process.env.HOME || os.homedir()), '.routecodex', 'camoufox-fp', `${profileId}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const payload = raw.trim() ? JSON.parse(raw) : null;
      return parseCamoufoxConfig(payload);
    } catch {
      return null;
    }
  }

  private buildDeepSeekBrowserHeaders(fingerprint: CamoufoxFingerprintSnapshot | null): Record<string, string> {
    const userAgent = normalizeString(fingerprint?.userAgent) || DEFAULT_DEEPSEEK_USER_AGENT;
    const clientPlatform = mapPlatformToClientPlatform(fingerprint?.platform) || 'android';

    return {
      'User-Agent': userAgent,
      'x-client-platform': clientPlatform,
      'x-client-version': '1.3.0-auto-resume',
      'x-client-locale': 'zh_CN',
      'accept-charset': 'UTF-8',
      Origin: 'https://chat.deepseek.com',
      Referer: 'https://chat.deepseek.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    };
  }
}

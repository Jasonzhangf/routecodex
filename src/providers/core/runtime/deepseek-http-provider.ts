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
import { DeepSeekSessionPowManager } from './deepseek-session-pow.js';

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_COMPLETION_ENDPOINT = '/api/v0/chat/completion';
const DEFAULT_CAMOUFOX_PROVIDER = 'deepseek';
const DEFAULT_DEEPSEEK_USER_AGENT = 'DeepSeek/1.0.13 Android/35';

type DeepSeekApiKeyAuth = ApiKeyAuth & {
  rawType?: string;
  accountAlias?: string;
};

type DeepSeekCompletionBody = {
  chat_session_id: string;
  parent_message_id: string | null;
  prompt: string;
  ref_file_ids: unknown[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  stream?: boolean;
};

type DeepSeekSessionPow = Pick<DeepSeekSessionPowManager, 'ensureChatSession' | 'createPowResponse' | 'cleanup'>;

type DeepSeekProviderError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
};

type CamoufoxFingerprintSnapshot = {
  userAgent?: string;
  platform?: string;
  oscpu?: string;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content === null || content === undefined) {
    return '';
  }
  if (!Array.isArray(content)) {
    return stringifyUnknown(content).trim();
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const type = normalizeString(item.type)?.toLowerCase();
    const text = normalizeString(item.text);
    if (
      text &&
      (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'text_delta')
    ) {
      parts.push(text);
      continue;
    }
    if (text) {
      parts.push(text);
      continue;
    }
    const contentText = normalizeString(item.content);
    if (contentText) {
      parts.push(contentText);
      continue;
    }
    if (type === 'tool_use') {
      const toolName = normalizeString(item.name) || 'tool_call';
      const toolInput = item.input ?? {};
      parts.push(stringifyUnknown({ tool_calls: [{ name: toolName, input: toolInput }] }));
      continue;
    }
    if (type === 'tool_result' && item.content !== undefined) {
      parts.push(stringifyUnknown(item.content));
      continue;
    }
  }
  return parts.join('\n').trim();
}

function normalizeToolCallsAsText(toolCallsRaw: unknown): string {
  if (!Array.isArray(toolCallsRaw) || toolCallsRaw.length === 0) {
    return '';
  }
  const toolCalls = toolCallsRaw
    .filter((item) => isRecord(item))
    .map((item) => {
      const fn = isRecord(item.function) ? item.function : item;
      const name = normalizeString(fn.name);
      if (!name) {
        return null;
      }
      const argsRaw = fn.arguments;
      let input: unknown = {};
      if (typeof argsRaw === 'string') {
        const trimmed = argsRaw.trim();
        if (trimmed) {
          try {
            input = JSON.parse(trimmed);
          } catch {
            input = { _raw: trimmed };
          }
        }
      } else if (argsRaw !== undefined) {
        input = argsRaw;
      }
      return { name, input };
    })
    .filter((item): item is { name: string; input: unknown } => Boolean(item));

  if (!toolCalls.length) {
    return '';
  }
  return stringifyUnknown({ tool_calls: toolCalls });
}

function buildPromptFromMessages(messagesRaw: unknown): string | undefined {
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) {
    return undefined;
  }
  const messages: Array<{ role: string; text: string }> = [];

  for (const item of messagesRaw) {
    if (!isRecord(item)) {
      continue;
    }
    const role = normalizeString(item.role)?.toLowerCase();
    if (!role) {
      continue;
    }
    const contentText = normalizeMessageContentToText(item.content);
    const toolCallsText = normalizeToolCallsAsText(item.tool_calls);
    const reasoning =
      normalizeString(item.reasoning_content) || normalizeString(item.reasoning) || '';
    const text = [contentText, toolCallsText, reasoning].filter(Boolean).join('\n').trim();
    if (!text) {
      continue;
    }
    messages.push({ role, text });
  }

  if (!messages.length) {
    return undefined;
  }

  const merged = [{ ...messages[0] }];
  for (const item of messages.slice(1)) {
    const last = merged[merged.length - 1];
    if (last.role === item.role) {
      last.text = [last.text, item.text].filter(Boolean).join('\n\n');
      continue;
    }
    merged.push({ ...item });
  }

  const parts: string[] = [];
  merged.forEach((block, index) => {
    if (block.role === 'assistant') {
      parts.push(`<｜Assistant｜>${block.text}<｜end▁of▁sentence｜>`);
      return;
    }
    if (block.role === 'user' || block.role === 'system' || block.role === 'tool') {
      if (index > 0) {
        parts.push(`<｜User｜>${block.text}`);
      } else {
        parts.push(block.text);
      }
      return;
    }
    parts.push(block.text);
  });

  const prompt = parts
    .join('')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '[$1]($2)')
    .trim();
  return prompt || undefined;
}

function createProviderError(code: string, message: string, statusCode: number, details?: Record<string, unknown>): DeepSeekProviderError {
  const error = new Error(message) as DeepSeekProviderError;
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  if (details) {
    error.details = details;
  }
  return error;
}

function readBooleanLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function readEnvBoolean(keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim()) {
      return readBooleanLike(raw, fallback);
    }
  }
  return fallback;
}

function parseCamoufoxConfig(payload: unknown): CamoufoxFingerprintSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const envNode = payload.env;
  if (!isRecord(envNode)) {
    return null;
  }
  const rawConfig = normalizeString(envNode.CAMOU_CONFIG_1);
  if (!rawConfig) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    userAgent: normalizeString(parsed['navigator.userAgent']),
    platform: normalizeString(parsed['navigator.platform']),
    oscpu: normalizeString(parsed['navigator.oscpu'])
  };
}

function mapPlatformToClientPlatform(platform?: string): string | undefined {
  const normalized = normalizeString(platform)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes('win')) {
    return 'windows';
  }
  if (normalized.includes('mac')) {
    return 'macos';
  }
  if (normalized.includes('linux') || normalized.includes('x11')) {
    return 'linux';
  }
  return undefined;
}

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
    if (this.readStreamIntent(request)) {
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

    const prompt = this.extractPrompt(body, request);
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
      this.extractSessionIdFromMetadata(request);

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
      ...(this.readStreamIntent(request) ? { stream: true } : {})
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

  private extractPrompt(body: Record<string, unknown>, request: UnknownObject): string | undefined {
    const direct = normalizeString(body.prompt);
    if (direct) {
      return direct;
    }
    const messagePrompt = buildPromptFromMessages(body.messages);
    if (messagePrompt) {
      return messagePrompt;
    }
    const dataNode = isRecord(request) && isRecord(request.data) ? request.data : undefined;
    const nestedPrompt = normalizeString(dataNode?.prompt);
    if (nestedPrompt) {
      return nestedPrompt;
    }
    return buildPromptFromMessages(dataNode?.messages);
  }

  private extractSessionIdFromMetadata(request: UnknownObject): string | undefined {
    const metadata = isRecord(request) && isRecord(request.metadata)
      ? request.metadata
      : isRecord(request) && isRecord(request.data) && isRecord(request.data.metadata)
        ? request.data.metadata
        : undefined;
    return normalizeString(metadata?.sessionId) || normalizeString(metadata?.conversationId);
  }

  private readStreamIntent(request: UnknownObject): boolean {
    const direct = isRecord(request) ? request : {};
    const dataNode = isRecord(direct.data) ? direct.data : undefined;
    const metadataNode = isRecord(direct.metadata)
      ? direct.metadata
      : dataNode && isRecord(dataNode.metadata)
        ? dataNode.metadata
        : undefined;

    if (direct.stream === true || dataNode?.stream === true) {
      return true;
    }
    if (metadataNode?.stream === true) {
      return true;
    }
    return false;
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

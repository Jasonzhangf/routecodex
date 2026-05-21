import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'crypto';
import {
  normalizeWindsurfProviderRuntimeOptions,
} from '../contracts/windsurf-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { resolveRccAuthDir } from '../../../config/user-data-paths.js';
import {
  buildWindsurfCloudEndpointCandidates,
  buildWindsurfCloudMetadata,
  buildWindsurfModelConfigProbeRequests,
  buildWindsurfStatusProbeRequests,
  WindsurfCloudClient,
} from './windsurf-cloud-client.js';

const MERGE_EFFORT_MAP: Record<string, string> = {
  minimal: 'none', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh'
};
const VALID_EFFORTS = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);

const WINDSURF_AUTH1_CONNECTIONS_URL = 'https://windsurf.com/_devin-auth/connections';
const WINDSURF_AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_CHECK_LOGIN_METHOD_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod';
const WINDSURF_POST_AUTH_URL_NEW = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_POST_AUTH_URL_LEGACY = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
const WINDSURF_CLOUD_CHAT_PRIMARY = 'https://daily-cloudcode-pa.googleapis.com';
const WINDSURF_CLOUD_CHAT_FALLBACK = 'https://cloudcode-pa.googleapis.com';

type WindsurfSessionCredential = {
  apiKey: string;
  sessionToken: string;
  auth1Token: string;
  accountId?: string;
};

type WindsurfLoginMethodProbe = {
  method: 'auth1' | null;
  hasPassword: boolean;
};

type WindsurfManagedAuthConfig = {
  apiKey?: string;
  rawType?: string;
  mobile?: string;
  account?: string;
  username?: string;
  password?: string;
  tokenFile?: string;
  accountAlias?: string;
};

function parseWindsurfPostAuthPayload(payload: unknown): { sessionToken?: string; accountId?: string; error?: string } {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const sessionToken = typeof record.sessionToken === 'string' ? record.sessionToken.trim() : '';
    const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : '';
    if (sessionToken) {
      return { sessionToken, accountId: accountId || undefined };
    }
  }
  if (typeof payload === 'string') {
    const raw = payload;
    const tokenMatch = raw.match(/devin-session-token\$[a-zA-Z0-9._-]+/);
    const accountMatch = raw.match(/account-[a-f0-9]+/);
    if (tokenMatch?.[0]) {
      return { sessionToken: tokenMatch[0], accountId: accountMatch?.[0] };
    }
    return { error: raw.slice(0, 200) || 'empty response' };
  }
  return { error: 'empty response' };
}

function createWindsurfFingerprintHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    Origin: 'https://windsurf.com',
    Referer: 'https://windsurf.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

function createWindsurfProviderError(message: string, fields: Partial<WindsurfFailureClass> = {}): Error {
  const error = new Error(message) as Error & Record<string, unknown>;
  attachWindsurfErrorFields(error, {
    code: fields.code || 'WINDSURF_SERVICE_UNREACHABLE',
    retryable: fields.retryable ?? false,
    status: fields.status ?? 502,
    rateLimitKind: fields.rateLimitKind,
  });
  return error;
}

function interpretWindsurfConnections(payload: unknown): WindsurfLoginMethodProbe {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const connections = Array.isArray(record.connections) ? record.connections : null;
    if (connections) {
      const emailConnection = connections.find((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        return String((entry as Record<string, unknown>).type || '').trim().toLowerCase() === 'email';
      });
      return {
        method: emailConnection ? 'auth1' : null,
        hasPassword: !!(emailConnection && (emailConnection as Record<string, unknown>).enabled),
      };
    }
    const authMethod = record.auth_method;
    if (authMethod && typeof authMethod === 'object') {
      const authMethodRecord = authMethod as Record<string, unknown>;
      return {
        method: String(authMethodRecord.method || '').trim().toLowerCase() === 'auth1' ? 'auth1' : null,
        hasPassword: authMethodRecord.has_password !== false,
      };
    }
  }
  return { method: null, hasPassword: false };
}

const WINDSURF_MODEL_SET = new Set([
  'gpt-5.4','gpt-5.4-none','gpt-5.4-low','gpt-5.4-medium','gpt-5.4-high','gpt-5.4-xhigh',
  'gpt-5.4-mini-low','gpt-5.4-mini-medium','gpt-5.4-mini-high','gpt-5.4-mini-xhigh',
  'gpt-5.5','gpt-5.5-none','gpt-5.5-low','gpt-5.5-medium','gpt-5.5-high','gpt-5.5-xhigh',
  'gpt-5.5-none-fast','gpt-5.5-low-fast','gpt-5.5-medium-fast','gpt-5.5-high-fast','gpt-5.5-xhigh-fast',
  'gpt-5.3-codex','gpt-5.3-codex-low','gpt-5.3-codex-high','gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-low-fast','gpt-5.3-codex-medium-fast','gpt-5.3-codex-high-fast','gpt-5.3-codex-xhigh-fast',
]);

type WindsurfFailureClass = {
  code: string;
  retryable: boolean;
  status: number;
  rateLimitKind?: 'daily_limit' | 'short_lived';
  cooldownOverrideMs?: number;
  quotaScope?: 'weekly';
  quotaReason?: string;
};

type WindsurfSemanticTurn =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; tool_calls?: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> }
  | { type: 'function_call_output'; call_id: string; name?: string; output: string };

function mergeReasoningEffortIntoModel(model: string, body: Record<string, unknown>): string {
  const effort = String((body.reasoning_effort as string) || (((body.reasoning as Record<string, unknown>)?.effort) as string) || '').toLowerCase().trim();
  if (!effort || !VALID_EFFORTS.has(effort)) return model;
  for (const e of VALID_EFFORTS) if (model.toLowerCase().endsWith('-' + e)) return model;
  const merged = `${model}-${MERGE_EFFORT_MAP[effort] || effort}`;
  return WINDSURF_MODEL_SET.has(merged.toLowerCase()) ? merged : model;
}

function attachWindsurfErrorFields(target: Error & Record<string, unknown>, c: WindsurfFailureClass): void {
  target.code = c.code;
  target.status = c.status;
  target.retryable = c.retryable;
  target.upstreamCode = c.code;
  target.providerFamily = 'windsurf';
  target.type = 'windsurf_upstream_error';
  if (c.rateLimitKind) {
    target.rateLimitKind = c.rateLimitKind;
  }
  if (typeof c.cooldownOverrideMs === 'number' && Number.isFinite(c.cooldownOverrideMs) && c.cooldownOverrideMs > 0) {
    target.cooldownOverrideMs = c.cooldownOverrideMs;
  }
  if (c.quotaScope) {
    target.quotaScope = c.quotaScope;
  }
  if (c.quotaReason) {
    target.quotaReason = c.quotaReason;
  }
}

export class WindsurfChatProvider extends HttpTransportProvider {
  private readonly windsurfRuntime: ReturnType<typeof normalizeWindsurfProviderRuntimeOptions>;
  private readonly windsurfCloudClient: WindsurfCloudClient;
  private windsurfSessionCredential: WindsurfSessionCredential | null = null;
  private windsurfSessionCredentialPromise: Promise<WindsurfSessionCredential | null> | null = null;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'windsurf',
      },
    };
    super(cfg, dependencies, 'windsurf-chat-provider');

    const raw = config.config.extensions as UnknownObject | undefined;
    const nested = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).windsurf : undefined;
    this.windsurfRuntime = normalizeWindsurfProviderRuntimeOptions(
      nested && typeof nested === 'object' ? (nested as UnknownObject) : raw
    );
    this.windsurfCloudClient = new WindsurfCloudClient(this.httpClient);
  }

  protected override getServiceProfile() {
    const base = super.getServiceProfile();
    return { ...base, supportsTools: true, supportsVision: true, supportsThinking: true, streamingModes: ['sse'] };
  }

  public override async checkHealth(): Promise<boolean> {
    return this.buildCloudEndpointCandidates().length > 0;
  }

  public async fetchCloudUserStatus(): Promise<unknown> {
    await this.ensureWindsurfSessionCredential();
    return this.windsurfCloudClient.getUserStatus(this.buildStatusProbeRequests());
  }

  public async fetchCloudModelConfigs(): Promise<unknown> {
    await this.ensureWindsurfSessionCredential();
    return this.windsurfCloudClient.getCascadeModelConfigs(this.buildModelConfigProbeRequests());
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const req = { ...request } as Record<string, unknown>;
    const body = (req.body as Record<string, unknown>) || req;

    if (Array.isArray(body.tools as unknown[])) {
      const tools = body.tools as Array<Record<string, unknown>>;
      if (tools.length > 0) {
        const preamble = tools.map(t => {
          const fn = (t.function as Record<string, string>) || {};
          return `- ${fn.name || t.type || 'unknown'}: ${fn.description || ''}\n  params: ${fn.parameters ? JSON.stringify(fn.parameters) : '{}'}`;
        }).join('\n');
        body.tools_preamble = `[Available tools]\n${preamble}`;
        delete body.tools;
      }
    }

    if (typeof body.model === 'string' && body.model.startsWith('windsurf.')) body.model = body.model.slice('windsurf.'.length);
    if (typeof body.model === 'string' && body.model.length > 0) body.model = mergeReasoningEffortIntoModel(body.model, body);

    return req;
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    try {
      const body = this.readRequestBodyRecord(request);
      const semanticConversation = this.parseCascadeSemanticRoundtripSync(body.messages);
      const configModel = typeof (this.config.config as Record<string, unknown>).model === 'string'
        ? String((this.config.config as Record<string, unknown>).model)
        : '';
      const model = typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : configModel.trim()
          ? configModel.trim()
          : 'gpt-5.5-medium';
      this.logWindsurfStage('sendRequestInternal.begin', {
        requestModel: model,
        messageCount: semanticConversation.length,
        hasToolsPreamble: typeof body.tools_preamble === 'string' && body.tools_preamble.length > 0,
      });
      const apiKey = await this.resolveCascadeApiKey();
      this.logWindsurfStage('resolveCascadeApiKey.done', {
        apiKeyKind: keyLikeSessionToken(apiKey) ? 'session-token' : 'other',
      });
      const response = await this.httpClient.post(
        this.buildCascadeSendEndpoint(),
        this.buildCascadeSendBody({
          model,
          messages: semanticConversation,
          toolsPreamble: body.tools_preamble,
        }),
        this.buildCascadeSendHeaders(apiKey),
      );
      return this.buildChatCompletionFromCascadeResponse({
        model,
        candidate: this.extractCascadeCandidate(response.data),
        usage: this.extractCascadeUsage(response.data),
      });
    } catch (error) {
      this.logWindsurfStage('sendRequestInternal.error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.classifyWindsurfCascadeError(error);
    }
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    if (request && typeof request === 'object') {
      const body = (request as Record<string, unknown>).body;
      if (body && typeof body === 'object' && (body as Record<string, unknown>).stream) return true;
      if ((request as Record<string, unknown>).stream) return true;
    }
    return super.wantsUpstreamSse(request, context);
  }

  private readApiKey(): string {
    const auth = this.authProvider;
    if (!(auth instanceof ApiKeyAuthProvider)) {
      throw new Error('windsurf auth provider unavailable');
    }
    const cfg = (auth as unknown as { config?: WindsurfManagedAuthConfig }).config;
    const rawType = normalizeWindsurfAuthRawType(cfg?.rawType);
    const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (isManagedWindsurfAuthRawType(rawType)) {
      if (key) {
        return key;
      }
      if (this.windsurfSessionCredential?.apiKey) {
        return this.windsurfSessionCredential.apiKey;
      }
      if (rawType === 'windsurf-devin-token') {
        throw createWindsurfProviderError('windsurf devin token missing', {
          code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
          status: 401,
          retryable: false,
        });
      }
      const mobile = typeof cfg?.mobile === 'string' ? cfg.mobile.trim() : '';
      const account = typeof cfg?.account === 'string' ? cfg.account.trim() : '';
      const username = typeof cfg?.username === 'string' ? cfg.username.trim() : '';
      const password = typeof cfg?.password === 'string' ? cfg.password.trim() : '';
      if (!(mobile || account || username) || !password) {
        throw createWindsurfProviderError('windsurf account credential missing', {
          code: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
          status: 401,
          retryable: false,
        });
      }
      throw createWindsurfProviderError('windsurf session token not initialized', {
        code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
        status: 401,
        retryable: false,
      });
    }
    if (!key) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    if (auth.getApiKeyInfo().length < 10) {
      throw createWindsurfProviderError('windsurf api key invalid', {
        code: 'INVALID_API_KEY',
        status: 401,
        retryable: false,
      });
    }
    return key;
  }

  private readManagedWindsurfAuthConfig(): { auth: ApiKeyAuthProvider; cfg: WindsurfManagedAuthConfig; rawType: string } | null {
    const auth = this.authProvider;
    if (!(auth instanceof ApiKeyAuthProvider)) {
      return null;
    }
    const cfg = (auth as unknown as { config?: WindsurfManagedAuthConfig }).config ?? {};
    const rawType = normalizeWindsurfAuthRawType(cfg.rawType);
    if (!isManagedWindsurfAuthRawType(rawType)) {
      return null;
    }
    return { auth, cfg, rawType };
  }

  private resolveWindsurfTokenFilePath(cfg: WindsurfManagedAuthConfig): string {
    const raw = typeof cfg.tokenFile === 'string' ? cfg.tokenFile.trim() : '';
    if (raw) {
      if (raw.startsWith('~/')) {
        return path.join(process.env.HOME || '', raw.slice(2));
      }
      return path.resolve(raw);
    }
    const alias = typeof cfg.accountAlias === 'string' && cfg.accountAlias.trim() ? cfg.accountAlias.trim() : 'default';
    return path.join(resolveRccAuthDir(), `windsurf-${alias}.json`);
  }

  private async loadPersistedWindsurfSessionCredential(cfg: WindsurfManagedAuthConfig): Promise<WindsurfSessionCredential | null> {
    const tokenFilePath = this.resolveWindsurfTokenFilePath(cfg);
    try {
      const raw = await fs.readFile(tokenFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
      const sessionToken = typeof parsed.sessionToken === 'string' ? parsed.sessionToken.trim() : apiKey;
      const auth1Token = typeof parsed.auth1Token === 'string' ? parsed.auth1Token.trim() : '';
      const accountId = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
      if (!keyLikeSessionToken(apiKey || sessionToken)) {
        return null;
      }
      return {
        apiKey: apiKey || sessionToken,
        sessionToken: sessionToken || apiKey,
        auth1Token,
        ...(accountId ? { accountId } : {}),
      };
    } catch {
      return null;
    }
  }

  private async persistWindsurfSessionCredential(cfg: WindsurfManagedAuthConfig, credential: WindsurfSessionCredential): Promise<void> {
    const tokenFilePath = this.resolveWindsurfTokenFilePath(cfg);
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, JSON.stringify(credential, null, 2), 'utf8');
  }

  private logWindsurfStage(stage: string, details: Record<string, unknown> = {}): void {
    return;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw createWindsurfProviderError(`windsurf fetch timeout after ${timeoutMs}ms: ${url}`, {
          code: 'WINDSURF_FETCH_TIMEOUT',
          status: 504,
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureWindsurfSessionCredential(): Promise<WindsurfSessionCredential | null> {
    const managed = this.readManagedWindsurfAuthConfig();
    if (!managed) {
      return null;
    }
    const { auth, cfg, rawType } = managed;
    if (this.windsurfSessionCredential?.apiKey) {
      return this.windsurfSessionCredential;
    }
    if (this.windsurfSessionCredentialPromise) {
      return await this.windsurfSessionCredentialPromise;
    }
    const run = async (): Promise<WindsurfSessionCredential | null> => {
      const inlineApiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (inlineApiKey) {
        const parsedInline = parseInlineWindsurfAccount(inlineApiKey);
        if (!parsedInline) {
          this.windsurfSessionCredential = {
            apiKey: inlineApiKey,
            sessionToken: inlineApiKey,
            auth1Token: '',
          };
          await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
          return this.windsurfSessionCredential;
        }
      }

      const persisted = await this.loadPersistedWindsurfSessionCredential(cfg);
      if (persisted) {
        this.windsurfSessionCredential = persisted;
        if ((auth as unknown as { config?: { apiKey?: string } }).config) {
          (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = persisted.apiKey;
        }
        return persisted;
      }

      if (rawType === 'windsurf-devin-token') {
        throw createWindsurfProviderError('windsurf devin token missing', {
          code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
          status: 401,
          retryable: false,
        });
      }

      const mobile = typeof cfg.mobile === 'string' ? cfg.mobile.trim() : '';
      const account = typeof cfg.account === 'string' ? cfg.account.trim() : '';
      const username = typeof cfg.username === 'string' ? cfg.username.trim() : '';
      const password = typeof cfg.password === 'string' ? cfg.password.trim() : '';
      const parsedInline = parseInlineWindsurfAccount(cfg.apiKey);
      const loginEmail = mobile || account || username || parsedInline?.email || '';
      const loginPassword = password || parsedInline?.passwordOrToken || '';
      if (!loginEmail || !loginPassword) {
        throw createWindsurfProviderError('windsurf account credential missing', {
          code: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
          status: 401,
          retryable: false,
        });
      }
      this.logWindsurfStage('sessionCredential.login.begin', { loginEmail });
      const fingerprint = createWindsurfFingerprintHeaders();
      const loginMethodProbe = await this.resolveWindsurfLoginMethodProbe(loginEmail, fingerprint);
      this.logWindsurfStage('sessionCredential.loginMethod.done', {
        loginEmail,
        method: loginMethodProbe.method,
        hasPassword: loginMethodProbe.hasPassword,
      });
      if (loginMethodProbe.method === 'auth1' && !loginMethodProbe.hasPassword) {
        throw createWindsurfProviderError('No password set. Please log in with Google or GitHub.', {
          code: 'WINDSURF_NO_PASSWORD_SET',
          status: 401,
          retryable: false,
        });
      }
      const loginBody = { email: loginEmail, password: loginPassword };
      let loginResp;
      try {
        loginResp = await this.httpClient.post(
          WINDSURF_AUTH1_PASSWORD_LOGIN_URL,
          loginBody,
          {
            ...fingerprint,
            'Content-Type': 'application/json',
          }
        );
      } catch (error) {
        const source = error as { status?: unknown; response?: { data?: unknown }; message?: unknown };
        const status = typeof source?.status === 'number' ? source.status : typeof source?.response?.data === 'object' ? 401 : 502;
        const detail = this.extractWindsurfAuthDetail(source?.response?.data);
        if (status === 401 || detail) {
          throw createWindsurfProviderError(detail || 'Invalid email or password', {
            code: detail?.toLowerCase().includes('no password set') ? 'WINDSURF_NO_PASSWORD_SET' : 'WINDSURF_AUTH_FAILED',
            status: 401,
            retryable: false,
          });
        }
        throw error;
      }
      this.logWindsurfStage('sessionCredential.passwordLogin.done', { loginEmail });
      const loginRecord = (loginResp.data && typeof loginResp.data === 'object') ? loginResp.data as Record<string, unknown> : {};
      const auth1Token = typeof loginRecord.token === 'string' ? loginRecord.token.trim() : '';
      const loginDetail = this.extractWindsurfAuthDetail(loginRecord);
      if (!auth1Token) {
        throw createWindsurfProviderError(loginDetail || 'windsurf auth1 token missing', {
          code: loginDetail?.toLowerCase().includes('no password set') ? 'WINDSURF_NO_PASSWORD_SET' : 'WINDSURF_AUTH_FAILED',
          status: 401,
          retryable: false,
        });
      }
      const postAuthHeaders = {
        ...fingerprint,
        'Content-Type': 'application/proto',
        'Content-Length': '0',
        'Connect-Protocol-Version': '1',
        'X-Devin-Auth1-Token': auth1Token,
        Referer: 'https://windsurf.com/account/login',
      };
      let parsed = { sessionToken: '', accountId: undefined as string | undefined, error: undefined as string | undefined };
      let lastErr: Error | null = null;
      for (const endpoint of [WINDSURF_POST_AUTH_URL_NEW, WINDSURF_POST_AUTH_URL_LEGACY]) {
        try {
          this.logWindsurfStage('sessionCredential.postAuth.begin', { endpoint, loginEmail });
          const response = await this.fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: postAuthHeaders,
            body: undefined,
          }, 15000);
          const raw = await response.text();
          const maybeJson = (() => { try { return JSON.parse(raw); } catch { return raw; } })();
          const result = parseWindsurfPostAuthPayload(maybeJson);
          if (response.ok && result.sessionToken) {
            this.logWindsurfStage('sessionCredential.postAuth.done', {
              endpoint,
              loginEmail,
              accountId: result.accountId || null,
            });
            parsed = { sessionToken: result.sessionToken, accountId: result.accountId, error: undefined };
            break;
          }
          lastErr = createWindsurfProviderError(result.error || `windsurf post auth failed: ${response.status}`, {
            code: 'WINDSURF_POSTAUTH_FAILED',
            status: response.status || 502,
            retryable: response.status >= 500,
          });
        } catch (error) {
          this.logWindsurfStage('sessionCredential.postAuth.error', {
            endpoint,
            loginEmail,
            error: error instanceof Error ? error.message : String(error),
          });
          lastErr = error instanceof Error
            ? error
            : createWindsurfProviderError(String(error), {
                code: 'WINDSURF_POSTAUTH_FAILED',
                status: 502,
                retryable: true,
              });
        }
      }
      if (!parsed.sessionToken) {
        throw lastErr ?? createWindsurfProviderError('windsurf session token missing', {
          code: 'WINDSURF_SESSION_TOKEN_MISSING',
          status: 401,
          retryable: false,
        });
      }
      this.windsurfSessionCredential = {
        apiKey: parsed.sessionToken,
        sessionToken: parsed.sessionToken,
        auth1Token,
        accountId: parsed.accountId,
      };
      (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = parsed.sessionToken;
      await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
      this.logWindsurfStage('sessionCredential.ready', {
        loginEmail,
        accountId: parsed.accountId || null,
      });
      return this.windsurfSessionCredential;
    };
    this.windsurfSessionCredentialPromise = run();
    try {
      return await this.windsurfSessionCredentialPromise;
    } finally {
      this.windsurfSessionCredentialPromise = null;
    }
  }

  private async resolveWindsurfLoginMethodProbe(
    email: string,
    fingerprint: Record<string, string>,
  ): Promise<WindsurfLoginMethodProbe> {
    const primary = await this.fetchWindsurfCheckLoginMethod(email, fingerprint);
    if (primary) {
      return primary;
    }
    return this.fetchWindsurfAuth1Connections(email, fingerprint);
  }

  private async fetchWindsurfCheckLoginMethod(
    email: string,
    fingerprint: Record<string, string>,
  ): Promise<WindsurfLoginMethodProbe | null> {
    try {
      const response = await this.httpClient.post(
        WINDSURF_CHECK_LOGIN_METHOD_URL,
        { email },
        {
          ...fingerprint,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        }
      );
      const data = response.data;
      if (!data || typeof data !== 'object') {
        return null;
      }
      const record = data as Record<string, unknown>;
      const hasUserField = Object.prototype.hasOwnProperty.call(record, 'userExists');
      const hasPasswordField = Object.prototype.hasOwnProperty.call(record, 'hasPassword');
      if (!hasUserField && !hasPasswordField) {
        return null;
      }
      if (record.userExists === false) {
        return { method: null, hasPassword: false };
      }
      return {
        method: 'auth1',
        hasPassword: !!record.hasPassword,
      };
    } catch {
      return null;
    }
  }

  private async fetchWindsurfAuth1Connections(
    email: string,
    fingerprint: Record<string, string>,
  ): Promise<WindsurfLoginMethodProbe> {
    try {
      const response = await this.httpClient.post(
        WINDSURF_AUTH1_CONNECTIONS_URL,
        { product: 'windsurf', email },
        {
          ...fingerprint,
          'Content-Type': 'application/json',
        }
      );
      return interpretWindsurfConnections(response.data);
    } catch {
      return { method: null, hasPassword: false };
    }
  }

  private extractWindsurfAuthDetail(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === 'string') {
      return detail.trim();
    }
    if (Array.isArray(detail)) {
      return detail
        .map((entry) => {
          if (typeof entry === 'string') {
            return entry;
          }
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;
            return typeof record.msg === 'string'
              ? record.msg
              : typeof record.type === 'string'
                ? record.type
                : JSON.stringify(record);
          }
          return '';
        })
        .filter(Boolean)
        .join('; ')
        .trim();
    }
    return '';
  }

  private buildCloudEndpointCandidates(): string[] {
    return buildWindsurfCloudEndpointCandidates([
      this.windsurfRuntime.apiBaseUrl,
      this.windsurfRuntime.apiBaseUrlFallback,
    ]);
  }

  private buildStatusProbeRequests(): Array<{ endpoint: string; path: string; body: Record<string, unknown> }> {
    return buildWindsurfStatusProbeRequests({
      apiKey: this.readApiKey(),
      endpoints: [this.windsurfRuntime.apiBaseUrl, this.windsurfRuntime.apiBaseUrlFallback],
    });
  }

  private buildModelConfigProbeRequests(): Array<{ endpoint: string; path: string; body: Record<string, unknown> }> {
    return buildWindsurfModelConfigProbeRequests({
      apiKey: this.readApiKey(),
      endpoints: [this.windsurfRuntime.apiBaseUrl, this.windsurfRuntime.apiBaseUrlFallback],
    });
  }

  private readRequestBodyRecord(request: UnknownObject): Record<string, unknown> {
    if (request && typeof request === 'object') {
      const record = request as Record<string, unknown>;
      if (record.body && typeof record.body === 'object') {
        return record.body as Record<string, unknown>;
      }
      return record;
    }
    return {};
  }

  private async resolveCascadeApiKey(): Promise<string> {
    await this.ensureWindsurfSessionCredential();
    const raw = this.readApiKey();
    if (keyLikeSessionToken(raw)) {
      return raw;
    }
    return this.readApiKey();
  }

  private buildCascadeSendEndpoint(): string {
    const candidates = buildWindsurfCloudEndpointCandidates([
      this.windsurfRuntime.apiBaseUrl,
      this.windsurfRuntime.apiBaseUrlFallback,
      WINDSURF_CLOUD_CHAT_PRIMARY,
      WINDSURF_CLOUD_CHAT_FALLBACK,
    ]);
    if (candidates.length === 0) {
      throw new Error('[windsurf] missing cloud chat endpoint');
    }
    return `${candidates[0]}${WINDSURF_LOAD_CODE_ASSIST_PATH}`;
  }

  private buildCascadeSendHeaders(apiKey: string): Record<string, string> {
    const token = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!token) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'windsurf/routecodex',
    };
  }

  private buildCascadeSendBody(args: {
    model: string;
    messages: unknown;
    toolsPreamble: unknown;
  }): Record<string, unknown> {
    return {
      model: args.model,
      conversation: Array.isArray(args.messages) ? args.messages : [],
      ...(typeof args.toolsPreamble === 'string' && args.toolsPreamble.trim()
        ? { toolsPreamble: args.toolsPreamble.trim() }
        : {}),
    };
  }

  private parseCascadeAssistantTurnSync(candidate: unknown): Record<string, unknown> {
    const record = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const rawContent = Array.isArray(record.content) ? record.content : [];
    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const seenToolCallIds = new Set<string>();
    const seenToolCallSignatures = new Set<string>();

    if (typeof record.content === 'string' && record.content) {
      textParts.push(record.content);
    }

    for (const item of rawContent) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const block = item as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
      if (type === 'text' || type === 'output_text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text) {
          textParts.push(text);
        }
        continue;
      }
      if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call') {
        continue;
      }
      const callId = typeof block.call_id === 'string'
        ? block.call_id.trim()
        : typeof block.id === 'string'
          ? block.id.trim()
          : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name) {
        throw new Error('[windsurf] assistant tool call missing name');
      }
      if (!callId) {
        throw new Error('[windsurf] assistant tool call missing call_id');
      }
      if (seenToolCallIds.has(callId)) {
        throw new Error('[windsurf] duplicate assistant tool call id in response output');
      }
      seenToolCallIds.add(callId);
      let args: Record<string, unknown>;
      if (type === 'custom_tool_call') {
        args = { input: typeof block.input === 'string' ? block.input : '' };
      } else if (type === 'function_call' && typeof block.arguments === 'string') {
        try {
          const parsed = JSON.parse(block.arguments);
          if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
            throw new Error('[windsurf] assistant tool call arguments must be valid json object');
          }
          args = parsed as Record<string, unknown>;
        } catch {
          throw new Error('[windsurf] assistant tool call arguments must be valid json object');
        }
      } else if (block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)) {
        args = block.arguments as Record<string, unknown>;
      } else {
        throw new Error('[windsurf] assistant tool call arguments must be object');
      }
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      });
      const signature = `${name}:${JSON.stringify(args)}`;
      if (seenToolCallSignatures.has(signature)) {
        throw new Error('[windsurf] duplicate assistant tool call signature in response output');
      }
      seenToolCallSignatures.add(signature);
    }

    const text = textParts.join('');
    if (!text && toolCalls.length === 0) {
      throw new Error('[windsurf] empty assistant completion');
    }

    return {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private parseCascadeSemanticRoundtripSync(messages: unknown): WindsurfSemanticTurn[] {
    if (!Array.isArray(messages)) {
      return [];
    }
    const out: WindsurfSemanticTurn[] = [];
    const matchedCalls = new Map<string, { name: string; signature: string }>();
    const completedToolCallIds = new Set<string>();
    let lastMatchedRoundSignatures: string[] = [];

    const buildSignature = (name: string, args: Record<string, unknown>): string => `${name}:${JSON.stringify(args)}`;
    const normalizeTextContent = (content: unknown): string => {
      if (typeof content === 'string') {
        return content;
      }
      if (!Array.isArray(content)) {
        return '';
      }
      const parts: string[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const block = item as Record<string, unknown>;
        const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
        if (type === 'input_text' || type === 'output_text' || type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) {
            parts.push(text);
          }
        }
      }
      return parts.join('');
    };

    for (const item of messages) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const msg = item as Record<string, unknown>;
      const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';

      if (role === 'user') {
        const text = normalizeTextContent(msg.content);
        lastMatchedRoundSignatures = [];
        out.push({ type: 'user', text });
        continue;
      }

      if (role === 'assistant') {
        const toolCallsRaw = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
        const textParts: string[] = [];
        if (typeof msg.content === 'string') {
          textParts.push(msg.content);
        }
        const normalizedCalls: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> = [];
        const seenHistoryToolCallIds = new Set<string>();
        const seenHistoryToolCallSignatures = new Set<string>();

        for (const entry of toolCallsRaw) {
          if (!entry || typeof entry !== 'object') {
            continue;
          }
          const row = entry as Record<string, unknown>;
          const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
          const callId = typeof row.id === 'string' ? row.id.trim() : typeof row.call_id === 'string' ? String(row.call_id).trim() : '';
          const name = typeof fn.name === 'string' ? fn.name.trim() : typeof row.name === 'string' ? String(row.name).trim() : '';
          const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : typeof row.arguments === 'string' ? String(row.arguments) : '{}';
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            } else {
              throw new Error('[windsurf] assistant tool call arguments must be valid json object');
            }
          } catch {
            throw new Error('[windsurf] assistant tool call arguments must be valid json object');
          }
          if (!name) {
            throw new Error('[windsurf] assistant tool call missing name');
          }
          if (!callId) {
            throw new Error('[windsurf] assistant tool call missing call_id');
          }
          if (seenHistoryToolCallIds.has(callId)) {
            throw new Error('[windsurf] duplicate assistant tool call id in history');
          }
          seenHistoryToolCallIds.add(callId);
          const signature = buildSignature(name, args);
          if (seenHistoryToolCallSignatures.has(signature)) {
            throw new Error('[windsurf] duplicate assistant tool call signature in history');
          }
          seenHistoryToolCallSignatures.add(signature);
          normalizedCalls.push({ call_id: callId, name, arguments: args });
        }

        if (contentBlocks.length > 0) {
          const hasChatToolCalls = normalizedCalls.length > 0;
          for (const blockEntry of contentBlocks) {
            if (!blockEntry || typeof blockEntry !== 'object') {
              continue;
            }
            const block = blockEntry as Record<string, unknown>;
            const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
            if (type === 'output_text' || type === 'text') {
              const blockText = typeof block.text === 'string' ? block.text : '';
              if (blockText) {
                textParts.push(blockText);
              }
              continue;
            }
            if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call') {
              continue;
            }
            const callId = typeof block.call_id === 'string'
              ? block.call_id.trim()
              : typeof block.id === 'string'
                ? block.id.trim()
                : '';
            const name = typeof block.name === 'string' ? block.name.trim() : '';
            const rawArgs = typeof block.arguments === 'string'
              ? block.arguments
              : type === 'custom_tool_call' && typeof block.input === 'string'
                ? JSON.stringify({ input: block.input })
                : block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)
                  ? block.arguments
                  : '{}';
            let args: Record<string, unknown> = {};
            if (typeof rawArgs === 'string') {
              try {
                const parsed = JSON.parse(rawArgs);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                } else {
                  throw new Error('[windsurf] assistant tool call arguments must be valid json object');
                }
              } catch {
                throw new Error('[windsurf] assistant tool call arguments must be valid json object');
              }
            } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
              args = rawArgs as Record<string, unknown>;
            } else {
              throw new Error('[windsurf] assistant tool call arguments must be valid json object');
            }
            if (!name) {
              throw new Error('[windsurf] assistant tool call missing name');
            }
            if (!callId) {
              throw new Error('[windsurf] assistant tool call missing call_id');
            }
            const signature = buildSignature(name, args);
            if (hasChatToolCalls) {
              if (seenHistoryToolCallIds.has(callId)) {
                throw new Error('[windsurf] duplicate assistant tool call id in history');
              }
              if (seenHistoryToolCallSignatures.has(signature)) {
                throw new Error('[windsurf] duplicate assistant tool call signature in history');
              }
              throw new Error('[windsurf] assistant history mixed chat tool_calls with content tool call');
            }
            if (seenHistoryToolCallIds.has(callId)) {
              throw new Error('[windsurf] duplicate assistant tool call id in history');
            }
            seenHistoryToolCallIds.add(callId);
            if (seenHistoryToolCallSignatures.has(signature)) {
              throw new Error('[windsurf] duplicate assistant tool call signature in history');
            }
            seenHistoryToolCallSignatures.add(signature);
            normalizedCalls.push({ call_id: callId, name, arguments: args });
          }
        }

        const text = textParts.join('');

        if (!text && normalizedCalls.length === 0) {
          throw new Error('[windsurf] empty assistant completion');
        }

        if (lastMatchedRoundSignatures.length > 0 && normalizedCalls.length > 0) {
          const current = normalizedCalls.map((entry) => buildSignature(entry.name, entry.arguments)).sort();
          const previous = [...lastMatchedRoundSignatures].sort();
          if (current.length === previous.length && current.every((value, index) => value === previous[index])) {
            throw new Error('[windsurf] upstream repeated prior tool call after tool_result');
          }
        }

        for (const call of normalizedCalls) {
          matchedCalls.set(call.call_id, {
            name: call.name,
            signature: buildSignature(call.name, call.arguments),
          });
        }

        out.push({
          type: 'assistant',
          text,
          ...(normalizedCalls.length > 0 ? { tool_calls: normalizedCalls } : {}),
        });
        continue;
      }

      if (role === 'tool') {
        const parsedToolResult = this.parseCascadeToolResultTurnSync(msg, matchedCalls);
        if (completedToolCallIds.has(parsedToolResult.call_id)) {
          throw new Error('[windsurf] duplicate tool_result for completed tool call');
        }
        const matched = matchedCalls.get(parsedToolResult.call_id)!;
        out.push(parsedToolResult);
        completedToolCallIds.add(parsedToolResult.call_id);
        if (!lastMatchedRoundSignatures.includes(matched.signature)) {
          lastMatchedRoundSignatures = [...lastMatchedRoundSignatures, matched.signature];
        }
        continue;
      }
    }

    return out;
  }

  private parseCascadeToolResultTurnSync(
    message: unknown,
    matchedCalls: Map<string, { name: string; signature: string }>,
  ): Extract<WindsurfSemanticTurn, { type: 'function_call_output' }> {
    const msg = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const extractNestedToolResultCallId = (content: unknown): string => {
      if (!Array.isArray(content)) {
        return '';
      }
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const block = item as Record<string, unknown>;
        const candidates = [
          block.tool_call_id,
          block.call_id,
          block.tool_use_id,
          block.id,
        ];
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      }
      return '';
    };
    const callId = typeof msg.tool_call_id === 'string'
      ? msg.tool_call_id.trim()
      : typeof msg.id === 'string'
        ? msg.id.trim()
        : extractNestedToolResultCallId(msg.content);
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    const normalizeToolResultContent = (content: unknown): string => {
      if (typeof content === 'string') {
        return content;
      }
      if (content == null) {
        return '';
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        let sawStructuredBlock = false;
        for (const item of content) {
          if (!item || typeof item !== 'object') {
            continue;
          }
          const block = item as Record<string, unknown>;
          const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
          if (type === 'text' || type === 'output_text') {
            sawStructuredBlock = true;
            const text = typeof block.text === 'string' ? block.text : '';
            if (text) {
              parts.push(text);
            }
            continue;
          }
          if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output' || type === 'tool_message') {
            sawStructuredBlock = true;
            const nestedOutput = typeof block.output === 'string'
              ? block.output
              : block.output == null
                ? typeof block.content === 'string'
                  ? block.content
                  : block.content == null
                    ? ''
                    : JSON.stringify(block.content)
                : JSON.stringify(block.output);
            if (nestedOutput) {
              parts.push(nestedOutput);
            }
          }
        }
        if (sawStructuredBlock) {
          return parts.join('');
        }
      }
      return JSON.stringify(content);
    };
    const output = normalizeToolResultContent(msg.content);
    if (!callId || !matchedCalls.has(callId)) {
      throw new Error('[windsurf] orphan tool_result without matching assistant tool call');
    }
    const matched = matchedCalls.get(callId)!;
    return {
      type: 'function_call_output',
      call_id: callId,
      name: name || matched.name,
      output,
    };
  }

  private buildChatCompletionFromCascadeResponse(payload: {
    model: string;
    candidate: unknown;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
  }): Record<string, unknown> {
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('[windsurf] empty cascade candidate payload');
    }

    const parsed = this.parseCascadeAssistantTurnSync(candidate);
    const toolCalls = Array.isArray((parsed as Record<string, unknown>).tool_calls)
      ? ((parsed as Record<string, unknown>).tool_calls as unknown[])
      : [];
    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
    const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0;
    const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0;
    const cachedTokens = typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [
        {
          index: 0,
          message: parsed,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      ...(usage ? {
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          input_tokens_details: {
            cached_tokens: cachedTokens,
          },
        },
      } : {}),
    };
  }

  private extractCascadeCandidate(payload: unknown): unknown {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const output = Array.isArray(record.output) ? record.output : [];
    const hasStructuredAssistantPayload = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') {
        return false;
      }
      const row = value as Record<string, unknown>;
      if (typeof row.content === 'string' && row.content) {
        return true;
      }
      if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
        return true;
      }
      if (!Array.isArray(row.content) || row.content.length === 0) {
        return false;
      }
      for (const item of row.content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const block = item as Record<string, unknown>;
        const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
        if ((type === 'text' || type === 'output_text') && typeof block.text === 'string' && block.text) {
          return true;
        }
        if (type === 'tool_call' || type === 'function_call' || type === 'custom_tool_call') {
          return true;
        }
      }
      return false;
    };
    const toolResultIds = new Set<string>();
    let sawOutputToolResult = false;
    for (const item of output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as Record<string, unknown>;
      const type = String(row.type || '').trim().toLowerCase();
      const isToolResult = type === 'function_call_output' || type === 'custom_tool_call_output';
      if (!isToolResult) {
        continue;
      }
      sawOutputToolResult = true;
      const toolResultId = typeof row.call_id === 'string' && row.call_id.trim()
        ? row.call_id.trim()
        : typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : '';
      if (toolResultId) {
        if (toolResultIds.has(toolResultId)) {
          throw new Error('[windsurf] duplicate tool result id in response output');
        }
        toolResultIds.add(toolResultId);
      }
    }
    const normalizedOutputCandidate = (() => {
      if (!Array.isArray(output) || output.length === 0) {
        return null;
      }
      const content: unknown[] = [];
      let sawAssistantLike = false;
      for (const item of output) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const row = item as Record<string, unknown>;
        const type = String(row.type || '').trim().toLowerCase();
        if (type === 'message') {
          const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
          if (role && role !== 'assistant') {
            throw new Error('[windsurf] response output message role must be assistant');
          }
          sawAssistantLike = true;
          if (typeof row.content === 'string') {
            content.push({ type: 'output_text', text: row.content });
            continue;
          }
          const blocks = Array.isArray(row.content) ? row.content : [];
          content.push(...blocks);
          continue;
        }
        if (type === 'tool_call' || type === 'function_call' || type === 'custom_tool_call') {
          sawAssistantLike = true;
          content.push(row);
        }
      }
      if (!sawAssistantLike) {
        return null;
      }
      return {
        role: 'assistant',
        content,
      };
    })();
    if (normalizedOutputCandidate && sawOutputToolResult) {
      throw new Error('[windsurf] response output mixed assistant content with tool result item');
    }
    if (!normalizedOutputCandidate && sawOutputToolResult && candidates.length === 0 && !(record.candidate && typeof record.candidate === 'object')) {
      throw new Error('[windsurf] response output contains tool result without assistant tool call');
    }
    const firstStructuredCandidate = candidates.find((entry) => hasStructuredAssistantPayload(entry));
    const firstObjectCandidate = candidates.find((entry) => !!entry && typeof entry === 'object') ?? null;
    const candidateRecord = record.candidate;
    const candidate = normalizedOutputCandidate
      ?? (hasStructuredAssistantPayload(firstStructuredCandidate)
        ? firstStructuredCandidate
        : hasStructuredAssistantPayload(candidateRecord)
          ? candidateRecord
          : ((candidateRecord && typeof candidateRecord === 'object')
            ? candidateRecord
            : firstObjectCandidate));
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('[windsurf] empty cascade candidate payload');
    }
    return candidate;
  }

  private extractCascadeUsage(payload: unknown): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const usage = record.usageMetadata ?? record.usage;
    if (!usage || typeof usage !== 'object') {
      return null;
    }
    const usageRecord = usage as Record<string, unknown>;
    const inputTokensDetails = usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
      ? usageRecord.input_tokens_details as Record<string, unknown>
      : null;
    const inputTokensDetailsCamel = usageRecord.inputTokensDetails && typeof usageRecord.inputTokensDetails === 'object'
      ? usageRecord.inputTokensDetails as Record<string, unknown>
      : null;
    return {
      inputTokens: typeof usageRecord.inputTokens === 'number'
        ? usageRecord.inputTokens
        : typeof usageRecord.input_tokens === 'number'
          ? usageRecord.input_tokens
          : undefined,
      outputTokens: typeof usageRecord.outputTokens === 'number'
        ? usageRecord.outputTokens
        : typeof usageRecord.output_tokens === 'number'
          ? usageRecord.output_tokens
          : undefined,
      cacheReadTokens: typeof usageRecord.cacheReadTokens === 'number'
        ? usageRecord.cacheReadTokens
        : typeof usageRecord.cached_tokens === 'number'
          ? usageRecord.cached_tokens
          : typeof inputTokensDetails?.cached_tokens === 'number'
            ? inputTokensDetails.cached_tokens
            : typeof inputTokensDetailsCamel?.cachedTokens === 'number'
              ? inputTokensDetailsCamel.cachedTokens
          : undefined,
    };
  }

  private classifyWindsurfCascadeError(error: unknown): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    const structured = source as Error & Record<string, unknown>;
    if (
      typeof structured.code === 'string'
      && typeof structured.status === 'number'
      && typeof structured.retryable === 'boolean'
    ) {
      return source;
    }
    const classified = new Error(source.message) as Error & Record<string, unknown>;
    const sourceRecord = source as Error & { status?: unknown; response?: { status?: unknown; data?: unknown } };
    const responseData = sourceRecord.response?.data && typeof sourceRecord.response.data === 'object'
      ? sourceRecord.response.data as Record<string, unknown>
      : null;
    const nestedError = responseData?.error && typeof responseData.error === 'object'
      ? responseData.error as Record<string, unknown>
      : null;
    const upstreamStatus =
      typeof sourceRecord.status === 'number'
        ? sourceRecord.status
        : typeof sourceRecord.response?.status === 'number'
          ? sourceRecord.response.status
          : typeof nestedError?.code === 'number'
            ? nestedError.code
            : null;
    const statusText = typeof nestedError?.status === 'string' ? nestedError.status.toLowerCase() : '';
    const message = source.message.toLowerCase();
    const isWeeklyQuota =
      message.includes('weekly usage quota has been exhausted')
      || message.includes('weekly quota has been exhausted')
      || message.includes('weekly usage quota exhausted');
    const isAuth =
      upstreamStatus === 401
      || statusText === 'unauthenticated'
      || message.includes('unauthenticated')
      || message.includes('invalid authentication credentials')
      || message.includes('permission_denied');
    const isUnavailable =
      message.includes('connect') ||
      message.includes('econnreset') ||
      message.includes('err_http2') ||
      message.includes('econnrefused') ||
      message.includes('pending stream has been canceled') ||
      message.includes('err_http2_stream_cancel') ||
      message.includes('panel state') ||
      message.includes('session closed') ||
      message.includes('stream closed');
    attachWindsurfErrorFields(classified, {
      code: isWeeklyQuota
        ? 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED'
        : isAuth
          ? 'WINDSURF_AUTH_FAILED'
          : isUnavailable
            ? 'LANGUAGE_SERVER_UNAVAILABLE'
            : 'WINDSURF_SERVICE_UNREACHABLE',
      retryable: isWeeklyQuota ? false : !isAuth,
      status: isWeeklyQuota ? 429 : isAuth ? 401 : 502,
      rateLimitKind: isWeeklyQuota ? 'daily_limit' : undefined,
      cooldownOverrideMs: isWeeklyQuota ? 24 * 60 * 60_000 : undefined,
      quotaScope: isWeeklyQuota ? 'weekly' : undefined,
      quotaReason: isWeeklyQuota ? 'windsurf_weekly_exhausted' : undefined,
    });
    classified.cause = source;
    classified.transportBackend = 'cascade-cloud';
    return classified;
  }
}

function keyLikeSessionToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('devin-session-token$');
}

function parseInlineWindsurfAccount(value: unknown): { email: string; passwordOrToken: string } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const idx = trimmed.indexOf('|');
  if (idx <= 0 || idx >= trimmed.length - 1) {
    return null;
  }
  return {
    email: trimmed.slice(0, idx).trim(),
    passwordOrToken: trimmed.slice(idx + 1).trim(),
  };
}

function normalizeWindsurfAuthRawType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isManagedWindsurfAuthRawType(rawType: string): boolean {
  return rawType === 'windsurf-account' || rawType === 'windsurf-devin-token';
}

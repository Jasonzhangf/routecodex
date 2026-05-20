import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import { randomUUID } from 'crypto';
import {
  WINDSURF_DEFAULT_LS_PORT,
  normalizeWindsurfProviderRuntimeOptions,
} from '../contracts/windsurf-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import {
  buildWindsurfCloudEndpointCandidates,
  buildWindsurfCloudMetadata,
  buildWindsurfModelConfigProbeRequests,
  buildWindsurfStatusProbeRequests,
  WindsurfCloudClient,
} from './windsurf-cloud-client.js';
import { grpcFrame, grpcUnary, LS_SERVICE } from './grpc/grpc-client.js';
import {
  buildGetGeneratorMetadataRequest,
  buildGetTrajectoryRequest,
  buildGetTrajectoryStepsRequest,
  buildSendCascadeMessageRequest,
  buildStartCascadeRequest,
  parseGeneratorMetadata,
  parseStartCascadeResponse,
  parseTrajectoryStatus,
  parseTrajectorySteps,
} from './grpc/windsurf-grpc-bridge.js';
import {
  ensureWindsurfLangserverReady,
  resetWindsurfLangserverSession,
  resolveWindsurfWorkspacePath,
  type WindsurfLangserverEntry,
} from './windsurf-langserver-manager.js';

const MERGE_EFFORT_MAP: Record<string, string> = {
  minimal: 'none', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh'
};
const VALID_EFFORTS = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);

const WINDSURF_AUTH1_CONNECTIONS_URL = 'https://windsurf.com/_devin-auth/connections';
const WINDSURF_AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_CHECK_LOGIN_METHOD_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod';
const WINDSURF_POST_AUTH_URL_NEW = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_POST_AUTH_URL_LEGACY = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';

function isWindsurfCascadeTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /pending stream has been canceled|ECONNRESET|ERR_HTTP2|session closed|stream closed|panel state/i.test(message);
}

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

const WINDSURF_TRANSPORT_ERROR_RE = /pending stream has been canceled|ECONNRESET|ERR_HTTP2|session closed|stream closed|panel state/i;

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
    const body = this.readRequestBodyRecord(request);
    const messages = this.normalizeMessages(body.messages);
    const configModel = typeof (this.config.config as Record<string, unknown>).model === 'string'
      ? String((this.config.config as Record<string, unknown>).model)
      : '';
    const model = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : configModel.trim()
        ? configModel.trim()
        : 'gpt-5.5-medium';
    const modelInfo = this.resolveModelInfo(model);
    this.logWindsurfStage('sendRequestInternal.begin', {
      requestModel: model,
      messageCount: messages.length,
      hasToolsPreamble: typeof body.tools_preamble === 'string' && body.tools_preamble.length > 0,
    });
    const apiKey = await this.resolveCascadeApiKey();
    this.logWindsurfStage('resolveCascadeApiKey.done', {
      apiKeyKind: keyLikeSessionToken(apiKey) ? 'session-token' : 'other',
    });
    const prompt = this.buildCascadePrompt(messages, body.tools_preamble);
    const maxCascadeAttempts = 2;
    let lastError: unknown;
    let lastCascadeId = '';

    for (let attempt = 1; attempt <= maxCascadeAttempts; attempt++) {
      let lsEntry: WindsurfLangserverEntry;
      let cascadeId = '';
      try {
        lsEntry = await this.ensureCascadeWorkspace(apiKey);
        this.logWindsurfStage('ensureCascadeWorkspace.done', {
          port: lsEntry.port,
          ready: lsEntry.ready,
          hasSessionId: !!lsEntry.sessionId,
          generation: lsEntry.generation,
          attempt,
        });

        this.logWindsurfStage('startCascade.begin', {
          port: lsEntry.port,
          generation: lsEntry.generation,
          attempt,
        });
        cascadeId = await this.startCascade(apiKey, lsEntry);
        lastCascadeId = cascadeId;
        this.logWindsurfStage('startCascade.done', {
          cascadeId,
          attempt,
        });
        this.logWindsurfStage('sendCascadeMessage.begin', {
          cascadeId,
          promptChars: prompt.length,
          modelUid: modelInfo.modelUid || null,
          modelEnum: modelInfo.modelEnum,
          attempt,
        });
        await this.sendCascadeMessage(apiKey, cascadeId, prompt, modelInfo, lsEntry, body.tools_preamble);
        this.logWindsurfStage('sendCascadeMessage.done', {
          cascadeId,
          attempt,
        });
        this.logWindsurfStage('pollCascadeToCompletion.begin', {
          cascadeId,
          pollIntervalMs: this.windsurfRuntime.pollIntervalMs || 500,
          pollMaxWaitMs: this.windsurfRuntime.pollMaxWaitMs || 120000,
          attempt,
        });
        return await this.pollCascadeToCompletion(
          cascadeId,
          model,
          lsEntry,
          prompt.length,
          typeof body.tools_preamble === 'string' ? body.tools_preamble.length : 0,
        );
      } catch (error) {
        lastError = error;
        const retryableTransport = isWindsurfCascadeTransportError(error) && attempt < maxCascadeAttempts;
        this.logWindsurfStage('sendRequestInternal.error', {
          cascadeId: cascadeId || null,
          attempt,
          retryableTransport,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!retryableTransport) {
          throw this.classifyWindsurfCascadeError(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }

    this.logWindsurfStage('sendRequestInternal.error', {
      cascadeId: lastCascadeId || null,
      attempt: maxCascadeAttempts,
      retryableTransport: false,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw this.classifyWindsurfCascadeError(lastError);
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
    const cfg = (auth as unknown as { config?: { apiKey?: string; rawType?: string; mobile?: string; account?: string; username?: string; password?: string } }).config;
    const rawType = typeof cfg?.rawType === 'string' ? cfg.rawType.trim().toLowerCase() : '';
    const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (rawType === 'windsurf-account') {
      if (key) {
        return key;
      }
      if (this.windsurfSessionCredential?.apiKey) {
        return this.windsurfSessionCredential.apiKey;
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
    const auth = this.authProvider;
    if (!(auth instanceof ApiKeyAuthProvider)) {
      return null;
    }
    const cfg = (auth as unknown as { config?: { apiKey?: string; rawType?: string; mobile?: string; account?: string; username?: string; password?: string } }).config;
    const rawType = typeof cfg?.rawType === 'string' ? cfg.rawType.trim().toLowerCase() : '';
    if (rawType !== 'windsurf-account') {
      return null;
    }
    if (this.windsurfSessionCredential?.apiKey) {
      return this.windsurfSessionCredential;
    }
    if (this.windsurfSessionCredentialPromise) {
      return await this.windsurfSessionCredentialPromise;
    }
    const run = async (): Promise<WindsurfSessionCredential | null> => {
    const mobile = typeof cfg?.mobile === 'string' ? cfg.mobile.trim() : '';
    const account = typeof cfg?.account === 'string' ? cfg.account.trim() : '';
    const username = typeof cfg?.username === 'string' ? cfg.username.trim() : '';
    const password = typeof cfg?.password === 'string' ? cfg.password.trim() : '';
    const inlineApiKey = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (inlineApiKey) {
      const parsedInline = parseInlineWindsurfAccount(inlineApiKey);
      if (!parsedInline) {
        this.windsurfSessionCredential = {
          apiKey: inlineApiKey,
          sessionToken: inlineApiKey,
          auth1Token: '',
        };
        return this.windsurfSessionCredential;
      }
    }
    const parsedInline = parseInlineWindsurfAccount(cfg?.apiKey);
    const loginEmail = mobile || account || username || parsedInline?.email || '';
    const loginPassword = password || parsedInline?.passwordOrToken || '';
    if (!loginEmail || !loginPassword) {
      throw createWindsurfProviderError('windsurf account credential missing', {
        code: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
        status: 401,
        retryable: false,
      });
    }
    this.logWindsurfStage('sessionCredential.login.begin', {
      loginEmail,
    });
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
    this.logWindsurfStage('sessionCredential.passwordLogin.done', {
      loginEmail,
    });
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
        this.logWindsurfStage('sessionCredential.postAuth.begin', {
          endpoint,
          loginEmail,
        });
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

  private buildCloudMetadata(apiKey?: string): Record<string, unknown> {
    const token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : this.readApiKey();
    return buildWindsurfCloudMetadata(token);
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

  private resolveModelInfo(modelName: string): { modelEnum: number; modelUid?: string } {
    const model = modelName.toLowerCase();
    const catalog: Record<string, { modelEnum: number; modelUid?: string }> = {
      'gpt-5.5': { modelEnum: 0, modelUid: 'gpt-5-5-medium' },
      'gpt-5.5-none': { modelEnum: 0, modelUid: 'gpt-5-5-none' },
      'gpt-5.5-low': { modelEnum: 0, modelUid: 'gpt-5-5-low' },
      'gpt-5.5-medium': { modelEnum: 0, modelUid: 'gpt-5-5-medium' },
      'gpt-5.5-high': { modelEnum: 0, modelUid: 'gpt-5-5-high' },
      'gpt-5.5-xhigh': { modelEnum: 0, modelUid: 'gpt-5-5-xhigh' },
      'gpt-5.4-none': { modelEnum: 0, modelUid: 'gpt-5-4-none' },
      'gpt-5.4-low': { modelEnum: 0, modelUid: 'gpt-5-4-low' },
      'gpt-5.4-medium': { modelEnum: 0, modelUid: 'gpt-5-4-medium' },
      'gpt-5.4-high': { modelEnum: 0, modelUid: 'gpt-5-4-high' },
      'gpt-5.4-xhigh': { modelEnum: 0, modelUid: 'gpt-5-4-xhigh' },
      'gpt-5.3-codex': { modelEnum: 0, modelUid: 'gpt-5-3-codex-medium' },
      'gpt-5.3-codex-low': { modelEnum: 0, modelUid: 'gpt-5-3-codex-low' },
      'gpt-5.3-codex-high': { modelEnum: 0, modelUid: 'gpt-5-3-codex-high' },
      'gpt-5.3-codex-xhigh': { modelEnum: 0, modelUid: 'gpt-5-3-codex-xhigh' },
    };
    return catalog[model] ?? { modelEnum: 0, modelUid: model.replace(/\./g, '-') };
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

  private normalizeMessages(value: unknown): Array<{ role: string; content: string }> {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const role = typeof (item as Record<string, unknown>).role === 'string'
          ? String((item as Record<string, unknown>).role)
          : 'user';
        const rawContent = (item as Record<string, unknown>).content;
        const content = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map((part) => {
                if (typeof part === 'string') {
                  return part;
                }
                if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
                  return String((part as Record<string, unknown>).text);
                }
                return '';
              }).join('')
            : '';
        return { role, content };
      });
  }

  private async resolveCascadeApiKey(): Promise<string> {
    await this.ensureWindsurfSessionCredential();
    const raw = this.readApiKey();
    if (keyLikeSessionToken(raw)) {
      return raw;
    }
    return this.readApiKey();
  }

  private resolveGrpcPort(): number | undefined {
    return this.windsurfRuntime.lsPort || WINDSURF_DEFAULT_LS_PORT;
  }

  private resolveGrpcCsrfToken(): string | undefined {
    const token = typeof this.windsurfRuntime.csrfToken === 'string' ? this.windsurfRuntime.csrfToken.trim() : '';
    return token || undefined;
  }

  private async ensureCascadeWorkspace(apiKey: string): Promise<WindsurfLangserverEntry> {
    return ensureWindsurfLangserverReady({
      apiKey,
      port: this.resolveGrpcPort(),
      csrfToken: this.resolveGrpcCsrfToken(),
      workspacePath: resolveWindsurfWorkspacePath(apiKey),
    });
  }

  private async startCascade(apiKey: string, lsEntry: WindsurfLangserverEntry): Promise<string> {
    let startResp: Buffer;
    try {
      startResp = await grpcUnary(
        lsEntry.port,
        lsEntry.csrfToken,
        `${LS_SERVICE}/StartCascade`,
        grpcFrame(buildStartCascadeRequest(apiKey, lsEntry.sessionId || randomUUID())),
        10000,
      );
    } catch (error) {
      if (isWindsurfCascadeTransportError(error)) {
        resetWindsurfLangserverSession(lsEntry);
      }
      throw error;
    }
    const cascadeId = parseStartCascadeResponse(startResp);
    if (!cascadeId) {
      throw new Error('StartCascade returned empty cascade_id');
    }
    return cascadeId;
  }

  private buildCascadePrompt(
    messages: Array<{ role: string; content: string }>,
    toolsPreamble: unknown,
  ): string {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean).join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system');
    const toolBlock = typeof toolsPreamble === 'string' && toolsPreamble.trim()
      ? `${toolsPreamble.trim()}\n\n`
      : '';
    if (convo.length <= 1) {
      const latest = convo[0]?.content || '';
      return `${toolBlock}${system ? `${system}\n\n` : ''}${latest}`.trim();
    }
    const historyLines = convo.slice(0, -1).map((m) => {
      const tag = m.role === 'assistant' ? 'assistant' : 'human';
      return `<${tag}>\n${m.content}\n</${tag}>`;
    }).join('\n\n');
    const latest = convo[convo.length - 1];
    const latestHuman = `<human>\n${latest?.content || ''}\n</human>`;
    const historyBlock = `The following is a multi-turn conversation. You MUST remember and use all information from prior turns.\n\n${historyLines}\n\n${latestHuman}`;
    return `${toolBlock}${system ? `${system}\n\n` : ''}${historyBlock}`.trim();
  }

  private async sendCascadeMessage(
    apiKey: string,
    cascadeId: string,
    prompt: string,
    modelInfo: { modelEnum: number; modelUid?: string },
    lsEntry: WindsurfLangserverEntry,
    toolsPreamble?: unknown,
  ): Promise<void> {
    try {
      await grpcUnary(
        lsEntry.port,
        lsEntry.csrfToken,
        `${LS_SERVICE}/SendUserCascadeMessage`,
        grpcFrame(buildSendCascadeMessageRequest(
          apiKey,
          cascadeId,
          prompt,
          modelInfo.modelEnum,
          modelInfo.modelUid,
          lsEntry.sessionId || randomUUID(),
          {
            toolPreamble: typeof toolsPreamble === 'string' ? toolsPreamble : '',
          }
        )),
        30000,
      );
    } catch (error) {
      if (isWindsurfCascadeTransportError(error)) {
        resetWindsurfLangserverSession(lsEntry);
      }
      throw error;
    }
  }

  private async pollCascadeToCompletion(
    cascadeId: string,
    model: string,
    lsEntry: WindsurfLangserverEntry,
    promptChars: number,
    toolPreambleChars: number,
  ): Promise<Record<string, unknown>> {
    const pollIntervalMs = this.windsurfRuntime.pollIntervalMs || 500;
    const pollMaxWaitMs = this.windsurfRuntime.pollMaxWaitMs || 600000;
    const startedAt = Date.now();
    let idleCount = 0;
    let sawActive = false;
    let sawText = false;
    let stepOffset = 0;
    let generatorOffset = 0;
    let lastUsage: ReturnType<typeof parseGeneratorMetadata> = null;
    let lastGrowthAt = Date.now();
    let lastStepCount = 0;
    let lastStatus = -1;
    const yieldedByStep = new Map<number, number>();
    const thinkingByStep = new Map<number, number>();
    let totalText = '';
    let totalThinking = '';
    const idleGraceMs = 8000;
    const coldStallBaseMs = 30000;
    const warmStallMs = 45000;
    const warmStallThinkingMs = 120000;
    const stallRetryMinText = 300;

    while (Date.now() - startedAt < pollMaxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      let stepsResp: Buffer;
      try {
        stepsResp = await grpcUnary(
          lsEntry.port,
          lsEntry.csrfToken,
          `${LS_SERVICE}/GetCascadeTrajectorySteps`,
          grpcFrame(buildGetTrajectoryStepsRequest(cascadeId, stepOffset)),
          15000,
        );
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          resetWindsurfLangserverSession(lsEntry);
        }
        throw error;
      }
      const steps = parseTrajectorySteps(stepsResp);
      if (steps.length > 0) {
        if (steps.length > lastStepCount) {
          lastStepCount = steps.length;
          lastGrowthAt = Date.now();
        }
        for (let i = 0; i < steps.length; i += 1) {
          const step = steps[i];
          if (step.type === 17 && step.errorText) {
            const error = new Error(step.errorText.trim() || 'windsurf cascade error step');
            (error as Error & { isModelError?: boolean; kind?: string }).isModelError = true;
            (error as Error & { isModelError?: boolean; kind?: string }).kind = 'model_error';
            throw error;
          }
          const liveThinking = step.thinking || '';
          if (liveThinking) {
            const prevThinking = thinkingByStep.get(i) || 0;
            if (liveThinking.length > prevThinking) {
              const delta = liveThinking.slice(prevThinking);
              thinkingByStep.set(i, liveThinking.length);
              totalThinking += delta;
              lastGrowthAt = Date.now();
            }
          }

          const liveText = step.responseText || step.text || '';
          if (liveText) {
            const prevText = yieldedByStep.get(i) || 0;
            if (liveText.length > prevText) {
              const delta = liveText.slice(prevText);
              yieldedByStep.set(i, liveText.length);
              totalText += delta;
              sawText = true;
              lastGrowthAt = Date.now();
            }
          }

          if (step.modifiedText) {
            const liveModified = step.modifiedText;
            const responseLen = (step.responseText || '').length;
            const currentCursor = yieldedByStep.get(i) || 0;
            if (liveModified.length > currentCursor && liveModified.startsWith(step.responseText || '')) {
              const delta = liveModified.slice(currentCursor);
              yieldedByStep.set(i, liveModified.length);
              totalText += delta;
              lastGrowthAt = Date.now();
            } else if (!step.responseText && liveModified.length > currentCursor) {
              const delta = liveModified.slice(currentCursor);
              yieldedByStep.set(i, liveModified.length);
              totalText += delta;
              lastGrowthAt = Date.now();
            } else if (responseLen > currentCursor) {
              yieldedByStep.set(i, responseLen);
            }
          }

        }
      }

      const elapsed = Date.now() - startedAt;
      const effectiveChars = promptChars + toolPreambleChars;
      const coldStallMs = Math.min(pollMaxWaitMs, coldStallBaseMs + Math.floor(Math.max(effectiveChars, 1) / 1500) * 5000);
      if (elapsed > coldStallMs && sawActive && !sawText && totalThinking.length === 0) {
        throw new Error(`Cascade planner stalled — no output after ${Math.round(coldStallMs / 1000)}s`);
      }

      let statusResp: Buffer;
      try {
        statusResp = await grpcUnary(
          lsEntry.port,
          lsEntry.csrfToken,
          `${LS_SERVICE}/GetCascadeTrajectory`,
          grpcFrame(buildGetTrajectoryRequest(cascadeId)),
          10000,
        );
      } catch (error) {
        if (isWindsurfCascadeTransportError(error)) {
          resetWindsurfLangserverSession(lsEntry);
        }
        throw error;
      }
      const status = parseTrajectoryStatus(statusResp);
      lastStatus = status;
      if (status !== 1) {
        sawActive = true;
        idleCount = 0;
      }

      try {
        const metaResp = await grpcUnary(
          lsEntry.port,
          lsEntry.csrfToken,
          `${LS_SERVICE}/GetCascadeTrajectoryGeneratorMetadata`,
          grpcFrame(buildGetGeneratorMetadataRequest(cascadeId, generatorOffset)),
          5000,
        );
        const metadata = parseGeneratorMetadata(metaResp);
        if (metadata) {
          generatorOffset += metadata.entryCount;
          lastUsage = metadata;
        }
      } catch {
        // usage fetch is non-blocking
      }

      const msSinceGrowth = Date.now() - lastGrowthAt;
      const hasActiveStep = steps.some((step) => step && step.status === 1);
      const effectiveWarmStallMs = hasActiveStep
        ? 180000
        : totalThinking.length > 0
          ? warmStallThinkingMs
          : warmStallMs;
      if (sawText && lastStatus !== 1 && msSinceGrowth > effectiveWarmStallMs) {
        if (totalText.length < stallRetryMinText) {
          throw new Error(`Cascade planner stalled after preamble — no progress for ${Math.round(effectiveWarmStallMs / 1000)}s`);
        }
        break;
      }

      if (status === 1) {
        const graceOver = Date.now() - startedAt > idleGraceMs;
        if (!sawActive && !graceOver) {
          continue;
        }
        idleCount += 1;
        const growthSettled = (Date.now() - lastGrowthAt) > pollIntervalMs * 2;
        const canBreak = sawText ? (idleCount >= 2 && growthSettled) : idleCount >= 4;
        if (!canBreak) {
          continue;
        }
        let finalStepsResp: Buffer | null = null;
        try {
          finalStepsResp = await grpcUnary(
            lsEntry.port,
            lsEntry.csrfToken,
            `${LS_SERVICE}/GetCascadeTrajectorySteps`,
            grpcFrame(buildGetTrajectoryStepsRequest(cascadeId, stepOffset)),
            15000,
          );
        } catch (error) {
          if (isWindsurfCascadeTransportError(error)) {
            resetWindsurfLangserverSession(lsEntry);
          }
          throw error;
        }
        const finalSteps = parseTrajectorySteps(finalStepsResp);
        if (finalSteps.length > 0) {
          lastStepCount = finalSteps.length;
          for (let i = 0; i < finalSteps.length; i += 1) {
            const step = finalSteps[i];

            const responseText = step.responseText || '';
            const modifiedText = step.modifiedText || '';
            const previousText = yieldedByStep.get(i) || 0;
            if (responseText.length > previousText) {
              const delta = responseText.slice(previousText);
              yieldedByStep.set(i, responseText.length);
              totalText += delta;
            }

            const cursor = yieldedByStep.get(i) || 0;
            if (modifiedText.length > cursor && modifiedText.startsWith(responseText)) {
              const delta = modifiedText.slice(cursor);
              yieldedByStep.set(i, modifiedText.length);
              totalText += delta;
            }

            const liveThinking = step.thinking || '';
            const previousThinking = thinkingByStep.get(i) || 0;
            if (liveThinking.length > previousThinking) {
              const delta = liveThinking.slice(previousThinking);
              thinkingByStep.set(i, liveThinking.length);
              totalThinking += delta;
            }
          }
        }
        this.logWindsurfStage('pollCascadeToCompletion.exit', {
          cascadeId,
          reason: totalText.trim() || totalThinking.trim() ? 'idle_done' : 'idle_empty',
          elapsedMs: Date.now() - startedAt,
          textChars: totalText.length,
          thinkingChars: totalThinking.length,
        });
        break;
      }
    }

    if (!totalText.trim() && !totalThinking.trim()) {
      this.logWindsurfStage('pollCascadeToCompletion.empty', {
        cascadeId,
        elapsedMs: Date.now() - startedAt,
        stepOffset,
        generatorOffset,
      });
      throw new Error('windsurf cascade returned empty completion');
    }

    this.logWindsurfStage('pollCascadeToCompletion.done', {
      cascadeId,
      elapsedMs: Date.now() - startedAt,
      textChars: totalText.length,
      thinkingChars: totalThinking.length,
      hasUsage: !!lastUsage,
    });

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: totalText,
            ...(totalThinking.trim() ? { reasoning_content: totalThinking } : {}),
          },
          finish_reason: 'stop',
        },
      ],
      ...(lastUsage ? {
        usage: {
          input_tokens: lastUsage.inputTokens,
          output_tokens: lastUsage.outputTokens,
          total_tokens: lastUsage.inputTokens + lastUsage.outputTokens,
          input_tokens_details: {
            cached_tokens: lastUsage.cacheReadTokens,
          },
        },
      } : {}),
    };
  }

  private classifyWindsurfCascadeError(error: unknown): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    const classified = new Error(source.message) as Error & Record<string, unknown>;
    const message = source.message.toLowerCase();
    const isWeeklyQuota =
      message.includes('weekly usage quota has been exhausted')
      || message.includes('weekly quota has been exhausted')
      || message.includes('weekly usage quota exhausted');
    const isAuth = message.includes('unauthenticated') || message.includes('permission_denied');
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
    classified.transportBackend = this.windsurfRuntime.transportBackend || 'grpc';
    classified.lsPort = this.resolveGrpcPort();
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

/**
 * Gemini HTTP Provider (V2)
 *
 * 以 Gemini Chat 协议（gemini-chat）为目标，调用 Google Generative Language API。
 * - 默认基地址：https://generativelanguage.googleapis.com/v1beta
 * - 生成路径：/models/{model}:generateContent
 * - 认证：优先使用 header 'x-goog-api-key: <API_KEY>'；若仅提供 Authorization: Bearer <key>，自动转换为 x-goog-api-key。
 * - 形状转换：在 preprocessRequest 做最小映射（OpenAI Chat → Gemini contents）；若已经是 Gemini 形状（contents/systemInstruction）则透传。
 */

import { BaseProvider } from './base-provider.js';
import { HttpClient } from '../utils/http-client.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';

export class GeminiHttpProvider extends BaseProvider {
  readonly type = 'gemini-http-provider';

  private httpClient!: HttpClient;
  private serviceProfile: ServiceProfile;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    super({ ...config, config: { ...config.config, providerType: 'gemini' as ProviderType } }, dependencies);
    this.serviceProfile = this.getServiceProfile();
    this.createHttpClient();
  }

  protected getServiceProfile(): ServiceProfile {
    return {
      defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultEndpoint: '/models:generateContent', // 实际发送时注入 /{model}:generateContent
      defaultModel: '',
      requiredAuth: ['apikey'],
      optionalAuth: [],
      headers: { 'Content-Type': 'application/json' },
      timeout: 300000,
      maxRetries: 2
    };
  }

  protected createAuthProvider(): any {
    // 复用 ApiKeyAuthProvider；允许使用自定义 headerName（x-goog-api-key）
    const auth = (this.config as any)?.config?.auth || { type: 'apikey' };
    const { ApiKeyAuthProvider } = require('../auth/apikey-auth.js');
    // 若未设置 headerName，允许后续在 headers 构建时将 Authorization 转换为 x-goog-api-key
    return new ApiKeyAuthProvider(auth);
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const r: any = request || {};
    const body: any = (r && typeof r === 'object' && r.data && typeof r.data === 'object') ? r.data : r;

    // 如果已经是 Gemini 形状（存在 contents 或 systemInstruction），透传
    if (Array.isArray(body?.contents) || body?.systemInstruction) {
      return request;
    }

    // OpenAI Chat → Gemini contents 映射（最小化，仅文本）
    const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
    const systemMsgs = messages.filter((m) => m?.role === 'system' && typeof m?.content === 'string');
    const userOrAsst = messages.filter((m) => m?.role === 'user' || m?.role === 'assistant');
    const contents = userOrAsst.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));
    const systemInstruction = systemMsgs.length > 0
      ? { role: 'system', parts: [{ text: systemMsgs.map((s)=>s.content).join('\n') }] }
      : undefined;

    const generationConfig: any = {};
    if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
    if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
    if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;

    const rebuilt = {
      ...body,
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    };

    // 删除 OpenAI 专属字段
    delete (rebuilt as any).messages;
    delete (rebuilt as any).stream;

    // 回写到 request
    if (r && typeof r === 'object' && r.data && typeof r.data === 'object') {
      r.data = rebuilt;
      return r as UnknownObject;
    }
    return rebuilt as UnknownObject;
  }

  protected async postprocessResponse(response: unknown, _context: ProviderContext): Promise<unknown> {
    // 保持上游 JSON 原样返回；Composite 在响应侧仅做形状守卫（允许 candidates/content 等）
    return response;
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const headers = await this.buildRequestHeaders();

    const bodyAny: any = (request as any)?.data || (request as any) || {};
    const model = typeof bodyAny?.model === 'string' ? bodyAny.model.trim() : '';
    if (!model) {
      throw new Error('provider-runtime-error: missing model from virtual router');
    }

    // 构造 URL: /models/{model}:generateContent
    const base = this.getEffectiveBaseUrl();
    const path = `/models/${encodeURIComponent(model)}:generateContent`;
    let url = `${base.replace(/\/$/, '')}${path}`;

    // 删除 body.model，避免与路径重复
    try { if ('model' in bodyAny) delete bodyAny.model; } catch { /* ignore */ }

    // 发送 JSON 请求
    const resp = await this.httpClient.post(url.replace(this.getEffectiveBaseUrl(), ''), bodyAny, headers);
    return resp;
  }

  protected async onInitialize(): Promise<void> {
    // 初始化 HTTP 客户端
    this.createHttpClient();
    // 初始化 Auth 提供者（使用基类）
    try { (this as any).authProvider = this.createAuthProvider(); await (this as any).authProvider.initialize?.(); } catch { /* allow missing auth in init; build headers will throw */ }
  }

  private createHttpClient(): void {
    const profile = this.serviceProfile;
    const baseUrl = this.getEffectiveBaseUrl();
    const timeout = this.config.config.overrides?.timeout ?? profile.timeout ?? 300000;
    const maxRetries = this.config.config.overrides?.maxRetries ?? profile.maxRetries ?? 2;
    const headers = { ...(profile.headers||{}), ...(this.config.config.overrides?.headers||{}) } as Record<string, string>;
    this.httpClient = new HttpClient({ baseUrl, timeout, maxRetries, defaultHeaders: headers });
  }

  private getEffectiveBaseUrl(): string {
    return (
      this.config.config.overrides?.baseUrl ||
      this.config.config.baseUrl ||
      this.serviceProfile.defaultBaseUrl
    );
  }

  private async buildRequestHeaders(): Promise<Record<string, string>> {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const serviceHeaders = this.serviceProfile.headers || {};
    const overrideHeaders = (this.config as any)?.config?.overrides?.headers || {};
    let authHeaders: Record<string, string> = {};
    try { authHeaders = (this as any).authProvider?.buildHeaders?.() || {}; } catch { authHeaders = {}; }
    return { ...baseHeaders, ...serviceHeaders, ...overrideHeaders, ...authHeaders };
  }
}

export default GeminiHttpProvider;

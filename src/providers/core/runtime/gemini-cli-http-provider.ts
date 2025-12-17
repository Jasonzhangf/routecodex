/**
 * Gemini CLI HTTP Provider
 *
 * 以 Gemini CLI 协议（gemini-cli）为目标，调用 Google Cloud Code Assist API。
 * - 默认基地址：https://cloudcode-pa.googleapis.com/v1internal
 * - 生成路径：/:generateContent, /:streamGenerateContent, /:countTokens
 * - 认证：OAuth2 Bearer token
 * - 特性：多 project 支持、token 共享、模型回退
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { GeminiCLIProtocolClient } from '../../../client/gemini-cli/gemini-cli-protocol-client.js';
import { getDefaultProjectId } from '../../auth/gemini-cli-userinfo-helper.js';

type DataEnvelope = UnknownObject & { data?: UnknownObject };

type MutablePayload = Record<string, unknown> & {
  model?: unknown;
  project?: unknown;
  contents?: unknown;
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown>;
};

export class GeminiCLIHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        // 使用统一的 providerType=gemini，表示协议族与标准 Gemini 一致
        // gemini-cli 仅作为 Cloud Code Assist 变体，通过模块类型 + auth 配置区分
        providerType: 'gemini' as ProviderType
      }
    };
    super(cfg, dependencies, 'gemini-cli-http-provider', new GeminiCLIProtocolClient());
  }

  protected getServiceProfile(): ServiceProfile {
    // 完全依赖 service-profiles / config-core 提供的行为配置，避免在 Provider 内重复硬编码
    return super.getServiceProfile();
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const adapter = this.resolvePayload(request);
    const payload = adapter.payload as MutablePayload;

    // 从 auth provider 获取 project_id（仅做最小的 OAuth token 解析，不介入登录流程）
    if (!this.authProvider) {
      throw new Error('Gemini CLI: auth provider not found');
    }

    const oauthClient = (this.authProvider as any).getOAuthClient?.();
    const tokenData = oauthClient?.getToken?.();
    const projectId = getDefaultProjectId(tokenData || {});

    if (!projectId) {
      throw new Error(
        'Gemini CLI: project_id not found in token. Please authenticate with Google OAuth first.'
      );
    }

    // 构建 Gemini CLI 格式的请求
    const model = typeof payload.model === 'string' ? payload.model : '';
    if (!model) {
      throw new Error('Gemini CLI: model is required');
    }

    // 转换 messages 到 contents (如果存在)
    let contents = payload.contents;
    if (!contents && Array.isArray((payload as any).messages)) {
      contents = this.convertMessagesToContents((payload as any).messages);
    }

    // 构建 generationConfig
    const generationConfig = this.buildGenerationConfig(payload);

    const rebuilt: MutablePayload = {
      ...payload,
      model,
      project: projectId
    };

    if (contents) {
      rebuilt.contents = contents;
    }
    if (Object.keys(generationConfig).length > 0) {
      rebuilt.generationConfig = generationConfig;
    }

    // 删除不必要的字段
    delete rebuilt.messages;
    delete rebuilt.stream;

    return adapter.assign(rebuilt);
  }

  protected override async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    if (response && typeof response === 'object') {
      return response as UnknownObject;
    }
    return { data: response } as UnknownObject;
  }

  private resolvePayload(source: UnknownObject): {
    payload: MutablePayload;
    assign(updated: MutablePayload): UnknownObject;
  } {
    if (this.hasDataEnvelope(source)) {
      const envelope = source as DataEnvelope;
      const dataRecord = (envelope.data && typeof envelope.data === 'object')
        ? (envelope.data as MutablePayload)
        : {};
      if (!envelope.data || typeof envelope.data !== 'object') {
        envelope.data = dataRecord;
      }
      return {
        payload: dataRecord,
        assign: (updated) => {
          envelope.data = updated;
          return source;
        }
      };
    }
    return {
      payload: source as MutablePayload,
      assign: (updated) => updated
    };
  }

  protected hasDataEnvelope(payload: UnknownObject): payload is DataEnvelope {
    return typeof payload === 'object' && payload !== null && 'data' in payload;
  }

  private convertMessagesToContents(messages: unknown[]): unknown[] {
    return messages
      .filter((msg): msg is UnknownObject => typeof msg === 'object' && msg !== null)
      .map((message) => {
        const role = (message.role === 'assistant' ? 'model' : 'user') as string;
        const content = this.normalizeMessageContent(message.content);
        return { role, parts: [{ text: content }] };
      });
  }

  private normalizeMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n');
    }
    return JSON.stringify(content ?? '');
  }

  private buildGenerationConfig(payload: MutablePayload): Record<string, unknown> {
    const generationConfig =
      typeof payload.generationConfig === 'object' && payload.generationConfig !== null
        ? { ...(payload.generationConfig as Record<string, unknown>) }
        : {};

    if (typeof payload.max_tokens === 'number') {
      generationConfig.maxOutputTokens = payload.max_tokens;
    }
    if (typeof payload.temperature === 'number') {
      generationConfig.temperature = payload.temperature;
    }
    if (typeof payload.top_p === 'number') {
      generationConfig.topP = payload.top_p;
    }
    if (typeof payload.top_k === 'number') {
      generationConfig.topK = payload.top_k;
    }

    return generationConfig;
  }

  /**
   * 获取模型回退列表（用于处理 429 限流）
   * 参考 CLIProxyAPI 的 cliPreviewFallbackOrder
   */
  protected getFallbackModels(model: string): string[] {
    const fallbackMap: Record<string, string[]> = {
      'gemini-2.5-pro': ['gemini-2.5-pro-preview-06-05'],
      'gemini-2.5-flash': [],
      'gemini-2.5-flash-lite': []
    };
    return fallbackMap[model] || [];
  }
}

export default GeminiCLIHttpProvider;

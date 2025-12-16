/**
 * Gemini CLI Protocol Client
 *
 * 处理 Gemini CLI API 的协议层逻辑
 * - 请求体构建
 * - Endpoint 解析
 * - Header 最终化（添加 OAuth Bearer token）
 */

import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import type { UnknownObject } from '../../types/common-types.js';

interface DataEnvelope {
  data?: UnknownObject;
}

interface GeminiCLIPayload extends UnknownObject {
  model?: string;
  project?: string;
  contents?: unknown;
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown>;
  action?: string;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

export class GeminiCLIProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);

    // 保持原生 Gemini CLI 格式
    const body: GeminiCLIPayload = { ...payload };

    // 移除不必要的字段
    delete (body as any).stream;

    return body;
  }

  resolveEndpoint(request: ProtocolRequestPayload, defaultEndpoint: string): string {
    const payload = this.extractPayload(request);
    const action = (payload.action as string) || 'generateContent';

    // 根据 action 返回对应的 endpoint
    // generateContent, streamGenerateContent, countTokens
    return `/v1internal:${action}`;
  }

  finalizeHeaders(
    headers: Record<string, string>,
    _request: ProtocolRequestPayload
  ): Record<string, string> {
    const normalized: Record<string, string> = { ...headers };

    // 确保包含必需的 headers
    if (!normalized['User-Agent']) {
      normalized['User-Agent'] = 'google-api-nodejs-client/9.15.1';
    }
    if (!normalized['X-Goog-Api-Client']) {
      normalized['X-Goog-Api-Client'] = 'gl-node/22.17.0';
    }
    if (!normalized['Client-Metadata']) {
      normalized['Client-Metadata'] = 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI';
    }
    if (!normalized['Accept']) {
      normalized['Accept'] = 'application/json';
    }

    return normalized;
  }

  private extractPayload(request: ProtocolRequestPayload): GeminiCLIPayload {
    if (hasDataEnvelope(request)) {
      const envelopeData = request.data;
      if (envelopeData && typeof envelopeData === 'object') {
        return envelopeData as GeminiCLIPayload;
      }
    }
    return { ...(request as Record<string, unknown>) } as GeminiCLIPayload;
  }
}

export default GeminiCLIProtocolClient;

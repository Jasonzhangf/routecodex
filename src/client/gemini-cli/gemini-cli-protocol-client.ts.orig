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
  metadata?: unknown;
  action?: string;
  requestId?: string;
  userAgent?: string;
   requestType?: string;
  session_id?: string;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

export class GeminiCLIProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);

    // 顶层字段：model / project / action / request metadata
    const { model, project, action, requestId, userAgent, requestType, metadata: _metadata, ...rest } = payload;

    const body: Record<string, unknown> = {};
    if (typeof model === 'string' && model.length > 0) {
      body.model = model;
    }
    if (typeof project === 'string' && project.length > 0) {
      body.project = project;
    }
    if (typeof requestId === 'string' && requestId.length > 0) {
      body.requestId = requestId;
    }
    if (typeof userAgent === 'string' && userAgent.length > 0) {
      body.userAgent = userAgent;
    }
    if (typeof requestType === 'string' && requestType.length > 0) {
      body.requestType = requestType;
    }

    // 其余 Gemini Chat 兼容字段（contents/systemInstruction/generationConfig/tools/metadata 等）
    // 统一放到 request 下，对齐 Cloud Code Assist v1internal:generateContent 的预期形状
    const requestPayload: Record<string, unknown> = { ...rest };
    // 显式移除 OpenAI 兼容字段
    delete (requestPayload as any).stream;

    if (Object.keys(requestPayload).length > 0) {
      body.request = requestPayload;
    }

    return body;
  }

  resolveEndpoint(request: ProtocolRequestPayload, defaultEndpoint: string): string {
    const payload = this.extractPayload(request);
    const action = (payload.action as string) || 'generateContent';
    const endpoint = `/v1internal:${action}`;

    // 根据 action 返回对应的 endpoint
    // generateContent, streamGenerateContent, countTokens
    if (action === 'streamGenerateContent') {
      return `${endpoint}?alt=sse`;
    }
    return endpoint;
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

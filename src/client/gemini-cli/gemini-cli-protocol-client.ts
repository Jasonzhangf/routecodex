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
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

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
    // 注意：Cloud Code Assist 的 request schema 不接受 request.metadata / request.action。
    // action 仅用于 resolveEndpoint；metadata 不下发到上游。
    const { model, project, requestId, userAgent, requestType, ...rest } = payload;
    const isAntigravity = typeof userAgent === 'string' && userAgent.trim() === 'antigravity';

    const body: Record<string, unknown> = {};
    if (typeof model === 'string' && model.length > 0) {
      body.model = model;
    }
    if (typeof project === 'string' && project.length > 0) {
      body.project = project;
    }
    // opencode-antigravity-auth alignment:
    // - antigravity keeps requestId/userAgent/requestType in JSON wrapper
    // - headers may still carry the same values
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
    const payloadRecord = requestPayload as Record<string, unknown>;
    delete payloadRecord.stream;
    // Cloud Code Assist: request 不接受 metadata/action/web_search 等非标准字段
    delete payloadRecord.metadata;
    delete payloadRecord.action;
    delete payloadRecord.web_search;

    if (Object.keys(requestPayload).length > 0) {
      body.request = requestPayload;
    }

    return stripInternalKeysDeep(body);
  }

  resolveEndpoint(request: ProtocolRequestPayload, _defaultEndpoint: string): string {
    const payload = this.extractPayload(request);
    const action = (payload.action as string) || 'generateContent';
    const defaultEndpoint = typeof _defaultEndpoint === 'string' ? _defaultEndpoint.trim() : '';
    const base =
      defaultEndpoint && defaultEndpoint.includes(':')
        ? defaultEndpoint.replace(/:[^/?]+/, '')
        : '/v1internal';
    const endpoint = `${base}:${action}`;

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

    const deleteHeaderInsensitive = (target: string): void => {
      const lowered = target.toLowerCase();
      for (const key of Object.keys(normalized)) {
        if (key.toLowerCase() === lowered) {
          delete normalized[key];
        }
      }
    };

    // gcli2api / opencode alignment: do not forward client identifiers.
    deleteHeaderInsensitive('session_id');
    deleteHeaderInsensitive('conversation_id');

    const payload = this.extractPayload(_request);
    const isAntigravity = typeof payload.userAgent === 'string' && payload.userAgent.trim() === 'antigravity';
    if (isAntigravity) {
      // Antigravity Tools alignment: do not send Gemini CLI header triplet.
      deleteHeaderInsensitive('x-goog-api-client');
      deleteHeaderInsensitive('client-metadata');
    } else if (!isAntigravity) {
      // gcli2api / opencode alignment: keep a stable header triplet for Gemini CLI.
      // Always override inbound UA to avoid leaking host/client fingerprints into upstream.
      normalized['User-Agent'] = 'google-api-nodejs-client/9.15.1';
      normalized['X-Goog-Api-Client'] = 'gl-node/22.17.0';
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

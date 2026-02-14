/**
 * iFlow Signature Builder
 *
 * 构建 iFlow 特有的签名头部：
 * - x-iflow-timestamp
 * - x-iflow-signature
 */

import { createHmac } from 'node:crypto';
import { DEFAULT_PROVIDER } from '../../../../constants/index.js';
import { HeaderUtils } from './header-utils.js';

export class IflowSigner {
  static enforceIflowCliHeaders(headers: Record<string, string>): void {
    const resolvedSessionId =
      HeaderUtils.findHeaderValue(headers, 'session-id') ??
      HeaderUtils.findHeaderValue(headers, 'session_id') ??
      '';
    const resolvedConversationId =
      HeaderUtils.findHeaderValue(headers, 'conversation-id') ??
      HeaderUtils.findHeaderValue(headers, 'conversation_id') ??
      resolvedSessionId;

    if (resolvedSessionId) {
      HeaderUtils.assignHeader(headers, 'session-id', resolvedSessionId);
    }
    if (resolvedConversationId) {
      HeaderUtils.assignHeader(headers, 'conversation-id', resolvedConversationId);
    }

    const bearerApiKey = IflowSigner.extractBearerApiKey(headers);
    if (!bearerApiKey) {
      return;
    }

    const userAgent = HeaderUtils.findHeaderValue(headers, 'User-Agent') ?? 'iFlow-Cli';
    const timestamp = Date.now().toString();
    const signature = IflowSigner.buildIflowSignature(userAgent, resolvedSessionId, timestamp, bearerApiKey);
    if (!signature) {
      return;
    }

    HeaderUtils.assignHeader(headers, 'x-iflow-timestamp', timestamp);
    HeaderUtils.assignHeader(headers, 'x-iflow-signature', signature);
  }

  private static extractBearerApiKey(headers: Record<string, string>): string | undefined {
    const authorization = HeaderUtils.findHeaderValue(headers, 'Authorization');
    if (!authorization) {
      return undefined;
    }
    const matched = authorization.match(/^Bearer\s+(.+)$/i);
    if (!matched || !matched[1]) {
      return undefined;
    }
    const apiKey = matched[1].trim();
    return apiKey || undefined;
  }

  private static buildIflowSignature(
    userAgent: string,
    sessionId: string,
    timestamp: string,
    apiKey: string
  ): string | undefined {
    if (!apiKey) {
      return undefined;
    }
    const payload = `${userAgent}:${sessionId}:${timestamp}`;
    try {
      return createHmac(DEFAULT_PROVIDER.IFLOW_SIGNATURE_ALGORITHM, apiKey).update(payload, 'utf8').digest('hex');
    } catch {
      return undefined;
    }
  }
}

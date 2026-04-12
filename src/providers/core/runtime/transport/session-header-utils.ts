import { createHash } from 'node:crypto';
import type { ProviderRuntimeMetadata } from '../provider-runtime-metadata.js';
import { CODEX_IDENTIFIER_MAX_LENGTH } from '../../../../constants/index.js';
import { HeaderUtils } from './header-utils.js';
import { ProviderPayloadUtils } from './provider-payload-utils.js';

export class SessionHeaderUtils {
  private static readIdentifier(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private static ensureRuntimeMetadataCarrier(
    runtimeMetadata?: ProviderRuntimeMetadata
  ): Record<string, unknown> | undefined {
    if (!runtimeMetadata) {
      return undefined;
    }
    if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
      runtimeMetadata.metadata = {};
    }
    return runtimeMetadata.metadata as Record<string, unknown>;
  }

  static ensureCodexSessionMetadata(
    runtimeMetadata?: ProviderRuntimeMetadata
  ): { sessionId?: string; conversationId?: string } {
    const metadata = SessionHeaderUtils.ensureRuntimeMetadataCarrier(runtimeMetadata);
    if (!metadata) {
      return {};
    }

    const existingSessionId =
      SessionHeaderUtils.readIdentifier(metadata.sessionId)
      ?? SessionHeaderUtils.readIdentifier(metadata.session_id)
      ?? SessionHeaderUtils.readIdentifier((runtimeMetadata as Record<string, unknown>)?.sessionId);
    const existingConversationId =
      SessionHeaderUtils.readIdentifier(metadata.conversationId)
      ?? SessionHeaderUtils.readIdentifier(metadata.conversation_id)
      ?? SessionHeaderUtils.readIdentifier((runtimeMetadata as Record<string, unknown>)?.conversationId);

    const sessionId =
      existingSessionId
      ?? existingConversationId
      ?? SessionHeaderUtils.buildCodexIdentifier('session', runtimeMetadata);
    const conversationId =
      existingConversationId
      ?? existingSessionId
      ?? SessionHeaderUtils.buildCodexIdentifier('conversation', runtimeMetadata);

    metadata.sessionId = sessionId;
    metadata.conversationId = conversationId;
    (runtimeMetadata as Record<string, unknown>).sessionId = sessionId;
    (runtimeMetadata as Record<string, unknown>).conversationId = conversationId;
    return { sessionId, conversationId };
  }

  static normalizeCodexClientHeaders(
    headers: Record<string, string> | undefined,
    codexUaMode: boolean
  ): Record<string, string> | undefined {
    if (!headers) {
      return undefined;
    }
    if (!codexUaMode) {
      return headers;
    }
    const normalizedHeaders = { ...headers };
    HeaderUtils.copyHeaderValue(normalizedHeaders, headers, 'anthropic-session-id', 'session_id');
    HeaderUtils.copyHeaderValue(normalizedHeaders, headers, 'anthropic-conversation-id', 'conversation_id');
    HeaderUtils.copyHeaderValue(normalizedHeaders, headers, 'anthropic-user-agent', 'User-Agent');
    HeaderUtils.copyHeaderValue(normalizedHeaders, headers, 'anthropic-originator', 'originator');
    return normalizedHeaders;
  }

  static ensureCodexSessionHeaders(
    headers: Record<string, string>,
    runtimeMetadata?: ProviderRuntimeMetadata
  ): void {
    const runtimeMetadataRecord =
      runtimeMetadata && typeof runtimeMetadata === 'object'
        ? (runtimeMetadata as Record<string, unknown>)
        : undefined;
    const runtimeMetadataCarrier =
      runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
        ? (runtimeMetadata.metadata as Record<string, unknown>)
        : undefined;
    const existingSessionId =
      SessionHeaderUtils.readIdentifier(HeaderUtils.findHeaderValue(headers, 'session_id'))
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataCarrier?.sessionId)
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataCarrier?.session_id)
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataRecord?.sessionId);
    const existingConversationId =
      SessionHeaderUtils.readIdentifier(HeaderUtils.findHeaderValue(headers, 'conversation_id'))
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataCarrier?.conversationId)
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataCarrier?.conversation_id)
      ?? SessionHeaderUtils.readIdentifier(runtimeMetadataRecord?.conversationId);
    const resolvedSessionId =
      existingSessionId
      ?? existingConversationId
      ?? SessionHeaderUtils.buildCodexIdentifier('session', runtimeMetadata);
    const resolvedConversationId =
      existingConversationId
      ?? existingSessionId
      ?? SessionHeaderUtils.buildCodexIdentifier('conversation', runtimeMetadata);

    HeaderUtils.setHeaderIfMissing(headers, 'session_id', resolvedSessionId);
    HeaderUtils.setHeaderIfMissing(headers, 'conversation_id', resolvedConversationId);
  }

  static extractClientHeaders(
    source?: Record<string, unknown> | ProviderRuntimeMetadata
  ): Record<string, string> | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const candidates: unknown[] = [];
    const metadataNode = (source as { metadata?: unknown }).metadata;
    if (metadataNode && typeof metadataNode === 'object') {
      const headersNode = (metadataNode as Record<string, unknown>).clientHeaders;
      if (headersNode) {
        candidates.push(headersNode);
      }
    }
    const directNode = (source as { clientHeaders?: unknown }).clientHeaders;
    if (directNode) {
      candidates.push(directNode);
    }
    for (const candidate of candidates) {
      const normalized = ProviderPayloadUtils.normalizeClientHeaders(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private static buildCodexIdentifier(
    kind: 'session' | 'conversation',
    runtimeMetadata?: ProviderRuntimeMetadata
  ): string {
    const fallbackId = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? (runtimeMetadata.metadata as Record<string, unknown>).clientRequestId
      : undefined;
    const requestId = runtimeMetadata?.requestId ?? fallbackId;
    const routeName = runtimeMetadata?.routeName;
    const suffix = (requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      .toString()
      .replace(/[^A-Za-z0-9_-]/g, '_');
    const parts = ['codex_cli', kind, suffix];
    if (routeName) {
      parts.push(routeName.replace(/[^A-Za-z0-9_-]/g, '_'));
    }
    return SessionHeaderUtils.enforceCodexIdentifierLength(parts.join('_'));
  }

  private static enforceCodexIdentifierLength(value: string): string {
    if (value.length <= CODEX_IDENTIFIER_MAX_LENGTH) {
      return value;
    }
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
    const keep = Math.max(1, CODEX_IDENTIFIER_MAX_LENGTH - hash.length - 1);
    return `${value.slice(0, keep)}_${hash}`;
  }
}

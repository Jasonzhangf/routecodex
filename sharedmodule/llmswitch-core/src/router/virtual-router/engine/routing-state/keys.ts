import type { RouterMetadataInput } from '../../types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveConversationScopeValue(conversationId: unknown): string | undefined {
  const normalized = readText(conversationId);
  return normalized ? `conversation:${normalized}` : undefined;
}

export function resolveContinuationRequestChainKey(continuation: unknown): string | undefined {
  const row = asRecord(continuation);
  if (!row) {
    return undefined;
  }
  const stickyScope = readText(row.stickyScope);
  if (stickyScope !== 'request_chain') {
    return undefined;
  }
  const resumeFrom = asRecord(row.resumeFrom);
  return readText(row.chainId) ?? readText(resumeFrom?.requestId);
}

export function resolveLegacyResponsesRequestChainKey(responsesResume: unknown): string | undefined {
  const resume = asRecord(responsesResume);
  return readText(resume?.previousRequestId);
}

export function resolveSessionScopeValue(scope: {
  sessionId?: unknown;
  conversationId?: unknown;
}): string | undefined {
  const sessionId = readText(scope.sessionId);
  if (sessionId) {
    return `session:${sessionId}`;
  }
  return resolveConversationScopeValue(scope.conversationId);
}

function readConversationScope(metadata: RouterMetadataInput): string | undefined {
  return resolveConversationScopeValue(metadata.conversationId);
}

function readStickyScope(continuation: unknown): string | undefined {
  return readText(asRecord(continuation)?.stickyScope);
}

export function resolveSessionScope(metadata: RouterMetadataInput): string | undefined {
  return resolveSessionScopeValue(metadata);
}

export function resolveStickyKey(metadata: RouterMetadataInput): string {
  const stickyScope = readStickyScope(metadata.continuation);
  const requestChainKey = resolveContinuationRequestChainKey(metadata.continuation);
  if (requestChainKey) {
    return requestChainKey;
  }

  if (stickyScope === 'session') {
    return resolveSessionScope(metadata) ?? metadata.requestId;
  }

  if (stickyScope === 'conversation') {
    return readConversationScope(metadata) ?? resolveSessionScope(metadata) ?? metadata.requestId;
  }

  if (stickyScope === 'request') {
    return metadata.requestId;
  }

  // Migration fallback only: prefer unified continuation when present, then legacy responses resume.
  if (metadata.providerProtocol === 'openai-responses') {
    const previousRequestId = resolveLegacyResponsesRequestChainKey(metadata.responsesResume);
    if (previousRequestId) {
      return previousRequestId;
    }
    return metadata.requestId;
  }

  return resolveSessionScope(metadata) ?? metadata.requestId;
}

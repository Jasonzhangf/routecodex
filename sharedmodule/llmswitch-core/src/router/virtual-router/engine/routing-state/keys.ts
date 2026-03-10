import type { RouterMetadataInput } from '../../types.js';

export function resolveSessionScope(metadata: RouterMetadataInput): string | undefined {
  const sessionId = typeof metadata.sessionId === 'string' ? metadata.sessionId.trim() : '';
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const conversationId = typeof metadata.conversationId === 'string' ? metadata.conversationId.trim() : '';
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  return undefined;
}

export function resolveStickyKey(metadata: RouterMetadataInput): string {
  const providerProtocol = metadata.providerProtocol;

  // For Responses protocol, auto-sticky is request-chain scoped:
  // - resume/submit: stickyKey = previousRequestId (points to chain root)
  // - normal call: stickyKey = requestId
  if (providerProtocol === 'openai-responses') {
    const resume = metadata.responsesResume;
    if (resume && typeof resume.previousRequestId === 'string' && resume.previousRequestId.trim()) {
      return resume.previousRequestId.trim();
    }
    return metadata.requestId;
  }

  // Other protocols: session/conversation scoped when available.
  const sessionScope = resolveSessionScope(metadata);
  if (sessionScope) {
    return sessionScope;
  }
  return metadata.requestId;
}

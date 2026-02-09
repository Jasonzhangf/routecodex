import type { BuildRequestBodyInput, ProviderFamilyProfile } from '../profile-contracts.js';

type UnknownRecord = Record<string, unknown>;

function trimGlmRequestMessages(body: UnknownRecord): void {
  const container = body as { messages?: unknown };
  const rawMessages = container.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return;
  }
  const messages = rawMessages as unknown[];

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const entry = messages[idx];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if ((entry as Record<string, unknown>).role !== 'assistant') {
      continue;
    }
    const contentNode = (entry as { content?: unknown }).content;
    if (typeof contentNode === 'string') {
      continue;
    }
    if (contentNode === null || typeof contentNode === 'undefined') {
      (entry as { content?: string }).content = '';
      continue;
    }
    if (typeof contentNode === 'object') {
      try {
        (entry as { content?: string }).content = JSON.stringify(contentNode);
      } catch {
        (entry as { content?: string }).content = '';
      }
      continue;
    }
    (entry as { content?: string }).content = String(contentNode);
  }
}

export const glmFamilyProfile: ProviderFamilyProfile = {
  id: 'glm/default',
  providerFamily: 'glm',
  buildRequestBody(input: BuildRequestBodyInput) {
    const body = input.defaultBody;
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    trimGlmRequestMessages(body as UnknownRecord);
    return body;
  }
};

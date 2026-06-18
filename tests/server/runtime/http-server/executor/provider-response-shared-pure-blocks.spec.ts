import { describe, expect, it } from '@jest/globals';

import { shouldAllowDirectResponsesPrebuiltSsePassthrough } from '../../../../../src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.js';

describe('provider-response shared pure blocks', () => {
  it('allows prebuilt responses SSE passthrough only for direct same-protocol responses', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(true);
  });

  it('RED: rejects relay /v1/responses prebuilt SSE passthrough even when providerProtocol matches', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'relay'
    })).toBe(false);
  });

  it('RED: rejects non-direct passthrough when continuation owner is missing', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      hasSseStream: true
    })).toBe(false);
  });

  it('rejects non-responses or non-responses-protocol SSE passthrough', () => {
    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-responses',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(false);

    expect(shouldAllowDirectResponsesPrebuiltSsePassthrough({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      hasSseStream: true,
      continuationOwner: 'direct'
    })).toBe(false);
  });
});

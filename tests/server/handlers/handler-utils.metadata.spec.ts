import { describe, expect, it } from '@jest/globals';

import {
  mergePipelineMetadata,
  stripRequestBodyMetadataForPipeline
} from '../../../src/server/handlers/handler-utils.js';

describe('handler metadata merge (Phase Server-B fail-fast whitelist)', () => {
  it('throws on client routeHint metadata (no silent drop)', () => {
    expect(() => mergePipelineMetadata(
      { routeHint: 'coding' },
      { providerProtocol: 'openai-responses' }
    )).toThrow('[server.req_adapter] forbidden client metadata field: routeHint');
  });

  it('throws on client sessionId metadata (no silent drop, no sessionId in whitelist)', () => {
    expect(() => mergePipelineMetadata(
      { sessionId: 'fin' },
      { providerProtocol: 'openai-responses' }
    )).toThrow('[server.req_adapter] unsupported client metadata field: sessionId');
  });

  it('throws on client __rt metadata (no merge with internal __rt, no silent drop)', () => {
    expect(() => mergePipelineMetadata(
      { __rt: { routeHint: 'coding', keep: true } },
      { providerProtocol: 'openai-responses', __rt: { internal: true } }
    )).toThrow('[server.req_adapter] forbidden client metadata field: __rt');
  });

  it('accepts whitelisted client identity fields and forwards them', () => {
    const merged = mergePipelineMetadata(
      {
        clientRequestId: 'client-1',
        userAgent: 'ua',
        clientOriginator: 'originator',
        requestSource: 'cli',
        experimentFlag: 'A',
        appVersion: '1.0.0',
      },
      {
        providerProtocol: 'openai-responses',
        __rt: { internal: true }
      }
    );
    expect(merged).toMatchObject({
      clientRequestId: 'client-1',
      userAgent: 'ua',
      clientOriginator: 'originator',
      requestSource: 'cli',
      experimentFlag: 'A',
      appVersion: '1.0.0',
      providerProtocol: 'openai-responses',
      __rt: { internal: true }
    });
  });

  it('strips top-level request body metadata before pipeline body handoff (no metadata on wire)', () => {
    const original = {
      model: 'gpt-test',
      metadata: { session_id: 'must-not-leak' },
      input: [{ role: 'user', content: 'hello' }]
    };

    const stripped = stripRequestBodyMetadataForPipeline(original) as Record<string, unknown>;

    expect(stripped).toEqual({
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }]
    });
    expect(original.metadata).toEqual({ session_id: 'must-not-leak' });
  });
});

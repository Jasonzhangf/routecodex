import { describe, expect, it } from '@jest/globals';

import {
  buildHandlerPipelineMetadata,
  stripRequestBodyMetadataForPipeline
} from '../../../src/server/handlers/handler-utils.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

describe('handler metadata merge (Phase Server-B fail-fast whitelist)', () => {
  it('throws on client routeHint metadata (no silent drop)', () => {
    expect(() => buildHandlerPipelineMetadata(
      { routeHint: 'coding' },
      { providerProtocol: 'openai-responses' }
    )).toThrow('[server.req_adapter] forbidden client metadata field: routeHint');
  });

  it('accepts session scope metadata fields and forwards them through carrier only', () => {
    const internalMetadata = { providerProtocol: 'openai-responses' } as Record<string, unknown>;
    const center = MetadataCenter.attach(internalMetadata);
    const merged = buildHandlerPipelineMetadata(
      {
        sessionId: 'sess-1',
        session_id: 'sess-legacy',
        conversationId: 'conv-1',
        conversation_id: 'conv-legacy',
        client_tmux_session_id: 'tmux-1',
        rcc_session_client_tmux_session_id: 'tmux-legacy'
      },
      internalMetadata
    );
    expect(merged).toMatchObject({
      sessionId: 'sess-1',
      session_id: 'sess-legacy',
      conversationId: 'conv-1',
      conversation_id: 'conv-legacy',
      client_tmux_session_id: 'tmux-1',
      rcc_session_client_tmux_session_id: 'tmux-legacy',
      providerProtocol: 'openai-responses'
    });
    expect(MetadataCenter.read(merged)).toBe(center);
  });

  it('keeps session scope fields stable when request metadata is absent', () => {
    const merged = buildHandlerPipelineMetadata(undefined, {
      providerProtocol: 'openai-responses',
      sessionId: 'sess-keep',
      conversationId: 'conv-keep'
    });
    expect(merged).toMatchObject({
      providerProtocol: 'openai-responses',
      sessionId: 'sess-keep',
      conversationId: 'conv-keep'
    });
  });

  it('keeps stopMessage runtime control only inside MetadataCenter at handler boundary', () => {
    const internalMetadata = { providerProtocol: 'openai-responses' } as Record<string, unknown>;
    const center = MetadataCenter.attach(internalMetadata);
    center.writeRuntimeControl(
      'stopMessageEnabled',
      true,
      {
        module: 'tests/server/handlers/handler-utils.metadata.spec.ts',
        symbol: 'projects stopMessage runtime control into Rust-visible top-level metadata at handler boundary',
        stage: 'test'
      },
      'test stopless enablement'
    );

    const merged = buildHandlerPipelineMetadata(undefined, internalMetadata);

    expect(merged).toMatchObject({
      providerProtocol: 'openai-responses',
    });
    expect(merged.stopMessageEnabled).toBeUndefined();
    expect(merged.routecodexPortStopMessageEnabled).toBeUndefined();
    expect(MetadataCenter.read(merged)).toBe(center);
    expect(MetadataCenter.read(merged)?.readRuntimeControl().stopMessageEnabled).toBe(true);
  });

  it('throws on client __rt metadata (no merge with internal __rt, no silent drop)', () => {
    expect(() => buildHandlerPipelineMetadata(
      { __rt: { routeHint: 'coding', keep: true } },
      { providerProtocol: 'openai-responses', __rt: { internal: true } }
    )).toThrow('[server.req_adapter] forbidden client metadata field: __rt');
  });

  it('accepts whitelisted client identity fields and forwards them', () => {
    const merged = buildHandlerPipelineMetadata(
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

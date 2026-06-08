import { describe, expect, test } from '@jest/globals';

import {
  applyFollowupRuntimeMetadata,
  materializeFollowupPayload,
  resolveFollowupExecutionMode,
  resolveFollowupPayloadSource
} from '../../src/servertool/followup-runtime-block.js';

describe('servertool followup runtime block', () => {
  test('uses native skip outcome mode directly', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'reasoning_stop_finalize_flow',
        metadata: {},
        readClientInjectOnly: () => false
      })
    ).toBe('skip');
  });

  test('keeps explicit metadata client inject override authoritative at dispatch time', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'continue_execution_flow',
        metadata: { clientInjectOnly: true },
        readClientInjectOnly: (metadata) => metadata.clientInjectOnly === true
      })
    ).toBe('client_inject_only');
  });

  test('defaults normal followup flows to reenter', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'continue_execution_flow',
        metadata: {},
        readClientInjectOnly: () => false
      })
    ).toBe('reenter');
  });

  test('classifies payload source from followup plan shape', () => {
    expect(resolveFollowupPayloadSource({ payload: { ok: true } })).toBe('payload');
    expect(resolveFollowupPayloadSource({ injection: { ops: [] } })).toBe('injection');
    expect(resolveFollowupPayloadSource({ metadata: { clientInjectOnly: true } })).toBe('none');
  });

  test('materializes injection payload through a single helper', () => {
    expect(
      materializeFollowupPayload({
        followupPlan: { injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } },
        buildInjectionPayload: () => ({ messages: [{ role: 'user', content: '继续执行' }] })
      })
    ).toEqual({
      source: 'injection',
      payload: { messages: [{ role: 'user', content: '继续执行' }] }
    });
  });

  test('preserves original route hint on followup metadata instead of clearing routing context', () => {
    const metadata: Record<string, unknown> = {};
    applyFollowupRuntimeMetadata({
      metadata,
      loopState: null,
      originalEntryEndpoint: '/v1/responses',
      followupEntryEndpoint: '/v1/responses',
      flowId: 'apply_patch_read_before_retry_guard',
      decision: {
        flowId: 'apply_patch_read_before_retry_guard',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: true,
        flowOnlyLoopLimit: true,
        clientInjectOnly: false,
        seedLoopPayload: false,
        retryEmptyFollowupOnce: false,
        ignoreRequiresActionFollowup: false
      },
      adapterContext: {
        requestId: 'req-followup',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        routecodexPortMode: 'router',
        routeId: 'coding'
      } as any
    });
    expect(metadata.routeHint).toBe('coding');
    expect((metadata as any).__shadowCompareForcedProviderKey).toBeUndefined();
    expect((metadata as any).__rt?.serverToolFollowup).toBe(true);
    expect((metadata as any).__rt?.preserveRouteHint).toBe(false);
    expect((metadata as any).__rt?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');
  });

  test('falls back to runtime route name when adapter routeId/routeHint are absent', () => {
    const metadata: Record<string, unknown> = {};
    applyFollowupRuntimeMetadata({
      metadata,
      loopState: null,
      originalEntryEndpoint: '/v1/responses',
      followupEntryEndpoint: '/v1/responses',
      flowId: 'apply_patch_read_before_retry_guard',
      decision: {
        flowId: 'apply_patch_read_before_retry_guard',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: true,
        flowOnlyLoopLimit: true,
        clientInjectOnly: false,
        seedLoopPayload: false,
        retryEmptyFollowupOnce: false,
        ignoreRequiresActionFollowup: false
      },
      adapterContext: {
        requestId: 'req-followup',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        __rt: {
          serverToolFollowupMode: 'router',
          routeName: 'coding'
        }
      } as any
    });
    expect(metadata.routeHint).toBe('coding');
    expect((metadata as any).__shadowCompareForcedProviderKey).toBeUndefined();
    expect((metadata as any).__rt?.serverToolFollowup).toBe(true);
  });
});

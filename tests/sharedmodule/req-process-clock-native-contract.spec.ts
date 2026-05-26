import { describe, expect, it } from '@jest/globals';

import { applyReqProcessToolGovernanceWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';

describe('req_process clock native contract', () => {
  it('native req_process governance strips latest valid clock marker and returns runtime summary', () => {
    const dueAtIso = new Date(Date.now() + 120_000).toISOString();
    const result = applyReqProcessToolGovernanceWithNative({
      request: {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'old\n<**clock:{"time":"bad-time","message":"old-task"}**>' },
          { role: 'assistant', content: 'ok' },
          {
            role: 'user',
            content: `please remind me later\n<**clock:{"time":"${dueAtIso}","message":"marker-task","recurrence":{"kind":"daily","maxRuns":2}}**>`,
          },
        ],
        tools: [],
        parameters: {},
        metadata: { originalEndpoint: '/v1/chat/completions' },
      },
      rawPayload: {},
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        tmuxSessionId: 'clock-native-req-process',
        __rt: { clock: { enabled: true, tickMs: 0 } },
      },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-native',
      hasActiveStopMessageForContinueExecution: true,
    });

    const messages = result.processedRequest.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]?.content ?? '')).toContain('old');
    expect(String(messages[0]?.content ?? '')).not.toContain('old-task');
    expect(String(messages[2]?.content ?? '')).toContain('please remind me later');
    expect(String(messages[2]?.content ?? '')).not.toContain('marker-task');

    const processingMetadata = result.processedRequest.processingMetadata as Record<string, unknown>;
    expect(processingMetadata.clockRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        sessionId: 'tmux:clock-native-req-process',
        shouldScheduleMarkers: true,
        shouldReserveDueReminders: true,
        injectPerRequestTimeTag: false,
        shouldClearTasks: false,
      }),
    );

    const markerDirectives = (processingMetadata.clockRuntime as Record<string, unknown>)?.markerDirectives as Array<Record<string, unknown>>;
    expect(Array.isArray(markerDirectives)).toBe(true);
    expect(markerDirectives).toHaveLength(1);
    expect(markerDirectives[0]).toEqual(
      expect.objectContaining({
        task: 'marker-task',
        dueAt: dueAtIso,
        dueAtMs: expect.any(Number),
        recurrence: expect.objectContaining({ kind: 'daily', maxRuns: 2 }),
      }),
    );
  });

  it('native req_process governance strips malformed clock marker text without emitting schedule directives', () => {
    const result = applyReqProcessToolGovernanceWithNative({
      request: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: 'please remind me later\n<**clock:{"time":"not-a-time","message":"marker-task"}**>',
          },
        ],
        tools: [],
        parameters: {},
        metadata: { originalEndpoint: '/v1/chat/completions' },
      },
      rawPayload: {},
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        tmuxSessionId: 'clock-native-invalid',
        __rt: { clock: { enabled: true, tickMs: 0 } },
      },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-native-invalid',
      hasActiveStopMessageForContinueExecution: true,
    });

    const messages = result.processedRequest.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]?.content ?? '')).toContain('please remind me later');
    expect(String(messages[0]?.content ?? '')).not.toContain('marker-task');

    const processingMetadata = result.processedRequest.processingMetadata as Record<string, unknown>;
    expect(processingMetadata.clockRuntime).toEqual(
      expect.objectContaining({
        enabled: true,
        sessionId: 'tmux:clock-native-invalid',
        shouldScheduleMarkers: false,
      }),
    );
    expect((processingMetadata.clockRuntime as Record<string, unknown>)?.markerDirectives).toEqual([]);
  });
});

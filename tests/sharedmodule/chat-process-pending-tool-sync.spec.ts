import { describe, expect, it, jest } from '@jest/globals';

import { maybeInjectPendingServerToolResultsAfterClientTools } from '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-pending-tool-sync.js';

describe('chat process pending tool sync non-blocking observability', () => {
  it('logs and throttles pending session clear failures', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const request = {
      messages: [{ role: 'tool', tool_call_id: 'call-1' }],
      metadata: { sessionId: 'session-1' }
    } as any;

    const deps = {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: [{ role: 'assistant', content: 'from-server' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 }),
      clearPendingServerToolInjectionFn: async () => {
        throw new Error('clear boom');
      }
    };

    const first = await maybeInjectPendingServerToolResultsAfterClientTools(request, { sessionId: 'session-1' }, deps);
    const second = await maybeInjectPendingServerToolResultsAfterClientTools(request, { sessionId: 'session-1' }, deps);

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=session_cleanup');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=clear_pending_server_tool_injection');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('session-1');

    warnSpy.mockRestore();
  });
});

import { describe, expect, it } from '@jest/globals';

import { applyReqProcessToolGovernanceWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';

describe('req_process heartbeat native contract', () => {
  it('native req_process governance strips latest valid hb directive and returns runtime summary', () => {
    const result = applyReqProcessToolGovernanceWithNative({
      request: {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: '<**hb:off**>\nold' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'please continue\n<**hb:15m**>\nthanks' }
        ],
        tools: [],
        parameters: {},
        metadata: { originalEndpoint: '/v1/chat/completions' }
      },
      rawPayload: {},
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        tmuxSessionId: 'hb-native-req-process',
        cwd: '/tmp/hb-native-req-process'
      },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-native',
      hasActiveStopMessageForContinueExecution: true
    });

    const messages = result.processedRequest.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]?.content ?? '')).toContain('<**hb:off**>');
    expect(String(messages[2]?.content ?? '')).not.toContain('hb:15m');

    const processingMetadata = result.processedRequest.processingMetadata as Record<string, unknown>;
    expect(processingMetadata.heartbeatDirective).toEqual(
      expect.objectContaining({
        action: 'on',
        intervalMs: 15 * 60_000,
        tmuxSessionId: 'hb-native-req-process',
        workdir: '/tmp/hb-native-req-process',
        contentChanged: true
      })
    );
  });
});

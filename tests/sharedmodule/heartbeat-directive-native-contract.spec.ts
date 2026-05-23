import { describe, expect, it } from '@jest/globals';

import { resolveHeartbeatDirectiveWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';

describe('heartbeat directive native contract', () => {
  it('extracts the latest hb directive through the active native resolver with camelCase fields', () => {
    const result = resolveHeartbeatDirectiveWithNative({
      messages: [
        { role: 'user', content: '<**hb:off**>' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'please continue\n<**hb:15m**>' }
      ],
      metadata: {
        tmuxSessionId: 'hb-native-contract',
        cwd: '/tmp/hb-native-contract'
      }
    }) as Record<string, unknown>;

    expect(result.action).toBe('on');
    expect(result.intervalMs).toBe(15 * 60_000);
    expect(result.tmuxSessionId).toBe('hb-native-contract');
    expect(result.workdir).toBe('/tmp/hb-native-contract');
    expect(result.contentChanged).toBe(true);
  });
});

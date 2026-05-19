import { describe, expect, test } from '@jest/globals';

import { resolveAdapterContextProviderKey } from '../../sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.js';

describe('servertool sticky provider pin', () => {
  test('prefers exact target providerKey over alias adapter providerKey', () => {
    expect(
      resolveAdapterContextProviderKey({
        providerKey: 'mini27.key1.minimax',
        targetProviderKey: 'mini27.key1.minimax',
        target: {
          providerKey: 'mini27.key1.MiniMax-M2.7'
        }
      })
    ).toBe('mini27.key1.MiniMax-M2.7');
  });
});

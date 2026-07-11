import { describe, expect, test } from '@jest/globals';
import {
  planStopMessageDefaultConfigDirectNative
} from './helpers/stop-message-direct-native.ts';

describe('stop_message runtime config precedence', () => {
  test('uses explicit config maxRepeats as the highest-priority source', () => {
    const plan = planStopMessageDefaultConfigDirectNative({
      tombstoneCleared: false,
      configEnabled: true,
      configText: '  config text  ',
      configMaxRepeats: 3,
      envText: 'env text',
      envMaxRepeats: '2'
    });

    expect(plan).toEqual({
      enabled: true,
      text: 'config text',
      maxRepeats: 3
    });
  });

  test('falls back to env values when config values are empty or invalid', () => {
    const plan = planStopMessageDefaultConfigDirectNative({
      tombstoneCleared: false,
      configText: ' ',
      configMaxRepeats: 0,
      envText: '  env text  ',
      envMaxRepeats: '5.9'
    });

    expect(plan).toEqual({
      enabled: true,
      text: 'env text',
      maxRepeats: 5
    });
  });
});

import { describe, expect, test } from '@jest/globals';

import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.js';

describe('native required exports for sse stream helpers', () => {
  test('includes sse stream resolver/process exports and keeps export list deduplicated', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('processSseStreamJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('resolveSseStreamModeJson');
    expect(new Set(REQUIRED_NATIVE_HOTPATH_EXPORTS).size).toBe(REQUIRED_NATIVE_HOTPATH_EXPORTS.length);
  });
});

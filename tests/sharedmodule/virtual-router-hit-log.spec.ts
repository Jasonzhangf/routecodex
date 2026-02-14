import { formatVirtualRouterHit } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-logging.js';

describe('virtual-router hit log', () => {
  it('includes request token estimate when available', () => {
    const line = formatVirtualRouterHit(
      'thinking',
      'thinking-primary',
      'iflow.key1.kimi-k2.5',
      'kimi-k2.5',
      'thinking:user-input',
      undefined,
      undefined,
      1234.6
    );

    expect(line).toContain('reqTokens=1235');
  });

  it('omits request token estimate when unavailable', () => {
    const line = formatVirtualRouterHit(
      'thinking',
      'thinking-primary',
      'iflow.key1.kimi-k2.5',
      'kimi-k2.5',
      'thinking:user-input'
    );

    expect(line).not.toContain('reqTokens=');
  });
});

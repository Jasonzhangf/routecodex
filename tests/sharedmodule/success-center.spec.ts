import { describe, expect, it, jest } from '@jest/globals';

import { ProviderSuccessCenter } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/success-center.js';

describe('provider success center non-blocking observability', () => {
  it('logs listener failures, throttles repeats, and keeps propagation alive', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const center = new ProviderSuccessCenter();
    const received: string[] = [];

    center.subscribe(() => {
      throw new Error('listener boom');
    });
    center.subscribe((event) => {
      received.push(String(event.runtime?.requestId || ''));
    });

    const event = {
      runtime: { requestId: 'req-success', providerKey: 'provider-a' },
      timestamp: Date.now()
    } as any;

    const first = center.emit(event);
    const second = center.emit(event);

    expect(first.runtime.requestId).toBe('req-success');
    expect(second.runtime.requestId).toBe('req-success');
    expect(received).toEqual(['req-success', 'req-success']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=listener_dispatch');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=provider_success_listener');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('provider-a');

    warnSpy.mockRestore();
  });
});

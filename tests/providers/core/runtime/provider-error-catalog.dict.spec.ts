import { describe, expect, it } from '@jest/globals';

describe('provider-error-catalog SSOT: public code sets', () => {
  it('exposes PROVIDER_UNRECOVERABLE_CODES / PROVIDER_NETWORK_CODES / PROVIDER_BLOCKING_RECOVERABLE_CODES', async () => {
    const mod = await import('../../../../src/providers/core/runtime/provider-error-catalog.js');
    expect(mod.PROVIDER_UNRECOVERABLE_CODES).toBeDefined();
    expect(mod.PROVIDER_NETWORK_CODES).toBeDefined();
    expect(mod.PROVIDER_BLOCKING_RECOVERABLE_CODES).toBeDefined();
  });

  it('PROVIDER_UNRECOVERABLE_CODES contains canonical unrecoverable aliases', async () => {
    const { PROVIDER_UNRECOVERABLE_CODES } = await import('../../../../src/providers/core/runtime/provider-error-catalog.js');
    expect(PROVIDER_UNRECOVERABLE_CODES.has('INVALID_API_KEY')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('INVALID_ACCESS_TOKEN')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('INSUFFICIENT_QUOTA')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('ACCESS_DENIED')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('FORBIDDEN')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('ACCOUNT_DISABLED')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('ACCOUNT_SUSPENDED')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('MODEL_NOT_SUPPORTED')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('MODEL_DISABLED')).toBe(true);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('NO_SUCH_MODEL')).toBe(true);
    // provider-specific must NOT leak into provider-agnostic catalog
    expect(PROVIDER_UNRECOVERABLE_CODES.has('WINDSURF_RATE_LIMITED')).toBe(false);
    expect(PROVIDER_UNRECOVERABLE_CODES.has('DEEPSEEK_SESSION_CREATE_FAILED')).toBe(false);
  });

  it('PROVIDER_NETWORK_CODES contains canonical network code family', async () => {
    const { PROVIDER_NETWORK_CODES } = await import('../../../../src/providers/core/runtime/provider-error-catalog.js');
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_HTTP2_STREAM_CANCEL']) {
      expect(PROVIDER_NETWORK_CODES.has(code)).toBe(true);
    }
  });

  it('PROVIDER_BLOCKING_RECOVERABLE_CODES contains canonical blocking recoverable', async () => {
    const { PROVIDER_BLOCKING_RECOVERABLE_CODES } = await import('../../../../src/providers/core/runtime/provider-error-catalog.js');
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('PROVIDER_TRAFFIC_SATURATED')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('HTTP_429')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('HTTP_500')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('HTTP_502')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('HTTP_503')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('HTTP_504')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('SSE_DECODE_ERROR')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('SSE_TO_JSON_ERROR')).toBe(true);
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('UPSTREAM_EMPTY_OUTPUT')).toBe(true);
    // provider-specific WINDSURF_RATE_LIMITED must NOT leak
    expect(PROVIDER_BLOCKING_RECOVERABLE_CODES.has('WINDSURF_RATE_LIMITED')).toBe(false);
  });
});

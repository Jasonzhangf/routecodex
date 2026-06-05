import { describe, expect, it } from '@jest/globals';

describe('windsurf-provider-contract SSOT: error code sets', () => {
  it('exposes WINDSURF_ERROR_CODES Object.freeze and Type alias', async () => {
    const mod = await import('../../../../src/providers/core/contracts/windsurf-provider-contract.js');
    expect(mod.WINDSURF_ERROR_CODES.RATE_LIMITED).toBe('WINDSURF_RATE_LIMITED');
    expect(mod.WINDSURF_ERROR_CODES.SESSION_TOKEN_NOT_INITIALIZED).toBe('WINDSURF_SESSION_TOKEN_NOT_INITIALIZED');
    expect(mod.WINDSURF_ERROR_CODES.ACCOUNT_CREDENTIAL_MISSING).toBe('WINDSURF_ACCOUNT_CREDENTIAL_MISSING');
    expect(mod.WINDSURF_ERROR_CODES.NO_PASSWORD_SET).toBe('WINDSURF_NO_PASSWORD_SET');
    expect(mod.WINDSURF_ERROR_CODES.POSTAUTH_FAILED).toBe('WINDSURF_POSTAUTH_FAILED');
    expect(mod.WINDSURF_ERROR_CODES.SESSION_TOKEN_MISSING).toBe('WINDSURF_SESSION_TOKEN_MISSING');
    expect(mod.WINDSURF_ERROR_CODES.CASCADE_NO_PROGRESS).toBe('WINDSURF_CASCADE_NO_PROGRESS');
  });

  it('WINDSURF_UNRECOVERABLE_CODES contains the 6 unrecoverable codes', async () => {
    const { WINDSURF_UNRECOVERABLE_CODES } = await import('../../../../src/providers/core/contracts/windsurf-provider-contract.js');
    expect(WINDSURF_UNRECOVERABLE_CODES.size).toBe(6);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_SESSION_TOKEN_NOT_INITIALIZED')).toBe(true);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_ACCOUNT_CREDENTIAL_MISSING')).toBe(true);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_NO_PASSWORD_SET')).toBe(true);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_POSTAUTH_FAILED')).toBe(true);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_SESSION_TOKEN_MISSING')).toBe(true);
    expect(WINDSURF_UNRECOVERABLE_CODES.has('WINDSURF_CASCADE_NO_PROGRESS')).toBe(true);
  });

  it('WINDSURF_BLOCKING_RECOVERABLE_CODES contains RATE_LIMITED only', async () => {
    const { WINDSURF_BLOCKING_RECOVERABLE_CODES } = await import('../../../../src/providers/core/contracts/windsurf-provider-contract.js');
    expect(WINDSURF_BLOCKING_RECOVERABLE_CODES.size).toBe(1);
    expect(WINDSURF_BLOCKING_RECOVERABLE_CODES.has('WINDSURF_RATE_LIMITED')).toBe(true);
  });
});

describe('deepseek-provider-contract SSOT: error code sets', () => {
  it('exposes DEEPSEEK_UNRECOVERABLE_CODES containing 2 codes', async () => {
    const { DEEPSEEK_UNRECOVERABLE_CODES } = await import('../../../../src/providers/core/contracts/deepseek-provider-contract.js');
    expect(DEEPSEEK_UNRECOVERABLE_CODES.size).toBe(2);
    expect(DEEPSEEK_UNRECOVERABLE_CODES.has('DEEPSEEK_SESSION_CREATE_FAILED')).toBe(true);
    expect(DEEPSEEK_UNRECOVERABLE_CODES.has('DEEPSEEK_FILE_UPLOAD_FAILED')).toBe(true);
  });
});

import { describe, expect, it } from '@jest/globals';
import { redactSensitiveData } from '../../src/utils/sensitive-redaction.js';

describe('sensitive redaction', () => {
  it('redacts sensitive key fields but preserves safe references', () => {
    const input = {
      apiKey: 'sk-user-1234567890abcdef',
      auth: {
        tokenFile: 'authfile-openrouter',
        access_token: 'access-token-123456'
      },
      password: 'super-secret-password',
      headers: {
        Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        'x-api-key': 'inline-key-value'
      }
    };

    const output = redactSensitiveData(input) as Record<string, unknown>;
    expect(output.apiKey).toContain('[REDACTED]');
    expect((output.auth as Record<string, unknown>).tokenFile).toBe('authfile-openrouter');
    expect((output.auth as Record<string, unknown>).access_token).toContain('[REDACTED]');
    expect(output.password).toContain('[REDACTED]');
    expect(((output.headers as Record<string, unknown>).Authorization as string)).toContain('[REDACTED]');
  });

  it('redacts bearer/sk tokens embedded in free text while keeping ordinary text', () => {
    const input = {
      note: 'use Authorization: Bearer abcdefghijklmnop and sk-1234567890abcdef123456 to call api',
      usage: { total_tokens: 42 }
    };
    const output = redactSensitiveData(input) as Record<string, unknown>;
    const note = String(output.note || '');
    expect(note).not.toContain('abcdefghijklmnop');
    expect(note).not.toContain('sk-1234567890abcdef123456');
    expect(note).toContain('[REDACTED]');
    expect((output.usage as Record<string, unknown>).total_tokens).toBe(42);
  });
});

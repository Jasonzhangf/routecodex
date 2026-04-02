import { describe, expect, it } from '@jest/globals';
import { validateProviderIdInput } from '../../../src/server/runtime/http-server/daemon-admin/providers-handler-utils.js';

describe('validateProviderIdInput', () => {
  it('accepts safe provider ids', () => {
    expect(validateProviderIdInput('openrouter')).toEqual({ ok: true, providerId: 'openrouter' });
    expect(validateProviderIdInput('qwenchat.2-135')).toEqual({ ok: true, providerId: 'qwenchat.2-135' });
    expect(validateProviderIdInput(' tabglm_key-1 ')).toEqual({ ok: true, providerId: 'tabglm_key-1' });
  });

  it('rejects empty and non-string ids', () => {
    expect(validateProviderIdInput('')).toEqual({ ok: false, message: 'providerId is required' });
    expect(validateProviderIdInput('   ')).toEqual({ ok: false, message: 'providerId is required' });
    expect(validateProviderIdInput(undefined)).toEqual({ ok: false, message: 'providerId must be a string' });
  });

  it('rejects unsafe path-like ids', () => {
    const invalids = ['../evil', '..', '.evil', '/abs', 'evil/next', 'evil\\next', 'evil:next'];
    for (const id of invalids) {
      const out = validateProviderIdInput(id);
      expect(out.ok).toBe(false);
    }
  });

  it('enforces max length 64', () => {
    const ok64 = `a${'b'.repeat(63)}`;
    const bad65 = `a${'b'.repeat(64)}`;
    expect(validateProviderIdInput(ok64)).toEqual({ ok: true, providerId: ok64 });
    expect(validateProviderIdInput(bad65).ok).toBe(false);
  });
});


import { inferAntigravityUaSuffixFromFingerprint } from '../../../src/providers/auth/antigravity-fingerprint.js';

describe('antigravity-fingerprint', () => {
  test('infers windows/amd64 from Win32 fingerprint', () => {
    expect(
      inferAntigravityUaSuffixFromFingerprint({
        navigatorPlatform: 'Win32',
        navigatorOscpu: 'Windows NT 10.0; Win64; x64',
        navigatorUserAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
      })
    ).toBe('windows/amd64');
  });

  test('infers linux/amd64 from Linux x86_64 fingerprint', () => {
    expect(
      inferAntigravityUaSuffixFromFingerprint({
        navigatorPlatform: 'Linux x86_64',
        navigatorOscpu: 'Linux x86_64',
        navigatorUserAgent:
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0'
      })
    ).toBe('linux/amd64');
  });

  test('infers macos/amd64 from MacIntel fingerprint', () => {
    expect(
      inferAntigravityUaSuffixFromFingerprint({
        navigatorPlatform: 'MacIntel',
        navigatorOscpu: 'Intel Mac OS X 10.15',
        navigatorUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0'
      })
    ).toBe('macos/amd64');
  });
});


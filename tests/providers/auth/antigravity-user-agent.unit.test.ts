import {
  formatAntigravityManagerUserAgent,
  normalizeAntigravityManagerArch,
  normalizeAntigravityManagerOs,
  parseAntigravityVersionFromUpdater
} from '../../../src/providers/auth/antigravity-user-agent.js';

describe('antigravity-user-agent (Antigravity-Manager alignment)', () => {
  test('parseAntigravityVersionFromUpdater parses X.Y.Z from updater text', () => {
    const text = 'Auto updater is running. Stable Version: 1.15.8-5724687216017408';
    expect(parseAntigravityVersionFromUpdater(text)).toBe('1.15.8');
  });

  test('normalizeAntigravityManagerOs matches Rust std::env::consts::OS conventions', () => {
    expect(normalizeAntigravityManagerOs('win32')).toBe('windows');
    expect(normalizeAntigravityManagerOs('darwin')).toBe('macos');
    expect(normalizeAntigravityManagerOs('linux')).toBe('linux');
  });

  test('normalizeAntigravityManagerArch matches Rust std::env::consts::ARCH conventions', () => {
    expect(normalizeAntigravityManagerArch('x64')).toBe('x86_64');
    expect(normalizeAntigravityManagerArch('arm64')).toBe('aarch64');
    // already-normalized values should pass through
    expect(normalizeAntigravityManagerArch('x86_64')).toBe('x86_64');
    expect(normalizeAntigravityManagerArch('aarch64')).toBe('aarch64');
  });

  test('formatAntigravityManagerUserAgent produces antigravity/{version} {os}/{arch}', () => {
    expect(
      formatAntigravityManagerUserAgent({ version: '9.9.9', platform: 'darwin', arch: 'arm64' })
    ).toBe('antigravity/9.9.9 macos/aarch64');
  });
});


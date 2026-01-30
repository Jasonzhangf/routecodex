import {
  formatAntigravityManagerUserAgent,
  parseAntigravityVersionFromUpdater
} from '../../../src/providers/auth/antigravity-user-agent.js';

describe('antigravity-user-agent (Antigravity-Manager alignment)', () => {
  test('parseAntigravityVersionFromUpdater parses X.Y.Z from updater text', () => {
    const text = 'Auto updater is running. Stable Version: 1.15.8-5724687216017408';
    expect(parseAntigravityVersionFromUpdater(text)).toBe('1.15.8');
  });

  test('formatAntigravityManagerUserAgent keeps stable UA suffix (windows/amd64)', () => {
    expect(formatAntigravityManagerUserAgent({ version: '9.9.9' })).toBe('antigravity/9.9.9 windows/amd64');
    expect(formatAntigravityManagerUserAgent({ version: '9.9.9', suffix: 'windows/amd64' })).toBe(
      'antigravity/9.9.9 windows/amd64'
    );
  });
});

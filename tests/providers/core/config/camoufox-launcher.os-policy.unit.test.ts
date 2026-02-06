import { applyGoogleLocaleHint, getCamoufoxOsPolicy } from '../../../../src/providers/core/config/camoufox-launcher.js';

describe('camoufox-launcher os policy', () => {
  test('never returns linux', () => {
    const aliases = [
      'antonsoltan',
      'geetasamodgeetasamoda',
      'jasonqueque',
      'xfour8605',
      'gbplasu1',
      'default',
      'test'
    ];
    for (const alias of aliases) {
      const policy = getCamoufoxOsPolicy('antigravity', alias);
      expect(policy === 'windows' || policy === 'macos').toBe(true);
      expect(policy).not.toBe('linux');
    }
  });

  test('adds default hl=en for Google account URLs', () => {
    const next = applyGoogleLocaleHint('https://accounts.google.com/signin/continue?flowName=GlifWebSignIn');
    expect(next).toContain('accounts.google.com/signin/continue');
    expect(next).toContain('hl=en');
  });

  test('keeps non-Google URLs unchanged', () => {
    const raw = 'https://iflow.cn/oauth?foo=bar';
    expect(applyGoogleLocaleHint(raw)).toBe(raw);
  });

  test('supports disabling locale hint by env', () => {
    const prev = process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL = 'off';
    try {
      const raw = 'https://accounts.google.com/signin/continue?flowName=GlifWebSignIn';
      expect(applyGoogleLocaleHint(raw)).toBe(raw);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
      } else {
        process.env.ROUTECODEX_OAUTH_GOOGLE_HL = prev;
      }
    }
  });

});

import {
  applyGoogleLocaleHint,
  getCamoufoxOsPolicy,
  resolveCamoufoxLocaleEnv,
  sanitizeCamouConfigForOAuth,
  shouldPreferCamoCliForOAuth,
  shouldRepairCamoufoxFingerprintForOAuth
} from '../../../../src/providers/core/config/camoufox-launcher.js';

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

  test('builds locale env from Google language hint', () => {
    const prev = process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL = 'ja-JP';
    try {
      const env = resolveCamoufoxLocaleEnv();
      expect(env.LANG).toBe('ja_JP.UTF-8');
      expect(env.LC_ALL).toBe('ja_JP.UTF-8');
      expect(env.LANGUAGE).toBe('ja-JP');
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
      } else {
        process.env.ROUTECODEX_OAUTH_GOOGLE_HL = prev;
      }
    }
  });

  test('falls back to en-US locale env when hint disabled', () => {
    const prev = process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL = 'off';
    try {
      const env = resolveCamoufoxLocaleEnv();
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.LC_ALL).toBe('en_US.UTF-8');
      expect(env.LANGUAGE).toBe('en-US');
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_OAUTH_GOOGLE_HL;
      } else {
        process.env.ROUTECODEX_OAUTH_GOOGLE_HL = prev;
      }
    }
  });

  test('sanitizes iflow CAMOU_CONFIG_1 by removing timezone (keep fingerprint injection)', () => {
    const env = {
      CAMOU_CONFIG_1: JSON.stringify({
        'navigator.platform': 'MacIntel',
        'headers.Accept-Encoding': 'gzip, deflate, br, zstd',
        timezone: 'America/Los_Angeles',
        'locale:language': 'en'
      })
    };
    const next = sanitizeCamouConfigForOAuth('iflow', env);
    const parsed = JSON.parse(String(next.CAMOU_CONFIG_1 || '{}')) as Record<string, unknown>;
    expect(parsed['navigator.platform']).toBe('MacIntel');
    expect(parsed['locale:language']).toBe('en');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'headers.Accept-Encoding')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'timezone')).toBe(false);
  });

  test('keeps non-iflow CAMOU_CONFIG_1 unchanged', () => {
    const env = {
      CAMOU_CONFIG_1: JSON.stringify({
        'navigator.platform': 'MacIntel',
        timezone: 'America/Los_Angeles'
      })
    };
    const next = sanitizeCamouConfigForOAuth('antigravity', env);
    const parsed = JSON.parse(String(next.CAMOU_CONFIG_1 || '{}')) as Record<string, unknown>;
    expect(parsed['navigator.platform']).toBe('MacIntel');
    expect(parsed.timezone).toBe('America/Los_Angeles');
  });

  test('handles invalid CAMOU_CONFIG_1 payload safely', () => {
    const env = { CAMOU_CONFIG_1: '{bad-json' };
    const next = sanitizeCamouConfigForOAuth('iflow', env);
    expect(next.CAMOU_CONFIG_1).toBe('{bad-json');
  });

  test('returns empty object when no CAMOU_CONFIG_1 present', () => {
    const next = sanitizeCamouConfigForOAuth('iflow', {});
    expect(next).toEqual({});
    const other = sanitizeCamouConfigForOAuth('iflow', { A: '1' });
    expect(other).toEqual({ A: '1' });
  });

  test('repairs iflow Windows fingerprint on macOS host', () => {
    expect(shouldRepairCamoufoxFingerprintForOAuth('iflow', 'Win32', 'darwin')).toBe(true);
  });

  test('does not repair non-Windows fingerprint on macOS host', () => {
    expect(shouldRepairCamoufoxFingerprintForOAuth('iflow', 'MacIntel', 'darwin')).toBe(false);
  });

  test('does not repair Windows fingerprint on non-macOS host', () => {
    expect(shouldRepairCamoufoxFingerprintForOAuth('iflow', 'Win32', 'linux')).toBe(false);
  });

  test('prefers camo-cli for iflow oauth by default', () => {
    const prev1 = process.env.ROUTECODEX_OAUTH_CAMO_CLI;
    const prev2 = process.env.RCC_OAUTH_CAMO_CLI;
    delete process.env.ROUTECODEX_OAUTH_CAMO_CLI;
    delete process.env.RCC_OAUTH_CAMO_CLI;
    try {
      expect(shouldPreferCamoCliForOAuth('iflow')).toBe(true);
      expect(shouldPreferCamoCliForOAuth('antigravity')).toBe(true);
      expect(shouldPreferCamoCliForOAuth(undefined)).toBe(true);
    } finally {
      if (prev1 === undefined) {
        delete process.env.ROUTECODEX_OAUTH_CAMO_CLI;
      } else {
        process.env.ROUTECODEX_OAUTH_CAMO_CLI = prev1;
      }
      if (prev2 === undefined) {
        delete process.env.RCC_OAUTH_CAMO_CLI;
      } else {
        process.env.RCC_OAUTH_CAMO_CLI = prev2;
      }
    }
  });

  test('supports disabling camo-cli oauth via env', () => {
    const prev = process.env.ROUTECODEX_OAUTH_CAMO_CLI;
    process.env.ROUTECODEX_OAUTH_CAMO_CLI = '0';
    try {
      expect(shouldPreferCamoCliForOAuth('iflow')).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_OAUTH_CAMO_CLI;
      } else {
        process.env.ROUTECODEX_OAUTH_CAMO_CLI = prev;
      }
    }
  });

});

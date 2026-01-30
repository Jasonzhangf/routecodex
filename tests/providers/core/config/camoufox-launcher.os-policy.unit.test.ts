import { getCamoufoxOsPolicy } from '../../../../src/providers/core/config/camoufox-launcher.js';

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
});

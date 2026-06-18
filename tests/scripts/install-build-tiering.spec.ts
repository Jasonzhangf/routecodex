import fs from 'node:fs';
import path from 'node:path';

describe('install build tiering', () => {
  const globalScript = fs.readFileSync(path.resolve('scripts/install-global.sh'), 'utf8');
  const releaseScript = fs.readFileSync(path.resolve('scripts/install-release.sh'), 'utf8');

  it('forces install-global.sh to use npm run build:min', () => {
    expect(globalScript).toContain('npm run build:min');
  });

  it('forces install-release.sh to use npm run build:min', () => {
    expect(releaseScript).toContain('npm run build:min');
  });
});

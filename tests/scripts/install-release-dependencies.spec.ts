import fs from 'node:fs';
import path from 'node:path';

describe('install-release dependency installation', () => {
  const releaseScript = fs.readFileSync(path.resolve('scripts/install-release.sh'), 'utf8');

  it('keeps optional native packages required by rollup during webui build', () => {
    expect(releaseScript).not.toContain('--omit=optional');
  });
});

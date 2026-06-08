import fs from 'node:fs';
import path from 'node:path';

describe('install-global artifact isolation', () => {
  const scriptPath = path.resolve('scripts/install-global.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('builds global install artifacts in an isolated staging root instead of deleting repo dist', () => {
    expect(script).toContain('prepare_isolated_build_root');
    expect(script).toContain('mktemp -d');
    expect(script).toContain('INSTALL_BUILD_ROOT');
    expect(script).not.toMatch(/rm\s+-rf\s+dist\b/);
  });

  it('installs and snapshots from the isolated build root', () => {
    expect(script).toContain('npm pack --pack-destination');
    expect(script).toMatch(/npm install -g "\$packed_path"/);
    expect(script).toMatch(/\(cd "\$INSTALL_BUILD_ROOT" && .*install-release-snapshot\.mjs/);
    expect(script).toContain('--skip-install-current');
  });

  it('keeps install pack output under the approved artifacts root', () => {
    expect(script).toContain('$INSTALL_BUILD_ROOT/artifacts/pack/install-global');
    expect(script).not.toContain('$INSTALL_BUILD_ROOT/.install-pack');
  });
});

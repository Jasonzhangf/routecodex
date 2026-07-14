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
    expect(script).toContain('node scripts/pack-mode.mjs --name routecodex --bin routecodex');
    expect(script).toContain('$INSTALL_BUILD_ROOT/artifacts/pack/routecodex-');
    expect(script).toMatch(/npm install -g "\$packed_path".*--offline/);
    expect(script).toMatch(/\(cd "\$INSTALL_BUILD_ROOT" && .*install-release-snapshot\.mjs/);
    expect(script).toContain('--skip-install-current');
  });

  it('keeps install pack output under the approved artifacts root', () => {
    expect(script).toContain('$INSTALL_BUILD_ROOT/artifacts/pack/routecodex-');
    expect(script).not.toContain('$INSTALL_BUILD_ROOT/.install-pack');
  });

  it('serializes release writers and removes the release shim immediately before npm owns the bin', () => {
    expect(script).toContain('source "$SOURCE_ROOT/scripts/lib/install-lifecycle-lock.sh"');
    expect(script).toContain('acquire_routecodex_install_lock');
    expect(script).toMatch(/rm -f "\$NPM_PREFIX\/bin\/routecodex"\s+npm install -g "\$packed_path"/);
  });

  it('copies tracked governance contracts required by architecture gates', () => {
    expect(script).toContain('copy_agent_collab_contract');
    expect(script).toContain('copy_isolated_path ".agent-collab/PROTOCOL.md"');
    expect(script).toContain('copy_isolated_path ".agent-collab/schema"');
    expect(script).toContain('copy_isolated_path ".agent-collab/examples"');
    expect(script).toContain('.gitignore AGENTS.md');
    expect(script).toContain('copy_isolated_path ".agents/skills/rcc-dev-skills"');
    expect(script).not.toContain('copy_isolated_path ".agent-collab/runs"');
    expect(script).not.toContain('copy_isolated_path ".agent-collab/claims"');
  });
});

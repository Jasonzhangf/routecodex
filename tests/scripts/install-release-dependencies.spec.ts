import fs from 'node:fs';
import path from 'node:path';

describe('install-release dependency installation', () => {
  const releaseScript = fs.readFileSync(path.resolve('scripts/install-release.sh'), 'utf8');

  it('keeps optional native packages required by rollup during webui build', () => {
    expect(releaseScript).not.toContain('--omit=optional');
  });

  it('starts adopted release runtime through the daemon path so install can exit', () => {
    expect(releaseScript).toMatch(
      /ROUTECODEX_START_DAEMON=1\s*\\\s*\n\s*RCC_START_DAEMON=1\s*\\[\s\S]*rcc start --restart --port "\$VERIFY_PORT"/
    );
  });

  it('starts release runtime when restart has no live server to target', () => {
    expect(releaseScript).toContain(
      'rcc restart --port "$VERIFY_PORT" --host "$VERIFY_HOST" || start_release_runtime_for_port'
    );
  });
});

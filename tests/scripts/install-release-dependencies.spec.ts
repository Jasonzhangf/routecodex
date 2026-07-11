import fs from 'node:fs';
import path from 'node:path';

describe('install-release dependency installation', () => {
  const releaseScript = fs.readFileSync(path.resolve('scripts/install-release.sh'), 'utf8');

  it('keeps optional native packages required by rollup during webui build', () => {
    expect(releaseScript).not.toContain('--omit=optional');
  });

  it('does not stop an existing runtime during release verification adoption', () => {
    expect(releaseScript).not.toContain('adopt_release_runtime_for_port');
    expect(releaseScript).not.toContain('/shutdown');
    expect(releaseScript).not.toContain('rcc start --restart');
    expect(releaseScript).not.toContain('install-release.runtime-version-adoption');
  });

  it('uses restart for live runtime and no-restart start only when no live runtime is available', () => {
    expect(releaseScript).toContain('rcc restart --port "$VERIFY_PORT" --host "$VERIFY_HOST"');
    expect(releaseScript).not.toContain('|| start_release_runtime_for_port');
    expect(releaseScript).toMatch(
      /ROUTECODEX_START_DAEMON=1\s*\\\s*\n\s*RCC_START_DAEMON=1\s*\\[\s\S]*rcc start --no-restart --port "\$VERIFY_PORT"/
    );
  });
});

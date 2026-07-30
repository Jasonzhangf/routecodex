import fs from 'node:fs';
import path from 'node:path';

describe('install-release dependency installation', () => {
  const releaseScript = fs.readFileSync(path.resolve('scripts/install-release.sh'), 'utf8');

  it('keeps optional native packages required by rollup during webui build', () => {
    expect(releaseScript).not.toContain('--omit=optional');
  });

  it('validates production dependency closure before reusing an existing node_modules tree', () => {
    expect(releaseScript).toContain('production_dependencies_ready');
    expect(releaseScript).toContain('✅ 根项目依赖闭包已验证，跳过安装');
    expect(releaseScript).not.toContain('✅ 根项目依赖已存在，跳过安装');
  });

  it('does not stop an existing runtime during release verification adoption', () => {
    expect(releaseScript).not.toContain('adopt_release_runtime_for_port');
    expect(releaseScript).not.toContain('/shutdown');
    expect(releaseScript).not.toContain('rcc start --restart');
    expect(releaseScript).not.toContain('install-release.runtime-version-adoption');
  });


  it('accepts V3 health build_version while preserving V2 health version verification', () => {
    expect(releaseScript).toContain("body.version===expected");
    expect(releaseScript).toContain("body.manifest_version===3&&body.build_version===expected");
    expect(releaseScript).toContain("v2Ready&&body.version!==expected");
    expect(releaseScript).toContain("v3Ready&&body.build_version!==expected");
  });

  it('installs release snapshots into the same RCC homes refreshed by V2/global install', () => {
    expect(releaseScript).toContain('install_release_snapshot_for_rcc_home');
    expect(releaseScript).toContain('for root in "${roots[@]}"');
    expect(releaseScript).toContain('roots+=("$HOME/.rcc")');
    expect(releaseScript).toContain('if [ -d "/Volumes/extension/.rcc" ]; then');
    expect(releaseScript).toContain('RCC_HOME="$root" ROUTECODEX_HOME="$root" ROUTECODEX_USER_DIR="$root"');
  });

  it('uses one aggregate restart located by verify port and no-restart start only when stopped', () => {
    expect(releaseScript).toContain('restart_release_runtime_for_aggregate');
    expect(releaseScript).not.toContain('restart_release_runtime_for_port');
    expect(releaseScript).toContain('定位并重启聚合 RouteCodex server instance（只请求一次）');
    expect(releaseScript).toContain('rcc restart --port "$VERIFY_PORT" --host "$VERIFY_HOST"');
    expect(releaseScript).not.toContain('|| start_release_runtime_for_port');
    expect(releaseScript).toMatch(
      /ROUTECODEX_START_DAEMON=1\s*\\\s*\n\s*RCC_START_DAEMON=1\s*\\[\s\S]*rcc start --no-restart --port "\$VERIFY_PORT"/
    );
  });
});

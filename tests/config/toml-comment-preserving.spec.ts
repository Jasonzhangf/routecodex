import { updateTomlStringScalarInTable } from '../../src/config/toml-comment-preserving.js';

describe('toml-comment-preserving writer', () => {
  it('updates root-level string scalar without losing comments or layout', () => {
    const before = `# RouteCodex user config
# 顶层注释
version = "2.0.0"
virtualrouterMode = "v2"
oauthBrowser = "default"   # OAuth 浏览器选择

[httpserver]
# HTTP 服务端口
host = "127.0.0.1"
port = 5555
`;
    const after = updateTomlStringScalarInTable(before, [], 'oauthBrowser', 'camoufox');
    expect(after).toContain('# RouteCodex user config');
    expect(after).toContain('# 顶层注释');
    expect(after).toContain('# OAuth 浏览器选择');
    expect(after).toContain('oauthBrowser = "camoufox"   # OAuth 浏览器选择');
    expect(after).toContain('[httpserver]');
    expect(after).toContain('# HTTP 服务端口');
    expect(after).toContain('port = 5555');
  });

  it('inserts root-level key before first [section] when not present', () => {
    const before = `version = "2.0.0"

[httpserver]
host = "127.0.0.1"
`;
    const after = updateTomlStringScalarInTable(before, [], 'oauthBrowser', 'camoufox');
    expect(after).toContain('oauthBrowser = "camoufox"');
    const oauthIdx = after.indexOf('oauthBrowser');
    const sectionIdx = after.indexOf('[httpserver]');
    expect(oauthIdx).toBeLessThan(sectionIdx);
  });

  it('appends root-level key at top when no sections exist', () => {
    const before = `version = "2.0.0"
virtualrouterMode = "v2"
`;
    const after = updateTomlStringScalarInTable(before, [], 'oauthBrowser', 'camoufox');
    expect(after).toContain('oauthBrowser = "camoufox"');
    expect(after).toContain('version = "2.0.0"');
  });

  it('updates table-level string scalar and preserves surround comments', () => {
    const before = `# RouteCodex user config
version = "2.0.0"

# 虚拟路由分组
[virtualrouter]
activeRoutingPolicyGroup = "default"   # 当前激活分组

# 服务端口
[httpserver]
host = "127.0.0.1"
port = 5555
`;
    const after = updateTomlStringScalarInTable(before, ['virtualrouter'], 'activeRoutingPolicyGroup', 'canary');
    expect(after).toContain('# RouteCodex user config');
    expect(after).toContain('# 虚拟路由分组');
    expect(after).toContain('activeRoutingPolicyGroup = "canary"   # 当前激活分组');
    expect(after).toContain('# 服务端口');
    expect(after).toContain('port = 5555');
  });

  it('creates target table and inserts key when table not found', () => {
    const before = `version = "2.0.0"

[httpserver]
host = "127.0.0.1"
`;
    const after = updateTomlStringScalarInTable(before, ['virtualrouter'], 'activeRoutingPolicyGroup', 'canary');
    expect(after).toContain('[virtualrouter]');
    expect(after).toContain('activeRoutingPolicyGroup = "canary"');
  });

  it('inserts key into existing table when not already defined', () => {
    const before = `[virtualrouter]
activeRoutingPolicyGroup = "default"

[virtualrouter.session]
enabled = true
tickMs = 1500
`;
    const after = updateTomlStringScalarInTable(before, ['virtualrouter'], 'oauthBrowser', 'camoufox');
    expect(after).toContain('oauthBrowser = "camoufox"');
    expect(after).toContain('activeRoutingPolicyGroup = "default"');
    expect(after).toContain('enabled = true');
    expect(after).toContain('tickMs = 1500');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let loadRoutingInstructionStateSync: typeof import('../servertool/routing-instructions-direct-native.js').loadRoutingInstructionStateSync;
let saveRoutingInstructionStateSync: typeof import('../servertool/routing-instructions-direct-native.js').saveRoutingInstructionStateSync;

describe('routing state store paths', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  let tempRoot = '';

  beforeAll(async () => {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node'
    );
    ({
      loadRoutingInstructionStateSync,
      saveRoutingInstructionStateSync
    } = await import('../servertool/routing-instructions-direct-native.js'));
  });

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-routing-paths-'));
    process.env.RCC_HOME = tempRoot;
    process.env.ROUTECODEX_USER_DIR = tempRoot;
    process.env.ROUTECODEX_HOME = tempRoot;
    process.env.ROUTECODEX_SESSION_DIR = tempRoot;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RCC_HOME;
    else process.env.RCC_HOME = prevHome;
    if (prevUserDir === undefined) delete process.env.ROUTECODEX_USER_DIR;
    else process.env.ROUTECODEX_USER_DIR = prevUserDir;
    if (prevRouteCodexHome === undefined) delete process.env.ROUTECODEX_HOME;
    else process.env.ROUTECODEX_HOME = prevRouteCodexHome;
    if (prevSessionDir === undefined) delete process.env.ROUTECODEX_SESSION_DIR;
    else process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    if (prevNativePath === undefined) delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    else process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  });

  test('writes persistent routing scopes without falling back to ROUTECODEX_SESSION_DIR env root', () => {
    const state = {
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>(),
      stopMessageText: '继续执行'
    } as any;

    saveRoutingInstructionStateSync('session:test-session', state);
    saveRoutingInstructionStateSync('conversation:test-conv', state);
    saveRoutingInstructionStateSync('tmux:test-tmux', state);

    expect(fs.existsSync(path.join(tempRoot, 'session-test-session.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'conversation-test-conv.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'tmux-test-tmux.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'env-only', 'session-test-session.json'))).toBe(false);
    expect(loadRoutingInstructionStateSync('session:test-session')?.stopMessageText).toBe('继续执行');
    expect(loadRoutingInstructionStateSync('conversation:test-conv')?.stopMessageText).toBe('继续执行');
    expect(loadRoutingInstructionStateSync('tmux:test-tmux')?.stopMessageText).toBe('继续执行');
  });

  test('uses explicit sessionDir override for routing scope', () => {
    const overrideDir = path.join(tempRoot, 'override-sessions');
    process.env.ROUTECODEX_SESSION_DIR = overrideDir;
    const state = {
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>(),
      stopMessageText: 'override routing state'
    } as any;

    saveRoutingInstructionStateSync('session:override-routing', state, overrideDir);
    saveRoutingInstructionStateSync('conversation:override-routing', state, overrideDir);

    expect(fs.existsSync(path.join(overrideDir, 'session-override-routing.json'))).toBe(true);
    expect(fs.existsSync(path.join(overrideDir, 'conversation-override-routing.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'session-override-routing.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'conversation-override-routing.json'))).toBe(false);
  });

  test('ignores ROUTECODEX_SESSION_DIR env fallback when no explicit override is passed', () => {
    const envOnlyDir = path.join(tempRoot, 'env-only');
    process.env.ROUTECODEX_SESSION_DIR = envOnlyDir;
    const state = {
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>(),
      stopMessageText: 'canonical path only'
    } as any;

    saveRoutingInstructionStateSync('session:no-env-fallback', state);

    expect(fs.existsSync(path.join(envOnlyDir, 'session-no-env-fallback.json'))).toBe(false);
    expect(loadRoutingInstructionStateSync('session:no-env-fallback')?.stopMessageText).toBe('canonical path only');
  });
});

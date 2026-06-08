import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';

describe('routing state store paths', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  let tempRoot = '';

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

  test('writes all persistent routing scopes to explicit session-dir override', () => {
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

    expect(fs.existsSync(path.join(tempRoot, 'session-test-session.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'conversation-test-conv.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'tmux-test-tmux.json'))).toBe(true);

    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'session-test-session.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'sessions', 'tmux-test-tmux.json'))).toBe(false);
  });

  test('uses ROUTECODEX_SESSION_DIR override for routing scope too', () => {
    const overrideDir = path.join(tempRoot, 'override-sessions');
    process.env.ROUTECODEX_SESSION_DIR = overrideDir;
    const state = {
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>(),
      stopMessageText: 'override routing state'
    } as any;

    saveRoutingInstructionStateSync('session:override-routing', state);
    saveRoutingInstructionStateSync('conversation:override-routing', state);

    expect(fs.existsSync(path.join(overrideDir, 'session-override-routing.json'))).toBe(true);
    expect(fs.existsSync(path.join(overrideDir, 'conversation-override-routing.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'session-override-routing.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'conversation-override-routing.json'))).toBe(false);
  });

  test('round-trips stopless goal state through persisted routing snapshots', () => {
    const state = {
      stoplessGoalState: {
        status: 'active',
        objective: '统一 RCC stopless goal lifecycle',
        latestNote: 'waiting for host inbound wiring',
        updatedAt: 456,
        createdAt: 123
      },
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>()
    } as any;

    saveRoutingInstructionStateSync('session:goal-state', state);

    const restored = loadRoutingInstructionStateSync('session:goal-state');
    expect(restored?.stoplessGoalState).toEqual(state.stoplessGoalState);
    expect(
      fs.existsSync(path.join(tempRoot, 'session-goal-state.json'))
    ).toBe(true);
  });
});

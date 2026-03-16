import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

describe('sticky session store paths', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sticky-paths-'));
    process.env.RCC_HOME = tempRoot;
    process.env.ROUTECODEX_USER_DIR = tempRoot;
    process.env.ROUTECODEX_HOME = tempRoot;
    delete process.env.ROUTECODEX_SESSION_DIR;
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

  test('writes tmux state to sessions root and session/conversation state to state/routing', () => {
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

    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'session-test-session.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'state', 'routing', 'conversation-test-conv.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'sessions', 'tmux-test-tmux.json'))).toBe(true);

    expect(fs.existsSync(path.join(tempRoot, 'sessions', 'session-test-session.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'sessions', 'conversation-test-conv.json'))).toBe(false);
  });
});

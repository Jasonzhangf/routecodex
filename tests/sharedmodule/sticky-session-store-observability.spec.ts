import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
} from '../servertool/routing-instructions-direct-native.js';

describe('routing state store observability', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  let tempRoot = '';

  const state = {
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, number>(),
    disabledModels: new Map<string, number>(),
    stopMessageText: '继续执行'
  } as any;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-routing-observe-'));
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

  test('sync persist keeps Rust store non-strict when mkdir fails', () => {
    const blockingFile = path.join(tempRoot, 'state');
    fs.writeFileSync(blockingFile, 'not-a-dir', 'utf8');

    expect(() => saveRoutingInstructionStateSync('session:observe-sync', state)).not.toThrow();

    expect(fs.statSync(blockingFile).isFile()).toBe(true);
  });

  test('async clear keeps Rust store non-strict when unlink target is directory', async () => {
    const filepath = path.join(tempRoot, 'state', 'routing', 'session-observe-async.json');
    fs.mkdirSync(filepath, { recursive: true });

    expect(() => saveRoutingInstructionStateAsync('session:observe-async', null)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fs.statSync(filepath).isDirectory()).toBe(true);
  });

  test('bad persisted JSON reads as empty state without TS-side provider error mock', () => {
    const filepath = path.join(tempRoot, 'state', 'routing', 'session-bad-json.json');
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, '{"broken":', 'utf8');

    const loaded = loadRoutingInstructionStateSync('session:bad-json');

    expect(loaded).toBeNull();
  });
});

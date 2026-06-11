/**
 * Red test: lock down stopless goal state truth sources.
 *
 * Locks:
 * 1. Rust planner for stopless goal state sync is the truth source.
 * 2. bridge read/persist stop relying on TS fallback/no-op semantics.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routingStateModule = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts');
const stoplessGoalStateModule = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.js');

const mockRequireCoreDist = jest.fn((subpath: string) => {
  if (subpath === 'servertool/handlers/stopless-goal-state') {
    return stoplessGoalStateModule;
  }
  if (subpath === 'native/router-hotpath/native-virtual-router-routing-state') {
    return routingStateModule;
  }
  throw new Error(`unexpected requireCoreDist subpath: ${subpath}`);
});

jest.unstable_mockModule('../../src/modules/llmswitch/bridge/module-loader.js', () => ({
  importCoreDist: jest.fn(),
  requireCoreDist: mockRequireCoreDist,
  resolveImplForSubpath: jest.fn(() => 'ts'),
  resolveCoreModulePath: jest.fn(),
  parsePrefixList: jest.fn(() => []),
  matchesPrefix: jest.fn(() => false),
  isEngineEnabled: jest.fn(() => false),
  getEnginePrefixes: jest.fn(() => [])
}));

describe('state-integrations stopless goal (red — locked)', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-state-int-red-'));
    process.env.RCC_HOME = tempRoot;
    process.env.ROUTECODEX_USER_DIR = tempRoot;
    process.env.ROUTECODEX_HOME = tempRoot;
    process.env.ROUTECODEX_SESSION_DIR = path.join(tempRoot, 'routing-state');
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

  test('SYNC: bridge rejects incomplete stopless start directive', async () => {
    const { syncStoplessGoalStateFromRequest } = await import('../../src/modules/llmswitch/bridge.js');
    const plan = syncStoplessGoalStateFromRequest({
      sessionId: 'goal-sync-native-red',
      capturedChatRequest: {
        messages: [
          {
            role: 'user',
            content: '前文\n\nstopless start\n实现统一 RCC stopless\n</rcc**>\n后文'
          }
        ]
      }
    }) as Record<string, unknown>;

    expect(plan.hadDirective).toBe(false);
    expect(plan.directiveTypes).toEqual([]);
    expect(plan.nextState).toBeUndefined();
  });

  test('SYNC: should be session-isolated and not bleed state between sessions', async () => {
    const { syncStoplessGoalStateFromRequest } = await import('../../src/modules/llmswitch/bridge.js');

    const first = {
      sessionId: 'goal-sync-session-a',
      capturedChatRequest: {
        messages: [{ role: 'user', content: '\nstopless start\n目标 A\n</rcc**>' }]
      }
    };
    const second = {
      sessionId: 'goal-sync-session-b',
      capturedChatRequest: {
        messages: [{ role: 'user', content: '普通文本，不应继承 A 的状态' }]
      }
    };

    const firstResult = syncStoplessGoalStateFromRequest(first) as Record<string, unknown>;
    const secondResult = syncStoplessGoalStateFromRequest(second) as Record<string, unknown>;

    expect(firstResult.hadDirective).toBe(false);
    expect(firstResult.state).toBeUndefined();
    expect(secondResult.hadDirective).toBe(false);
    expect(secondResult.state ?? null).toBeNull();
  });

  test('PERSIST: bridge must invoke real stopless owner export names', async () => {
    const { persistStoplessGoalStateSnapshot } = await import('../../src/modules/llmswitch/bridge.js');
    const adapterContext = { sessionId: 'goal-persist-red-1' };
    const state = {
      status: 'active',
      objective: '测试目标',
      updatedAt: Date.now(),
      createdAt: Date.now(),
    };

    const result = persistStoplessGoalStateSnapshot(adapterContext, state) as Record<string, unknown>;
    expect(result).toMatchObject({ stickyKey: 'session:goal-persist-red-1' });
  });

  test('READ: bridge must resolve real stopless owner export name', async () => {
    const { readStoplessGoalState } = await import('../../src/modules/llmswitch/bridge.js');
    const result = readStoplessGoalState({ sessionId: 'goal-read-red-1' }) as Record<string, unknown> | null;
    expect(result).toEqual({ stickyKey: 'session:goal-read-red-1' });
  });

  test('READ: returns empty owner result when no goal state is persisted', async () => {
    const { readStoplessGoalState } = await import('../../src/modules/llmswitch/bridge.js');
    const result = readStoplessGoalState({ sessionId: 'goal-read-green-1' });
    expect(result).toEqual({ stickyKey: 'session:goal-read-green-1' });
  });

  test('COOLDOWN: persisted 503 reprobe semantics are not part of stopless goal state store', async () => {
    const content = fs.readFileSync(
      path.join(
        __dirname,
        '../../sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs'
      ),
      'utf-8'
    );
    expect(content).not.toContain('persisted_503_reprobe_available');
    expect(content).not.toContain('persisted_503_reprobe_at');
    expect(content).not.toContain('persisted_503_reprobe_state');
  });
});

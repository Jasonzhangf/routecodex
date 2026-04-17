import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import {
  resetProviderRuntimeIngressForTests,
  setProviderRuntimeObserverHooks
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.js';
import type { ProviderErrorEvent } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('sticky session store observability', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  let tempRoot = '';
  let events: ProviderErrorEvent[] = [];
  let observerOwner: object | null = null;

  const state = {
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, number>(),
    disabledModels: new Map<string, number>(),
    stopMessageText: '继续执行'
  } as any;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sticky-observe-'));
    process.env.RCC_HOME = tempRoot;
    process.env.ROUTECODEX_USER_DIR = tempRoot;
    process.env.ROUTECODEX_HOME = tempRoot;
    delete process.env.ROUTECODEX_SESSION_DIR;
    events = [];
    observerOwner = {};
    resetProviderRuntimeIngressForTests();
    setProviderRuntimeObserverHooks(observerOwner, {
      onProviderErrorReported: (event) => {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    if (observerOwner) {
      setProviderRuntimeObserverHooks(observerOwner, undefined);
    }
    observerOwner = null;
    resetProviderRuntimeIngressForTests();
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

  test('emits provider error event when sync persist mkdir fails', () => {
    const blockingFile = path.join(tempRoot, 'state');
    fs.writeFileSync(blockingFile, 'not-a-dir', 'utf8');

    saveRoutingInstructionStateSync('session:observe-sync', state);

    expect(
      events.some((event) => (
        event.code === 'STICKY_STATE_PERSIST_FAILED'
        && event.stage === 'sticky_session.persist'
        && event.details?.operation === 'mkdirSync'
      ))
    ).toBe(true);
  });

  test('emits provider error event when async clear unlink fails', async () => {
    const filepath = path.join(tempRoot, 'state', 'routing', 'session-observe-async.json');
    fs.mkdirSync(filepath, { recursive: true });

    saveRoutingInstructionStateAsync('session:observe-async', null);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      events.some((event) => (
        event.code === 'STICKY_STATE_PERSIST_FAILED'
        && event.stage === 'sticky_session.persist'
        && event.details?.operation === 'unlink'
      ))
    ).toBe(true);
  });

  test('emits provider error event when persisted JSON cannot be parsed', () => {
    const filepath = path.join(tempRoot, 'state', 'routing', 'session-bad-json.json');
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, '{"broken":', 'utf8');

    const loaded = loadRoutingInstructionStateSync('session:bad-json');

    expect(loaded).toBeNull();
    expect(
      events.some((event) => (
        event.code === 'STICKY_STATE_READ_FAILED'
        && event.stage === 'sticky_session.read'
        && event.details?.operation === 'read_parse_json'
      ))
    ).toBe(true);
  });
});

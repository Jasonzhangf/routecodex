import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import type { ProviderErrorEvent } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.js';

const events: ProviderErrorEvent[] = [];

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.js', () => ({
  report_internal_error_err_02_host_to_router_policy: (source: ProviderErrorEvent) => {
    events.push(source);
    return source;
  },
}));

const {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');

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
    events.length = 0;
  });

  afterEach(() => {
    events.length = 0;
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
        event.code === 'ROUTING_STATE_PERSIST_FAILED'
        && event.stage === 'routing_state.persist'
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
        event.code === 'ROUTING_STATE_PERSIST_FAILED'
        && event.stage === 'routing_state.persist'
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
        event.code === 'ROUTING_STATE_READ_FAILED'
        && event.stage === 'routing_state.read'
        && event.details?.operation === 'read_parse_json'
      ))
    ).toBe(true);
  });
});

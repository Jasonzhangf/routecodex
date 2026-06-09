import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';

describe('syncStoplessGoalStateFromRequest', () => {
  const prevHome = process.env.RCC_HOME;
  const prevUserDir = process.env.ROUTECODEX_USER_DIR;
  const prevRouteCodexHome = process.env.ROUTECODEX_HOME;
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stopless-goal-'));
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

  test('persists stopless start goal state and rewrites latest user text to body-forward text', async () => {
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');
    const { saveRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');
    const { syncStoplessGoalStateFromRequest } = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.js');
    saveRoutingInstructionStateSync('session:goal-sync-1', {
      reasoningStopMode: 'on',
      reasoningStopArmed: true,
      reasoningStopSummary: 'legacy',
      reasoningStopUpdatedAt: 1,
      reasoningStopFailCount: 2,
      reasoningStopGuardTriggerCount: 1,
      reasoningStopGuardTriggerAt: 1,
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, Set<string | number>>(),
      disabledModels: new Map<string, Set<string>>()
    } as any);
    const adapterContext = {
      sessionId: 'goal-sync-1',
      capturedChatRequest: {
        messages: [
          {
            role: 'user',
            content: '前文\n<**rcc**>\nstopless start\n实现统一 RCC stopless\n</rcc**>\n后文'
          }
        ]
      }
    };

    const result = syncStoplessGoalStateFromRequest(adapterContext);

    expect(result.hadDirective).toBe(true);
    expect(result.directiveTypes).toEqual(['stopless.start']);
    expect(result.state).toMatchObject({
      status: 'active',
      objective: '实现统一 RCC stopless'
    });
    expect((adapterContext.capturedChatRequest as any).messages[0].content).toBe('前文\n实现统一 RCC stopless\n后文');

    const persisted = loadRoutingInstructionStateSync('session:goal-sync-1');
    expect(persisted?.stoplessGoalState).toMatchObject({
      status: 'active',
      objective: '实现统一 RCC stopless'
    });
    expect(persisted?.reasoningStopMode).toBeUndefined();
    expect(persisted?.reasoningStopArmed).toBeUndefined();
    expect(persisted?.reasoningStopSummary).toBeUndefined();
  });


  test('rewrites RCC fence inside multipart user content without rejecting non-fence text parts', async () => {
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');
    const { syncStoplessGoalStateFromRequest } = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.js');
    const adapterContext = {
      sessionId: 'goal-sync-multipart',
      capturedChatRequest: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '普通文本块' },
              { type: 'text', text: '<**rcc**>\nstopless start\n多段输入目标\n</rcc**>' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
          }
        ]
      }
    };

    const result = syncStoplessGoalStateFromRequest(adapterContext);

    expect(result.hadDirective).toBe(true);
    expect(result.state).toMatchObject({ status: 'active', objective: '多段输入目标' });
    expect((adapterContext.capturedChatRequest as any).messages[0].content[1].text).toBe('多段输入目标');
    expect(loadRoutingInstructionStateSync('session:goal-sync-multipart')?.stoplessGoalState).toMatchObject({
      status: 'active',
      objective: '多段输入目标'
    });
  });


  test('uses first RCC fence text part and clears duplicate fence parts without throwing', async () => {
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');
    const { syncStoplessGoalStateFromRequest } = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.js');
    const adapterContext = {
      sessionId: 'goal-sync-multipart-multi-fence',
      capturedChatRequest: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<**rcc**>\nstopless start\n多 fence 目标\n</rcc**>' },
              { type: 'text', text: '<**rcc**>\nstopless progress\n继续推进\n</rcc**>' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
          }
        ]
      }
    };

    const result = syncStoplessGoalStateFromRequest(adapterContext);

    expect(result.hadDirective).toBe(true);
    expect(result.directiveTypes).toEqual(['stopless.start']);
    expect(result.state).toMatchObject({ status: 'active', objective: '多 fence 目标' });
    const content = (adapterContext.capturedChatRequest as any).messages[0].content;
    expect(content[0].text).toBe('多 fence 目标');
    expect(content[1].text).toBe('');
    expect(loadRoutingInstructionStateSync('session:goal-sync-multipart-multi-fence')?.stoplessGoalState).toMatchObject({
      status: 'active',
      objective: '多 fence 目标'
    });
  });

  test('applies private-only pause directive without leaking RCC fence to upstream content', async () => {
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js');
    const { syncStoplessGoalStateFromRequest } = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.js');
    const startContext = {
      sessionId: 'goal-sync-2',
      capturedChatRequest: {
        messages: [{ role: 'user', content: '<**rcc**>\nstopless start\n持续推进改造\n</rcc**>' }]
      }
    };
    syncStoplessGoalStateFromRequest(startContext);

    const pauseContext = {
      sessionId: 'goal-sync-2',
      capturedChatRequest: {
        messages: [{ role: 'user', content: '<**rcc**>\nstopless pause\n等待 Jason 确认\n</rcc**>' }]
      }
    };

    const result = syncStoplessGoalStateFromRequest(pauseContext);

    expect(result.hadDirective).toBe(true);
    expect(result.directiveTypes).toEqual(['stopless.pause']);
    expect(result.state).toMatchObject({
      status: 'paused',
      objective: '持续推进改造',
      latestNote: '等待 Jason 确认'
    });
    expect((pauseContext.capturedChatRequest as any).messages[0].content).toBe('');

    const persisted = loadRoutingInstructionStateSync('session:goal-sync-2');
    expect(persisted?.stoplessGoalState).toMatchObject({
      status: 'paused',
      objective: '持续推进改造',
      latestNote: '等待 Jason 确认'
    });
  });
});

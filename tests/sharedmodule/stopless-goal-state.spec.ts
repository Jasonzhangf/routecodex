import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';

function parseDirective(text: string) {
  const match = text.match(/<\*\*rcc\*\*>\s*([\s\S]*?)<\/rcc\*\*>/);
  if (!match) {
    return { blocks: [], directives: [] };
  }
  const full = match[0];
  const inner = match[1] ?? '';
  const normalized = inner.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((line, index, arr) => !(index === 0 && !line.trim()) && !(index === arr.length - 1 && !line.trim()));
  const commandLine = lines[0]?.trim() ?? '';
  const [domain = '', action = ''] = commandLine.split(/\s+/);
  const body = lines.slice(1).join('\n').trim();
  return {
    blocks: [{
      raw: full,
      startOffset: text.indexOf(full),
      endOffset: text.indexOf(full) + full.length,
      commandLine,
      domain,
      action,
      args: [],
      body
    }],
    directives: [{
      directiveType: `${domain}.${action}`,
      domain,
      action,
      args: [],
      body,
      passthrough: action === 'start' ? 'body-forward' : 'private-only'
    }]
  };
}

function applyDirective(input: {
  currentState?: {
    status: 'idle' | 'active' | 'paused' | 'stopped' | 'completed';
    objective: string;
    latestNote?: string;
    completionEvidence?: string;
    updatedAt: number;
    createdAt: number;
  };
  directive: {
    action: string;
    body: string;
  };
  nowMs?: number | null;
}) {
  const nowMs = Math.max(0, Number(input.nowMs ?? 0));
  const current = input.currentState ?? {
    status: 'idle' as const,
    objective: '',
    updatedAt: nowMs,
    createdAt: nowMs
  };
  if (input.directive.action === 'start') {
    return {
      status: 'active' as const,
      objective: input.directive.body,
      updatedAt: nowMs,
      createdAt: nowMs
    };
  }
  if (input.directive.action === 'pause') {
    return {
      ...current,
      status: 'paused' as const,
      latestNote: input.directive.body,
      updatedAt: nowMs
    };
  }
  throw new Error(`unsupported action ${input.directive.action}`);
}

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-rcc-fence-semantics.js',
  () => ({
    parseRccFenceDocumentWithNative: parseDirective,
    applyStoplessGoalDirectiveWithNative: applyDirective
  })
);

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

  test('persists stopless start goal state and rewrites latest user text to body-forward text', async () => {
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js');
    const { saveRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js');
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
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js');
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
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js');
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
    const { loadRoutingInstructionStateSync } = await import('../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js');
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

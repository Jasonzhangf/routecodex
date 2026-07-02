import { describe, expect, test } from '@jest/globals';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import { runPrimaryServerToolEngineSelection } from '../../sharedmodule/llmswitch-core/src/servertool/engine-selection-block.js';

const DEFAULT_PRIMARY_AUTO_HOOK_IDS = ['vision_auto', 'stop_message_auto'];

function makeResult(partial: Partial<ServerSideToolEngineResult> = {}): ServerSideToolEngineResult {
  return {
    mode: 'tool_flow',
    finalChatResponse: { id: 'chatcmpl-engine-selection' } as JsonObject,
    execution: { flowId: 'selected_flow' },
    ...partial
  };
}

describe('servertool engine selection block', () => {
  test('keeps skeleton queue shape reading out of the selection shell', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/engine-selection-block.ts',
      'utf8'
    );

    expect(source).toContain('readServertoolPrimaryAutoHookIdsWithNative');
    expect(source).not.toContain('planServertoolSkeletonDerivedConfigWithNative');
    expect(source).not.toContain('autoHookQueueConfig as');
    expect(source).not.toContain('optionalPrimaryOrder: string[]');
    expect(source).not.toContain("if (afterRunPlan.action === 'rerun_excluding_primary_hooks')");
    expect(source).not.toContain('switch (afterRunPlan.action)');
    expect(source).toContain('resolveEngineSelectionAfterRunWithNative');
    expect(source).not.toContain('String(afterRunPlan.action)');
    expect(source).not.toContain('afterRunPlan.overrides ?? {}');
    expect(source).toContain('return await args.runEngine(afterRunDecision.rerunOverrides);');
    expect(source).not.toContain("[servertool] invalid engine selection action");
  });

  test('runs primary hooks first and returns current result when execution exists', async () => {
    const calls: Partial<ServerSideToolEngineOptions>[] = [];
    await runPrimaryServerToolEngineSelection({
      runEngine: async (overrides) => {
        calls.push(overrides);
        return makeResult();
      }
    });

    expect(calls).toEqual([
      {
        disableToolCallHandlers: true,
        includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      }
    ]);
  });

  test('reruns excluding primary hooks after passthrough primary result', async () => {
    const calls: Partial<ServerSideToolEngineOptions>[] = [];
    await runPrimaryServerToolEngineSelection({
      runEngine: async (overrides) => {
        calls.push(overrides);
        return calls.length === 1
          ? makeResult({ mode: 'passthrough', execution: undefined })
          : makeResult({ execution: { flowId: 'fallback_flow' } });
      }
    });

    expect(calls).toEqual([
      {
        disableToolCallHandlers: true,
        includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      },
      {
        excludeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      }
    ]);
  });

  test('reruns excluding primary hooks after primary result without execution', async () => {
    const calls: Partial<ServerSideToolEngineOptions>[] = [];
    await runPrimaryServerToolEngineSelection({
      runEngine: async (overrides) => {
        calls.push(overrides);
        return calls.length === 1
          ? makeResult({ execution: undefined })
          : makeResult({ execution: { flowId: 'fallback_flow' } });
      }
    });

    expect(calls).toEqual([
      {
        disableToolCallHandlers: true,
        includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      },
      {
        excludeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      }
    ]);
  });
});

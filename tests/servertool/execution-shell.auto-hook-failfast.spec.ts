import { describe, expect, test } from '@jest/globals';

describe('execution-shell auto hook failfast', () => {
  test('keeps auto-hook queue internal and fail-fast through native attempt planning', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts',
        'utf8'
      )
    );

    expect(source).toContain('async function runAutoHookExecutionQueue(');
    expect(source).not.toContain('export async function runAutoHookExecutionQueue(');
    expect(source).toContain('const attemptPlan = planAutoHookRuntimeAttemptWithNative({');
    expect(source).toContain('const result = planned != null');
    expect(source).toContain('switch (attemptPlan.returnResult)');
    expect(source).not.toContain('if (planned) {');
    expect(source).not.toContain('if (attemptPlan.returnResult)');
    expect(source).toContain('args.options.onAutoHookTrace?.(attemptPlan.traceEvent as ServerToolAutoHookTraceEvent);');
    expect(source).toContain('throw error;');
    expect(source).not.toContain('catch (error) { continue;');
    expect(source).not.toContain('catch (error) { return null;');
  });
});

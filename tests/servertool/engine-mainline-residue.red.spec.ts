import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('engine mainline residue red gate', () => {
  test('engine.ts still contains local stopless mainline owner branches that must be removed', () => {
    const source = fs.readFileSync('sharedmodule/llmswitch-core/src/servertool/engine.ts', 'utf8');

    expect(source).not.toContain("if (runtimeAction.action === 'persist_pending_injection_and_return' && engineResult.pendingInjection)");
    expect(source).not.toContain("if (runtimeAction.action === 'return_servertool_cli_projection_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'return_stop_message_terminal_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'build_stop_message_cli_projection')");
    expect(source).not.toContain('const followupSummary: Record<string, unknown> = {');
    expect(source).not.toContain('throw Object.assign(new Error(`[servertool] retired followup/reenter mainline reached for flow ${flowId}`), {');
    expect(source).not.toContain('function resolveStoplessCliProjectionContext(');
    expect(source).not.toContain('planStoplessCliProjectionContextWithNative');
    expect(source).not.toContain('planServertoolEnginePreflightWithNative');
  });
});

import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

describe('engine mainline residue red gate', () => {
  test('servertool engine TS facades stay physically deleted', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine.ts')).toBe(false);
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts')).toBe(false);
  });

  test('servertool source does not restore retired engine orchestration semantics', () => {
    const servertoolRoot = 'sharedmodule/llmswitch-core/src/servertool';
    const sources = fs.readdirSync(servertoolRoot, { recursive: true })
      .map((entry) => `${servertoolRoot}/${String(entry)}`)
      .filter((entry) => /\.(?:ts|js)$/.test(entry) && fs.statSync(entry).isFile())
      .map((entry) => fs.readFileSync(entry, 'utf8'))
      .join('\n');

    expect(sources).not.toContain("if (runtimeAction.action === 'persist_pending_injection_and_return' && engineResult.pendingInjection)");
    expect(sources).not.toContain("if (runtimeAction.action === 'return_servertool_cli_projection_final')");
    expect(sources).not.toContain("if (runtimeAction.action === 'return_stop_message_terminal_final')");
    expect(sources).not.toContain("if (runtimeAction.action === 'build_stop_message_cli_projection')");
    expect(sources).not.toContain('const followupSummary: Record<string, unknown> = {');
    expect(sources).not.toContain('throw Object.assign(new Error(`[servertool] retired followup/reenter mainline reached for flow ${flowId}`), {');
    expect(sources).not.toContain('function resolveStoplessCliProjectionContext(');
    expect(sources).not.toContain('planStoplessCliProjectionContextWithNative');
  });
});

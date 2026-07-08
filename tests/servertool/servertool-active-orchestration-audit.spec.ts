import fs from 'node:fs';
import path from 'node:path';

const DELETED_SERVER_SIDE_TOOL_FILES = [
  'sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts',
  'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts',
  'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts',
] as const;

const DELETED_SERVER_SIDE_TOOL_TESTS = [
  'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
  'tests/servertool/continue-execution-finish-reason.spec.ts',
  'tests/servertool/continue-execution-followup.spec.ts',
  'tests/servertool/continue-execution-summary.spec.ts',
  'tests/servertool/engine-observation-shell.spec.ts',
  'tests/servertool/engine-preflight-shell.spec.ts',
  'tests/servertool/engine-selection-block.spec.ts',
  'tests/servertool/engine.stopless-session-thin-shell.spec.ts',
  'tests/servertool/exec-command-guard.spec.ts',
  'tests/servertool/execution-dispatch-outcome-shell.spec.ts',
  'tests/servertool/execution-queue-shell.spec.ts',
  'tests/servertool/execution-shell.auto-hook-failfast.spec.ts',
  'tests/servertool/execution-shell.backend-failfast.spec.ts',
  'tests/servertool/execution-shell.outcome-native.spec.ts',
  'tests/servertool/execution-stage-shell.spec.ts',
  'tests/servertool/progress-log-block.failfast.spec.ts',
  'tests/servertool/reasoning-only-continue.spec.ts',
  'tests/servertool/registry-orchestration-shell.spec.ts',
  'tests/servertool/response-stage-auto-hook-shell.spec.ts',
  'tests/servertool/response-stage-orchestration-shell.spec.ts',
  'tests/servertool/run-server-side-tool-engine-shell.spec.ts',
  'tests/servertool/server-side-tools.auto-hook-caller-guard.spec.ts',
  'tests/servertool/server-side-tools.auto-hook-config.spec.ts',
  'tests/servertool/server-side-tools.dispatch-native.spec.ts',
  'tests/servertool/server-side-tools.extract-tool-calls.spec.ts',
  'tests/servertool/server-side-tools.failfast.spec.ts',
  'tests/servertool/server-side-tools.response-stage-gate-guard.spec.ts',
  'tests/servertool/servertool-auto-hook-trace.spec.ts',
  'tests/servertool/servertool-mixed-tools.spec.ts',
  'tests/servertool/servertool-progress-logging.spec.ts',
  'tests/servertool/servertool-registry-casing.spec.ts',
  'tests/servertool/stop-message-auto-no-reenter.red.spec.ts',
  'tests/servertool/stopless-cli-continuation.spec.ts',
  'tests/servertool/stopmessage-anthropic-stop-sequence.spec.ts',
  'tests/servertool/stopmessage-compaction-false-positive.spec.ts',
  'tests/servertool/stopmessage-session-scope.spec.ts',
  'tests/servertool/timeout-error-block.spec.ts',
  'tests/sharedmodule/provider-response-post-servertool-effect-native.spec.ts',
] as const;

const ACTIVE_SOURCE_ROOTS = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
] as const;

const DELETED_IMPORT_MARKERS = [
  'servertool/auto-hook-caller.js',
  'servertool/engine-orchestration-shell.js',
  'servertool/execution-queue-shell.js',
  'servertool/execution-stage-shell.js',
  'servertool/progress-log-block.js',
  'servertool/run-server-side-tool-engine-shell.js',
  'servertool/timeout-error-block.js',
  'servertool/response-stage-orchestration-shell.js',
] as const;

const DELETED_RUNTIME_SYMBOLS = [
  'runServertoolResponseStageOrchestrationShell',
  'runServerToolOrchestrationShell',
  'orchestrateServertoolEngine',
  'runServertoolExecutionStage',
  'runServertoolIoExecutionQueue',
  'runServertoolAutoHookCaller',
  'planProviderResponseServertoolRuntimeActionsWithNative',
  'resolveProviderResponsePostServertoolEffectWithNative',
  'planProviderResponseServertoolRuntimeActionsJson',
  'resolveProviderResponsePostServertoolEffectJson',
] as const;

function repoPath(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

function collectFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!['dist', 'target', 'node_modules', 'coverage'].includes(entry)) {
        collectFiles(fullPath, out);
      }
      continue;
    }
    if (/\.(?:ts|tsx|js|mjs|rs)$/.test(entry)) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('servertool active orchestration audit', () => {
  for (const file of [...DELETED_SERVER_SIDE_TOOL_FILES, ...DELETED_SERVER_SIDE_TOOL_TESTS]) {
    it(`${file} must stay physically deleted`, () => {
      expect(fs.existsSync(repoPath(file))).toBe(false);
    });
  }

  it('active runtime source must not import deleted server-side tool engines', () => {
    const files = ACTIVE_SOURCE_ROOTS.flatMap((root) => collectFiles(repoPath(root)));
    const findings = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return DELETED_IMPORT_MARKERS
        .filter((marker) => source.includes(marker))
        .map((marker) => ({ file: path.relative(process.cwd(), file), marker }));
    });

    expect(findings).toEqual([]);
  });

  it('provider response shell fails fast instead of executing server-side tools', () => {
    const source = fs.readFileSync(
      repoPath('sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts'),
      'utf8',
    );

    expect(source).toContain('executeProviderResponseNativeServertoolEffects');
    expect(source).toContain('server-side tool execution has been removed');
    expect(source).toContain('CLI-owned tools must be projected by Rust');
    for (const symbol of DELETED_RUNTIME_SYMBOLS) {
      expect(source).not.toContain(symbol);
    }
  });
});

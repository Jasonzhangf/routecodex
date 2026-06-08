import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const SOURCE_ROOTS = ['src', 'sharedmodule/llmswitch-core/src', 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src'];

function walkFiles(dir: string, suffixes: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'target') continue;
      walkFiles(fullPath, suffixes, out);
      continue;
    }
    if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(fullPath);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => walkFiles(path.join(ROOT, root), ['.ts', '.rs']));
}

function relative(filePath: string): string {
  return path.relative(ROOT, filePath);
}

function matches(pattern: RegExp): string[] {
  const findings: string[] = [];
  for (const filePath of sourceFiles()) {
    const rel = relative(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index] ?? '')) {
        findings.push(`${rel}:${index + 1}`);
      }
    }
  }
  return findings;
}

describe('Error Pipeline contract', () => {
  it('exports the named ErrorErr01-06 skeleton wrappers from owning modules', () => {
    const owners = [
      ['src/providers/core/utils/provider-error-reporter.ts', 'capture_error_err_02_host_from_error_err_01_source'],
      ['src/providers/core/runtime/provider-failure-policy-impl.ts', 'classify_error_err_03_runtime_from_error_err_02_host'],
      ['sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts', 'apply_error_err_04_router_policy_from_error_err_03_runtime'],
      ['src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts', 'consume_error_err_05_execution_decision_from_error_err_04_router_policy'],
      ['src/server/utils/http-error-mapper.ts', 'project_error_err_06_client_from_error_err_05_execution_decision'],
    ] as const;
    for (const [ownerPath, symbol] of owners) {
      const source = fs.readFileSync(path.join(ROOT, ownerPath), 'utf8');
      expect(source).toContain(`export function ${symbol}`);
    }
  });

  it('owns ErrorErr02 capture in provider-error-reporter and keeps legacy emit APIs as wrappers', () => {
    const filePath = path.join(ROOT, 'src/providers/core/utils/provider-error-reporter.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).toContain('export function capture_error_err_02_host_from_error_err_01_source');
    expect(source).toContain('export async function report_error_err_02_host_to_router_policy_from_error_err_01_source');
    expect(source).toContain('export function emitProviderError(options: EmitOptions): void');
    expect(source).toContain('export async function emitProviderErrorAndWait(options: EmitOptions): Promise<void>');
  });

  it('router-direct does not classify provider transport errors locally', () => {
    const filePath = path.join(ROOT, 'src/server/runtime/http-server/router-direct-pipeline.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).toContain('onProviderError?: (error: unknown, context: RouterDirectAuditContext)');
    expect(source).toContain('await input.onProviderError?.(error, auditContext);');
    expect(source).not.toContain('isRecoverableDirectProviderError');
    expect(source).not.toContain('errorClassification:');
    expect(source).toContain('throw error;');
  });

  it('router-direct live path delegates provider errors to the unified ErrorErr05 execution plan', () => {
    const filePath = path.join(ROOT, 'src/server/runtime/http-server/index.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).toContain('router-direct.send.error');
    expect(source).toContain('resolveRequestExecutorProviderFailurePlan');
    expect(source).toContain('providerFailurePlan.retryExecutionPlan');
    expect(source).toContain("reason: 'router-direct-provider-failure-standard-retry'");
    expect(source).toContain('__routecodexProviderFailureAttemptOffset');
    expect(source).not.toContain('__routerDirectFailedProviderKey');
    expect(source).not.toContain('__routerDirectRecoverable');
  });

  it('handleProviderFailure is not implemented as independent policy in the TS proxy', () => {
    const filePath = path.join(ROOT, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).toContain('handleProviderFailure(event: ProviderFailureEvent): void');
    expect(source).toContain('this.nativeProxy.handleProviderFailure(JSON.stringify(event));');
    expect(source).not.toMatch(/handleProviderFailure\([^)]*\)\s*:\s*void\s*{[\s\S]*?health_manager\./);
  });

  it('manual reportProviderErrorToRouterPolicy event construction stays in bridge/capture modules only', () => {
    const offenders = matches(/reportProviderErrorToRouterPolicy\s*\(\s*\{/).filter((entry) => {
      return !entry.startsWith('src/providers/core/utils/provider-error-reporter.ts:')
        && !entry.startsWith('sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts:')
        && !entry.includes('/tests/');
    });
    expect(offenders).toEqual([]);
  });

  it('runtime source modules do not mutate Virtual Router health directly', () => {
    const providerRuntimeSourceRoots = [
      path.join(ROOT, 'src/providers'),
      path.join(ROOT, 'src/server/runtime/http-server/router-direct-pipeline.ts'),
      path.join(ROOT, 'src/server/runtime/http-server/executor'),
      path.join(ROOT, 'sharedmodule/llmswitch-core/src/conversion'),
    ];
    const offenders: string[] = [];
    for (const root of providerRuntimeSourceRoots) {
      const files = fs.statSync(root).isDirectory() ? walkFiles(root, ['.ts']) : [root];
      for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        const lines = source.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (/health_manager\.(record_|cooldown_|trip_provider|clear_|apply_)/.test(lines[index] ?? '')) {
            offenders.push(`${relative(filePath)}:${index + 1}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ErrorHandlingCenter is not imported by provider policy modules', () => {
    const policyFiles = sourceFiles().filter((filePath) => {
      const rel = relative(filePath);
      return rel.includes('providers/core/runtime')
        || rel.includes('providers/core/utils/provider-error-reporter')
        || rel.includes('server/runtime/http-server/executor/request-executor-provider')
        || rel.includes('server/runtime/http-server/executor/request-executor-retry')
        || rel.includes('router-direct-pipeline');
    });
    const offenders = policyFiles
      .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('ErrorHandlingCenter'))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});

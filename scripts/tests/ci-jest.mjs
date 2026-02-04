import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Keep CI Jest fast and deterministic:
// - Prefer pure unit tests / mock-provider tests (no external network).
// - Expand coverage by adding more suites here (don’t run `jest --all` in CI).
const routingInstructionTests = [
  'tests/token-daemon/interactive-refresh.spec.ts',
  'tests/server/runtime/request-executor.single-attempt.spec.ts',
  'tests/server/runtime/executor-provider.retryable.spec.ts',
  'tests/providers/auth/tokenfile-auth.iflow.spec.ts',
  'tests/providers/core/runtime/gemini-http-provider.unit.test.ts',
  'tests/providers/core/runtime/gemini-cli-http-provider.unit.test.ts',
  'tests/providers/core/runtime/base-provider.spec.ts',
  'tests/providers/core/runtime/http-transport-provider.headers.test.ts',
  'tests/providers/core/runtime/protocol-http-providers.unit.test.ts',
  'tests/providers/core/runtime/provider-error-classifier.spec.ts',
  'tests/providers/core/runtime/antigravity-quota-client.unit.test.ts',
  'tests/providers/core/utils/http-client.postStream.idle-timeout.spec.ts',
  'tests/providers/core/utils/snapshot-writer.sse-error-propagation.spec.ts',
  'tests/manager/quota/provider-quota-center.spec.ts',
  'tests/manager/quota/provider-quota-store.spec.ts',
  'tests/manager/quota/quota-manager-refresh.spec.ts',
  'tests/manager/quota/provider-quota-daemon-module.spec.ts',
  'tests/manager/quota/provider-key-normalization.spec.ts',
  'tests/responses/responses-openai-bridge.spec.ts',
  'tests/server/http-server/daemon-admin.e2e.spec.ts',
  'tests/server/http-server/daemon-admin-provider-pool.e2e.spec.ts',
  'tests/server/http-server/apikey-auth.e2e.spec.ts',
  'tests/server/http-server/quota-view-injection.spec.ts',
  'tests/server/http-server/quota-refresh-triggers.e2e.spec.ts',
  'tests/server/http-server/hub-policy-injection.spec.ts',
  'tests/server/http-server/session-header-injection.spec.ts',
  'tests/server/http-server/session-dir.spec.ts',
  'tests/server/http-server/execute-pipeline-failover.spec.ts',
  'tests/server/runtime/http-server/executor-provider.spec.ts',
  'tests/server/runtime/http-server/request-executor.spec.ts',
  'tests/server/utils/http-error-mapper-timeout.spec.ts',
  'tests/server/utils/http-error-mapper-malformed-request.spec.ts',
  'tests/server/handlers/handler-utils.apikey-denylist.spec.ts',
  'tests/server/handlers/sse-timeout.spec.ts',
  'tests/utils/is-direct-execution.test.ts',
  'tests/utils/windows-netstat.test.ts',
  'tests/servertool/virtual-router-context-fallback.spec.ts',
  'tests/servertool/virtual-router-longcontext-fallback.spec.ts',
  'tests/servertool/virtual-router-series-cooldown.spec.ts',
  'tests/servertool/virtual-router-context-weighted.spec.ts',
  'tests/servertool/virtual-router-engine-update-deps.spec.ts',
  'tests/servertool/virtual-router-health-weighted-rr.spec.ts',
  'tests/servertool/virtual-router-priority-selection.spec.ts',
  'tests/servertool/virtual-router-quota-routing.spec.ts',
  'tests/servertool/virtual-router-routing-instructions.spec.ts',
  'tests/servertool/virtual-router-servertool-routing.spec.ts',
  'tests/servertool/routing-instructions.spec.ts',
  'tests/servertool/server-side-web-search.spec.ts',
  'tests/servertool/vision-flow.spec.ts',
  'tests/servertool/gemini-empty-reply-continue.spec.ts',
  'tests/servertool/iflow-model-error-retry.spec.ts',
  'tests/servertool/apply-patch-guard.spec.ts',
  'tests/servertool/exec-command-guard.spec.ts',
  'tests/servertool/hub-pipeline-session-headers.spec.ts',
  'tests/servertool/stopmessage-anthropic-stop-sequence.spec.ts',
  'tests/servertool/servertool-progress-logging.spec.ts',
  'tests/unified-hub/hub-v1-single-path-imports.spec.ts',
  'tests/unified-hub/policy-errorsample-write.spec.ts',
  'tests/unified-hub/policy-observe-shadow.spec.ts',
  'tests/unified-hub/shadow-runtime-compare.errorsamples.spec.ts'
];

const cliTests = [
  'tests/cli/clean-command.spec.ts',
  'tests/cli/code-command.spec.ts',
  'tests/cli/config-command.spec.ts',
  'tests/cli/env-command.spec.ts',
  'tests/cli/env-output.spec.ts',
  'tests/cli/examples-command.spec.ts',
  'tests/cli/port-command.spec.ts',
  'tests/cli/port-utils.spec.ts',
  'tests/cli/restart-command.spec.ts',
  'tests/cli/smoke.spec.ts',
  'tests/cli/start-command.spec.ts',
  'tests/cli/status-command.spec.ts',
  'tests/cli/stop-command.spec.ts'
];

const wantsCoverage = process.argv.includes('--coverage') || process.env.ROUTECODEX_CI_COVERAGE === '1';
const allTests = [...routingInstructionTests, ...cliTests];

const jestBin = path.join(process.cwd(), 'node_modules', 'jest', 'bin', 'jest.js');

const args = [
  '--runTestsByPath',
  ...allTests,
  ...(wantsCoverage ? ['--testTimeout=20000'] : []),
  ...(wantsCoverage
    ? [
        '--coverage',
        ...(process.env.ROUTECODEX_CI_MAX_WORKERS
          ? [`--maxWorkers=${process.env.ROUTECODEX_CI_MAX_WORKERS}`]
          : []),
        '--coverageReporters=json-summary',
        '--coverageReporters=text',
        '--coverageDirectory=coverage'
      ]
    : [])
];

const result = spawnSync(
  process.execPath,
  ['--experimental-vm-modules', jestBin, ...args],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);

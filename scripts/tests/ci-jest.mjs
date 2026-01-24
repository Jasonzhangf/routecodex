import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const routingInstructionTests = [
  'tests/server/runtime/request-executor.single-attempt.spec.ts',
  'tests/server/runtime/executor-provider.retryable.spec.ts',
  'tests/providers/auth/tokenfile-auth.iflow.spec.ts',
  'tests/providers/core/runtime/gemini-cli-http-provider.unit.test.ts',
  'tests/providers/core/runtime/antigravity-quota-client.unit.test.ts',
  'tests/manager/quota/provider-quota-center.spec.ts',
  'tests/manager/quota/provider-quota-store.spec.ts',
  'tests/manager/quota/quota-manager-refresh.spec.ts',
  'tests/manager/quota/provider-quota-daemon-module.spec.ts',
  'tests/manager/quota/provider-key-normalization.spec.ts',
  'tests/server/http-server/daemon-admin.e2e.spec.ts',
  'tests/server/http-server/quota-view-injection.spec.ts',
  'tests/server/http-server/quota-refresh-triggers.e2e.spec.ts',
  'tests/server/http-server/hub-policy-injection.spec.ts',
  'tests/server/http-server/session-header-injection.spec.ts',
  'tests/server/http-server/session-dir.spec.ts',
  'tests/server/handlers/sse-timeout.spec.ts',
  'tests/utils/is-direct-execution.test.ts',
  'tests/utils/windows-netstat.test.ts',
  'tests/servertool/virtual-router-context-fallback.spec.ts',
  'tests/servertool/virtual-router-longcontext-fallback.spec.ts',
  'tests/servertool/virtual-router-series-cooldown.spec.ts',
  'tests/servertool/routing-instructions.spec.ts',
  'tests/servertool/stopmessage-anthropic-stop-sequence.spec.ts',
  'tests/servertool/servertool-progress-logging.spec.ts',
  'tests/unified-hub/hub-v1-single-path-imports.spec.ts'
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
  ...(wantsCoverage
    ? [
        '--coverage',
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

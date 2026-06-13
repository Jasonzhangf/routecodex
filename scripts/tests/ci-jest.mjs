import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Keep CI Jest fast and deterministic:
// - Prefer pure unit tests / mock-provider tests (no external network).
// - Expand coverage by adding more suites here (don’t run `jest --all` in CI).
const routingInstructionTests = [
  'tests/token-daemon/token-daemon.auto-refresh-noninteractive.spec.ts',
  'tests/server/runtime/request-executor.single-attempt.spec.ts',
  'tests/server/runtime/executor-provider.retryable.spec.ts',
  'tests/server/runtime/http-server/executor/usage-aggregator.spec.ts',
  'tests/providers/core/runtime/gemini-http-provider.unit.test.ts',
  'tests/providers/core/runtime/deepseek-http-provider.unit.test.ts',
  'tests/providers/core/runtime/base-provider.spec.ts',
  'tests/providers/core/runtime/http-transport-provider.headers.test.ts',
  'tests/providers/core/runtime/protocol-http-providers.unit.test.ts',
  'tests/providers/core/runtime/provider-error-classifier.spec.ts',
  'tests/providers/core/runtime/provider-2056-classification.spec.ts',
  'tests/providers/core/runtime/provider-request-preprocessor.unit.test.ts',
  'tests/providers/core/utils/http-client.postStream.idle-timeout.spec.ts',
  'tests/providers/core/utils/snapshot-writer.sse-error-propagation.spec.ts',
  'tests/manager/quota/provider-quota-center.spec.ts',
  'tests/manager/quota/provider-quota-store.spec.ts',
  'tests/manager/quota/provider-key-normalization.spec.ts',
  'tests/responses/responses-openai-bridge.spec.ts',
  'tests/server/http-server/daemon-admin.e2e.spec.ts',
  'tests/server/http-server/daemon-admin-provider-pool.e2e.spec.ts',
  'tests/server/http-server/apikey-auth.e2e.spec.ts',
  'tests/server/http-server/quota-view-injection.spec.ts',
  'tests/server/http-server/hub-policy-injection.spec.ts',
  'tests/server/http-server/session-dir.spec.ts',
  'tests/server/http-server/execute-pipeline-failover.spec.ts',
  'tests/server/runtime/http-server/executor-provider.spec.ts',
  'tests/server/runtime/http-server/request-executor.spec.ts',
  'tests/red-tests/error_chain_singleton_truth.test.ts',
  'tests/red-tests/vr_route_availability_floor_singleton_truth.test.ts',
  'tests/server/runtime/http-server/executor/error-chain-singleton.unit.test.ts',
  'tests/red-tests/server_module_help_contract.test.ts',
  'tests/red-tests/server_req_adapter_metadata_whitelist.test.ts',
  'tests/red-tests/server_response_projection_metadata_guard.test.ts',
  'tests/red-tests/server_error_projection_metadata_guard.test.ts',
  'tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts',
  'tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts',
  'tests/server/handlers/handler-utils.metadata-contract.spec.ts',
  'tests/sharedmodule/server-module-help.live.spec.ts',
  'tests/server/runtime/http-server/provider-direct-pipeline.spec.ts',
  'tests/server/runtime/http-server/router-direct-pipeline.spec.ts',
  'tests/server/runtime/http-server/direct-passthrough-payload.spec.ts',
  'tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts',
  'tests/server/runtime/http-server/port-config-validator-sameprotocol.spec.ts',
  'tests/server/utils/http-error-mapper-timeout.spec.ts',
  'tests/server/utils/http-error-mapper-malformed-request.spec.ts',
  'tests/server/handlers/handler-utils.apikey-denylist.spec.ts',
  'tests/server/handlers/sse-timeout.spec.ts',
  'tests/utils/is-direct-execution.test.ts',
  'tests/utils/windows-netstat.test.ts',
  'tests/servertool/virtual-router-context-fallback.spec.ts',
  'tests/servertool/virtual-router-longcontext-fallback.spec.ts',
  'tests/servertool/virtual-router-series-cooldown.spec.ts',
  'tests/servertool/virtual-router-engine-update-deps.spec.ts',
  'tests/servertool/virtual-router-priority-selection.spec.ts',
  'tests/servertool/virtual-router-quota-routing.spec.ts',
  'tests/servertool/virtual-router-routing-instructions.spec.ts',
  'tests/servertool/virtual-router-servertool-routing.spec.ts',
  'tests/servertool/routing-instructions.spec.ts',
  'tests/servertool/server-side-web-search.spec.ts',
  'tests/servertool/vision-flow.spec.ts',
  'tests/servertool/exec-command-guard.spec.ts',
  'tests/servertool/hub-pipeline-session-headers.spec.ts',
  'tests/servertool/stopmessage-anthropic-stop-sequence.spec.ts',
  'tests/servertool/servertool-progress-logging.spec.ts',
  'tests/servertool/stop-message-native-decision.spec.ts',
  'tests/servertool/stopless-direct-mode-guard.spec.ts',
  'tests/sharedmodule/anthropic-tool-schema-stability.spec.ts',
  'tests/sharedmodule/apply-patch-chat-process-contract.spec.ts',
  'tests/sharedmodule/virtual-router-hit-log.spec.ts',
  'tests/utils/snapshot-stage-policy.spec.ts',
  'tests/debug/snapshot-store-port-isolation.red.spec.ts',
  'tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts',
  'tests/server/runtime/http-server/executor/provider-response-converter.error-logging.spec.ts',
  'tests/server/runtime/http-server/executor/provider-response-converter.finish-reason.spec.ts',
  'tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts',
  'tests/unified-hub/hub-v1-single-path-imports.spec.ts',
  'tests/unified-hub/policy-errorsample-write.spec.ts',
  'tests/unified-hub/runtime-error-errorsample-write.spec.ts',
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

const webuiTests = [
  'tests/frontend/webui-app.utils.spec.ts',
  'tests/frontend/webui-app.render.spec.tsx',
  'tests/frontend/webui-app.integration.spec.tsx',
  'tests/frontend/webui-app.pages.spec.tsx',
  'tests/frontend/webui-app.edge.spec.tsx'
];

const wantsCoverage = process.argv.includes('--coverage') || process.env.ROUTECODEX_CI_COVERAGE === '1';
const allTests = [...routingInstructionTests, ...cliTests, ...webuiTests];

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

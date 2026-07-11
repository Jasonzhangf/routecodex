#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const issues = [];

function fail(check, detail) {
  issues.push({ check, detail });
}

function pass(check, detail) {
  console.log(`[PASS] ${check}: ${detail}`);
}

function repoPath(path) {
  return resolve(ROOT, path);
}

function rel(path) {
  return relative(ROOT, path);
}

function readRequired(path) {
  if (!existsSync(path)) {
    fail('required-file', `${rel(path)} is missing`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function collectFiles(dir, out = []) {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!['dist', 'target', 'node_modules', 'coverage', '.git'].includes(entry)) {
        collectFiles(fullPath, out);
      }
      continue;
    }
    if (/\.(?:ts|tsx|js|mjs|rs|yml|yaml|json|md)$/.test(entry)) {
      out.push(fullPath);
    }
  }
  return out;
}

function assertMissing(check, paths, reason) {
  for (const path of paths) {
    if (existsSync(path)) {
      fail(check, `${rel(path)} must stay physically deleted; ${reason}`);
    }
  }
  pass(check, `${paths.length} deleted paths are absent`);
}

function assertContains(check, path, content, marker) {
  if (!content.includes(marker)) {
    fail(check, `${rel(path)} must contain ${marker}`);
  }
}

function assertNotContains(check, path, content, marker) {
  if (content.includes(marker)) {
    fail(check, `${rel(path)} must not contain ${marker}`);
  }
}

const deletedServerSideToolFiles = [
  'sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts',
  'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts',
  'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/timeout-error-block.ts',
  'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts',
  'sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-impl.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/cli-projection.ts',
  'sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/cli-executor.ts',
].map(repoPath);

const deletedServerSideToolTests = [
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
].map(repoPath);

const deletedNativeExports = [
  'planProviderResponseServertoolRuntimeActionsJson',
  'resolveProviderResponsePostServertoolEffectJson',
  'projectPostServertoolHubRespOutbound04ClientSemanticJson',
];

const deletedTsBridgeSymbols = [
  'runServertoolResponseStageOrchestrationShell',
  'runServerToolOrchestrationShell',
  'orchestrateServertoolEngine',
  'runServertoolExecutionStage',
  'runServertoolIoExecutionQueue',
  'runServertoolAutoHookCaller',
  'planProviderResponseServertoolRuntimeActionsWithNative',
  'resolveProviderResponsePostServertoolEffectWithNative',
  'projectPostServertoolHubRespOutbound04ClientSemanticWithNative',
  ...deletedNativeExports,
];

const activeRuntimeRoots = [
  repoPath('src'),
  repoPath('sharedmodule/llmswitch-core/src'),
  repoPath('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src'),
];

function checkDeletedServerSideToolRuntimeAbsent() {
  assertMissing(
    'server-side-tool-runtime-deleted',
    [...deletedServerSideToolFiles, ...deletedServerSideToolTests],
    'server-side tool execution is retired and CLI-owned tools are projected by Rust'
  );
}

function checkNoActiveRuntimeRefs() {
  const files = activeRuntimeRoots.flatMap((root) => collectFiles(root));
  const allow = new Set([
    repoPath('src/modules/llmswitch/bridge/provider-response-converter-host.ts'),
  ]);
  for (const file of files) {
    if (allow.has(file)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    for (const marker of [
      ...deletedTsBridgeSymbols,
      'servertool/auto-hook-caller.js',
      'servertool/engine-orchestration-shell.js',
      'servertool/execution-queue-shell.js',
      'servertool/execution-stage-shell.js',
      'servertool/progress-log-block.js',
      'servertool/run-server-side-tool-engine-shell.js',
      'servertool/timeout-error-block.js',
      'servertool/response-stage-orchestration-shell.js',
    ]) {
      if (source.includes(marker)) {
        fail('server-side-tool-runtime-ref-deleted', `${rel(file)} contains retired marker ${marker}`);
      }
    }
  }
  pass('server-side-tool-runtime-ref-deleted', `scanned ${files.length} active runtime files`);
}

function checkProviderResponseFailFastShell() {
  const path = repoPath('src/modules/llmswitch/bridge/provider-response-converter-host.ts');
  const source = readRequired(path);
  assertContains('provider-response-servertool-failfast', path, source, 'executeProviderResponseNativeServertoolEffects');
  assertContains('provider-response-servertool-failfast', path, source, 'server-side tool execution has been removed');
  assertContains('provider-response-servertool-failfast', path, source, 'CLI-owned tools must be projected by Rust');
  assertContains('provider-response-servertool-failfast', path, source, 'writeRustStopGatewayContextToMetadataCenter');
  assertContains('provider-response-servertool-failfast', path, source, 'applyNativeRuntimeControlWritePlan');
  assertContains('provider-response-servertool-failfast', path, source, 'readBoundMetadataCenter');
  for (const marker of deletedTsBridgeSymbols) {
    assertNotContains('provider-response-servertool-failfast', path, source, marker);
  }
  pass('provider-response-servertool-failfast', 'provider-response host boundary has no server-side executor bridge');
}

function checkNativeExportSurface() {
  const requiredExportsPath = repoPath('sharedmodule/llmswitch-core/native-hotpath-required-exports.json');
  const libPath = repoPath('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs');
  const protocolPath = repoPath('tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts');
  const nativeExportsPath = repoPath('src/modules/llmswitch/bridge/native-exports.ts');
  for (const [path, source] of [
    [requiredExportsPath, readRequired(requiredExportsPath)],
    [libPath, readRequired(libPath)],
  ]) {
    for (const marker of deletedNativeExports) {
      assertNotContains('native-servertool-runtime-action-export-deleted', path, source, marker);
    }
  }
  const protocol = readRequired(protocolPath);
  assertContains('native-servertool-runtime-effects-carrier', protocolPath, protocol, 'servertoolRuntimeActions: Array<Record<string, unknown>>');
  assertContains('native-servertool-runtime-effects-carrier', protocolPath, protocol, 'Array.isArray(row.servertoolRuntimeActions)');
  const nativeExports = readRequired(nativeExportsPath);
  const retiredServertoolWrapperSubpath = ['native', 'servertool-wrapper'].join('/');
  const retiredServertoolWrapperToken = ['servertool', 'wrapper'].join('-');
  for (const marker of [
    'SERVERTOOL ORCHESTRATION WRAPPERS',
    'SERVERTOOL CORE BRIDGE WRAPPERS',
    'servertool-core bridge:',
    retiredServertoolWrapperSubpath,
    'export function inspectStopGatewaySignalWithNative',
    'export function planServertoolEnginePreflightWithNative',
    'export function resolveServertoolExecutionLoopInitialDecisionWithNative',
    'export function finalizeServertoolResponseStageWithNative',
  ]) {
    assertNotContains('native-servertool-wrapper-fanout-deleted', nativeExportsPath, nativeExports, marker);
  }
  for (const [path, source] of [
    [repoPath('sharedmodule/llmswitch-core/package.json'), readRequired(repoPath('sharedmodule/llmswitch-core/package.json'))],
    [repoPath('scripts/verify-rcc-release-install.mjs'), readRequired(repoPath('scripts/verify-rcc-release-install.mjs'))],
    [repoPath('scripts/install-release-snapshot.mjs'), readRequired(repoPath('scripts/install-release-snapshot.mjs'))],
    [repoPath('scripts/lib/build-core-utils.mjs'), readRequired(repoPath('scripts/lib/build-core-utils.mjs'))],
  ]) {
    assertNotContains('native-servertool-wrapper-package-subpath-deleted', path, source, retiredServertoolWrapperToken);
  }
  pass('native-servertool-runtime-action-export-deleted', 'runtime action planner exports are absent');
}

function checkFocusedVerificationMap() {
  const verificationMapPath = repoPath('docs/architecture/verification-map.yml');
  const verificationMap = readRequired(verificationMapPath);
  for (const required of [
    'tests/cli/servertool-command.spec.ts',
    'tests/servertool/servertool-cli-native-bridge.spec.ts',
    'tests/servertool/servertool-cli-result-restore.spec.ts',
    'tests/servertool/servertool-active-orchestration-audit.spec.ts',
    'tests/sharedmodule/provider-response.metadata-center-provider-protocol.spec.ts',
    'tests/sharedmodule/native-required-exports-sse-stream.spec.ts',
    'tests/sharedmodule/apply-patch-chat-process-contract.spec.ts',
  ]) {
    if (!existsSync(repoPath(required))) {
      fail('servertool-verification-map', `${required} is listed as required but is missing`);
      continue;
    }
    assertContains('servertool-verification-map', verificationMapPath, verificationMap, required);
  }
  for (const deleted of deletedServerSideToolTests.map(rel)) {
    assertNotContains('servertool-verification-map', verificationMapPath, verificationMap, deleted);
  }
  pass('servertool-verification-map', 'verification map points at live servertool closeout gates');
}

function checkPackageAndCiLists() {
  const packagePath = repoPath('package.json');
  const ciPath = repoPath('scripts/tests/ci-jest.mjs');
  const pkg = JSON.parse(readRequired(packagePath));
  for (const scriptName of ['build', 'build:min']) {
    const script = pkg.scripts?.[scriptName] ?? '';
    if (!script.includes('npm run verify:servertool-rust-only')) {
      fail('servertool-gate-in-build', `package.json ${scriptName} must run verify:servertool-rust-only`);
    }
  }
  const packageText = readRequired(packagePath);
  const ciText = readRequired(ciPath);
  for (const deleted of deletedServerSideToolTests.map(rel)) {
    assertNotContains('servertool-deleted-tests-unlisted', packagePath, packageText, deleted);
    assertNotContains('servertool-deleted-tests-unlisted', ciPath, ciText, deleted);
  }
  pass('servertool-gate-in-build', 'build scripts keep servertool rust-only gate');
}

console.log('\n=== verify-servertool-rust-only ===\n');

checkDeletedServerSideToolRuntimeAbsent();
checkNoActiveRuntimeRefs();
checkProviderResponseFailFastShell();
checkNativeExportSurface();
checkFocusedVerificationMap();
checkPackageAndCiLists();

console.log();

if (issues.length === 0) {
  console.log('All checks passed: server-side servertool runtime execution is removed.');
  process.exit(0);
}

console.log(`${issues.length} failure(s):\n`);
for (const issue of issues) {
  console.log(`[${issue.check}] ${issue.detail}\n`);
}
process.exit(1);

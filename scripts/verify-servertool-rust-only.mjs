#!/usr/bin/env node

/**
 * verify-servertool-rust-only.mjs
 *
 * Audit gate that verifies servertool Rust-only invariants.
 * Designed as a CI gate to catch regressions.
 *
 * Checks:
 * 1. No .bak files exist in active servertool paths
 * 2. No TS handler files are imported as side-effect runtime dependencies
 * 3. No duplicate semantic keywords (followupInjectionOps, buildServertoolGenericFollowupPayload)
 *    survive outside documentation
 *
 * Usage:
 *   node scripts/verify-servertool-rust-only.mjs
 *   node scripts/verify-servertool-rust-only.mjs --fix    (informational only)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Paths to scan ──────────────────────────────────────────────
const SERVERTOOL_TS_DIR = `${ROOT}/sharedmodule/llmswitch-core/src/servertool`;
const RUST_SRC_DIR = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`;
const CHAT_SERVERTOOL_ORCHESTRATION = `${RUST_SRC_DIR}/chat_servertool_orchestration.rs`;
const FUNCTION_MAP = `${ROOT}/docs/architecture/function-map.yml`;
const VERIFICATION_MAP = `${ROOT}/docs/architecture/verification-map.yml`;
const PACKAGE_JSON = `${ROOT}/package.json`;
const CLI_PROJECTION = `${SERVERTOOL_TS_DIR}/cli-projection.ts`;
const CLI_RESULT_GUARD = `${SERVERTOOL_TS_DIR}/cli-result-guard.ts`;
const TS_CLI_EXECUTOR = `${SERVERTOOL_TS_DIR}/cli-executor.ts`;
const RUST_SERVERTOOL_CLI = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/src/main.rs`;
const RUST_FOLLOWUP_CORE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/followup-core/src/lib.rs`;
const RUST_ROUTER_HOTPATH_NAPI_LIB = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`;
const RUST_SERVERTOOL_CORE_LOOKUP = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`;
const RUST_SERVERTOOL_COUNTER = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_counter.rs`;
const RUST_SERVERTOOL_BACKEND_ROUTE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`;
const RUST_SERVERTOOL_TEXT_EXTRACTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/text_extraction.rs`;
const RUST_SERVERTOOL_CLI_RESULT_GUARD = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_result_guard.rs`;
const TS_SERVER_SIDE_TOOLS = `${SERVERTOOL_TS_DIR}/server-side-tools.ts`;
const TS_BACKEND_ROUTE_SHAPE_GUARD = `${SERVERTOOL_TS_DIR}/backend-route-shape-guard.ts`;
const TS_BACKEND_ROUTE_FINALIZE = `${SERVERTOOL_TS_DIR}/backend-route-finalize-block.ts`;
const TS_BACKEND_ROUTE_FLOW_POLICY = `${SERVERTOOL_TS_DIR}/backend-route-flow-policy.ts`;
const TS_BACKEND_ROUTE_ORIGIN_DELTA = `${SERVERTOOL_TS_DIR}/backend-route-origin-delta.ts`;
const TS_BACKEND_ROUTE_RUNTIME = `${SERVERTOOL_TS_DIR}/backend-route-runtime-block.ts`;
const TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY = `${SERVERTOOL_TS_DIR}/backend-route-bootstrap-replay-block.ts`;
const TS_STOP_MESSAGE_LOOP_GUARD = `${SERVERTOOL_TS_DIR}/stop-message-loop-guard-block.ts`;
const TS_STOP_MESSAGE_COUNTER = `${SERVERTOOL_TS_DIR}/stop-message-counter.ts`;
const NATIVE_FOLLOWUP_MAINLINE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-followup-mainline-semantics.ts`;
const STOP_MESSAGE_AUTO_HANDLER = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto.ts`;
const STOP_MESSAGE_RUNTIME_UTILS = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/runtime-utils.ts`;
const SERVERTOOL_STATE_SCOPE = `${SERVERTOOL_TS_DIR}/state-scope.ts`;
const NATIVE_SERVERTOOL_CORE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`;
const NATIVE_REQUIRED_EXPORTS = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`;
const NATIVE_BUILD_SCRIPT = `${ROOT}/sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`;
const ACTIVE_RUNTIME_SCAN_PATHS = [
  `${ROOT}/src`,
  `${ROOT}/sharedmodule/llmswitch-core/src`,
  `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`,
];
const ACTIVE_RUNTIME_EXCLUDE_SUBSTRINGS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/tests/',
  '/__tests__/',
];

// ── Issues accumulator ─────────────────────────────────────────
const issues = [];

function fail(check, detail) {
  issues.push({ check, detail, severity: 'fail' });
}

function warn(check, detail) {
  issues.push({ check, detail, severity: 'warn' });
}

function pass(check, detail) {
  console.log(`[PASS] ${check}: ${detail}`);
}

function readRequired(path) {
  if (!existsSync(path)) {
    fail('required-file', `Missing required file: ${path}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function assertContains(check, file, content, needle) {
  if (!content.includes(needle)) {
    fail(check, `${file} must contain "${needle}"`);
    return;
  }
  pass(check, `${file.replace(`${ROOT}/`, '')} contains "${needle}"`);
}

function listFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = `${dir}/${entry}`;
    if (ACTIVE_RUNTIME_EXCLUDE_SUBSTRINGS.some((part) => full.includes(part))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listFiles(full, files);
    } else if (/\.d\.ts$/.test(full)) {
      continue;
    } else if (/\.(ts|tsx|js|mjs|rs)$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

function findJestUnstableMockModuleBlock(content, modulePath) {
  const moduleIndex = content.indexOf(`jest.unstable_mockModule(\n  '${modulePath}'`);
  if (moduleIndex < 0) return null;

  const nextMockIndex = content.indexOf('\njest.unstable_mockModule(', moduleIndex + 1);
  if (nextMockIndex < 0) {
    return content.slice(moduleIndex);
  }
  return content.slice(moduleIndex, nextMockIndex);
}

function extractFunctionBlock(content, functionName) {
  const signature = `function ${functionName}`;
  const start = content.indexOf(signature);
  if (start < 0) return '';
  const braceStart = content.indexOf('{', start);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let index = braceStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }
  return content.slice(start);
}

// ── Check 1: No .bak files in active servertool paths ──────────
function checkNoBakFiles() {
  try {
    const tsBak = execSync(
      `find "${SERVERTOOL_TS_DIR}" -name "*.bak" -maxdepth 5 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (tsBak) {
      fail('no-bak-files', `TS servertool path contains .bak files:\n${tsBak}`);
    } else {
      console.log('[PASS] no-bak-files: No .bak files in TS servertool path');
    }
  } catch {
    warn('no-bak-files', 'Could not scan TS servertool path for .bak files');
  }

  try {
    const rustBak = execSync(
      `find "${RUST_SRC_DIR}" -name "*.bak" -maxdepth 5 2>/dev/null`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    if (rustBak) {
      fail('no-bak-files', `Rust servertool path contains .bak files:\n${rustBak}`);
    } else {
      console.log('[PASS] no-bak-files: No .bak files in Rust path');
    }
  } catch {
    warn('no-bak-files', 'Could not scan Rust path for .bak files');
  }
}

// ── Check 2: No TS handler files are imported as runtime deps ──
function checkNoTSHandlerRuntimeImport() {
  const handlerDir = `${SERVERTOOL_TS_DIR}/handlers`;
  try {
    const files = execSync(
      `find "${handlerDir}" -name "*.ts" -maxdepth 3 ! -name "*.d.ts" 2>/dev/null | sort`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);

    // Known allowed imports — these are thin shells or utilities
    const allowedImports = [
      'memory/extract-responses-input',  // small extraction helper
    ];

    for (const file of files) {
      const relative = file.replace(`${SERVERTOOL_TS_DIR}/`, '');
      const modulePath = relative.replace(/\.ts$/, '');

      // Skip allowed
      if (allowedImports.some((a) => modulePath.endsWith(a))) {
        continue;
      }

      // Check if this handler is imported from outside the handlers dir
      // (self-imports within handlers/ are OK)
      try {
        const importers = execSync(
          `grep -rl "from.*['\\"]${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\\"]" "${SERVERTOOL_TS_DIR}" --include="*.ts" ! -path "${handlerDir}/*" 2>/dev/null`,
          { encoding: 'utf8', stdio: 'pipe' }
        ).trim();
        if (importers) {
          warn('no-handler-runtime-import',
            `Handler ${modulePath} imported from outside handlers/:\n${importers}`);
        }
      } catch {
        // grep found nothing = good
      }
    }
    console.log(`[PASS] no-handler-runtime-import: Scanned ${files.length} handler files`);
  } catch (err) {
    warn('no-handler-runtime-import', `Could not scan: ${err.message}`);
  }
}

// ── Check 3: No forbidden duplicate semantic keywords ──────────
function checkNoDuplicateSemantics() {
  const forbidden = [
    'followupInjectionOps',
    'buildServertoolGenericFollowupPayload',
    // stop-message-auto: these native-replaced functions must not reappear in TS handler
    'readPinnedTargetFromAdapterContext',
  ];

  for (const keyword of forbidden) {
    try {
      const result = execSync(
        `grep -r "${keyword}" "${ROOT}/sharedmodule/llmswitch-core/src" --include="*.ts" --include="*.rs" 2>/dev/null`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (result) {
        // Allow doc comments — check if all hits are in comments/docs
        const lines = result.split('\n').filter(Boolean);
        const nonDocLines = lines.filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*');
        });
        if (nonDocLines.length > 0) {
          fail('no-duplicate-semantics', `Forbidden keyword "${keyword}" found in non-doc context:\n${nonDocLines.join('\n')}`);
        }
      }
      console.log(`[PASS] no-duplicate-semantics: "${keyword}" not found in non-doc context`);
    } catch {
      // grep exit code 1 = no matches = good
      console.log(`[PASS] no-duplicate-semantics: "${keyword}" not found`);
    }
  }
}

// ── Check 4: Servertool CLI projection owner/protocol map ──────
function checkServertoolCliProjectionMap() {
  const functionMap = readRequired(FUNCTION_MAP);
  const verificationMap = readRequired(VERIFICATION_MAP);
  const orchestration = readRequired(CHAT_SERVERTOOL_ORCHESTRATION);
  const cliProjection = readRequired(CLI_PROJECTION);
  const rustCliContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`);
  const rustOutcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeServertoolWrapper = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`);

  assertContains(
    'cli-projection-map',
    FUNCTION_MAP,
    functionMap,
    'feature_id: hub.servertool_cli_projection'
  );
  assertContains(
    'cli-projection-map',
    VERIFICATION_MAP,
    verificationMap,
    'feature_id: hub.servertool_cli_projection'
  );
  assertContains(
    'cli-projection-owner',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    'feature_id: hub.servertool_cli_projection'
  );
  assertContains(
    'cli-projection-owner',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    'build_servertool_cli_projection_01_from_hub_resp_chatprocess_03'
  );
  assertContains(
    'cli-projection-command-contract',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    'routecodex servertool run <toolName> --input-json <json>'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'routecodex servertool run {} --input-json'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    rustOutcomeContract,
    'pub fn quote_posix_single_argument'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    rustOutcomeContract,
    'quote_posix_single_argument(&input_json)'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'quote_posix_single_argument(&input_json)'
  );
  for (const [file, content] of [
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`, rustOutcomeContract],
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract],
  ]) {
    const runtimeSource = content.split('#[cfg(test)]')[0];
    if (runtimeSource.includes("--input-json '")) {
      fail(
        'cli-projection-command-contract',
        `${file.replace(`${ROOT}/`, '')} runtime command builder must not wrap input JSON with raw single quotes; use quote_posix_single_argument`
      );
    }
  }
  assertContains(
    'cli-projection-native-wrapper',
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`,
    nativeServertoolWrapper,
    'buildClientExecCliProjectionOutputWithNative'
  );
  assertContains(
    'cli-projection-native-wrapper',
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`,
    nativeServertoolWrapper,
    'buildClientVisibleProjectionShellWithNative'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    '"name": "exec_command"'
  );
  assertContains(
    'cli-projection-additional-tool-guard',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'classify_servertool_outcome(function_name).is_some()'
  );
  assertContains(
    'cli-projection-internal-carrier-guard',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'DeniedInternalCarrier'
  );
  assertContains(
    'cli-projection-internal-carrier-guard',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'DENIED_INTERNAL_CARRIER_KEYS'
  );
  assertContains(
    'cli-projection-internal-carrier-guard',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'validate_no_internal_carrier(&value)'
  );
  assertContains('cli-projection-thin-wrapper', CLI_PROJECTION, cliProjection, 'buildClientVisibleProjectionShellWithNative');
  if (cliProjection.includes("name: 'exec_command'") || cliProjection.includes('"name": "exec_command"')) {
    fail('cli-projection-command-contract', 'cli-projection.ts must not build exec_command tool call shape in TS');
  }
  if (cliProjection.includes('routecodex servertool run')) {
    fail('cli-projection-command-contract', 'cli-projection.ts must not build servertool CLI command strings in TS');
  }
}

// ── Check 5: Build must run this gate ──────────────────────────
function checkBuildIncludesServertoolGate() {
  const pkg = JSON.parse(readRequired(PACKAGE_JSON));
  const required = 'npm run verify:servertool-rust-only';
  for (const scriptName of ['build', 'build:min']) {
    const script = pkg.scripts?.[scriptName] ?? '';
    if (!script.includes(required)) {
      fail('build-runs-servertool-gate', `package.json script "${scriptName}" must include "${required}"`);
    } else {
      pass('build-runs-servertool-gate', `${scriptName} includes ${required}`);
    }
  }
}

// ── Check 6: Removed old CLI restoration markers from runtime ──
function checkNoOldCliRestorationRuntime() {
  const forbidden = [
    '--ticket',
    'old_cli_',
    'old_cli_result_',
    'restoration handle',
    'restoration store',
  ];
  const files = ACTIVE_RUNTIME_SCAN_PATHS.flatMap((dir) => listFiles(dir));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const keyword of forbidden) {
      if (content.includes(keyword)) {
        fail(
          'no-old-cli-restoration-runtime',
          `Forbidden old CLI restoration marker "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }
  pass('no-old-cli-restoration-runtime', `scanned ${files.length} active runtime files`);
}

// ── Check 7: Migrated CLI paths must not reenter provider flow ──
function checkMigratedProjectionDoesNotReenter() {
  for (const file of [CLI_PROJECTION, CLI_RESULT_GUARD]) {
    const content = readRequired(file);
    for (const keyword of ['reenterPipeline', 'providerInvoker']) {
      if (content.includes(keyword)) {
        fail(
          'cli-projection-no-reenter',
          `${file.replace(`${ROOT}/`, '')} must not reference ${keyword}`
        );
      }
    }
  }
  pass('cli-projection-no-reenter', 'CLI projection and result guard do not reference reentry/provider invoker');
}

// ── Check 8: apply_patch stays out of CLI projection ───────────
function checkApplyPatchNotCliProjected() {
  const cliProjection = readRequired(CLI_PROJECTION);
  if (cliProjection.includes('apply_patch')) {
    fail('apply-patch-not-cli-projected', 'servertool CLI projection must not special-case or map apply_patch');
  } else {
    pass('apply-patch-not-cli-projected', 'cli-projection.ts does not reference apply_patch');
  }
}

// ── Check 9: servertool run is standalone Rust binary only ─────
function checkStandaloneServertoolBinary() {
  if (existsSync(TS_CLI_EXECUTOR)) {
    fail('servertool-cli-no-ts-executor', 'sharedmodule servertool/cli-executor.ts must be physically deleted');
  } else {
    pass('servertool-cli-no-ts-executor', 'TS servertool CLI executor is absent');
  }
  const rustCli = readRequired(RUST_SERVERTOOL_CLI);
  assertContains('servertool-cli-rust-binary', RUST_SERVERTOOL_CLI, rustCli, '#[command(name = "routecodex-servertool")]');
  assertContains('servertool-cli-rust-binary', RUST_SERVERTOOL_CLI, rustCli, 'build_servertool_cli_binary_run_command_from_client_exec_result');
  const nativeBuild = readRequired(NATIVE_BUILD_SCRIPT);
  assertContains('servertool-cli-packaged-binary', NATIVE_BUILD_SCRIPT, nativeBuild, "'servertool-cli'");
  assertContains('servertool-cli-packaged-binary', NATIVE_BUILD_SCRIPT, nativeBuild, 'packagedServertoolBinary');
  const files = ACTIVE_RUNTIME_SCAN_PATHS.flatMap((dir) => listFiles(dir));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('executeServertoolCliCommand') || content.includes('parseServertoolCliInputJson')) {
      fail(
        'servertool-cli-no-ts-executor',
        `Forbidden TS servertool executor symbol found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  pass('servertool-cli-no-ts-executor', `scanned ${files.length} active runtime files for deleted executor symbols`);
}

// ── Check 10: stop_message_flow must not revive reenter path ───
function checkStoplessNoReenterContract() {
  const deletedSpec = `${ROOT}/tests/servertool/stopless-goal-reenter.spec.ts`;
  if (existsSync(deletedSpec)) {
    fail('stopless-no-reenter-contract', 'obsolete stopless-goal-reenter.spec.ts must stay physically deleted');
  } else {
    pass('stopless-no-reenter-contract', 'obsolete stopless reenter spec is absent');
  }
  const files = [
    ...ACTIVE_RUNTIME_SCAN_PATHS.flatMap((dir) => listFiles(dir)),
    `${ROOT}/tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`,
    `${ROOT}/tests/cli/servertool-command.spec.ts`,
  ].filter((file) => existsSync(file));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('stop_message_flow') && content.includes("toBe('reenter')")) {
      fail(
        'stopless-no-reenter-contract',
        `Forbidden stop_message_flow reenter expectation found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  pass('stopless-no-reenter-contract', `scanned ${files.length} files for stopless reenter expectations`);
}

// ── Check 11: persisted lookup policy is Rust-owned ───────────
function checkStopMessagePersistedLookupRustOwner() {
  const rustLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP);
  const orchestration = readRequired(CHAT_SERVERTOOL_ORCHESTRATION);
  const runtimeUtils = readRequired(STOP_MESSAGE_RUNTIME_UTILS);
  const stateScope = readRequired(SERVERTOOL_STATE_SCOPE);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const chatProcessWrapper = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`);
  const stopMessageAuto = readRequired(STOP_MESSAGE_AUTO_HANDLER);
  const followupDispatchSpec = readRequired(`${ROOT}/tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`);

  assertContains(
    'stop-message-persisted-lookup-rust-owner',
    RUST_SERVERTOOL_CORE_LOOKUP,
    rustLookup,
    'pub fn plan_stop_message_persisted_lookup'
  );
  assertContains(
    'stop-message-persisted-lookup-rust-owner',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    'servertool_core::persisted_lookup'
  );
  assertContains(
    'stop-message-persisted-lookup-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planStopMessagePersistedLookupWithNative'
  );
  assertContains(
    'stop-message-persisted-lookup-bridge',
    STOP_MESSAGE_RUNTIME_UTILS,
    runtimeUtils,
    'native-servertool-core-semantics.js'
  );
  assertContains(
    'stop-message-persisted-lookup-bridge',
    SERVERTOOL_STATE_SCOPE,
    stateScope,
    'native-servertool-core-semantics.js'
  );
  for (const [file, content] of [
    [STOP_MESSAGE_RUNTIME_UTILS, runtimeUtils],
    [SERVERTOOL_STATE_SCOPE, stateScope],
  ]) {
    if (content.includes('native-chat-process-servertool-orchestration-semantics.js')) {
      fail(
        'stop-message-persisted-lookup-bridge-owner',
        `${file.replace(`${ROOT}/`, '')} must import stop-message lookup/scope helpers from native-servertool-core-semantics.js`
      );
    }
  }
  for (const symbol of [
    'planStopMessagePersistedLookupWithNative',
    'resolveStopMessageSessionScopeWithNative',
    'resolveServertoolStickyKeyWithNative',
    'resolveServertoolStateKeyWithNative',
  ]) {
    if (chatProcessWrapper.includes(`export function ${symbol}`)) {
      fail(
        'stop-message-persisted-lookup-bridge-owner',
        `${symbol} must not be exported from native-chat-process-servertool-orchestration-semantics.ts; servertool-core wrapper is the owner`
      );
    }
  }
  const chatProcessMockBlock = findJestUnstableMockModuleBlock(
    followupDispatchSpec,
    '../../../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js'
  );
  if (chatProcessMockBlock) {
    for (const symbol of [
      'planStopMessagePersistedLookupWithNative',
      'resolveStopMessageSessionScopeWithNative',
      'resolveServertoolStickyKeyWithNative',
      'resolveServertoolStateKeyWithNative',
    ]) {
      if (chatProcessMockBlock.includes(symbol)) {
        fail(
          'stop-message-persisted-lookup-bridge-owner',
          `servertool-followup-dispatch.spec.ts must not mock ${symbol} on the chat-process servertool wrapper`
        );
      }
    }
  }

  const forbiddenTsLookupOwners = [
    'fallbackStickyKey',
    'collectPersistedStopMessageCandidateKeys',
  ];
  const tsFiles = listFiles(SERVERTOOL_TS_DIR);
  for (const file of tsFiles) {
    const content = readFileSync(file, 'utf8');
    for (const keyword of forbiddenTsLookupOwners) {
      if (content.includes(keyword)) {
        fail(
          'stop-message-persisted-lookup-no-ts-owner',
          `Forbidden TS persisted lookup owner "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }

  if (/\nfn\s+collect_stop_message_persisted_candidate_keys\b/.test(orchestration)) {
    fail(
      'stop-message-persisted-lookup-no-hotpath-duplicate',
      'chat_servertool_orchestration.rs must not keep local collect_stop_message_persisted_candidate_keys; use servertool-core'
    );
  }
  if (/\nfn\s+plan_stop_message_persisted_lookup\b/.test(orchestration)) {
    fail(
      'stop-message-persisted-lookup-no-hotpath-duplicate',
      'chat_servertool_orchestration.rs must not keep local plan_stop_message_persisted_lookup; use servertool-core'
    );
  }
  if (!stopMessageAuto.includes('persistedLookupPlan.candidateKeys')) {
    fail(
      'stop-message-persisted-lookup-ts-consumes-native-plan',
      'stop-message-auto.ts must consume persistedLookupPlan.candidateKeys from native plan'
    );
  }
  pass('stop-message-persisted-lookup-no-ts-owner', `scanned ${tsFiles.length} servertool TS files`);
}

// ── Check 12: stop-message loop guard is Rust-owned ───────────
function checkStopMessageLoopGuardRustOwner() {
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const rustLoopGuard = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_loop_guard.rs`);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const tsLoopGuard = readRequired(TS_STOP_MESSAGE_LOOP_GUARD);

  assertContains(
    'stop-message-loop-guard-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod stop_message_loop_guard'
  );
  assertContains(
    'stop-message-loop-guard-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_loop_guard.rs`,
    rustLoopGuard,
    'pub fn evaluate'
  );
  assertContains(
    'stop-message-loop-guard-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'evaluateLoopGuardWithNative'
  );
  assertContains(
    'stop-message-loop-guard-thin-shell',
    TS_STOP_MESSAGE_LOOP_GUARD,
    tsLoopGuard,
    'evaluateLoopGuardWithNative'
  );
  for (const keyword of [
    'Fallback: pure TS',
    'Date.now()',
    'Math.floor',
    'Math.max(0',
    'elapsedMs >=',
    'pairRepeatCount >=',
  ]) {
    if (tsLoopGuard.includes(keyword)) {
      fail(
        'stop-message-loop-guard-no-ts-fallback',
        `Forbidden TS loop guard semantic "${keyword}" found in stop-message-loop-guard-block.ts`
      );
    }
  }
  pass('stop-message-loop-guard-no-ts-fallback', 'stop-message loop guard TS block is a native fail-fast shell');
}

// ── Check 12b: stop-message counter persisted update is Rust-owned ─
function checkStopMessageCounterRustOwner() {
  const rustCounter = readRequired(RUST_SERVERTOOL_COUNTER);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const tsCounter = readRequired(TS_STOP_MESSAGE_COUNTER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const symbol of [
    'pub fn plan_budget_state_update',
    'BudgetStateUpdateInput',
    'BudgetStateUpdatePlan',
  ]) {
    assertContains('stop-message-counter-rust-owner', RUST_SERVERTOOL_COUNTER, rustCounter, symbol);
  }
  assertContains(
    'stop-message-counter-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_budget_state_update_json'
  );
  assertContains(
    'stop-message-counter-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_budget_state_update_json'
  );
  assertContains(
    'stop-message-counter-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planBudgetStateUpdateJson'
  );
  assertContains(
    'stop-message-counter-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planBudgetStateUpdateWithNative'
  );
  assertContains(
    'stop-message-counter-thin-shell',
    TS_STOP_MESSAGE_COUNTER,
    tsCounter,
    'planBudgetStateUpdateWithNative'
  );
  assertContains(
    'stop-message-counter-error-budget',
    TS_STOP_MESSAGE_COUNTER,
    tsCounter,
    'incrementStopMessageErrorBudget'
  );

  for (const keyword of [
    'applyStopMessageSnapshotToState',
    'calculateBudgetWithNative',
    'stopMessageUsed =',
    'stopMessageLastUsedAt =',
    'stopMessageMaxRepeats =',
    'stopMessageText =',
    'stopMessageSource =',
    'stopMessageStageMode =',
    'stopMessageAiMode =',
    'Math.max(0',
    'used + 1',
  ]) {
    if (tsCounter.includes(keyword)) {
      fail(
        'stop-message-counter-no-ts-owner',
        `Forbidden TS stop-message counter semantic "${keyword}" found in stop-message-counter.ts`
      );
    }
  }
  pass('stop-message-counter-no-ts-owner', 'stop-message counter TS file is a native IO shell');
}

// ── Check 13: followup mainline bridge is Rust-owned ──────────
function checkFollowupMainlineNativeBridgeRustOwner() {
  const rustFollowupCore = readRequired(RUST_FOLLOWUP_CORE);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_FOLLOWUP_MAINLINE_WRAPPER);

  for (const symbol of [
    'pub fn build_followup_request_id',
    'pub fn inject_loop_warning',
    'pub fn decide_budget_reset',
  ]) {
    assertContains('followup-mainline-rust-owner', RUST_FOLLOWUP_CORE, rustFollowupCore, symbol);
  }
  for (const symbol of [
    'pub fn build_followup_request_id',
    'pub fn inject_loop_warning_json',
    'pub fn decide_budget_reset_json',
  ]) {
    assertContains('followup-mainline-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, symbol);
  }
  for (const symbol of [
    'buildFollowupRequestId',
    'injectLoopWarningJson',
    'decideBudgetResetJson',
  ]) {
    assertContains('followup-mainline-native-wrapper', NATIVE_FOLLOWUP_MAINLINE_WRAPPER, nativeWrapper, symbol);
  }
  for (const keyword of [
    'Fallback: pure TS',
    'return input.messages',
    'return { should_reset',
    'currentUsed + 1',
    'Math.max(input.warn_threshold, input.repeat_count)',
    '检测到 stopMessage 请求/响应参数已连续',
  ]) {
    if (nativeWrapper.includes(keyword)) {
      fail(
        'followup-mainline-no-ts-fallback',
        `Forbidden TS followup-mainline fallback semantic "${keyword}" found in native-followup-mainline-semantics.ts`
      );
    }
  }
  if (napiLib.includes('r#"{"should_reset":false,"next_used":0}"#') || napiLib.includes('unwrap_or_else(|_|')) {
    fail(
      'followup-mainline-no-native-default-fallback',
      'decide_budget_reset_json must return a NapiResult error on serialization failure, not a default decision'
    );
  }
  pass('followup-mainline-no-ts-fallback', 'native followup mainline bridge is fail-fast and Rust-owned');
}

// ── Check 14: backend-route policy has Rust owner ─────────────
function checkBackendRoutePolicyRustOwner() {
  const rustBackendRoute = readRequired(RUST_SERVERTOOL_BACKEND_ROUTE);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const outcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const flowPolicyShell = readRequired(TS_BACKEND_ROUTE_FLOW_POLICY);

  if (existsSync(TS_BACKEND_ROUTE_SHAPE_GUARD)) {
    fail(
      'backend-route-shape-guard-no-ts-owner',
      'sharedmodule/llmswitch-core/src/servertool/backend-route-shape-guard.ts must stay physically deleted; native normalize is the owner'
    );
  } else {
    pass('backend-route-shape-guard-no-ts-owner', 'backend-route-shape-guard.ts is physically deleted');
  }

  assertContains(
    'backend-route-policy-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03'
  );
  assertContains(
    'backend-route-policy-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod backend_route_contract'
  );
  assertContains(
    'backend-route-outcome-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    outcomeContract,
    '"web_search" | "vision_auto" => Some(ServertoolOutcome::BackendRouteReenter)'
  );
  assertContains(
    'backend-route-policy-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolBackendRoutePolicyWithNative'
  );
  assertContains(
    'backend-route-policy-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolBackendRoutePolicyJson'
  );
  assertContains(
    'backend-route-flow-policy-native-owner',
    TS_BACKEND_ROUTE_FLOW_POLICY,
    flowPolicyShell,
    'planServertoolFollowupRuntimeWithNative'
  );
  if (flowPolicyShell.includes('function normalizeFlowId') || flowPolicyShell.includes('normalizeFlowId(')) {
    fail(
      'backend-route-flow-policy-no-ts-owner',
      'backend-route-flow-policy.ts must not normalize flowId in TS; Rust plan_servertool_followup_runtime_json owns flow id normalization'
    );
  }
  assertContains(
    'backend-route-flow-policy-native-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`,
    readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`),
    'pub fn plan_servertool_followup_runtime_json'
  );
  assertContains(
    'backend-route-finalize-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn decorate_servertool_final_chat_with_context'
  );
  assertContains(
    'backend-route-finalize-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn should_short_circuit_requires_action_followup'
  );
  assertContains(
    'backend-route-finalize-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'decorateServertoolFinalChatWithNative'
  );
  assertContains(
    'backend-route-finalize-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'shouldShortCircuitRequiresActionFollowupWithNative'
  );
  assertContains(
    'backend-route-finalize-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'decorateServertoolFinalChatJson'
  );
  assertContains(
    'backend-route-finalize-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'shouldShortCircuitRequiresActionFollowupJson'
  );
  assertContains(
    'backend-route-followup-execution-mode-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_execution_mode'
  );
  assertContains(
    'backend-route-followup-execution-mode-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planFollowupExecutionModeWithNative'
  );
  assertContains(
    'backend-route-followup-execution-mode-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planFollowupExecutionModeJson'
  );
  for (const [toolName, forbiddenProjection] of [
    ['web_search', 'ClientExecCliProjection'],
    ['vision_auto', 'ClientExecCliProjection'],
    ['memory_cache_auto', 'BackendRouteReenter'],
  ]) {
    const pattern = new RegExp(`"${toolName}"[^\\n]+${forbiddenProjection}`);
    if (pattern.test(rustBackendRoute)) {
      fail(
        'backend-route-policy-rust-owner',
        `${toolName} has forbidden ${forbiddenProjection} mapping in backend_route_contract.rs`
      );
    }
  }
  const finalizeShell = readRequired(TS_BACKEND_ROUTE_FINALIZE);
  const originDeltaShell = readRequired(TS_BACKEND_ROUTE_ORIGIN_DELTA);
  const bootstrapReplayShell = readRequired(TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY);
  const runtimeShell = readRequired(TS_BACKEND_ROUTE_RUNTIME);
  assertContains(
    'backend-route-origin-delta-native-seed-owner',
    TS_BACKEND_ROUTE_ORIGIN_DELTA,
    originDeltaShell,
    'extractCapturedChatSeed'
  );
  for (const keyword of [
    'function cloneJson',
    'JSON.parse(JSON.stringify',
    'function normalizeSeed',
    'seed.messages =',
    'delete seed.model',
  ]) {
    if (originDeltaShell.includes(keyword)) {
      fail(
        'backend-route-origin-delta-no-ts-seed-owner',
        `Forbidden TS origin seed semantic "${keyword}" found in backend-route-origin-delta.ts`
      );
    }
  }
  assertContains(
    'backend-route-bootstrap-replay-native-request-id-owner',
    TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY,
    bootstrapReplayShell,
    'buildFollowupRequestIdWithNative'
  );
  for (const keyword of [
    "baseRequestId.trim() ? baseRequestId.trim() : 'servertool'",
    "suffix.trim() ? suffix.trim() : ':followup'",
    'return `${trimmedBase}${trimmedSuffix}`',
  ]) {
    if (bootstrapReplayShell.includes(keyword)) {
      fail(
        'backend-route-bootstrap-replay-no-ts-request-id-owner',
        `Forbidden TS requestId builder semantic "${keyword}" found in backend-route-bootstrap-replay-block.ts`
      );
    }
  }
  for (const keyword of [
    'isNoFollowupFlowId',
    'isAutoLimitFlowId',
    'isFlowOnlyLoopLimitFlowId',
    'isClientInjectOnlyFollowupFlowId',
    'isSeedLoopPayloadFollowupFlowId',
    'resolveClientInjectSourceForFlowId',
    'resolveTransparentReplayRequestSuffixForFlowId',
    'shouldIgnoreRequiresActionFollowup',
    'resolveContextDecorationModeForFlowId',
    'shouldPreserveStopMessageEligibilityForFollowup',
    "outcomeMode: plan?.outcomeMode ?? 'reenter'",
    'plan?.noFollowup === true',
    'plan?.autoLimit === true',
    'plan?.flowOnlyLoopLimit === true',
    'plan?.clientInjectOnly === true',
    'plan?.seedLoopPayload === true',
  ]) {
    if (flowPolicyShell.includes(keyword)) {
      fail(
        'backend-route-flow-policy-no-ts-owner',
        `Forbidden TS flow policy semantic "${keyword}" found in backend-route-flow-policy.ts`
      );
    }
  }
  for (const keyword of [
    'visibleSummary',
    'decorateContinueExecutionSummary',
    'decorateWebSearchSummary',
    'message.content',
    'cloneJsonObject',
    '【web_search',
  ]) {
    if (finalizeShell.includes(keyword)) {
      fail(
        'backend-route-finalize-no-ts-owner',
        `Forbidden TS finalize semantic "${keyword}" found in backend-route-finalize-block.ts`
      );
    }
  }
  assertContains(
    'backend-route-followup-execution-mode-thin-shell',
    TS_BACKEND_ROUTE_RUNTIME,
    runtimeShell,
    'planFollowupExecutionModeWithNative'
  );
  const executionModeBlock = extractFunctionBlock(runtimeShell, 'resolveFollowupExecutionMode');
  for (const keyword of [
    "decision.outcomeMode === 'skip'",
    'decision.noFollowup',
    "clientInjectSource === 'servertool.stopless_goal_continue'",
    "decision.outcomeMode === 'client_inject_only'",
    'decision.clientInjectOnly',
  ]) {
    if (executionModeBlock.includes(keyword)) {
      fail(
        'backend-route-followup-execution-mode-no-ts-owner',
        `Forbidden TS followup execution mode semantic "${keyword}" found in backend-route-runtime-block.ts`
      );
    }
  }
  const files = ACTIVE_RUNTIME_SCAN_PATHS.flatMap((dir) => listFiles(dir));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('./backend-route-shape-guard.js')) {
      fail(
        'backend-route-shape-guard-no-ts-owner',
        `Forbidden backend-route-shape-guard import found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
    if (content.includes('validateServertoolFollowupPayloadShape')) {
      fail(
        'backend-route-shape-guard-no-ts-owner',
        `Forbidden deleted TS shape validation symbol found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
    if (content.includes('SERVERTOOL_FOLLOWUP_INVALID_SHAPE')) {
      fail(
        'backend-route-shape-guard-no-ts-owner',
        `Forbidden deleted servertool shape error code found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  pass('backend-route-policy-rust-owner', 'servertool-core owns backend-route policy contract');
}

// ── Check 15: servertool text extraction has Rust owner ───────
function checkServertoolTextExtractionRustOwner() {
  const rustTextExtraction = readRequired(RUST_SERVERTOOL_TEXT_EXTRACTION);
  const serverSideTools = readRequired(TS_SERVER_SIDE_TOOLS);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);

  assertContains(
    'servertool-text-extraction-rust-owner',
    RUST_SERVERTOOL_TEXT_EXTRACTION,
    rustTextExtraction,
    'pub fn extract_text_from_chat_like'
  );
  assertContains(
    'servertool-text-extraction-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'extract_servertool_text_from_chat_like_json'
  );
  assertContains(
    'servertool-text-extraction-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'extractServertoolTextFromChatLikeJson'
  );
  assertContains(
    'servertool-text-extraction-thin-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'extractTextFromChatLikeWithNative'
  );
  assertContains(
    'servertool-text-extraction-thin-wrapper',
    TS_SERVER_SIDE_TOOLS,
    serverSideTools,
    'extractTextFromChatLikeWithNative(payload)'
  );

  const functionBlock = extractFunctionBlock(serverSideTools, 'extractTextFromChatLike');
  if (!functionBlock) {
    fail('servertool-text-extraction-no-ts-owner', 'extractTextFromChatLike function not found');
    return;
  }
  for (const keyword of [
    'choices',
    'message.content',
    'output_text',
    'web_search',
    'publish_date',
    '【',
    'join',
    'slice',
    'trim()',
  ]) {
    if (functionBlock.includes(keyword)) {
      fail(
        'servertool-text-extraction-no-ts-owner',
        `Forbidden TS text extraction semantic "${keyword}" found in extractTextFromChatLike`
      );
    }
  }
  pass('servertool-text-extraction-rust-owner', 'servertool-core owns chat-like text extraction');
}

// ── Check 16: servertool CLI result guard has Rust owner ──────
function checkServertoolCliResultGuardRustOwner() {
  const rustCliResultGuard = readRequired(RUST_SERVERTOOL_CLI_RESULT_GUARD);
  const cliResultGuardShell = readRequired(CLI_RESULT_GUARD);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);

  assertContains(
    'servertool-cli-result-guard-rust-owner',
    RUST_SERVERTOOL_CLI_RESULT_GUARD,
    rustCliResultGuard,
    'pub fn has_stop_message_auto_cli_result_in_request'
  );
  assertContains(
    'servertool-cli-result-guard-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'has_stop_message_auto_cli_result_in_request_json'
  );
  assertContains(
    'servertool-cli-result-guard-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'hasStopMessageAutoCliResultInRequestJson'
  );
  assertContains(
    'servertool-cli-result-guard-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'hasStopMessageAutoCliResultInRequestWithNative'
  );
  assertContains(
    'servertool-cli-result-guard-thin-shell',
    CLI_RESULT_GUARD,
    cliResultGuardShell,
    'hasStopMessageAutoCliResultInRequestWithNative(args)'
  );

  for (const keyword of [
    'ROUTECODEX_STOP_MESSAGE_AUTO_CLI',
    'MAX_SCAN_DEPTH',
    'MAX_SCAN_NODES',
    'collectScanRoots',
    'scanValue',
    'isToolResultLike',
    'readResultText',
    'collectText',
    'parseJsonObjectFromText',
    'validateClientExecCommandResultWithNative',
    'routecodex servertool run stop_message_auto',
    'function_call_output',
    'tool_call_id',
    'output_text',
  ]) {
    if (cliResultGuardShell.includes(keyword)) {
      fail(
        'servertool-cli-result-guard-no-ts-owner',
        `Forbidden TS CLI result guard semantic "${keyword}" found in cli-result-guard.ts`
      );
    }
  }
  pass('servertool-cli-result-guard-rust-owner', 'servertool-core owns CLI result guard scanning');
}

// ── Run ────────────────────────────────────────────────────────
console.log('\n=== verify-servertool-rust-only ===\n');

checkNoBakFiles();
checkNoTSHandlerRuntimeImport();
checkNoDuplicateSemantics();
checkServertoolCliProjectionMap();
checkBuildIncludesServertoolGate();
checkNoOldCliRestorationRuntime();
checkMigratedProjectionDoesNotReenter();
checkApplyPatchNotCliProjected();
checkStandaloneServertoolBinary();
checkStoplessNoReenterContract();
checkStopMessagePersistedLookupRustOwner();
checkStopMessageLoopGuardRustOwner();
checkStopMessageCounterRustOwner();
checkFollowupMainlineNativeBridgeRustOwner();
checkBackendRoutePolicyRustOwner();
checkServertoolTextExtractionRustOwner();
checkServertoolCliResultGuardRustOwner();

console.log();

if (issues.length === 0) {
  console.log('✅ All checks passed — servertool Rust-only invariants hold.');
  process.exit(0);
}

const failCount = issues.filter((i) => i.severity === 'fail').length;
const warnCount = issues.filter((i) => i.severity === 'warn').length;

console.log(`❌ ${failCount} failures, ${warnCount} warnings:\n`);
for (const issue of issues) {
  const icon = issue.severity === 'fail' ? '❌' : '⚠️';
  console.log(`  ${icon} [${issue.check}] ${issue.detail}\n`);
}

if (failCount > 0) {
  process.exit(1);
}
process.exit(0);

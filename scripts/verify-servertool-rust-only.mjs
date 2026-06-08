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
const RUST_SERVERTOOL_CORE_LOOKUP = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`;
const RUST_SERVERTOOL_BACKEND_ROUTE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`;
const STOP_MESSAGE_AUTO_HANDLER = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto.ts`;
const STOP_MESSAGE_RUNTIME_UTILS = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/runtime-utils.ts`;
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
    } else if (/\.(ts|tsx|js|mjs|rs)$/.test(full)) {
      files.push(full);
    }
  }
  return files;
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
    'cli-projection-native-wrapper',
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`,
    nativeServertoolWrapper,
    'buildClientExecCliProjectionOutputWithNative'
  );
  assertContains('cli-projection-command-contract', CLI_PROJECTION, cliProjection, "name: 'exec_command'");
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
  const stopMessageAuto = readRequired(STOP_MESSAGE_AUTO_HANDLER);

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
    STOP_MESSAGE_RUNTIME_UTILS,
    runtimeUtils,
    'planStopMessagePersistedLookupWithNative'
  );

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

// ── Check 12: backend-route policy has Rust owner ─────────────
function checkBackendRoutePolicyRustOwner() {
  const rustBackendRoute = readRequired(RUST_SERVERTOOL_BACKEND_ROUTE);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const outcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

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
  pass('backend-route-policy-rust-owner', 'servertool-core owns backend-route policy contract');
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
checkBackendRoutePolicyRustOwner();

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

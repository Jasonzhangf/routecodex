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
const RUST_SERVERTOOL_CLI_BLACKBOX = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/tests/cli_blackbox.rs`;
const RUST_FOLLOWUP_CORE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/followup-core/src/lib.rs`;
const RUST_ROUTER_HOTPATH_NAPI_LIB = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`;
const RUST_SERVERTOOL_CORE_LOOKUP = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`;
const RUST_SERVERTOOL_STOP_GATEWAY = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_gateway_context.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_COMPARE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_compare_context.rs`;
const RUST_SERVERTOOL_COUNTER = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_counter.rs`;
const RUST_SERVERTOOL_BACKEND_ROUTE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`;
const RUST_SERVERTOOL_LOOP_STATE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/loop_state_contract.rs`;
const RUST_SERVERTOOL_ORCHESTRATION_POLICY = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs`;
const RUST_SERVERTOOL_PENDING_SESSION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs`;
const RUST_SERVERTOOL_PRE_COMMAND = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`;
const RUST_SERVERTOOL_ENGINE_SELECTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs`;
const RUST_SERVERTOOL_TEXT_EXTRACTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/text_extraction.rs`;
const RUST_SERVERTOOL_STOP_VISIBLE_TEXT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_visible_text.rs`;
const RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_SIGNALS = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs`;
const RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_GOAL = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_goal.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_DEFAULT_CONFIG = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_default_config.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_persist_plan.rs`;
const RUST_SERVERTOOL_STOPLESS_ORCHESTRATION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`;
const RUST_SERVERTOOL_STOPLESS_GOAL_STATE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_goal_state_contract.rs`;
const RUST_SERVERTOOL_STOPLESS_LEARNED_NOTE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_learned_note_contract.rs`;
const RUST_SERVERTOOL_CLI_RESULT_GUARD = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_result_guard.rs`;
const RUST_SERVERTOOL_BLOCKED_REPORT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/blocked_report_contract.rs`;
const TS_SERVER_SIDE_TOOLS = `${SERVERTOOL_TS_DIR}/server-side-tools.ts`;
const TS_PENDING_INJECTION = `${SERVERTOOL_TS_DIR}/pending-injection-block.ts`;
const TS_PENDING_SESSION = `${SERVERTOOL_TS_DIR}/pending-session.ts`;
const TS_PRE_COMMAND_HOOKS = `${SERVERTOOL_TS_DIR}/pre-command-hooks.ts`;
const TS_ENGINE_SELECTION = `${SERVERTOOL_TS_DIR}/engine-selection-block.ts`;
const TS_FLOW_PRESENTATION = `${SERVERTOOL_TS_DIR}/flow-presentation-block.ts`;
const TS_SERVERTOOL_SKELETON_CONFIG = `${SERVERTOOL_TS_DIR}/skeleton-config.ts`;
const TS_BACKEND_ROUTE_SHAPE_GUARD = `${SERVERTOOL_TS_DIR}/backend-route-shape-guard.ts`;
const TS_BACKEND_ROUTE_FINALIZE = `${SERVERTOOL_TS_DIR}/backend-route-finalize-block.ts`;
const TS_BACKEND_ROUTE_FLOW_POLICY = `${SERVERTOOL_TS_DIR}/backend-route-flow-policy.ts`;
const TS_BACKEND_ROUTE_ORIGIN_DELTA = `${SERVERTOOL_TS_DIR}/backend-route-origin-delta.ts`;
const TS_BACKEND_ROUTE_RUNTIME = `${SERVERTOOL_TS_DIR}/backend-route-runtime-block.ts`;
const TS_BACKEND_ROUTE_REENTER = `${SERVERTOOL_TS_DIR}/backend-route-reenter-block.ts`;
const TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY = `${SERVERTOOL_TS_DIR}/backend-route-bootstrap-replay-block.ts`;
const TS_BACKEND_ROUTE_RESPONSE = `${SERVERTOOL_TS_DIR}/backend-route-response-block.ts`;
const TS_VISION_ELIGIBILITY = `${SERVERTOOL_TS_DIR}/handlers/vision-eligibility.ts`;
const TS_LOOP_STATE_BLOCK = `${SERVERTOOL_TS_DIR}/loop-state-block.ts`;
const TS_STOP_GATEWAY_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-gateway-context.ts`;
const TS_STOP_MESSAGE_COMPARE_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-message-compare-context.ts`;
const TS_STOP_MESSAGE_LOOP_GUARD = `${SERVERTOOL_TS_DIR}/stop-message-loop-guard-block.ts`;
const TS_STOP_MESSAGE_LOOP_PAYLOAD = `${SERVERTOOL_TS_DIR}/stop-message-loop-payload-block.ts`;
const TS_STOP_MESSAGE_COUNTER = `${SERVERTOOL_TS_DIR}/stop-message-counter.ts`;
const TS_ORCHESTRATION_POLICY = `${SERVERTOOL_TS_DIR}/orchestration-policy-block.ts`;
const TS_TIMEOUT_ERROR_BLOCK = `${SERVERTOOL_TS_DIR}/timeout-error-block.ts`;
const NATIVE_FOLLOWUP_MAINLINE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-followup-mainline-semantics.ts`;
const STOP_MESSAGE_AUTO_HANDLER = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto.ts`;
const STOP_MESSAGE_AUTO_CONFIG = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/config.ts`;
const STOPLESS_GOAL_STATE_HANDLER = `${SERVERTOOL_TS_DIR}/handlers/stopless-goal-state.ts`;
const STOP_MESSAGE_RUNTIME_UTILS = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/runtime-utils.ts`;
const STOP_MESSAGE_ROUTING_STATE = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/routing-state.ts`;
const STOP_MESSAGE_BLOCKED_REPORT = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/blocked-report.ts`;
const SERVERTOOL_STATE_SCOPE = `${SERVERTOOL_TS_DIR}/state-scope.ts`;
const NATIVE_SERVERTOOL_CORE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`;
const NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`;
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
const DELETED_REVIEW_TOOL_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/review.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/review-pure-blocks.ts`,
  `${ROOT}/tests/servertool/review-followup.spec.ts`,
];
const DELETED_EMPTY_REPLY_CONTINUE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/empty_reply_continue_contract.rs`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/empty-reply-continue.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/scripts/tests/servertool-empty-responses-continue.mjs`,
  `${ROOT}/tests/servertool/gemini-empty-reply-continue.spec.ts`,
];
const DELETED_STOP_VISIBLE_TEXT_TS_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/visible-text.ts`,
];
const DELETED_CLI_RESULT_GUARD_TS_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/cli-result-guard.ts`,
];
const DELETED_AI_FOLLOWUP_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup-pure-blocks.ts`,
  `${ROOT}/tests/servertool/stopmessage-response-snapshot.spec.ts`,
  `${ROOT}/tests/servertool/stop-message-auto-followup-extraction.spec.ts`,
];
const SERVERTOOL_RUSTIFICATION_REQUIRED_VERIFICATION = Object.freeze({
  'hub.servertool_cli_projection': [
    'tests/cli/servertool-command.spec.ts',
    'tests/servertool/servertool-cli-projection.spec.ts',
    'tests/servertool/servertool-cli-native-bridge.spec.ts',
    'tests/servertool/servertool-cli-result-restore.spec.ts',
    'tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts',
    'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
  ],
  'hub.servertool_backend_route_runtime': [
    'tests/servertool/server-side-web-search.spec.ts',
    'tests/servertool/vision-flow.spec.ts',
    'tests/servertool/servertool-mixed-tools.spec.ts',
  ],
  'hub.servertool_stopless_cli_projection_seed': [
    'tests/servertool/stop-message-auto.spec.ts',
    'tests/servertool/servertool-cli-projection.spec.ts',
  ],
});

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

function extractConstArrayBlock(content, constName) {
  const pattern = new RegExp(`const\\s+${constName}\\s*:[^=]+=[\\s\\S]*?\\];`);
  return content.match(pattern)?.[0] ?? '';
}

function extractFunctionBlock(content, functionName) {
  const signature = `function ${functionName}`;
  const start = content.indexOf(signature);
  if (start < 0) return '';
  let parenDepth = 0;
  let sawParams = false;
  let paramsEnd = -1;
  for (let index = start + signature.length; index < content.length; index += 1) {
    const char = content[index];
    if (char === '(') {
      parenDepth += 1;
      sawParams = true;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      if (sawParams && parenDepth === 0) {
        paramsEnd = index;
        break;
      }
      continue;
    }
  }
  if (paramsEnd < 0) return '';
  let braceStart = -1;
  let typeBraceDepth = 0;
  for (let index = paramsEnd + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') {
      let previous = '';
      for (let scan = index - 1; scan >= paramsEnd; scan -= 1) {
        if (!/\s/.test(content[scan])) {
          previous = content[scan];
          break;
        }
      }
      if (typeBraceDepth === 0 && previous !== ':') {
        braceStart = index;
        break;
      }
      typeBraceDepth += 1;
      continue;
    }
    if (char === '}' && typeBraceDepth > 0) {
      typeBraceDepth -= 1;
      continue;
    }
  }
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

    for (const file of files) {
      const relative = file.replace(`${SERVERTOOL_TS_DIR}/`, '');
      const modulePath = relative.replace(/\.ts$/, '');

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
  const serverSideTools = readRequired(TS_SERVER_SIDE_TOOLS);
  const rustCliContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`);
  const rustOutcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeServertoolWrapper = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

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
    'servertool-fixture-rust-dispatch-owner',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    'CLIENT_EXEC_CLI_PROJECTION_TOOL_NAMES'
  );
  assertContains(
    'servertool-fixture-rust-dispatch-owner',
    CHAT_SERVERTOOL_ORCHESTRATION,
    orchestration,
    '"client_exec_cli_projection".to_string()'
  );
  if (existsSync(`${SERVERTOOL_TS_DIR}/handlers/fixture.ts`)) {
    fail('servertool-fixture-ts-handler-deleted', 'servertool fixture TS handler must stay physically deleted');
  }
  if (serverSideTools.includes("import './handlers/fixture.js'")) {
    fail('servertool-fixture-ts-handler-deleted', 'server-side-tools.ts must not side-effect import deleted fixture handler');
  }
  pass('servertool-fixture-ts-handler-deleted', 'servertool fixture TS handler is deleted; Rust dispatch owns CLI projection');
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
  for (const needle of [
    'pub struct ServertoolHubRespChatProcess03Input',
    'pub struct ServertoolClientExecCliProjection01Planned',
    'pub struct ServertoolBackendRouteHint01Planned',
    'pub struct ServertoolServerIoInternal01Observed',
    'pub fn build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03',
    'pub fn build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03',
    'pub fn build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03',
  ]) {
    assertContains(
      'servertool-outcome-topology-rust-owner',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
      rustOutcomeContract,
      needle
    );
  }
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'quote_posix_single_argument(&input_json)'
  );
  for (const needle of [
    'fn web_search_cannot_build_client_exec_projection_plan',
    'fn vision_auto_cannot_build_client_exec_projection_plan',
    'fn unknown_tool_returns_none',
    'fn unknown_tool_is_rejected_by_projection_builder',
    'fn memory_cache_auto_is_rejected_by_client_projection_builder',
    'fn memory_cache_auto_is_rejected_by_backend_route_builder',
  ]) {
    assertContains(
      'servertool-outcome-negative-rust-tests',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
      rustOutcomeContract,
      needle
    );
  }
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
  for (const [capability, expected] of [
    ['buildClientExecCliProjectionOutputJson', 'buildClientExecCliProjectionOutputJson native error: ${message}'],
    ['buildClientVisibleProjectionShellJson', 'buildClientVisibleProjectionShellJson native error: ${message}'],
  ]) {
    assertContains(
      'cli-projection-native-error-contract',
      `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`,
      nativeServertoolWrapper,
      capability
    );
    assertContains(
      'cli-projection-native-error-contract',
      `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`,
      nativeServertoolWrapper,
      expected
    );
  }
  assertContains(
    'cli-projection-native-raw-string-contract',
    `${ROOT}/tests/servertool/servertool-cli-native-bridge.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/servertool-cli-native-bridge.spec.ts`),
    'keeps the raw NAPI projection shell contract as JSON string'
  );
  assertContains(
    'cli-projection-private-carrier-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'client-visible stopless CLI shell leaked private carrier'
  );
  assertContains(
    'cli-projection-command-contract',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    '"name": "exec_command"'
  );
  for (const [check, file, content, needle] of [
    ['cli-projection-output-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, 'pub fn plan_client_exec_cli_projection_output'],
    ['cli-projection-output-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_client_exec_cli_projection_output'],
    ['cli-projection-output-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn build_client_exec_cli_projection_output_json'],
    ['cli-projection-output-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'buildClientExecCliProjectionOutputJson'],
    ['cli-projection-output-native-wrapper', `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`, nativeServertoolWrapper, 'buildClientExecCliProjectionOutputWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }
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
  const cliDeniedCarrierBlock = extractConstArrayBlock(rustCliContract, 'DENIED_INTERNAL_CARRIER_KEYS');
  const cliDeniedCarrierTextBlock = extractConstArrayBlock(rustCliContract, 'DENIED_INTERNAL_CARRIER_TEXT');
  for (const privateCarrier of [
    'reenterPipeline',
    'providerInvoker',
    'serverToolFollowup',
    'serverToolFollowupSource',
  ]) {
    assertContains(
      'cli-projection-private-carrier-contract',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
      rustOutcomeContract,
      privateCarrier
    );
    assertContains(
      'cli-projection-private-carrier-contract',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
      cliDeniedCarrierBlock,
      privateCarrier
    );
    assertContains(
      'cli-projection-private-carrier-contract',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
      cliDeniedCarrierTextBlock,
      privateCarrier
    );
  }
  assertContains('cli-projection-thin-wrapper', CLI_PROJECTION, cliProjection, 'buildClientVisibleProjectionShellWithNative');
  if (cliProjection.includes("name: 'exec_command'") || cliProjection.includes('"name": "exec_command"')) {
    fail('cli-projection-command-contract', 'cli-projection.ts must not build exec_command tool call shape in TS');
  }
  if (cliProjection.includes('routecodex servertool run')) {
    fail('cli-projection-command-contract', 'cli-projection.ts must not build servertool CLI command strings in TS');
  }
  for (const keyword of [
    "args.flowId === 'stop_message_flow'",
    'const toolName = args.flowId',
    'typeof args.input?.repeatCount',
    'typeof args.input?.maxRepeats',
    'const repeatCount =',
    'const maxRepeats =',
  ]) {
    if (cliProjection.includes(keyword)) {
      fail(
        'cli-projection-output-no-ts-owner',
        `Forbidden TS client exec projection semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`
      );
    }
  }
  pass('cli-projection-output-rust-owner', 'servertool-core owns client exec CLI projection output planning');
}

function checkServertoolRustificationVerificationRegistry() {
  const verificationMap = readRequired(VERIFICATION_MAP);
  for (const [featureId, requiredTests] of Object.entries(SERVERTOOL_RUSTIFICATION_REQUIRED_VERIFICATION)) {
    assertContains(
      'servertool-rustification-verification-registry',
      VERIFICATION_MAP,
      verificationMap,
      `feature_id: ${featureId}`
    );
    for (const relativePath of requiredTests) {
      if (!existsSync(`${ROOT}/${relativePath}`)) {
        fail(
          'servertool-rustification-verification-registry',
          `${relativePath} is required by ${featureId} but is missing`
        );
        continue;
      }
      if (!verificationMap.includes(relativePath)) {
        fail(
          'servertool-rustification-verification-registry',
          `${relativePath} must be listed in docs/architecture/verification-map.yml for ${featureId}`
        );
      }
    }
  }
  pass(
    'servertool-rustification-verification-registry',
    'servertool rustification features keep explicit feature-to-test mapping'
  );
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
    'stcli_',
    'rcc_cli_',
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
  for (const file of [CLI_PROJECTION]) {
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
  for (const file of DELETED_CLI_RESULT_GUARD_TS_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-result-guard-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; CLI result guard scanning is Rust-owned`
      );
    }
  }
  pass('cli-projection-no-reenter', 'CLI projection does not reference reentry/provider invoker; CLI result guard TS shell is deleted');
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
  const rustCliBlackbox = readRequired(RUST_SERVERTOOL_CLI_BLACKBOX);
  assertContains('servertool-cli-supported-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn stop_message_auto_outputs_rust_owned_schema');
  assertContains('servertool-cli-supported-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn servertool_fixture_outputs_ordinary_exec_command_json');
  assertContains('servertool-cli-private-carrier-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn private_carrier_text_fails_fast');
  for (const needle of [
    'fn fake_exec_tool_name_fails_fast',
    'fn denied_cli_markers_fail_fast',
    'fn denied_cli_markers_in_tool_name_and_flow_fail_fast',
    'fn internal_carrier_fails_fast',
    'fn restoration_handle_carrier_fails_fast',
    'SERVERTOOL_DENIED_TOOL: fake_exec',
    'SERVERTOOL_DENIED_CLI_MARKER: {expected_marker}',
    'SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}',
  ]) {
    assertContains('servertool-cli-denied-marker-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, needle);
  }
  assertContains('servertool-cli-private-carrier-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'SERVERTOOL_DENIED_INTERNAL_CARRIER: serverToolFollowup');
  for (const needle of [
    'fn missing_continuation_prompt_fails_fast',
    'fn invalid_stop_message_flow_id_fails_fast',
    'fn invalid_stop_message_repeat_budget_fails_fast',
    'fn invalid_explicit_repeat_args_fail_fast',
    'fn stop_message_auto_explicit_repeat_args_override_input_json',
    'fn explicit_flow_arg_overrides_input_json_flow_id',
    'fn non_object_input_json_fails_fast',
    'fn malformed_input_json_fails_fast',
    'SERVERTOOL_CLI_MISSING_FIELD: continuationPrompt',
    'SERVERTOOL_CLI_INVALID_FIELD: flowId',
    'SERVERTOOL_CLI_INVALID_FIELD: repeatCount/maxRepeats',
    'SERVERTOOL_CLI_INVALID_FIELD: inputJson',
    'SERVERTOOL_CLI_INVALID_JSON:',
  ]) {
    assertContains('servertool-cli-input-contract-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, needle);
  }
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn non_client_exec_servertools_fail_fast');
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn unknown_tool_fails_fast_without_client_stdout');
  for (const toolName of ['web_search', 'vision_auto', 'memory_cache_auto']) {
    assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, toolName);
    assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, `SERVERTOOL_UNSUPPORTED_TOOL: {tool_name}`);
  }
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

function checkLegacyReviewToolDeleted() {
  for (const file of DELETED_REVIEW_TOOL_FILES) {
    if (existsSync(file)) {
      fail(
        'legacy-review-tool-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; legacy review servertool orchestration was removed`
      );
    }
  }
  const skeletonConfig = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  const outcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  for (const [file, content] of [
    [`${RUST_SRC_DIR}/servertool_skeleton_config.rs`, skeletonConfig],
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`, outcomeContract],
  ]) {
    if (content.includes('"review"') || content.includes('review_flow') || content.includes('servertool.review')) {
      fail(
        'legacy-review-tool-deleted',
        `${file.replace(`${ROOT}/`, '')} must not expose deleted review servertool semantics`
      );
    }
  }
  pass('legacy-review-tool-deleted', 'deleted review servertool path is absent from active servertool gates');
}

// ── Check 11: persisted lookup policy is Rust-owned ───────────
function checkStopMessagePersistedLookupRustOwner() {
  const rustLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP);
  const orchestration = readRequired(CHAT_SERVERTOOL_ORCHESTRATION);
  const runtimeUtils = readRequired(STOP_MESSAGE_RUNTIME_UTILS);
  const routingState = readRequired(STOP_MESSAGE_ROUTING_STATE);
  const stateScope = readRequired(SERVERTOOL_STATE_SCOPE);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const chatProcessWrapper = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`);
  const stopMessageAuto = readRequired(STOP_MESSAGE_AUTO_HANDLER);
  const stopMessageCounter = readRequired(TS_STOP_MESSAGE_COUNTER);
  const followupDispatchSpec = readRequired(`${ROOT}/tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`);

  assertContains(
    'stop-message-persisted-lookup-rust-owner',
    RUST_SERVERTOOL_CORE_LOOKUP,
    rustLookup,
    'pub fn plan_stop_message_persisted_lookup'
  );
  for (const needle of [
    'pub fn resolve_servertool_state_key',
    'pub fn resolve_runtime_stop_message_state',
    'pub fn resolve_runtime_stop_message_state_from_adapter_context',
    'pub fn read_runtime_stop_message_stage_mode',
    'pub fn normalize_stop_message_stage_mode_value',
    'pub fn has_armed_stop_message_state',
    'pub fn plan_stop_message_routing_snapshot',
    'pub fn plan_stop_message_persisted_state_selection',
    'pub fn plan_stop_message_routing_state_apply',
    'pub fn plan_stop_message_routing_state_clear',
    'pub fn read_servertool_followup_flow_id',
    'pub fn resolve_bd_working_directory_for_record',
    'pub fn resolve_stop_message_followup_provider_key',
    'pub fn get_captured_request',
    'pub fn resolve_client_connection_state',
    'pub fn has_compaction_flag',
    'pub fn resolve_entry_endpoint',
    'pub fn resolve_stop_message_followup_tool_content_max_chars',
    'pub fn plan_persist_stop_message_state',
    'pub fn resolve_default_stop_message_snapshot',
    'pub fn resolve_implicit_gemini_stop_message_snapshot',
    'STOP_MESSAGE_FOLLOWUP_FLOW_ID',
    'loop_state.get("maxRepeats")',
  ]) {
    assertContains(
      'stop-message-runtime-state-rust-owner',
      RUST_SERVERTOOL_CORE_LOOKUP,
      rustLookup,
      needle
    );
  }
  if (rustLookup.includes('loop_state.get("repeatCount")')) {
    fail(
      'stop-message-runtime-state-rust-owner',
      'servertool-core persisted_lookup.rs must not restore runtime stop state from loopState.repeatCount'
    );
  }
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
    'stopless-decision-context-signals-rust-owner',
    RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_SIGNALS,
    readRequired(RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_SIGNALS),
    'pub fn plan_stopless_decision_context_signals'
  );
  assertContains(
    'stopless-decision-context-goal-rust-owner',
    RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_GOAL,
    readRequired(RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_GOAL),
    'pub fn plan_stopless_decision_context_goal_status'
  );
  assertContains(
    'stop-message-default-config-rust-owner',
    RUST_SERVERTOOL_STOP_MESSAGE_DEFAULT_CONFIG,
    readRequired(RUST_SERVERTOOL_STOP_MESSAGE_DEFAULT_CONFIG),
    'pub fn plan_stop_message_default_config'
  );
  assertContains(
    'stop-message-persist-plan-rust-owner',
    RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN,
    readRequired(RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN),
    'pub fn plan_stop_message_persist_snapshot'
  );
  for (const needle of [
    'resolveServertoolStateKeyWithNative',
    'resolveRuntimeStopMessageStateWithNative',
    'resolveRuntimeStopMessageStateFromAdapterContextWithNative',
    'readRuntimeStopMessageStageModeWithNative',
    'normalizeStopMessageStageModeValueWithNative',
    'hasArmedStopMessageStateWithNative',
    'planStopMessageRoutingSnapshotWithNative',
    'planStopMessagePersistedStateSelectionWithNative',
    'planStopMessageRoutingStateApplyWithNative',
    'planStopMessageRoutingStateClearWithNative',
    'planStoplessDecisionContextSignalsWithNative',
    'planStoplessDecisionContextGoalStatusWithNative',
    'planStopMessageDefaultConfigWithNative',
    'planStopMessagePersistSnapshotWithNative',
    'readServertoolFollowupFlowIdWithNative',
    'resolveBdWorkingDirectoryForRecordWithNative',
    'resolveStopMessageFollowupProviderKeyWithNative',
    'getCapturedRequestWithNative',
    'resolveClientConnectionStateWithNative',
    'hasCompactionFlagWithNative',
    'resolveEntryEndpointWithNative',
    'resolveStopMessageFollowupToolContentMaxCharsWithNative',
    'planPersistStopMessageStateWithNative',
    'resolveDefaultStopMessageSnapshotWithNative',
    'resolveImplicitGeminiStopMessageSnapshotWithNative',
  ]) {
    assertContains(
      'stop-message-runtime-state-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
  }
  for (const needle of [
    '"resolveServertoolStateKeyJson"',
    '"resolveRuntimeStopMessageStateJson"',
    '"resolveRuntimeStopMessageStateFromAdapterContextJson"',
    '"readRuntimeStopMessageStageModeJson"',
    '"normalizeStopMessageStageModeValueJson"',
    '"hasArmedStopMessageStateJson"',
    '"planStopMessageRoutingSnapshotJson"',
    '"planStopMessagePersistedStateSelectionJson"',
    '"planStopMessageRoutingStateApplyJson"',
    '"planStopMessageRoutingStateClearJson"',
    '"planStoplessDecisionContextSignalsJson"',
    '"planStoplessDecisionContextGoalStatusJson"',
    '"planStopMessageDefaultConfigJson"',
    '"planStopMessagePersistSnapshotJson"',
    '"readServertoolFollowupFlowIdJson"',
    '"resolveBdWorkingDirectoryForRecordJson"',
    '"resolveStopMessageFollowupProviderKeyJson"',
    '"getCapturedRequestJson"',
    '"resolveClientConnectionStateJson"',
    '"hasCompactionFlagJson"',
    '"resolveEntryEndpointJson"',
    '"resolveStopMessageFollowupToolContentMaxCharsJson"',
    '"planPersistStopMessageStateJson"',
    '"resolveDefaultStopMessageSnapshotJson"',
    '"resolveImplicitGeminiStopMessageSnapshotJson"',
  ]) {
    assertContains(
      'stop-message-runtime-state-required-export',
      NATIVE_REQUIRED_EXPORTS,
      readRequired(NATIVE_REQUIRED_EXPORTS),
      needle
    );
  }
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
  if (!stopMessageAuto.includes('planStopMessagePersistedStateSelection(candidateKeys)')) {
    fail(
      'stop-message-persisted-state-selection-ts-thin-shell',
      'stop-message-auto.ts must pass candidateKeys to Rust-owned persisted state selection'
    );
  }
  if (!stopMessageAuto.includes('planStoplessDecisionContextSignals({')) {
    fail(
      'stopless-decision-context-signals-ts-thin-shell',
      'stop-message-auto.ts must consume Rust-owned stopless decision context signal plan'
    );
  }
  if (!stopMessageAuto.includes('planStoplessDecisionContextGoalStatus({')) {
    fail(
      'stopless-decision-context-goal-ts-thin-shell',
      'stop-message-auto.ts must consume Rust-owned stopless decision context goal status plan'
    );
  }
  if (!stopMessageAuto.includes('planStopMessageDefaultConfig({')) {
    fail(
      'stop-message-default-config-ts-thin-shell',
      'stop-message-auto.ts must consume Rust-owned stop-message default config plan'
    );
  }
  const stopMessageConfig = readRequired(STOP_MESSAGE_AUTO_CONFIG);
  for (const keyword of [
    'function readPositiveInt',
    'const floored = Math.floor(parsed)',
    'readPositiveInt(defaultConfig.maxRepeats)'
  ]) {
    if (stopMessageConfig.includes(keyword)) {
      fail(
        'stop-message-default-config-no-ts-owner',
        `config.ts must not restore TS default maxRepeats parse semantic "${keyword}"`
      );
    }
  }
  if (!stopMessageCounter.includes('planStopMessageDefaultConfigWithNative')) {
    fail(
      'stop-message-default-config-ts-thin-shell',
      'stop-message-counter.ts must consume Rust-owned stop-message default config plan'
    );
  }
  if (!stopMessageAuto.includes('planStopMessagePersistSnapshot({')) {
    fail(
      'stop-message-persist-plan-ts-thin-shell',
      'stop-message-auto.ts must consume Rust-owned stop-message persist snapshot plan'
    );
  }
  for (const keyword of [
    'readPersistedStopMessageSnapshotFromCandidateKeys',
    'readPersistedStopMessageStageModeFromCandidateKeys',
    'readPersistedStopMessageTombstoneFromCandidateKeys',
    'isDefaultStopMessageExhausted',
    'isStopMessageClearedTombstone',
    'function hasResponsesSubmitToolOutputsResume',
    'function isStopMessageDisabledByPort',
    'function isPlanModeActiveFromCapturedRequest',
    'toolOutputsDetailed.length',
    'routecodexPortStopMessageEnabled',
    'collaboration mode: plan',
    'function resolveStopMessageDefaultEnabledLive',
    'function resolveStopMessageDefaultTextLive',
    'function resolveStopMessageDefaultMaxRepeatsLive',
    'function isDirectStoplessGoalStateSnapshot',
    'function readRequestScopedGoalState',
    'stoplessGoalStateSource',
    'hasExplicitGoalState',
    'const gateMaxRepeats',
    'const resolvedMaxRepeats',
    'const schemaBudgetMaxRepeats',
    'const nextMaxRepeats',
    'const nextUsed',
    'Math.max(0, Math.floor(persistedSnap.maxRepeats))',
    'Math.max(0, Math.floor(persistedSnap.used))',
    'Math.max(0, Math.floor(runtimeSnap.maxRepeats))',
    'Math.max(0, Math.floor(runtimeSnap.used))',
    "String(persistedSnap.text ?? '')",
    "String(runtimeSnap.text ?? '')",
    'ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;',
    'ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;',
    'const STOP_MESSAGE_EXECUTION_APPEND',
    'resolveStopMessageSnapshot(loadRoutingInstructionStateSync',
    'normalizeStopMessageStageMode(state?.stopMessageStageMode',
    'stopMessageSource ===',
  ]) {
    if (stopMessageAuto.includes(keyword)) {
      fail(
        'stop-message-persisted-state-selection-ts-thin-shell',
        `stop-message-auto.ts must not restore TS persisted state selection semantic "${keyword}"`
      );
    }
  }

  const stateKeyBlock = extractFunctionBlock(runtimeUtils, 'resolveStateKey');
  if (!stateKeyBlock.includes('resolveServertoolStateKeyWithNative')) {
    fail(
      'stop-message-state-key-ts-thin-shell',
      'runtime-utils.ts resolveStateKey must call resolveServertoolStateKeyWithNative'
    );
  }
  for (const keyword of [
    'continuationScope',
    'stickyScope',
    'resolveStopMessageSessionScope(',
    'metadata.requestId',
    "'default'",
    '"default"',
  ]) {
    if (stateKeyBlock.includes(keyword)) {
      fail(
        'stop-message-state-key-ts-thin-shell',
        `runtime-utils.ts resolveStateKey must not contain TS state-key semantic "${keyword}"`
      );
    }
  }

  const runtimeStateBlock = extractFunctionBlock(runtimeUtils, 'resolveRuntimeStopMessageState');
  if (!runtimeStateBlock.includes('resolveRuntimeStopMessageStateWithNative')) {
    fail(
      'stop-message-runtime-state-ts-thin-shell',
      'runtime-utils.ts resolveRuntimeStopMessageState must call resolveRuntimeStopMessageStateWithNative'
    );
  }
  for (const keyword of [
    'resolveStopMessageSnapshot',
    'serverToolLoopState',
    'stopMessageState',
    'stopMessageUsed',
    'stopMessageText',
    'loopState.maxRepeats',
    'flowId',
    'stop_message_flow',
    'servertool.stop_message',
    '继续执行',
  ]) {
    if (runtimeStateBlock.includes(keyword)) {
      fail(
        'stop-message-runtime-state-ts-thin-shell',
        `runtime-utils.ts resolveRuntimeStopMessageState must not contain TS runtime-state semantic "${keyword}"`
      );
    }
  }

  const adapterRuntimeStateBlock = extractFunctionBlock(runtimeUtils, 'resolveRuntimeStopMessageStateFromAdapterContext');
  if (!adapterRuntimeStateBlock.includes('resolveRuntimeStopMessageStateFromAdapterContextWithNative')) {
    fail(
      'stop-message-cli-result-state-ts-thin-shell',
      'runtime-utils.ts resolveRuntimeStopMessageStateFromAdapterContext must call resolveRuntimeStopMessageStateFromAdapterContextWithNative'
    );
  }
  for (const keyword of [
    'parseStopMessageCliInputFromCommand',
    'readStopMessageCliCommandMap',
    'findLastStopMessageCliCommandSeed',
    'resolveRuntimeStopMessageStateFromRequestRecord',
    "routecodex servertool run stop_message_auto",
    "--input-json '",
    "'\\\\''",
    'client_exec_result',
    'stop_message_flow',
    'function_call_output',
    'tool_result',
    'tool_message',
    'validateClientExecCommandResultWithNative',
  ]) {
    if (adapterRuntimeStateBlock.includes(keyword)) {
      fail(
        'stop-message-cli-result-state-ts-thin-shell',
        `runtime-utils.ts resolveRuntimeStopMessageStateFromAdapterContext must not contain TS CLI-result semantic "${keyword}"`
      );
    }
  }
  for (const keyword of [
    'parseStopMessageCliInputFromCommand',
    'decodePosixSingleQuotedArgument',
    'readStopMessageCliCommandMap',
    'findLastStopMessageCliCommandSeed',
    'resolveRuntimeStopMessageStateFromRequestRecord',
    'client_exec_result',
  ]) {
    if (runtimeUtils.includes(keyword)) {
      fail(
        'stop-message-cli-result-state-no-ts-owner',
        `runtime-utils.ts must not restore TS CLI-result state owner "${keyword}"`
      );
    }
  }

  const runtimeStageBlock = extractFunctionBlock(runtimeUtils, 'readRuntimeStopMessageStageMode');
  if (!runtimeStageBlock.includes('readRuntimeStopMessageStageModeWithNative')) {
    fail(
      'stop-message-runtime-stage-ts-thin-shell',
      'runtime-utils.ts readRuntimeStopMessageStageMode must call readRuntimeStopMessageStageModeWithNative'
    );
  }
  for (const keyword of [
    'stopMessageState',
    'stopMessageStageMode',
    '.trim()',
    '.toLowerCase()',
  ]) {
    if (runtimeStageBlock.includes(keyword)) {
      fail(
        'stop-message-runtime-stage-ts-thin-shell',
        `runtime-utils.ts readRuntimeStopMessageStageMode must not contain TS stage-mode semantic "${keyword}"`
      );
    }
  }

  for (const [functionName, nativeSymbol] of [
    ['hasArmedStopMessageState', 'hasArmedStopMessageStateWithNative'],
    ['normalizeStopMessageStageMode', 'normalizeStopMessageStageModeValueWithNative'],
    ['resolveStopMessageSnapshot', 'planStopMessageRoutingSnapshotWithNative'],
    ['applyStopMessageSnapshotToState', 'planStopMessageRoutingStateApplyWithNative'],
    ['clearStopMessageState', 'planStopMessageRoutingStateClearWithNative'],
  ]) {
    const block = extractFunctionBlock(routingState, functionName);
    if (!block.includes(nativeSymbol)) {
      fail(
        'stop-message-routing-state-ts-thin-shell',
        `routing-state.ts ${functionName} must call ${nativeSymbol}`
      );
    }
  }
  for (const keyword of [
    'DEFAULT_STOP_MESSAGE_MAX_REPEATS',
    'normalizeStopMessageModeValue',
    'resolveStopMessageMaxRepeats',
    'normalizeStopMessageAiMode',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    '.toLowerCase()',
    '.trim()',
    "stageMode === 'off'",
  ]) {
    if (routingState.includes(keyword)) {
      fail(
        'stop-message-routing-state-no-ts-owner',
        `routing-state.ts must not contain TS routing-state semantic "${keyword}"`
      );
    }
  }

  const followupFlowBlock = extractFunctionBlock(runtimeUtils, 'readServerToolFollowupFlowId');
  if (!followupFlowBlock.includes('readServertoolFollowupFlowIdWithNative')) {
    fail(
      'servertool-followup-flow-id-ts-thin-shell',
      'runtime-utils.ts readServerToolFollowupFlowId must call readServertoolFollowupFlowIdWithNative'
    );
  }
  for (const keyword of [
    'serverToolLoopState',
    '.flowId',
    'toNonEmptyText',
  ]) {
    if (followupFlowBlock.includes(keyword)) {
      fail(
        'servertool-followup-flow-id-ts-thin-shell',
        `runtime-utils.ts readServerToolFollowupFlowId must not contain TS flow-id semantic "${keyword}"`
      );
    }
  }

  const bdWorkingDirectoryBlock = extractFunctionBlock(runtimeUtils, 'resolveBdWorkingDirectoryForRecord');
  if (!bdWorkingDirectoryBlock.includes('resolveBdWorkingDirectoryForRecordWithNative')) {
    fail(
      'servertool-bd-working-directory-ts-thin-shell',
      'runtime-utils.ts resolveBdWorkingDirectoryForRecord must call resolveBdWorkingDirectoryForRecordWithNative'
    );
  }
  for (const keyword of [
    'readSessionScopeValue',
    'readHubCaptureContextValue',
    '__hub_capture',
    'capturedContext',
    'workingDirectory',
    'workdir',
    'cwd',
  ]) {
    if (bdWorkingDirectoryBlock.includes(keyword)) {
      fail(
        'servertool-bd-working-directory-ts-thin-shell',
        `runtime-utils.ts resolveBdWorkingDirectoryForRecord must not contain TS working-directory semantic "${keyword}"`
      );
    }
  }

  const followupProviderKeyBlock = extractFunctionBlock(runtimeUtils, 'resolveStopMessageFollowupProviderKey');
  if (!followupProviderKeyBlock.includes('resolveStopMessageFollowupProviderKeyWithNative')) {
    fail(
      'servertool-followup-provider-key-ts-thin-shell',
      'runtime-utils.ts resolveStopMessageFollowupProviderKey must call resolveStopMessageFollowupProviderKeyWithNative'
    );
  }
  for (const keyword of [
    'readProviderKeyFromMetadata',
    'targetProviderKey',
    '.target',
    'toNonEmptyText',
  ]) {
    if (followupProviderKeyBlock.includes(keyword)) {
      fail(
        'servertool-followup-provider-key-ts-thin-shell',
        `runtime-utils.ts resolveStopMessageFollowupProviderKey must not contain TS provider-key semantic "${keyword}"`
      );
    }
  }
  for (const keyword of [
    'readSessionScopeValue',
    'readHubCaptureContextValue',
    'readProviderKeyFromMetadata',
    'toNonEmptyText',
  ]) {
    if (runtimeUtils.includes(keyword)) {
      fail(
        'stop-message-runtime-utils-no-ts-metadata-walker',
        `runtime-utils.ts must not restore TS metadata walker "${keyword}"`
      );
    }
  }

  const capturedRequestBlock = extractFunctionBlock(runtimeUtils, 'getCapturedRequest');
  if (!capturedRequestBlock.includes('getCapturedRequestWithNative')) {
    fail(
      'servertool-captured-request-ts-thin-shell',
      'runtime-utils.ts getCapturedRequest must call getCapturedRequestWithNative'
    );
  }
  for (const keyword of [
    'capturedEntryRequest',
    'capturedChatRequest',
    'Array.isArray',
  ]) {
    if (capturedRequestBlock.includes(keyword)) {
      fail(
        'servertool-captured-request-ts-thin-shell',
        `runtime-utils.ts getCapturedRequest must not contain TS captured-request semantic "${keyword}"`
      );
    }
  }

  const clientConnectionBlock = extractFunctionBlock(runtimeUtils, 'resolveClientConnectionState');
  if (!clientConnectionBlock.includes('resolveClientConnectionStateWithNative')) {
    fail(
      'servertool-client-connection-state-ts-thin-shell',
      'runtime-utils.ts resolveClientConnectionState must call resolveClientConnectionStateWithNative'
    );
  }
  for (const keyword of [
    'Array.isArray',
    'typeof value',
  ]) {
    if (clientConnectionBlock.includes(keyword)) {
      fail(
        'servertool-client-connection-state-ts-thin-shell',
        `runtime-utils.ts resolveClientConnectionState must not contain TS connection-state semantic "${keyword}"`
      );
    }
  }

  const compactionFlagBlock = extractFunctionBlock(runtimeUtils, 'hasCompactionFlag');
  if (!compactionFlagBlock.includes('hasCompactionFlagWithNative')) {
    fail(
      'servertool-compaction-flag-ts-thin-shell',
      'runtime-utils.ts hasCompactionFlag must call hasCompactionFlagWithNative'
    );
  }
  for (const keyword of [
    'compactionRequest',
    'toLowerCase',
    'trim()',
  ]) {
    if (compactionFlagBlock.includes(keyword)) {
      fail(
        'servertool-compaction-flag-ts-thin-shell',
        `runtime-utils.ts hasCompactionFlag must not contain TS compaction semantic "${keyword}"`
      );
    }
  }

  const entryEndpointBlock = extractFunctionBlock(runtimeUtils, 'resolveEntryEndpoint');
  if (!entryEndpointBlock.includes('resolveEntryEndpointWithNative')) {
    fail(
      'servertool-entry-endpoint-ts-thin-shell',
      'runtime-utils.ts resolveEntryEndpoint must call resolveEntryEndpointWithNative'
    );
  }
  for (const keyword of [
    'entryEndpoint',
    '/v1/chat/completions',
    'metadata',
  ]) {
    if (entryEndpointBlock.includes(keyword)) {
      fail(
        'servertool-entry-endpoint-ts-thin-shell',
        `runtime-utils.ts resolveEntryEndpoint must not contain TS entry-endpoint semantic "${keyword}"`
      );
    }
  }

  const followupToolContentMaxCharsBlock = extractFunctionBlock(runtimeUtils, 'resolveStopMessageFollowupToolContentMaxChars');
  if (!followupToolContentMaxCharsBlock.includes('resolveStopMessageFollowupToolContentMaxCharsWithNative')) {
    fail(
      'servertool-followup-tool-content-max-chars-ts-thin-shell',
      'runtime-utils.ts resolveStopMessageFollowupToolContentMaxChars must call resolveStopMessageFollowupToolContentMaxCharsWithNative'
    );
  }
  for (const keyword of [
    'Number(',
    'Math.max',
    'Math.floor',
    'kimi-k2.5',
    'toLowerCase',
  ]) {
    if (followupToolContentMaxCharsBlock.includes(keyword)) {
      fail(
        'servertool-followup-tool-content-max-chars-ts-thin-shell',
        `runtime-utils.ts resolveStopMessageFollowupToolContentMaxChars must not contain TS content-limit semantic "${keyword}"`
      );
    }
  }

  const persistStopMessageStateBlock = extractFunctionBlock(runtimeUtils, 'persistStopMessageState');
  if (!persistStopMessageStateBlock.includes('planPersistStopMessageStateWithNative')) {
    fail(
      'servertool-persist-stop-message-state-ts-thin-shell',
      'runtime-utils.ts persistStopMessageState must call planPersistStopMessageStateWithNative'
    );
  }
  for (const keyword of [
    'stoplessGoalState',
    'forcedTarget',
    'preferTarget',
    '.size',
    'preCommandScriptPath',
    'preCommandUpdatedAt',
    'stopMessageLastUsedAt',
    'stopMessageText',
    'stopMessageMaxRepeats',
    'stopMessageUsed',
    'stopMessageStageMode',
    'stopMessageAiMode',
    'Number.isFinite',
    'trim()',
  ]) {
    if (persistStopMessageStateBlock.includes(keyword)) {
      fail(
        'servertool-persist-stop-message-state-ts-thin-shell',
        `runtime-utils.ts persistStopMessageState must not contain TS persist-state semantic "${keyword}"`
      );
    }
  }

  for (const keyword of [
    "from '../../stop-gateway-context.js'",
    "from './ai-followup.js'",
    'isStopEligibleForServerTool',
    'extractResponsesOutputText',
    'hasToolLikeOutput',
    'function isEmptyAssistantReply',
  ]) {
    if (runtimeUtils.includes(keyword)) {
      fail(
        'servertool-snapshot-resolver-ts-thin-shell',
        `runtime-utils.ts must not restore snapshot/empty-reply TS semantic "${keyword}"`
      );
    }
  }

  const defaultSnapshotBlock = extractFunctionBlock(runtimeUtils, 'resolveDefaultStopMessageSnapshot');
  if (!defaultSnapshotBlock.includes('resolveDefaultStopMessageSnapshotWithNative')) {
    fail(
      'servertool-default-stop-message-snapshot-ts-thin-shell',
      'runtime-utils.ts resolveDefaultStopMessageSnapshot must call resolveDefaultStopMessageSnapshotWithNative'
    );
  }
  for (const keyword of [
    'isStopEligibleForServerTool',
    'Number.isFinite',
    'Math.floor',
    '继续执行',
    'trim()',
    'catch',
  ]) {
    if (defaultSnapshotBlock.includes(keyword)) {
      fail(
        'servertool-default-stop-message-snapshot-ts-thin-shell',
        `runtime-utils.ts resolveDefaultStopMessageSnapshot must not contain TS default snapshot semantic "${keyword}"`
      );
    }
  }

  const implicitGeminiSnapshotBlock = extractFunctionBlock(runtimeUtils, 'resolveImplicitGeminiStopMessageSnapshot');
  if (!implicitGeminiSnapshotBlock.includes('resolveImplicitGeminiStopMessageSnapshotWithNative')) {
    fail(
      'servertool-implicit-gemini-snapshot-ts-thin-shell',
      'runtime-utils.ts resolveImplicitGeminiStopMessageSnapshot must call resolveImplicitGeminiStopMessageSnapshotWithNative'
    );
  }
  for (const keyword of [
    'gemini-chat',
    '/v1/responses',
    'isStopEligibleForServerTool',
    'isEmptyAssistantReply',
    'extractResponsesOutputText',
    'hasToolLikeOutput',
    'choices',
    'finish_reason',
    'tool_calls',
    'required_action',
    'outputText',
    'outputRaw',
    'toLowerCase',
    'trim()',
    'catch',
  ]) {
    if (implicitGeminiSnapshotBlock.includes(keyword)) {
      fail(
        'servertool-implicit-gemini-snapshot-ts-thin-shell',
        `runtime-utils.ts resolveImplicitGeminiStopMessageSnapshot must not contain TS implicit snapshot semantic "${keyword}"`
      );
    }
  }
  pass('stop-message-persisted-lookup-no-ts-owner', `scanned ${tsFiles.length} servertool TS files`);
}

// ── Check 12: stop-message loop guard is Rust-owned ───────────
function checkStopMessageLoopGuardRustOwner() {
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const rustLoopGuard = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_loop_guard.rs`);
  const rustFollowupCore = readRequired(RUST_FOLLOWUP_CORE);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const tsLoopGuard = readRequired(TS_STOP_MESSAGE_LOOP_GUARD);
  const tsLoopPayload = readRequired(TS_STOP_MESSAGE_LOOP_PAYLOAD);

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
  assertContains(
    'stop-message-loop-warning-rust-owner',
    RUST_FOLLOWUP_CORE,
    rustFollowupCore,
    'pub fn inject_loop_warning'
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
  for (const keyword of [
    'appendStopMessageLoopWarning',
    'warningText',
    'repeatCountRaw',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'messages.push',
    '检测到 stopMessage 请求/响应参数已连续',
  ]) {
    if (tsLoopPayload.includes(keyword)) {
      fail(
        'stop-message-loop-warning-no-ts-duplicate',
        `Forbidden TS loop-warning semantic "${keyword}" found in stop-message-loop-payload-block.ts`
      );
    }
  }
  assertContains(
    'stop-message-loop-payload-thin-shell',
    TS_STOP_MESSAGE_LOOP_PAYLOAD,
    tsLoopPayload,
    'buildServertoolReq04FollowupPayloadWithNative'
  );
  pass('stop-message-loop-guard-no-ts-fallback', 'stop-message loop guard TS block is a native fail-fast shell');
  pass('stop-message-loop-warning-no-ts-duplicate', 'stop-message loop warning text/count policy is Rust/native-owned');
}

// ── Check 12b: stop-gateway context is Rust-owned ─────────────
function checkStopGatewayContextRustOwner() {
  const rustStopGateway = readRequired(RUST_SERVERTOOL_STOP_GATEWAY);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const tsShell = readRequired(TS_STOP_GATEWAY_CONTEXT);

  for (const needle of [
    'pub fn inspect',
    'pub fn is_stop_eligible',
    'pub fn normalize_stop_gateway_context',
    'fn contains_tool_marker_text',
  ]) {
    assertContains(
      'stop-gateway-context-rust-owner',
      RUST_SERVERTOOL_STOP_GATEWAY,
      rustStopGateway,
      needle
    );
  }
  assertContains(
    'stop-gateway-context-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn normalize_stop_gateway_context_json'
  );
  assertContains(
    'stop-gateway-context-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'inspectStopGatewaySignalWithNative'
  );
  assertContains(
    'stop-gateway-context-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'normalizeStopGatewayContextWithNative'
  );
  assertContains(
    'stop-gateway-context-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'normalizeStopGatewayContextJson'
  );
  for (const keyword of [
    'tsFallbackInspect',
    'tryNativeInspect',
    'HARVESTABLE_TOOL_MARKER_PATTERN',
    'hasHarvestableToolMarkers',
    'hasEmbeddedToolCallMarkersInChatMessage',
    'hasVisibleAssistantText',
    'isReasoningOnlyEmptyAssistantMessage',
    'function normalizeStopGatewayContext',
    'function hasToolLikeOutput',
    'hasToolLikeOutput',
    'Number.isFinite',
    'Math.floor',
    'catch',
    'catch { return undefined; }',
    'ignore metadata write failures',
  ]) {
    if (tsShell.includes(keyword)) {
      fail(
        'stop-gateway-context-ts-thin-shell',
        `Forbidden TS stop-gateway semantic/fallback "${keyword}" found in stop-gateway-context.ts`
      );
    }
  }
  assertContains(
    'stop-gateway-context-ts-thin-shell',
    TS_STOP_GATEWAY_CONTEXT,
    tsShell,
    'inspectStopGatewaySignalWithNative'
  );
  assertContains(
    'stop-gateway-context-ts-thin-shell',
    TS_STOP_GATEWAY_CONTEXT,
    tsShell,
    'normalizeStopGatewayContextWithNative'
  );
  pass('stop-gateway-context-rust-owner', 'servertool-core owns stop-gateway inspect and metadata normalization');
}

// ── Check 12c: stop-message compare context is Rust-owned ─────
function checkStopMessageCompareContextRustOwner() {
  const rustCompare = readRequired(RUST_SERVERTOOL_STOP_MESSAGE_COMPARE);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const tsShell = readRequired(TS_STOP_MESSAGE_COMPARE_CONTEXT);

  for (const needle of [
    'pub fn normalize_stop_message_compare_context',
    'pub fn format_stop_message_compare_context',
    'StopMessageCompareContext',
    'read_non_negative_i32',
    'read_truthy',
  ]) {
    assertContains(
      'stop-message-compare-context-rust-owner',
      RUST_SERVERTOOL_STOP_MESSAGE_COMPARE,
      rustCompare,
      needle
    );
  }
  for (const needle of [
    'normalize_stop_message_compare_context_json',
    'format_stop_message_compare_context_json',
  ]) {
    assertContains(
      'stop-message-compare-context-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      needle
    );
    assertContains(
      'stop-message-compare-context-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      `pub fn ${needle}`
    );
  }
  for (const needle of [
    'normalizeStopMessageCompareContextWithNative',
    'formatStopMessageCompareContextWithNative',
  ]) {
    assertContains(
      'stop-message-compare-context-native-wrapper',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
  }
  for (const needle of [
    'normalizeStopMessageCompareContextJson',
    'formatStopMessageCompareContextJson',
  ]) {
    assertContains(
      'stop-message-compare-context-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const keyword of [
    'function normalizeStopMessageCompareContext',
    'decisionRaw',
    'modeRaw',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'Boolean(record.',
    'ignore metadata write failures',
    'catch',
    'decision=unknown reason=no_context',
  ]) {
    if (tsShell.includes(keyword)) {
      fail(
        'stop-message-compare-context-ts-thin-shell',
        `Forbidden TS stop-message compare semantic/fallback "${keyword}" found in stop-message-compare-context.ts`
      );
    }
  }
  assertContains(
    'stop-message-compare-context-ts-thin-shell',
    TS_STOP_MESSAGE_COMPARE_CONTEXT,
    tsShell,
    'normalizeStopMessageCompareContextWithNative'
  );
  assertContains(
    'stop-message-compare-context-ts-thin-shell',
    TS_STOP_MESSAGE_COMPARE_CONTEXT,
    tsShell,
    'formatStopMessageCompareContextWithNative'
  );
  pass('stop-message-compare-context-rust-owner', 'servertool-core owns stop-message compare context normalization and formatting');
}

// ── Check 12d: orchestration policy is Rust-owned ─────────────
function checkOrchestrationPolicyRustOwner() {
  const rustPolicy = readRequired(RUST_SERVERTOOL_ORCHESTRATION_POLICY);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const tsShell = readRequired(TS_ORCHESTRATION_POLICY);
  const timeoutShell = readRequired(TS_TIMEOUT_ERROR_BLOCK);

  assertContains(
    'servertool-orchestration-policy-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod orchestration_policy_contract'
  );
  for (const needle of [
    'pub fn parse_servertool_timeout_ms',
    'pub fn plan_servertool_timeout_watcher',
    'pub fn is_adapter_client_disconnected',
    'pub fn plan_client_disconnect_watcher',
    'pub fn plan_servertool_client_disconnected_error',
    'pub fn plan_servertool_timeout_error',
    'pub fn plan_stop_message_fetch_failed_error',
    'pub fn read_client_inject_only',
    'pub fn normalize_client_inject_text',
    'pub fn sanitize_followup_text',
    'pub fn compact_followup_error_reason',
    'pub fn resolve_adapter_context_provider_key',
  ]) {
    assertContains(
      'servertool-orchestration-policy-rust-owner',
      RUST_SERVERTOOL_ORCHESTRATION_POLICY,
      rustPolicy,
      needle
    );
  }
  for (const needle of [
    'parse_servertool_timeout_ms_json',
    'plan_servertool_timeout_watcher_json',
    'is_adapter_client_disconnected_json',
    'plan_client_disconnect_watcher_json',
    'plan_servertool_client_disconnected_error_json',
    'plan_servertool_timeout_error_json',
    'plan_stop_message_fetch_failed_error_json',
    'read_client_inject_only_json',
    'normalize_client_inject_text_json',
    'compact_followup_error_reason_json',
    'resolve_adapter_context_provider_key_json',
  ]) {
    assertContains(
      'servertool-orchestration-policy-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      needle
    );
    assertContains(
      'servertool-orchestration-policy-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      `pub fn ${needle}`
    );
  }
  for (const needle of [
    'parseServertoolTimeoutMsWithNative',
    'readClientInjectOnlyWithNative',
    'normalizeClientInjectTextWithNative',
    'compactFollowupErrorReasonWithNative',
    'resolveAdapterContextProviderKeyWithNative',
  ]) {
    assertContains(
      'servertool-orchestration-policy-native-wrapper',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
  }
  for (const needle of [
    'parseServertoolTimeoutMsJson',
    'planServertoolTimeoutWatcherJson',
    'isAdapterClientDisconnectedJson',
    'planClientDisconnectWatcherJson',
    'planServertoolClientDisconnectedErrorJson',
    'planServertoolTimeoutErrorJson',
    'planStopMessageFetchFailedErrorJson',
    'readClientInjectOnlyJson',
    'normalizeClientInjectTextJson',
    'compactFollowupErrorReasonJson',
    'resolveAdapterContextProviderKeyJson',
  ]) {
    assertContains(
      'servertool-orchestration-policy-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const keyword of [
    'function parseTimeoutMs',
    'function parseBooleanLike',
    'FOLLOWUP_ERROR_REASON_MAX_LENGTH',
    'httpCodeMatch',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'toLowerCase',
    'targetProviderKey',
    'ProviderProtocolError',
    'inspectStopGatewaySignal',
  ]) {
    if (tsShell.includes(keyword)) {
      fail(
        'servertool-orchestration-policy-ts-thin-shell',
        `Forbidden TS orchestration policy semantic "${keyword}" found in orchestration-policy-block.ts`
      );
    }
  }
  const followupSanitize = readRequired(`${SERVERTOOL_TS_DIR}/handlers/followup-sanitize.ts`);
  for (const keyword of [
    'const TIME_TAG_BLOCK_RE',
    'const STOPMESSAGE_MARKER_RE',
    'const IMAGE_OMITTED_RE',
    'function collapseBlankLines',
    'replace(STOPMESSAGE_MARKER_RE',
  ]) {
    if (followupSanitize.includes(keyword)) {
      fail(
        'servertool-followup-sanitize-ts-thin-shell',
        `Forbidden TS followup sanitize semantic "${keyword}" found in followup-sanitize.ts`
      );
    }
  }
  assertContains(
    'servertool-followup-sanitize-ts-thin-shell',
    `${SERVERTOOL_TS_DIR}/handlers/followup-sanitize.ts`,
    followupSanitize,
    'normalizeClientInjectTextWithNative'
  );
  for (const needle of [
    'parseServertoolTimeoutMsWithNative',
    'readClientInjectOnlyWithNative',
    'normalizeClientInjectTextWithNative',
    'compactFollowupErrorReasonWithNative',
    'resolveAdapterContextProviderKeyWithNative',
    'containsSyntheticRouteCodexControlTextWithNative',
  ]) {
    assertContains(
      'servertool-orchestration-policy-ts-thin-shell',
      TS_ORCHESTRATION_POLICY,
      tsShell,
      needle
    );
  }
  for (const keyword of [
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'toLowerCase',
    'clientConnectionState',
    'clientDisconnected',
    'disconnected',
    "flow=${options.flowId}",
    'timeout after ${options.timeoutMs}',
  ]) {
    if (timeoutShell.includes(keyword)) {
      fail(
        'servertool-timeout-error-ts-thin-shell',
        `Forbidden TS timeout-error semantic "${keyword}" found in timeout-error-block.ts`
      );
    }
  }
  for (const needle of [
    'planServertoolTimeoutWatcherWithNative',
    'isAdapterClientDisconnectedWithNative',
    'planClientDisconnectWatcherWithNative',
    'planServertoolClientDisconnectedErrorWithNative',
    'planServertoolTimeoutErrorWithNative',
    'planStopMessageFetchFailedErrorWithNative',
  ]) {
    assertContains(
      'servertool-timeout-error-ts-thin-shell',
      TS_TIMEOUT_ERROR_BLOCK,
      timeoutShell,
      needle
    );
  }
  assertContains(
    'server-side-tools-client-disconnect-native-shell',
    TS_SERVER_SIDE_TOOLS,
    readRequired(TS_SERVER_SIDE_TOOLS),
    "from './timeout-error-block.js'"
  );
  const serverSideToolsClientDisconnectBlock = extractFunctionBlock(readRequired(TS_SERVER_SIDE_TOOLS), 'isClientDisconnected');
  if (serverSideToolsClientDisconnectBlock) {
    fail(
      'server-side-tools-client-disconnect-native-shell',
      'server-side-tools.ts must not restore local isClientDisconnected; use timeout-error native wrapper'
    );
  }
  for (const keyword of [
    'clientConnectionState',
    'clientDisconnected',
    "trim().toLowerCase() === 'true'",
  ]) {
    if (readRequired(TS_SERVER_SIDE_TOOLS).includes(keyword)) {
      fail(
        'server-side-tools-client-disconnect-native-shell',
        `Forbidden server-side-tools TS client disconnect semantic "${keyword}" found`
      );
    }
  }
  pass('servertool-timeout-error-ts-thin-shell', 'timeout-error-block.ts consumes Rust timeout/disconnect/error plans only');
  pass('servertool-orchestration-policy-rust-owner', 'servertool-core owns orchestration policy parsing and compaction');
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

// ── Check 14: skeleton config has Rust owner ──────────────────
function checkServertoolSkeletonConfigRustOwner() {
  const rustSkeletonConfig = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  const skeletonConfigShell = readRequired(TS_SERVERTOOL_SKELETON_CONFIG);
  const nativeWrapper = readRequired(NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'pub fn plan_servertool_skeleton_derived_config_json',
    'pub fn normalize_servertool_registration_spec_json',
    'pub fn resolve_servertool_tool_spec_json',
  ]) {
    assertContains(
      'servertool-skeleton-config-rust-owner',
      `${RUST_SRC_DIR}/servertool_skeleton_config.rs`,
      rustSkeletonConfig,
      needle
    );
  }
  for (const needle of [
    'planServertoolSkeletonDerivedConfigWithNative',
    'normalizeServertoolRegistrationSpecWithNative',
    'resolveServertoolToolSpecWithNative',
  ]) {
    assertContains(
      'servertool-skeleton-config-native-bridge',
      NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER,
      nativeWrapper,
      needle
    );
  }
  for (const needle of [
    'planServertoolSkeletonDerivedConfigJson',
    'normalizeServertoolRegistrationSpecJson',
    'resolveServertoolToolSpecJson',
  ]) {
    assertContains(
      'servertool-skeleton-config-native-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const keyword of [
    'function normalizeServerToolName',
    'function normalizeAutoHookPhase',
    'function normalizeInteger',
    'Number.isFinite',
    'Math.floor',
    "key === 'websearch'",
    "key === 'web-search'",
    "trigger === 'auto' ? 'auto_hook' : 'guarded'",
    'profile.noFollowup === true',
    'profile.autoLimit === true',
    'profile.contextDecorationMode ===',
    'Object.fromEntries(',
  ]) {
    if (skeletonConfigShell.includes(keyword)) {
      fail(
        'servertool-skeleton-config-no-ts-owner',
        `Forbidden TS skeleton semantic "${keyword}" found in skeleton-config.ts`
      );
    }
  }
  for (const needle of [
    'planServertoolSkeletonDerivedConfigWithNative',
    'normalizeServertoolRegistrationSpecWithNative',
    'resolveServertoolToolSpecWithNative',
  ]) {
    assertContains(
      'servertool-skeleton-config-ts-thin-shell',
      TS_SERVERTOOL_SKELETON_CONFIG,
      skeletonConfigShell,
      needle
    );
  }
  pass('servertool-skeleton-config-no-ts-owner', 'skeleton-config.ts is native-only shell for derived config and registration semantics');
}

function checkPendingSessionRustOwner() {
  const rustPendingSession = readRequired(RUST_SERVERTOOL_PENDING_SESSION);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const pendingSessionShell = readRequired(TS_PENDING_SESSION);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'pub fn resolve_pending_file_name',
    'pub fn resolve_pending_max_age_ms',
    'pub fn plan_pending_session_save',
    'pub fn plan_pending_session_load',
    'pub fn plan_pending_injection_persist',
    'pub fn plan_pending_injection_persist_error',
  ]) {
    assertContains(
      'servertool-pending-session-rust-owner',
      RUST_SERVERTOOL_PENDING_SESSION,
      rustPendingSession,
      needle
    );
  }
  assertContains(
    'servertool-pending-session-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod pending_session_contract'
  );
  for (const needle of [
    'resolve_pending_session_file_name_json',
    'resolve_pending_session_max_age_ms_json',
    'plan_pending_session_save_json',
    'plan_pending_session_load_json',
    'plan_pending_injection_persist_json',
    'plan_pending_injection_persist_error_json',
  ]) {
    assertContains(
      'servertool-pending-session-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      needle
    );
  }
  for (const needle of [
    'pub fn resolve_pending_session_file_name_json',
    'pub fn resolve_pending_session_max_age_ms_json',
    'pub fn plan_pending_session_save_json',
    'pub fn plan_pending_session_load_json',
    'pub fn plan_pending_injection_persist_json',
    'pub fn plan_pending_injection_persist_error_json',
  ]) {
    assertContains(
      'servertool-pending-session-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      needle
    );
  }
  for (const needle of [
    'resolvePendingSessionFileNameJson',
    'resolvePendingSessionMaxAgeMsJson',
    'planPendingSessionSaveJson',
    'planPendingSessionLoadJson',
    'planPendingInjectionPersistJson',
    'planPendingInjectionPersistErrorJson',
  ]) {
    assertContains(
      'servertool-pending-session-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const needle of [
    'resolvePendingSessionFileNameWithNative',
    'resolvePendingSessionMaxAgeMsWithNative',
    'planPendingSessionSaveWithNative',
    'planPendingSessionLoadWithNative',
  ]) {
    assertContains(
      'servertool-pending-session-native-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-pending-session-ts-thin-shell',
      TS_PENDING_SESSION,
      pendingSessionShell,
      needle
    );
  }
  const pendingInjectionShell = readRequired(TS_PENDING_INJECTION);
  for (const needle of [
    'planPendingInjectionPersistWithNative',
    'planPendingInjectionPersistErrorWithNative',
  ]) {
    assertContains(
      'servertool-pending-injection-native-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-pending-injection-ts-thin-shell',
      TS_PENDING_INJECTION,
      pendingInjectionShell,
      needle
    );
  }
  for (const keyword of [
    'aliasSessionIds',
    'Array.from(new Set',
    '.filter((value)',
    '.map((value) => value.trim())',
    'sessionIds: uniqueSessionIds',
    'afterToolCallIds: args.pendingInjection.afterToolCallIds',
    'messages: args.pendingInjection.messages',
    'sourceRequestId: args.requestId',
    "code: 'SERVERTOOL_PENDING_INJECTION_FAILED'",
    "category: 'INTERNAL_ERROR'",
    'status = 502',
  ]) {
    if (pendingInjectionShell.includes(keyword)) {
      fail(
        'servertool-pending-injection-no-ts-owner',
        `Forbidden TS pending-injection semantic "${keyword}" found in pending-injection-block.ts`
      );
    }
  }
  pass(
    'servertool-pending-injection-no-ts-owner',
    'pending-injection-block.ts is native-plan shell for session dedupe, save payload, and error envelope decisions'
  );
  for (const keyword of [
    'DEFAULT_PENDING_MAX_AGE_MS',
    'function sanitizeSegment',
    'function coercePending',
    'Number.parseInt',
    'Number.isFinite',
    'Math.floor',
    '.replace(/[^a-zA-Z0-9_.-]/g',
    'stale pending injection dropped session=${',
    'invalid pending injection dropped: malformed payload',
  ]) {
    if (pendingSessionShell.includes(keyword)) {
      fail(
        'servertool-pending-session-no-ts-owner',
        `Forbidden TS pending-session semantic "${keyword}" found in pending-session.ts`
      );
    }
  }
  pass(
    'servertool-pending-session-no-ts-owner',
    'pending-session.ts is native-only shell for max-age, session file, payload coercion, and stale/malformed load decisions'
  );
}

function checkPreCommandHooksRustOwner() {
  const rustPreCommand = readRequired(RUST_SERVERTOOL_PRE_COMMAND);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const preCommandShell = readRequired(TS_PRE_COMMAND_HOOKS);

  for (const needle of [
    'feature_id: hub.servertool_pre_command_hooks',
    'pub struct PreCommandHooksConfigPlanInput',
    'pub struct PreCommandHooksConfigPlan',
    'pub struct PreCommandHookRulePlan',
    'pub struct PreCommandRegexPlan',
    'pub struct RuntimePreCommandRulePlanInput',
    'pub fn plan_pre_command_hooks_config',
    'pub fn plan_runtime_pre_command_rule',
  ]) {
    assertContains(
      'servertool-pre-command-hooks-rust-owner',
      RUST_SERVERTOOL_PRE_COMMAND,
      rustPreCommand,
      needle
    );
  }
  assertContains(
    'servertool-pre-command-hooks-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod pre_command_hook_contract'
  );
  for (const needle of [
    'plan_pre_command_hooks_config_json',
    'plan_runtime_pre_command_rule_json',
  ]) {
    assertContains(
      'servertool-pre-command-hooks-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      needle
    );
  }
  for (const needle of [
    'pub fn plan_pre_command_hooks_config_json',
    'pub fn plan_runtime_pre_command_rule_json',
  ]) {
    assertContains(
      'servertool-pre-command-hooks-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      needle
    );
  }
  for (const needle of [
    'planPreCommandHooksConfigJson',
    'planRuntimePreCommandRuleJson',
  ]) {
    assertContains(
      'servertool-pre-command-hooks-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const needle of [
    'planPreCommandHooksConfigWithNative',
    'planRuntimePreCommandRuleWithNative',
  ]) {
    assertContains(
      'servertool-pre-command-hooks-native-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-pre-command-hooks-ts-thin-shell',
      TS_PRE_COMMAND_HOOKS,
      preCommandShell,
      needle
    );
  }
  for (const keyword of [
    'function normalizePreCommandHookRule',
    'function sanitizeHookId',
    'function normalizeHookId',
    'function normalizeToolSet',
    'function parseRegex',
    'function normalizeTimeoutMs',
    'function normalizePriority',
    'Number.parseInt',
    'Number.isFinite',
    'Math.floor',
    'Math.min',
    'DEFAULT_TIMEOUT_MS',
    'DEFAULT_TOOLS',
    '.replace(/[^a-zA-Z0-9_.-]+/g',
  ]) {
    if (preCommandShell.includes(keyword)) {
      fail(
        'servertool-pre-command-hooks-no-ts-owner',
        `Forbidden TS pre-command hook semantic "${keyword}" found in pre-command-hooks.ts`
      );
    }
  }
  pass(
    'servertool-pre-command-hooks-no-ts-owner',
    'pre-command-hooks.ts is native-plan shell for config/rule normalization, hook id, tools, regex plan, timeout, and priority policy'
  );
}

function checkEngineSelectionRustOwner() {
  const rustEngineSelection = readRequired(RUST_SERVERTOOL_ENGINE_SELECTION);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const engineSelectionShell = readRequired(TS_ENGINE_SELECTION);

  for (const needle of [
    'feature_id: hub.servertool_engine_selection',
    'pub struct EngineSelectionStartInput',
    'pub struct EngineSelectionStartPlan',
    'pub struct EngineSelectionAfterRunInput',
    'pub struct EngineSelectionAfterRunPlan',
    'pub enum EngineSelectionAction',
    'pub fn plan_engine_selection_start',
    'pub fn plan_engine_selection_after_run',
  ]) {
    assertContains(
      'servertool-engine-selection-rust-owner',
      RUST_SERVERTOOL_ENGINE_SELECTION,
      rustEngineSelection,
      needle
    );
  }
  assertContains(
    'servertool-engine-selection-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod engine_selection_contract'
  );
  for (const needle of [
    'plan_engine_selection_start_json',
    'plan_engine_selection_after_run_json',
  ]) {
    assertContains(
      'servertool-engine-selection-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      needle
    );
  }
  for (const needle of [
    'pub fn plan_engine_selection_start_json',
    'pub fn plan_engine_selection_after_run_json',
  ]) {
    assertContains(
      'servertool-engine-selection-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      needle
    );
  }
  for (const needle of [
    'planEngineSelectionStartJson',
    'planEngineSelectionAfterRunJson',
  ]) {
    assertContains(
      'servertool-engine-selection-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const needle of [
    'planEngineSelectionStartWithNative',
    'planEngineSelectionAfterRunWithNative',
  ]) {
    assertContains(
      'servertool-engine-selection-native-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-engine-selection-ts-thin-shell',
      TS_ENGINE_SELECTION,
      engineSelectionShell,
      needle
    );
  }
  for (const keyword of [
    'primaryAutoHookIds.length',
    'engineResult.mode',
    '!engineResult.execution',
    "mode === 'passthrough'",
    'disableToolCallHandlers: true',
    'includeAutoHookIds: primaryAutoHookIds',
    'excludeAutoHookIds: primaryAutoHookIds',
  ]) {
    if (engineSelectionShell.includes(keyword)) {
      fail(
        'servertool-engine-selection-no-ts-owner',
        `Forbidden TS engine selection semantic "${keyword}" found in engine-selection-block.ts`
      );
    }
  }
  pass(
    'servertool-engine-selection-no-ts-owner',
    'engine-selection-block.ts is native-plan shell for primary hook first-pass and rerun decisions'
  );
}

function checkServertoolFlowPresentationRustOwner() {
  const rustSkeletonConfig = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  const flowPresentationShell = readRequired(TS_FLOW_PRESENTATION);
  const skeletonConfigShell = readRequired(TS_SERVERTOOL_SKELETON_CONFIG);
  const nativeWrapper = readRequired(NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'pub fn resolve_servertool_progress_tool_name_json',
    'pub fn should_use_servertool_gold_progress_highlight_json',
  ]) {
    assertContains(
      'servertool-flow-presentation-rust-owner',
      `${RUST_SRC_DIR}/servertool_skeleton_config.rs`,
      rustSkeletonConfig,
      needle
    );
  }
  for (const needle of [
    'resolveServertoolProgressToolNameJson',
    'shouldUseServertoolGoldProgressHighlightJson',
  ]) {
    assertContains(
      'servertool-flow-presentation-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      needle
    );
  }
  for (const needle of [
    'resolveServertoolProgressToolNameWithNative',
    'shouldUseServertoolGoldProgressHighlightWithNative',
  ]) {
    assertContains(
      'servertool-flow-presentation-native-bridge',
      NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-flow-presentation-ts-thin-shell',
      TS_FLOW_PRESENTATION,
      flowPresentationShell,
      needle
    );
  }
  for (const keyword of [
    'function normalizeFlowId',
    'buildServertoolProgressConfig',
    'toolNameByFlowId',
    'goldHighlightFlowIds',
    'new Set(',
    "return 'unknown'",
  ]) {
    if (flowPresentationShell.includes(keyword)) {
      fail(
        'servertool-flow-presentation-no-ts-owner',
        `Forbidden TS flow presentation semantic "${keyword}" found in flow-presentation-block.ts`
      );
    }
  }
  for (const keyword of [
    'buildServertoolProgressConfig',
    'progressConfig:',
    'toolNameByFlowId:',
    'goldHighlightFlowIds:',
  ]) {
    if (skeletonConfigShell.includes(keyword)) {
      fail(
        'servertool-flow-presentation-no-skeleton-ts-owner',
        `Forbidden TS skeleton progress presentation semantic "${keyword}" found in skeleton-config.ts`
      );
    }
  }
  pass(
    'servertool-flow-presentation-no-ts-owner',
    'flow-presentation-block.ts is native-only shell for progress tool name and highlight semantics'
  );
  pass(
    'servertool-flow-presentation-no-skeleton-ts-owner',
    'skeleton-config.ts has no progress presentation projection shell'
  );
}

// ── Check 14: backend-route policy has Rust owner ─────────────
function checkBackendRoutePolicyRustOwner() {
  const rustBackendRoute = readRequired(RUST_SERVERTOOL_BACKEND_ROUTE);
  const rustLoopState = readRequired(RUST_SERVERTOOL_LOOP_STATE);
  const skeletonConfigShell = readRequired(TS_SERVERTOOL_SKELETON_CONFIG);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const outcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const chatProcessServertoolWrapper = readRequired(NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const flowPolicyShell = readRequired(TS_BACKEND_ROUTE_FLOW_POLICY);
  const runtimeShell = readRequired(TS_BACKEND_ROUTE_RUNTIME);
  const loopStateShell = readRequired(TS_LOOP_STATE_BLOCK);

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
    'backend-route-outcome-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    outcomeContract,
    '"memory_cache_auto" => Some(ServertoolOutcome::ServerIoInternal)'
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
  const flowPolicyFunctionNames = Array.from(flowPolicyShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (flowPolicyFunctionNames.join(',') !== 'resolveFollowupFlowDecision') {
    fail(
      'backend-route-flow-policy-ts-thin-shell',
      `backend-route-flow-policy.ts must remain a single native delegate; found exports: ${flowPolicyFunctionNames.join(',') || '(none)'}`
    );
  }
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
  for (const keyword of [
    "optionalPrimaryOrder.splice",
    "optionalPrimaryOrder.push('empty_reply_continue')",
    "optionalPrimaryOrder.push('vision_auto')",
    "!optionalPrimaryOrder.includes('empty_reply_continue')",
    "!optionalPrimaryOrder.includes('vision_auto')",
  ]) {
    if (skeletonConfigShell.includes(keyword)) {
      fail(
        'servertool-skeleton-config-no-ts-queue-owner',
        `Forbidden TS auto-hook queue semantic "${keyword}" found in skeleton-config.ts`
      );
    }
  }
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
  assertContains(
    'backend-route-followup-runtime-action-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_runtime_action'
  );
  assertContains(
    'backend-route-followup-runtime-action-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'is_stop_message_flow'
  );
  assertContains(
    'backend-route-followup-runtime-action-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planFollowupRuntimeActionWithNative'
  );
  assertContains(
    'backend-route-followup-runtime-action-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'isStopMessageFlow'
  );
  assertContains(
    'backend-route-followup-runtime-action-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planFollowupRuntimeActionJson'
  );
  const backendRouteMainlineShell = readRequired(`${SERVERTOOL_TS_DIR}/backend-route-mainline-block.ts`);
  const backendRouteMainlineFunctionNames = Array.from(
    backendRouteMainlineShell.matchAll(/export (?:async\s+)?function\s+([A-Za-z0-9_]+)/g)
  )
    .map((match) => match[1])
    .sort();
  if (backendRouteMainlineFunctionNames.join(',') !== 'runFollowupMainline') {
    fail(
      'backend-route-mainline-ts-surface',
      `backend-route-mainline-block.ts must expose only runFollowupMainline orchestration; found exports: ${backendRouteMainlineFunctionNames.join(',') || '(none)'}`
    );
  }
  if (backendRouteMainlineShell.includes("args.execution.flowId === 'stop_message_flow'")) {
    fail(
      'backend-route-followup-runtime-action-no-ts-flow-owner',
      'backend-route-mainline-block.ts must read isStopMessageFlow from Rust runtime action plan'
    );
  }
  assertContains(
    'backend-route-followup-runtime-metadata-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_runtime_metadata'
  );
  assertContains(
    'backend-route-followup-runtime-metadata-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planFollowupRuntimeMetadataWithNative'
  );
  assertContains(
    'backend-route-followup-runtime-metadata-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planFollowupRuntimeMetadataJson'
  );
  assertContains(
    'backend-route-followup-materialization-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_materialization'
  );
  assertContains(
    'backend-route-followup-append-user-text-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_append_user_text'
  );
  assertContains(
    'backend-route-followup-append-user-text-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'fn followup_append_user_text_uses_first_non_empty_append_op'
  );
  assertContains(
    'backend-route-followup-append-user-text-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'fn followup_append_user_text_ignores_blank_and_invalid_shapes'
  );
  assertContains(
    'backend-route-preferred-final-response-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_preferred_final_response'
  );
  assertContains(
    'backend-route-preferred-final-response-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'fn preferred_final_response_selects_followup_for_requires_action_or_non_empty_body'
  );
  assertContains(
    'backend-route-preferred-final-response-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'fn preferred_final_response_keeps_final_chat_for_empty_or_missing_followup'
  );
  assertContains(
    'backend-route-followup-materialization-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planFollowupMaterializationWithNative'
  );
  assertContains(
    'backend-route-followup-materialization-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planFollowupMaterializationJson'
  );
  for (const keyword of [
    'resolveFollowupEntryEndpoint',
    'resolveFollowupPayloadFromPlan',
    'resolveFollowupPayloadSource',
    'materializeFollowupPayload',
    'FollowupPayloadSource',
    'materializationPlan.payloadSource',
    "payloadSource === 'payload'",
    "payloadSource === 'injection'",
    "payloadSource === 'none'",
    "hasOwnProperty.call(followupPlan, 'payload')",
    "hasOwnProperty.call(followupPlan, 'injection')",
    "typeof (followupPlan as { entryEndpoint?: unknown }).entryEndpoint",
    "'/v1/chat/completions'"
  ]) {
    if (runtimeShell.includes(keyword)) {
      fail(
        'backend-route-followup-materialization-no-ts-owner',
        `Forbidden TS followup materialization semantic "${keyword}" found in backend-route-runtime-block.ts`
      );
    }
  }
  pass(
    'backend-route-followup-materialization-no-ts-owner',
    'backend-route-runtime-block.ts consumes native materialization plan without local followupPlan field policy'
  );
  assertContains(
    'backend-route-loop-state-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod loop_state_contract'
  );
  for (const needle of [
    'pub fn read_servertool_loop_state',
    'pub fn plan_servertool_loop_state',
    'AUTO_PAYLOAD_HASH',
    'STOP_MESSAGE_FLOW_ID',
  ]) {
    assertContains(
      'backend-route-loop-state-rust-owner',
      RUST_SERVERTOOL_LOOP_STATE,
      rustLoopState,
      needle
    );
  }
  assertContains(
    'backend-route-loop-state-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'readServertoolLoopStateWithNative'
  );
  assertContains(
    'backend-route-loop-state-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolLoopStateWithNative'
  );
  assertContains(
    'backend-route-loop-state-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'readServertoolLoopStateJson'
  );
  assertContains(
    'backend-route-loop-state-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolLoopStateJson'
  );
  assertContains(
    'backend-route-loop-state-ts-thin-shell',
    TS_LOOP_STATE_BLOCK,
    loopStateShell,
    'planServertoolLoopStateWithNative'
  );
  for (const keyword of [
    'sameFlow',
    'samePayload',
    'prevCount',
    'previousStartedAtMs',
    'previousPairHash',
    'previousPairCount',
    '__servertool_auto__',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    "args.flowId === 'stop_message_flow'",
    "args.flowId !== 'stop_message_flow'",
  ]) {
    if (loopStateShell.includes(keyword)) {
      fail(
        'backend-route-loop-state-ts-thin-shell',
        `Forbidden TS loop-state policy semantic "${keyword}" found in loop-state-block.ts`
      );
    }
  }
  for (const [toolName, forbiddenProjection] of [
    ['web_search', 'ClientExecCliProjection'],
    ['vision_auto', 'ClientExecCliProjection'],
    ['memory_cache_auto', 'BackendRouteReenter'],
  ]) {
    const pattern = new RegExp(`"${toolName}"[^\\n]+${forbiddenProjection}`);
    if (pattern.test(outcomeContract) || pattern.test(rustBackendRoute)) {
      fail(
        'backend-route-policy-rust-owner',
        `${toolName} has forbidden ${forbiddenProjection} mapping in servertool Rust contracts`
      );
    }
  }
  const finalizeShell = readRequired(TS_BACKEND_ROUTE_FINALIZE);
  const originDeltaShell = readRequired(TS_BACKEND_ROUTE_ORIGIN_DELTA);
  const reenterShell = readRequired(TS_BACKEND_ROUTE_REENTER);
  const bootstrapReplayShell = readRequired(TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY);
  const responseShell = readRequired(TS_BACKEND_ROUTE_RESPONSE);
  const visionEligibilityShell = readRequired(TS_VISION_ELIGIBILITY);
  const finalizeFunctionNames = Array.from(finalizeShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (
    finalizeFunctionNames.join(',') !==
    'decorateFinalChatWithServerToolContext,shouldShortCircuitRequiresActionFollowup'
  ) {
    fail(
      'backend-route-finalize-ts-thin-shell',
      `backend-route-finalize-block.ts must remain a two-function native delegate; found exports: ${finalizeFunctionNames.join(',') || '(none)'}`
    );
  }
  const finalizeShortCircuitBlock = extractFunctionBlock(finalizeShell, 'shouldShortCircuitRequiresActionFollowup');
  assertContains(
    'backend-route-finalize-ts-thin-shell',
    TS_BACKEND_ROUTE_FINALIZE,
    finalizeShortCircuitBlock,
    'shouldShortCircuitRequiresActionFollowupWithNative'
  );
  const finalizeDecorateBlock = extractFunctionBlock(finalizeShell, 'decorateFinalChatWithServerToolContext');
  assertContains(
    'backend-route-finalize-ts-thin-shell',
    TS_BACKEND_ROUTE_FINALIZE,
    finalizeDecorateBlock,
    'decorateServertoolFinalChatWithNative'
  );
  const visionEligibilityFunctionNames = Array.from(visionEligibilityShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (
    visionEligibilityFunctionNames.join(',') !==
    'shouldBypassStopMessageForMediaContext,shouldRunVisionFlowForAdapterContext'
  ) {
    fail(
      'backend-route-vision-eligibility-ts-thin-shell',
      `vision-eligibility.ts must remain a two-function native delegate; found exports: ${visionEligibilityFunctionNames.join(',') || '(none)'}`
    );
  }
  for (const functionName of [
    'shouldRunVisionFlowForAdapterContext',
    'shouldBypassStopMessageForMediaContext',
  ]) {
    assertContains(
      'backend-route-vision-eligibility-ts-thin-shell',
      TS_VISION_ELIGIBILITY,
      extractFunctionBlock(visionEligibilityShell, functionName),
      'planVisionEligibilityWithNative'
    );
  }
  assertContains(
    'backend-route-origin-delta-native-seed-owner',
    RUST_SRC_DIR + '/servertool_followup_delta.rs',
    readRequired(RUST_SRC_DIR + '/servertool_followup_delta.rs'),
    'pub(crate) fn resolve_followup_origin_seed'
  );
  assertContains(
    'backend-route-origin-delta-native-bridge',
    NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER,
    chatProcessServertoolWrapper,
    'resolveFollowupOriginSeedWithNative'
  );
  assertContains(
    'backend-route-origin-delta-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'resolveFollowupOriginSeedJson'
  );
  assertContains(
    'backend-route-origin-delta-ts-thin-shell',
    TS_BACKEND_ROUTE_ORIGIN_DELTA,
    originDeltaShell,
    'resolveFollowupOriginSeedWithNative'
  );
  const originDeltaFunctionNames = Array.from(originDeltaShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (
    originDeltaFunctionNames.join(',') !==
    'applyFollowupDeltaPlan,extractAssistantFollowupMessage,loadFollowupOriginSeed'
  ) {
    fail(
      'backend-route-origin-delta-ts-thin-shell',
      `backend-route-origin-delta.ts must remain a three-function IO/native delegate; found exports: ${originDeltaFunctionNames.join(',') || '(none)'}`
    );
  }
  for (const [functionName, nativeCall] of [
    ['extractAssistantFollowupMessage', 'extractAssistantFollowupMessageWithNative'],
    ['loadFollowupOriginSeed', 'resolveFollowupOriginSeedWithNative'],
    ['applyFollowupDeltaPlan', 'applyFollowupDeltaPlanWithNative'],
  ]) {
    assertContains(
      'backend-route-origin-delta-ts-thin-shell',
      TS_BACKEND_ROUTE_ORIGIN_DELTA,
      extractFunctionBlock(originDeltaShell, functionName),
      nativeCall
    );
  }
  const responseFunctionNames = Array.from(responseShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (
    responseFunctionNames.join(',') !==
    [
      'choosePreferredFinalChatResponse',
      'coerceFollowupPayloadStream',
      'createEmptyFollowupError',
      'createMissingFollowupPayloadError',
      'extractAppendUserTextFromFollowupPlan',
      'hasRequiresActionShape',
      'isEmptyClientResponsePayload',
    ].sort().join(',')
  ) {
    fail(
      'backend-route-response-ts-surface',
      `backend-route-response-block.ts exported function surface changed; found exports: ${responseFunctionNames.join(',') || '(none)'}`
    );
  }
  assertContains(
    'backend-route-response-ts-thin-shell',
    TS_BACKEND_ROUTE_RESPONSE,
    extractFunctionBlock(responseShell, 'isEmptyClientResponsePayload'),
    'isEmptyClientResponsePayloadWithNative'
  );
  assertContains(
    'backend-route-response-ts-thin-shell',
    TS_BACKEND_ROUTE_RESPONSE,
    extractFunctionBlock(responseShell, 'hasRequiresActionShape'),
    'isToolCallContinuationResponseWithNative'
  );
  for (const keyword of [
    'function cloneJson',
    'JSON.parse(JSON.stringify',
    'function normalizeSeed',
    'extractCapturedChatSeed',
    'capturedEntryRequest',
    'capturedChatRequest',
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
    'backend-route-vision-eligibility-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_vision_eligibility'
  );
  assertContains(
    'backend-route-vision-eligibility-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planVisionEligibilityWithNative'
  );
  assertContains(
    'backend-route-vision-eligibility-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planVisionEligibilityJson'
  );
  assertContains(
    'backend-route-vision-eligibility-ts-thin-shell',
    TS_VISION_ELIGIBILITY,
    visionEligibilityShell,
    'planVisionEligibilityWithNative'
  );
  for (const keyword of [
    'containsImageAttachment',
    'readRuntimeMetadata',
    'extractCapturedChatSeed',
    'VIDEO_URL_HINT_RE',
    'latestUserTurnContainsVideo',
    'resolveInlineMultimodalSupport',
    'hasInlineMultimodalSupport',
    'isImageGenerationRequest',
    'hasImageGenerationFlag',
    'readMediaUrlCandidate',
    'supportsMultimodal',
    'routeHint',
    'forceVision',
    'hasVideoAttachment'
  ]) {
    if (visionEligibilityShell.includes(keyword)) {
      fail(
        'backend-route-vision-eligibility-no-ts-owner',
        `Forbidden TS vision eligibility semantic "${keyword}" found in vision-eligibility.ts`
      );
    }
  }
  pass(
    'backend-route-vision-eligibility-no-ts-owner',
    'vision-eligibility.ts delegates vision/media eligibility to Rust native plan'
  );
  assertContains(
    'backend-route-bootstrap-replay-native-request-id-owner',
    TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY,
    bootstrapReplayShell,
    'buildFollowupRequestIdWithNative'
  );
  assertContains(
    'backend-route-followup-error-envelope-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_followup_error_envelope'
  );
  assertContains(
    'backend-route-followup-error-envelope-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planFollowupErrorEnvelopeWithNative'
  );
  assertContains(
    'backend-route-followup-error-envelope-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planFollowupErrorEnvelopeJson'
  );
  assertContains(
    'backend-route-bootstrap-replay-rust-owner',
    RUST_SERVERTOOL_BACKEND_ROUTE,
    rustBackendRoute,
    'pub fn plan_bootstrap_replay'
  );
  assertContains(
    'backend-route-bootstrap-replay-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planBootstrapReplayWithNative'
  );
  assertContains(
    'backend-route-bootstrap-replay-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planBootstrapReplayJson'
  );
  for (const keyword of [
    'function readTrimmedString',
    'function extractFollowupErrorEnvelope',
    'function isTerminalFollowupError',
    'upstreamStatus >= 400',
    'upstreamStatus < 500',
    'provider_not_available',
    'client_timeout_hint_expired',
    'no available providers after applying routing instructions',
    "text.includes(\"tool_choice\")",
    "text.includes('tool_choice')",
  ]) {
    if (reenterShell.includes(keyword)) {
      fail(
        'backend-route-followup-error-envelope-no-ts-owner',
        `Forbidden TS followup error semantic "${keyword}" found in backend-route-reenter-block.ts`
      );
    }
  }
  pass(
    'backend-route-followup-error-envelope-no-ts-owner',
    'backend-route-reenter-block.ts consumes native error envelope plan without local terminal classification'
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
    'function readPreflightStatus',
    'function buildReplayPayload',
    'extractCapturedChatSeed',
    './backend-route-seed.js',
    'Number.isFinite',
    'Math.floor',
    '/^HTTP_\\d{3}$/i',
    'preflightStatus === 429',
    'preflightStatus === 400',
    'preflightError as any',
    'seed.messages as JsonObject[]',
  ]) {
    if (bootstrapReplayShell.includes(keyword)) {
      fail(
        'backend-route-bootstrap-replay-no-ts-owner',
        `Forbidden TS bootstrap replay semantic "${keyword}" found in backend-route-bootstrap-replay-block.ts`
      );
    }
  }
  pass(
    'backend-route-bootstrap-replay-no-ts-owner',
    'backend-route-bootstrap-replay-block.ts consumes native bootstrap replay plan without local preflight/replay policy'
  );
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
  const runtimeFunctionNames = Array.from(runtimeShell.matchAll(/export function\s+([A-Za-z0-9_]+)/g))
    .map((match) => match[1])
    .sort();
  if (
    runtimeFunctionNames.join(',') !==
    [
      'applyClientInjectOnlyMetadata',
      'applyFollowupRuntimeMetadata',
      'assertAutoLimitNotExceeded',
      'materializeFollowupInjectionPayload',
      'planFollowupMaterialization',
      'resolveFollowupExecutionMode',
      'resolveFollowupRuntimeActionPlan',
      'resolveLoopPayload',
    ].sort().join(',')
  ) {
    fail(
      'backend-route-followup-runtime-ts-surface',
      `backend-route-runtime-block.ts exported function surface changed; found exports: ${runtimeFunctionNames.join(',') || '(none)'}`
    );
  }
  const executionModeBlock = extractFunctionBlock(runtimeShell, 'resolveFollowupExecutionMode');
  for (const keyword of [
    "decision.outcomeMode === 'skip'",
    'if (decision.noFollowup',
    '|| decision.noFollowup',
    'decision.noFollowup ||',
    "clientInjectSource === 'servertool.stopless_goal_continue'",
    "decision.outcomeMode === 'client_inject_only'",
    'if (decision.clientInjectOnly',
    '|| decision.clientInjectOnly',
    'decision.clientInjectOnly ||',
  ]) {
    if (executionModeBlock.includes(keyword)) {
      fail(
        'backend-route-followup-execution-mode-no-ts-owner',
        `Forbidden TS followup execution mode semantic "${keyword}" found in backend-route-runtime-block.ts`
      );
    }
  }
  for (const [functionName, keywords] of [
    [
      'resolveLoopPayload',
      [
        'args.followupPayloadRaw ||',
        '? args.buildSeedLoopPayload()',
      ],
    ],
    [
      'assertAutoLimitNotExceeded',
      [
        'if (!decision.autoLimit',
        'args.loopState.repeatCount < 3',
        'repeatCount < 3',
        "reason: 'followup_auto_limit_hit'",
      ],
    ],
    [
      'applyClientInjectOnlyMetadata',
      [
        'if (!decision.clientInjectOnly',
        'decision.clientInjectSource ??',
        "'servertool.followup'",
      ],
    ],
  ]) {
    const runtimeActionPlanBlock = extractFunctionBlock(runtimeShell, 'resolveFollowupRuntimeActionPlan');
    assertContains(
      'backend-route-followup-runtime-action-thin-shell',
      TS_BACKEND_ROUTE_RUNTIME,
      runtimeActionPlanBlock,
      'planFollowupRuntimeActionWithNative'
    );
    const block = extractFunctionBlock(runtimeShell, functionName);
    assertContains(
      'backend-route-followup-runtime-action-thin-shell',
      TS_BACKEND_ROUTE_RUNTIME,
      block,
      'resolveFollowupRuntimeActionPlan'
    );
    for (const keyword of keywords) {
      if (block.includes(keyword)) {
        fail(
          'backend-route-followup-runtime-action-no-ts-owner',
          `Forbidden TS followup runtime semantic "${keyword}" found in ${functionName}`
        );
      }
    }
  }
  const runtimeMetadataBlock = extractFunctionBlock(runtimeShell, 'applyFollowupRuntimeMetadata');
  assertContains(
    'backend-route-followup-runtime-metadata-thin-shell',
    TS_BACKEND_ROUTE_RUNTIME,
    runtimeMetadataBlock,
    'planFollowupRuntimeMetadataWithNative'
  );
  for (const keyword of [
    'const adapterTarget',
    'runtimeRouteHint',
    'runtimeRouteName',
    'followupMode',
    'const routeHint',
    "routecodexPortMode === 'string'",
    "serverToolFollowupMode === 'string'",
    'rootLoopState',
    'currentLoopState',
    'mergedLoopState',
    'metadata.routeHint =',
    'delete (args.metadata as Record<string, unknown>).routeHint',
    "serverToolOriginalEntryEndpoint =",
    "args.originalEntryEndpoint.trim().length",
  ]) {
    if (runtimeMetadataBlock.includes(keyword)) {
      fail(
        'backend-route-followup-runtime-metadata-no-ts-owner',
        `Forbidden TS followup runtime metadata semantic "${keyword}" found in applyFollowupRuntimeMetadata`
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

// ── Check 15b: stop visible text cleanup has Rust owner ───────
function checkStopVisibleTextRustOwner() {
  const rustStopVisibleText = readRequired(RUST_SERVERTOOL_STOP_VISIBLE_TEXT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const stopMessageHandler = readRequired(STOP_MESSAGE_AUTO_HANDLER);
  const servertoolEngine = readRequired(`${SERVERTOOL_TS_DIR}/engine.ts`);

  for (const file of DELETED_STOP_VISIBLE_TEXT_TS_FILES) {
    if (existsSync(file)) {
      fail(
        'stop-visible-text-no-ts-owner',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; stop_schema visible cleanup is Rust-owned`
      );
    }
  }

  assertContains(
    'stop-visible-text-rust-owner',
    RUST_SERVERTOOL_STOP_VISIBLE_TEXT,
    rustStopVisibleText,
    'pub fn strip_stop_schema_control_text'
  );
  assertContains(
    'stop-visible-text-rust-owner',
    RUST_SERVERTOOL_STOP_VISIBLE_TEXT,
    rustStopVisibleText,
    'pub fn strip_stop_schema_control_payload'
  );
  assertContains(
    'stop-visible-text-rust-owner',
    RUST_SERVERTOOL_STOP_VISIBLE_TEXT,
    rustStopVisibleText,
    'pub fn extract_current_assistant_stop_text'
  );
  assertContains(
    'stop-visible-text-rust-owner',
    RUST_SERVERTOOL_STOP_VISIBLE_TEXT,
    rustStopVisibleText,
    'pub fn build_stop_message_terminal_visible_payload'
  );
  assertContains(
    'stop-visible-text-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod stop_visible_text'
  );
  assertContains(
    'stop-visible-text-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'strip_stop_schema_control_text_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'extract_current_assistant_stop_text_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'build_stop_message_terminal_visible_payload_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn strip_stop_schema_control_text_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn extract_current_assistant_stop_text_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn build_stop_message_terminal_visible_payload_json'
  );
  assertContains(
    'stop-visible-text-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'stripStopSchemaControlTextJson'
  );
  assertContains(
    'stop-visible-text-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'extractCurrentAssistantStopTextJson'
  );
  assertContains(
    'stop-visible-text-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'buildStopMessageTerminalVisiblePayloadJson'
  );
  assertContains(
    'stop-visible-text-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'stripStopSchemaControlTextWithNative'
  );
  assertContains(
    'stop-visible-text-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'extractCurrentAssistantStopTextWithNative'
  );
  assertContains(
    'stop-visible-text-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'buildStopMessageTerminalVisiblePayloadWithNative'
  );
  for (const [file, content, keyword] of [
    [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'strip_stop_schema_control_payload_json'],
    [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn strip_stop_schema_control_payload_json'],
    [NATIVE_REQUIRED_EXPORTS, requiredExports, 'stripStopSchemaControlPayloadJson'],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeServertoolWrapper, 'stripStopSchemaControlPayloadWithNative'],
  ]) {
    if (content.includes(keyword)) {
      fail(
        'stop-visible-text-dead-export-deleted',
        `Forbidden dead stop visible text export "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  assertContains(
    'stop-visible-text-thin-shell',
    STOP_MESSAGE_AUTO_HANDLER,
    stopMessageHandler,
    'extractCurrentAssistantStopTextWithNative(ctx.base)'
  );
  assertContains(
    'stop-visible-text-thin-shell',
    STOP_MESSAGE_AUTO_HANDLER,
    stopMessageHandler,
    'buildStopMessageTerminalVisiblePayloadWithNative'
  );
  assertContains(
    'stop-visible-text-thin-shell',
    `${SERVERTOOL_TS_DIR}/engine.ts`,
    servertoolEngine,
    'planStopMessageCliProjectionSeedWithNative'
  );

  for (const [file, content] of [
    [STOP_MESSAGE_AUTO_HANDLER, stopMessageHandler],
    [`${SERVERTOOL_TS_DIR}/engine.ts`, servertoolEngine],
  ]) {
    for (const keyword of [
      'isStopSchemaControlJson',
      'removeBareStopSchemaJsonObjects',
      'findJsonObjectEnd',
      '<stop_schema>',
      '停止原因',
      'function extractCurrentAssistantStopText',
      'function collectTextBlocks',
      'function prefixChatChoiceContent',
      'function replaceChatChoiceContent',
      'function prefixResponsesOutputContent',
      'function replaceResponsesOutputContent',
      'function stripVisibleReasoningFields',
      'function isResponsesReasoningItem',
    ]) {
      if (content.includes(keyword)) {
        fail(
          'stop-visible-text-no-ts-owner',
          `Forbidden TS stop visible text semantic "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }
  pass('stop-visible-text-rust-owner', 'servertool-core owns stop_schema visible text cleanup');
}

// ── Check 15c: stopless CLI projection seed has Rust owner ────
function checkStopMessageCliProjectionSeedRustOwner() {
  const rustCliContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const servertoolEngine = readRequired(`${SERVERTOOL_TS_DIR}/engine.ts`);

  for (const [check, file, content, needle] of [
    ['stop-message-cli-projection-seed-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, 'pub fn plan_stop_message_cli_projection_seed'],
    ['stop-message-cli-projection-seed-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_stop_message_cli_projection_seed_json'],
    ['stop-message-cli-projection-seed-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_stop_message_cli_projection_seed_json'],
    ['stop-message-cli-projection-seed-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planStopMessageCliProjectionSeedJson'],
    ['stop-message-cli-projection-seed-native-wrapper', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planStopMessageCliProjectionSeedWithNative'],
    ['stop-message-cli-projection-seed-thin-shell', `${SERVERTOOL_TS_DIR}/engine.ts`, servertoolEngine, 'planStopMessageCliProjectionSeedWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const keyword of [
    'function readStopMessageFollowupText',
    'function readStopMessageAssistantStopText',
    'function readAssistantStopTextFromChat',
    'function collectTextFromContentParts',
    'function readStopMessageRuntimeMetadata',
    'function readStopMessageLoopNumber',
    'stripStopSchemaControlTextWithNative',
    'Number.isFinite(value)',
    'Math.floor(value)',
    '继续完成当前用户目标。若仍需操作',
    '模型以 finish_reason=stop 结束，RouteCodex 正在请求继续执行。',
  ]) {
    if (servertoolEngine.includes(keyword)) {
      fail(
        'stop-message-cli-projection-seed-no-ts-owner',
        `Forbidden TS stopless projection seed semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/engine.ts`
      );
    }
  }
  pass('stop-message-cli-projection-seed-rust-owner', 'servertool-core owns stopless CLI projection seed planning');
}

// ── Check 15d: stopless orchestration action has Rust owner ───
function checkStoplessOrchestrationActionRustOwner() {
  const rustStoplessOrchestration = readRequired(RUST_SERVERTOOL_STOPLESS_ORCHESTRATION);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const servertoolEngine = readRequired(`${SERVERTOOL_TS_DIR}/engine.ts`);

  for (const [check, file, content, needle] of [
    ['stopless-orchestration-action-rust-owner', RUST_SERVERTOOL_STOPLESS_ORCHESTRATION, rustStoplessOrchestration, 'pub fn plan_stopless_orchestration_action'],
    ['stopless-orchestration-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_stopless_orchestration_action_json'],
    ['stopless-orchestration-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_stopless_orchestration_action_json'],
    ['stopless-orchestration-action-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planStoplessOrchestrationActionJson'],
    ['stopless-orchestration-action-native-wrapper', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planStoplessOrchestrationActionWithNative'],
    ['stopless-orchestration-action-thin-shell', `${SERVERTOOL_TS_DIR}/engine.ts`, servertoolEngine, 'planStoplessOrchestrationActionWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const keyword of [
    "flowId === 'stop_message_flow'",
    'flowId !== \'stop_message_flow\'',
    'function isStopMessageTerminalFinal',
    'stopMessageTerminalFinal === true',
  ]) {
    if (servertoolEngine.includes(keyword)) {
      fail(
        'stopless-orchestration-action-no-ts-owner',
        `Forbidden TS stopless orchestration semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/engine.ts`
      );
    }
  }
  pass('stopless-orchestration-action-rust-owner', 'servertool-core owns stopless CLI/terminal/followup action planning');
}

// ── Check 15e: stopless goal-state sync has Rust owner ────────
function checkStoplessGoalStateSyncRustOwner() {
  const rustGoalState = readRequired(RUST_SERVERTOOL_STOPLESS_GOAL_STATE);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const tsGoalState = readRequired(STOPLESS_GOAL_STATE_HANDLER);

  for (const [check, file, content, needle] of [
    ['stopless-goal-state-sync-rust-owner', RUST_SERVERTOOL_STOPLESS_GOAL_STATE, rustGoalState, 'pub fn plan_stopless_goal_state_sync'],
    ['stopless-goal-state-sync-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_stopless_goal_state_sync_json'],
    ['stopless-goal-state-sync-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_stopless_goal_state_sync_json'],
    ['stopless-goal-state-sync-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planStoplessGoalStateSyncJson'],
    ['stopless-goal-state-sync-native-wrapper', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planStoplessGoalStateSyncWithNative'],
    ['stopless-goal-state-sync-thin-shell', STOPLESS_GOAL_STATE_HANDLER, tsGoalState, 'planStoplessGoalStateSyncWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const keyword of [
    'parseRccFenceDocumentWithNative',
    'applyStoplessGoalDirectiveWithNative',
    'consumeStoplessDirectivesFromText',
    'compactRewrittenText',
    'directive.domain',
    'directive.passthrough',
    'directive.directiveType',
    'directive.body',
    'block.startOffset',
    'block.endOffset',
    'RccDirective',
    'RccFenceDocument',
  ]) {
    if (tsGoalState.includes(keyword)) {
      fail(
        'stopless-goal-state-sync-no-ts-owner',
        `Forbidden TS stopless goal-state semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.ts`
      );
    }
  }
  pass('stopless-goal-state-sync-rust-owner', 'servertool-core owns stopless goal directive sync and rewrite planning');
}

// ── Check 15f: stop blocked-report parser has Rust owner ──────
function checkStopMessageBlockedReportRustOwner() {
  const rustBlockedReport = readRequired(RUST_SERVERTOOL_BLOCKED_REPORT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const tsBlockedReport = readRequired(STOP_MESSAGE_BLOCKED_REPORT);

  assertContains(
    'stop-message-blocked-report-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod blocked_report_contract'
  );
  for (const needle of [
    'pub fn extract_blocked_report_from_messages',
    'pub fn extract_captured_message_text',
    'pub fn extract_text_from_message_content',
    'StopMessageBlockedReport',
    'fn extracts_uppercase_json_code_block_language',
  ]) {
    assertContains(
      'stop-message-blocked-report-rust-owner',
      RUST_SERVERTOOL_BLOCKED_REPORT,
      rustBlockedReport,
      needle
    );
  }
  if (!tsBlockedReport.includes('extractBlockedReportFromMessages')) {
    fail(
      'stop-message-blocked-report-no-ts-owner',
      'blocked-report.ts must either stay as a callable native thin wrapper or be physically deleted after native wiring'
    );
  }
  if (!tsBlockedReport.includes('extractStopMessageBlockedReportFromMessagesWithNative')) {
    fail(
      'stop-message-blocked-report-native-bridge',
      'blocked-report.ts must delegate blocked-report parsing to native Rust'
    );
  }
  for (const keyword of [
    'function extractUnknownText',
    'function extractBlockedReportFromText',
    'function normalizeBlockedReport',
    'function extractJsonCodeBlocks',
    'function extractBalancedJsonObjectStrings',
  ]) {
    if (tsBlockedReport.includes(keyword)) {
      fail(
        'stop-message-blocked-report-no-ts-owner',
        `TS blocked-report semantic must not remain after native wiring: ${keyword}`
      );
    }
  }
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  assertContains(
    'stop-message-blocked-report-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'extractStopMessageBlockedReportFromMessagesWithNative'
  );
  pass(
    'stop-message-blocked-report-rust-owner',
    'servertool-core owns blocked-report parser contract; TS is native thin wrapper only'
  );
}

// ── Check 15g: stopless learned-note write plan has Rust owner ─
function checkStoplessLearnedNoteRustOwner() {
  const rustLearnedNote = readRequired(RUST_SERVERTOOL_STOPLESS_LEARNED_NOTE);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const stopMessageAuto = readRequired(STOP_MESSAGE_AUTO_HANDLER);

  assertContains(
    'stopless-learned-note-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod stopless_learned_note_contract'
  );
  for (const needle of [
    'pub struct StoplessLearnedNotePlanInput',
    'pub struct StoplessLearnedNoteWritePlan',
    'pub fn plan_stopless_learned_note_write',
    'pub fn resolve_working_directory_from_adapter_context',
    'fn skips_write_when_schema_report_is_missing',
    'fn skips_write_when_learned_is_not_a_string',
    'fn rejects_negative_or_non_finite_timestamp_values_to_zero',
    'fn resolves_working_directory_by_explicit_field_order',
  ]) {
    assertContains(
      'stopless-learned-note-rust-owner',
      RUST_SERVERTOOL_STOPLESS_LEARNED_NOTE,
      rustLearnedNote,
      needle
    );
  }
  for (const keyword of [
    'function readNonEmptyString',
    'function persistStoplessLearnedNoteOnAllowStop',
  ]) {
    if (stopMessageAuto.includes(keyword)) {
      fail(
        'stopless-learned-note-no-ts-owner',
        `${STOP_MESSAGE_AUTO_HANDLER} must not retain TS learned-note semantic: ${keyword}`
      );
    }
  }
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  assertContains(
    'stopless-learned-note-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'planStoplessLearnedNoteWriteWithNative'
  );
  assertContains(
    'stopless-learned-note-native-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planStoplessLearnedNoteWriteJson'
  );
  pass(
    'stopless-learned-note-rust-owner',
    'servertool-core owns stopless learned-note write planning; TS only executes note IO'
  );
}

// ── Check 16: servertool CLI result guard has Rust owner ──────
function checkServertoolCliResultGuardRustOwner() {
  const rustCliResultGuard = readRequired(RUST_SERVERTOOL_CLI_RESULT_GUARD);
  const nativeServertoolWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);

  for (const file of DELETED_CLI_RESULT_GUARD_TS_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-result-guard-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; servertool-core owns CLI result guard scanning`
      );
    }
  }

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

  for (const keyword of [
    'ROUTECODEX_STOP_MESSAGE_AUTO_CLI',
    'MAX_SCAN_DEPTH',
    'MAX_SCAN_NODES',
    'collectScanRoots',
    'scanValue',
    'isToolResultLike',
    'readResultText',
    'parseJsonObjectFromText',
  ]) {
    for (const file of listFiles(SERVERTOOL_TS_DIR)) {
      if (file.includes('/native/')) continue;
      if (file.endsWith('/cli-projection.ts')) continue;
      const content = readFileSync(file, 'utf8');
      if (!content.includes(keyword)) continue;
      fail(
        'servertool-cli-result-guard-no-ts-owner',
        `Forbidden TS CLI result guard semantic "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  pass('servertool-cli-result-guard-rust-owner', 'servertool-core owns CLI result guard scanning; deleted TS shell stays absent');
}

// ── Check 17: deleted empty_reply_continue path stays absent ───
function checkDeletedEmptyReplyContinueAbsent() {
  for (const file of DELETED_EMPTY_REPLY_CONTINUE_FILES) {
    if (existsSync(file)) {
      fail(
        'deleted-empty-reply-continue-absent',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; empty-reply auto-continue previously rebuilt followup payloads and could drop multimodal content`
      );
    }
  }
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const skeletonConfig = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  const serverSideTools = readRequired(TS_SERVER_SIDE_TOOLS);

  for (const [file, content] of [
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib],
    [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks],
    [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
    [NATIVE_REQUIRED_EXPORTS, requiredExports],
    [`${RUST_SRC_DIR}/servertool_skeleton_config.rs`, skeletonConfig],
    [TS_SERVER_SIDE_TOOLS, serverSideTools],
  ]) {
    for (const keyword of [
      'empty_reply_continue',
      'empty-reply-continue',
      'EmptyReply',
      'planEmptyReply',
      'plan_empty_reply',
      'empty_reply_continue_contract',
    ]) {
      if (content.includes(keyword)) {
        fail(
          'deleted-empty-reply-continue-absent',
          `${file.replace(`${ROOT}/`, '')} must not contain deleted empty-reply continue semantic "${keyword}"`
        );
      }
    }
  }
  for (const script of [
    `${ROOT}/scripts/tests/ci-jest.mjs`,
    `${ROOT}/sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs`,
  ]) {
    const content = readRequired(script);
    if (content.includes('gemini-empty-reply-continue') || content.includes('servertool-empty-responses-continue')) {
      fail(
        'deleted-empty-reply-continue-absent',
        `${script.replace(`${ROOT}/`, '')} must not schedule deleted empty-reply continue tests`
      );
    }
  }
  pass('deleted-empty-reply-continue-absent', 'deleted empty-reply continue path is absent from servertool runtime gates');
}

// ── Check 18: deleted AI followup path stays absent ───────────
function checkDeletedAiFollowupAbsent() {
  for (const file of DELETED_AI_FOLLOWUP_FILES) {
    if (existsSync(file)) {
      fail(
        'deleted-ai-followup-absent',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; stopless now uses Rust-owned CLI projection, not AI followup`
      );
    }
  }

  const activeRuntimeFiles = ACTIVE_RUNTIME_SCAN_PATHS.flatMap((dir) => listFiles(dir));
  for (const file of activeRuntimeFiles) {
    const content = readFileSync(file, 'utf8');
    for (const keyword of [
      'ai-followup',
      'aiFollowup',
      'AiFollowup',
      'STOPMESSAGE_AI_FOLLOWUP',
      'STOPMESSAGE_AUTOMESSAGE',
      'renderStopMessageAutoFollowupViaAi',
      'buildStopMessageAutoMessagePrompt',
    ]) {
      if (content.includes(keyword)) {
        fail(
          'deleted-ai-followup-absent',
          `Forbidden AI followup runtime semantic "${keyword}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }

  const stopMessageConfig = readRequired(`${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/config.ts`);
  const stopMessageSpecPath = `${ROOT}/tests/servertool/stop-message-auto.spec.ts`;
  const stopMessageSpec = existsSync(stopMessageSpecPath)
    ? readFileSync(stopMessageSpecPath, 'utf8')
    : '';
  for (const keyword of [
    'aiFollowup',
    'StopMessageAi',
    'resolveStopMessageAi',
    'STOPMESSAGE_AI_FOLLOWUP',
    'STOPMESSAGE_AUTOMESSAGE',
  ]) {
    if (stopMessageConfig.includes(keyword) || stopMessageSpec.includes(keyword)) {
      fail(
        'deleted-ai-followup-absent',
        `Forbidden AI followup config/test residue "${keyword}" found`
      );
    }
  }

  pass('deleted-ai-followup-absent', 'AI followup files, runtime branch, config schema, and focused tests are absent');
}

// ── Run ────────────────────────────────────────────────────────
console.log('\n=== verify-servertool-rust-only ===\n');

checkNoBakFiles();
checkNoTSHandlerRuntimeImport();
checkNoDuplicateSemantics();
checkServertoolCliProjectionMap();
checkServertoolRustificationVerificationRegistry();
checkBuildIncludesServertoolGate();
checkNoOldCliRestorationRuntime();
checkMigratedProjectionDoesNotReenter();
checkApplyPatchNotCliProjected();
checkStandaloneServertoolBinary();
checkStoplessNoReenterContract();
checkLegacyReviewToolDeleted();
checkStopMessagePersistedLookupRustOwner();
checkStopMessageLoopGuardRustOwner();
checkStopGatewayContextRustOwner();
checkStopMessageCompareContextRustOwner();
checkOrchestrationPolicyRustOwner();
checkStopMessageCounterRustOwner();
checkFollowupMainlineNativeBridgeRustOwner();
checkServertoolSkeletonConfigRustOwner();
checkPendingSessionRustOwner();
checkPreCommandHooksRustOwner();
checkEngineSelectionRustOwner();
checkServertoolFlowPresentationRustOwner();
checkBackendRoutePolicyRustOwner();
checkServertoolTextExtractionRustOwner();
checkStopVisibleTextRustOwner();
checkStopMessageCliProjectionSeedRustOwner();
checkStoplessOrchestrationActionRustOwner();
checkStoplessGoalStateSyncRustOwner();
checkStopMessageBlockedReportRustOwner();
checkStoplessLearnedNoteRustOwner();
checkServertoolCliResultGuardRustOwner();
checkDeletedEmptyReplyContinueAbsent();
checkDeletedAiFollowupAbsent();

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

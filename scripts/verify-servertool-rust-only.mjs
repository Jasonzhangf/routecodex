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
const RUST_ROUTER_HOTPATH_NAPI_PROXY = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/napi_proxy.rs`;
const RUST_SERVERTOOL_CORE_LOOKUP = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`;
const RUST_SERVERTOOL_CORE_BLOCKS = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`;
const RUST_SERVERTOOL_STOP_GATEWAY = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_gateway_context.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_COMPARE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_compare_context.rs`;
const RUST_SERVERTOOL_COUNTER = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_counter.rs`;
const RUST_SERVERTOOL_LOOP_STATE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/loop_state_contract.rs`;
const RUST_SERVERTOOL_ORCHESTRATION_POLICY = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/orchestration_policy_contract.rs`;
const RUST_SERVERTOOL_PENDING_SESSION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs`;
const RUST_SERVERTOOL_PRE_COMMAND = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs`;
const RUST_SERVERTOOL_ENGINE_SELECTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_selection_contract.rs`;
const RUST_SERVERTOOL_TEXT_EXTRACTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/text_extraction.rs`;
const RUST_SERVERTOOL_STOP_VISIBLE_TEXT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_visible_text.rs`;
const RUST_SERVERTOOL_STOPLESS_DECISION_CONTEXT_SIGNALS = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_AUTO_HANDLER = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_auto_handler.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_DEFAULT_CONFIG = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_default_config.rs`;
const RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_persist_plan.rs`;
const RUST_SERVERTOOL_STOPLESS_ORCHESTRATION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`;
const RUST_SERVERTOOL_STOPLESS_LEARNED_NOTE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_learned_note_contract.rs`;
const RUST_SERVERTOOL_CLI_RESULT_GUARD = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_result_guard.rs`;
const RUST_SERVERTOOL_BLOCKED_REPORT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/blocked_report_contract.rs`;
const RUST_SERVERTOOL_HOOK_SKELETON = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs`;
const RUST_SERVERTOOL_AUTO_HOOK_EXECUTION = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_execution_contract.rs`;
const RUST_SERVERTOOL_AUTO_HOOK_RUNTIME = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_runtime_contract.rs`;
const RUST_SERVERTOOL_REGISTRY_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_HANDLER_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`;
const RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs`;
const RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs`;
const RUST_SERVERTOOL_ENGINE_PREPASS_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_prepass_action_contract.rs`;
const RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs`;
const RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_LOOP_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs`;
const RUST_SERVERTOOL_STOPLESS_CLI_PROJECTION_CONTEXT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`;
const TS_SERVER_SIDE_TOOLS = `${SERVERTOOL_TS_DIR}/server-side-tools.ts`;
const TS_PENDING_INJECTION = `${SERVERTOOL_TS_DIR}/pending-injection-block.ts`;
const TS_PRE_COMMAND_HOOKS = `${SERVERTOOL_TS_DIR}/pre-command-hooks.ts`;
const TS_PENDING_SESSION = `${SERVERTOOL_TS_DIR}/pending-session.ts`;
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
const TS_BACKEND_ROUTE_SHADOW = `${SERVERTOOL_TS_DIR}/backend-route-shadow.ts`;
const TS_VISION_ELIGIBILITY = `${SERVERTOOL_TS_DIR}/handlers/vision-eligibility.ts`;
const TS_STOP_GATEWAY_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-gateway-context.ts`;
const TS_STOP_MESSAGE_COMPARE_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-message-compare-context.ts`;
const TS_METADATA_CENTER_CARRIER = `${SERVERTOOL_TS_DIR}/metadata-center-carrier.ts`;
const TS_STOP_MESSAGE_COUNTER = `${SERVERTOOL_TS_DIR}/stop-message-counter.ts`;
const TS_ORCHESTRATION_POLICY = `${SERVERTOOL_TS_DIR}/orchestration-policy-block.ts`;
const TS_TIMEOUT_ERROR_BLOCK = `${SERVERTOOL_TS_DIR}/timeout-error-block.ts`;
const TS_EXECUTION_SHELL = `${SERVERTOOL_TS_DIR}/execution-shell.ts`;
const TS_EXECUTION_BRANCH_RUNTIME_SHELL = `${SERVERTOOL_TS_DIR}/execution-branch-runtime-shell.ts`;
const TS_RESPONSE_STAGE_FINALIZE_SHELL = `${SERVERTOOL_TS_DIR}/response-stage-finalize-shell.ts`;
const TS_RESPONSE_STAGE_PREPASS_SHELL = `${SERVERTOOL_TS_DIR}/response-stage-prepass-shell.ts`;
const TS_EXECUTION_QUEUE_SHELL = `${SERVERTOOL_TS_DIR}/execution-queue-shell.ts`;
const TS_EXECUTION_STAGE_SHELL = `${SERVERTOOL_TS_DIR}/execution-stage-shell.ts`;
const TS_EXTRACT_TOOL_CALLS_SHELL = `${SERVERTOOL_TS_DIR}/extract-tool-calls-shell.ts`;
const TS_DISPATCH_PREPARATION_SHELL = `${SERVERTOOL_TS_DIR}/dispatch-preparation-shell.ts`;
const TS_ENGINE_PREFLIGHT_SHELL = `${SERVERTOOL_TS_DIR}/engine-preflight-shell.ts`;
const TS_ENGINE_ORCHESTRATION_SHELL = `${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`;
const TS_ENGINE_OBSERVATION_SHELL = `${SERVERTOOL_TS_DIR}/engine-observation-shell.ts`;
const TS_ENTRY_PREFLIGHT_SHELL = `${SERVERTOOL_TS_DIR}/entry-preflight-shell.ts`;
const TS_ENTRY_CONTEXT_SHELL = `${SERVERTOOL_TS_DIR}/entry-context-shell.ts`;
const TS_SERVERTOOL_TYPES = `${SERVERTOOL_TS_DIR}/types.ts`;
const TS_REGISTRY_ORCHESTRATION_SHELL = `${SERVERTOOL_TS_DIR}/registry-orchestration-shell.ts`;
const TS_RUN_SERVER_SIDE_TOOL_ENGINE_SHELL = `${SERVERTOOL_TS_DIR}/run-server-side-tool-engine-shell.ts`;
const NATIVE_FOLLOWUP_MAINLINE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-followup-mainline-semantics.ts`;
const STOP_MESSAGE_AUTO_HANDLER = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto.ts`;
const STOP_MESSAGE_AUTO_CONFIG = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/config.ts`;
const STOP_MESSAGE_RUNTIME_UTILS = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/runtime-utils.ts`;
const STOP_MESSAGE_ROUTING_STATE = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/routing-state.ts`;
const STOP_MESSAGE_BLOCKED_REPORT = `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/blocked-report.ts`;
const SERVERTOOL_STATE_SCOPE = `${SERVERTOOL_TS_DIR}/state-scope.ts`;
const NATIVE_SERVERTOOL_CORE_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`;
const NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`;
const NATIVE_REQUIRED_EXPORTS = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`;
const NATIVE_STOP_MESSAGE_AUTO = `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`;
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
const DELETED_SERVERTOOL_DISPATCH_FACADE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts`,
];
const DELETED_SERVERTOOL_CLI_PROJECTION_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts`,
  `${ROOT}/tests/servertool/servertool-cli-projection.spec.ts`,
  `${ROOT}/tests/servertool/cli-projection-runtime-shell.spec.ts`,
];
const DELETED_SERVERTOOL_ROOT_FACADE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts`,
];
const DELETED_SERVERTOOL_REGISTRY_FACADE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry-impl.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry-types.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.ts`,
];
const DELETED_BACKEND_ROUTE_POLICY_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/backend_route_contract.rs`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/vision-eligibility.ts`,
  `${ROOT}/tests/servertool/servertool-snapshot-recording.spec.ts`,
];
const DELETED_STOPLESS_TRANSPARENT_FILES = [
  `${ROOT}/tests/servertool/stopless-sessionid-transparent.spec.ts`,
  `${ROOT}/docs/goals/stopless-sessionid-transparent-plan.md`,
  `${ROOT}/docs/goals/stopless-sessionid-transparent-goal-prompt.md`,
];
const DELETED_AI_FOLLOWUP_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup-pure-blocks.ts`,
  `${ROOT}/tests/servertool/stopmessage-response-snapshot.spec.ts`,
  `${ROOT}/tests/servertool/stop-message-auto-followup-extraction.spec.ts`,
];
const DELETED_SERVERTOOL_DATA_CONTEXT_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/memory/cache-writer.ts`,
  `${ROOT}/tests/servertool/cache-writer.spec.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/origin-request-store.ts`,
  `${ROOT}/tests/servertool/origin-request-store.spec.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/handlers/followup-sanitize.ts`,
];
const DELETED_SERVERTOOL_LOOP_SCOPE_TS_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/loop-state-block.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/state-scope.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/stop-message-loop-guard-block.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/stop-message-loop-payload-block.ts`,
  `${ROOT}/tests/servertool/loop-state-block.spec.ts`,
  `${ROOT}/tests/servertool/state-scope.metadata-center.spec.ts`,
];
const DELETED_STOP_CONTEXT_WRAPPER_TS_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/stop-gateway-context.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/stop-message-compare-context.ts`,
];
const SERVERTOOL_RUSTIFICATION_REQUIRED_VERIFICATION = Object.freeze({
  'hub.servertool_cli_projection': [
    'tests/cli/servertool-command.spec.ts',
    'tests/servertool/execution-stage-shell.spec.ts',
    'tests/servertool/servertool-cli-native-bridge.spec.ts',
    'tests/servertool/servertool-cli-result-restore.spec.ts',
    'tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts',
    'tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts',
  ],
  'hub.servertool_rust_only_closeout': [
    'tests/servertool/server-side-tools.dispatch-native.spec.ts',
    'tests/servertool/server-side-tools.auto-hook-config.spec.ts',
    'tests/servertool/servertool-auto-hook-trace.spec.ts',
  ],
});

const STOPLESS_SESSION_LOCK_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
  `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
];

const SERVERTOOL_ACTIVE_ORCHESTRATION_AUDIT = `${ROOT}/tests/servertool/servertool-active-orchestration-audit.spec.ts`;
const SERVERTOOL_ACTIVE_ORCHESTRATION_OWNER_FILES = [
  `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
  `${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`,
];
const SERVERTOOL_DISPATCH_OUTCOME_FORBIDDEN_MARKERS = [
  'args.appendToolOutput(',
  'JSON.stringify({',
  'retryable: true',
  'args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId ===',
  'args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId ===',
  'Array.isArray((args.baseForExecution as any).tool_outputs)',
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

function assertMissing(check, file, content, needle) {
  if (content.includes(needle)) {
    fail(check, `${file} must not contain "${needle}"`);
    return;
  }
  pass(check, `${file.replace(`${ROOT}/`, '')} does not contain "${needle}"`);
}

function assertMissingFile(check, file, detail) {
  if (existsSync(file)) {
    fail(check, detail);
    return;
  }
  pass(check, `${file.replace(`${ROOT}/`, '')} is physically absent`);
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

function assertStoplessSessionIdLock() {
  for (const file of DELETED_SERVERTOOL_CLI_PROJECTION_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-projection-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; Rust/native projection owns this surface`
      );
    }
  }
  const orchestration = readRequired(CHAT_SERVERTOOL_ORCHESTRATION);
  if (orchestration.includes('_raw_followup_text_ignored')) {
    fail(
      'stopless-schema-feedback-lock',
      `${CHAT_SERVERTOOL_ORCHESTRATION} must not discard schema followup text before the next-turn prompt`
    );
  }

  const rustCliContract = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
  );
  if (rustCliContract.includes('ServertoolCliError::MissingField("sessionId")')) {
    fail(
      'stopless-session-lock',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs must not require sessionId for stopless CLI`
    );
  }
  assertContains(
    'stopless-session-lock',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`,
    rustCliContract,
    'session_id: Option<String>'
  );

  const stoplessSpec = readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`);
  assertContains(
    'stopless-session-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    stoplessSpec,
    "expect(maybeExtractExecCommand(result.chat)).toBeUndefined();"
  );
  assertContains(
    'stopless-session-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    stoplessSpec,
    "expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop')"
  );

  const cliSpec = readRequired(`${ROOT}/tests/cli/servertool-command.spec.ts`);
  assertContains(
    'stopless-session-lock',
    `${ROOT}/tests/cli/servertool-command.spec.ts`,
    cliSpec,
    'expect(payload.sessionId).toBe(sessionId)'
  );
  assertContains(
    'stopless-session-lock',
    `${ROOT}/tests/cli/servertool-command.spec.ts`,
    cliSpec,
    'expect(payload.requestId).toBe(requestId)'
  );
  for (const file of STOPLESS_SESSION_LOCK_FILES) {
    const content = readRequired(file);
    for (const forbidden of [
      'resolve_stopless_default_session_id',
      'resolve_stopless_default_request_id',
      'CODEX_THREAD_ID',
      'TMUX_PANE',
      'TERM_SESSION_ID',
      'ITERM_SESSION_ID',
      'stop_message_auto auto flow requires sessionId on adapterContext',
    ]) {
      if (content.includes(forbidden)) {
        fail('stopless-session-lock', `${file} must not revive fallback token ${forbidden}`);
      }
    }
  }
}

function assertStoplessSchemaFeedbackLock() {
  const stopMessageHandler = readRequired(RUST_SERVERTOOL_STOP_MESSAGE_AUTO_HANDLER);
  const persistPlan = readRequired(RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN);
  assertContains(
    'stopless-schema-feedback-lock',
    RUST_SERVERTOOL_STOP_MESSAGE_AUTO_HANDLER,
    stopMessageHandler,
    'if let Some(ref ft) = schema_gate.followup_text'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    RUST_SERVERTOOL_STOP_MESSAGE_AUTO_HANDLER,
    stopMessageHandler,
    'effective_decision.followup_text = Some(ft.clone());'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN,
    persistPlan,
    'let prefer_schema_followup_text = matches!'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN,
    persistPlan,
    'invalid_schema_prefers_detailed_followup_text_for_snapshot'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/cli/servertool-command.spec.ts`,
    readRequired(`${ROOT}/tests/cli/servertool-command.spec.ts`),
    "missingFields: ['stopreason', 'reason', 'next_step']"
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/cli/servertool-command.spec.ts`,
    readRequired(`${ROOT}/tests/cli/servertool-command.spec.ts`),
    'expect(payload.schemaGuidance).toBeUndefined();'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`),
    "expect(message?.content).toContain('need more evidence')"
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`),
    'expect(message?.reasoning_text).toBeUndefined();'
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`),
    "expect(cliStdout.routeHint).toBe('thinking')"
  );
  assertContains(
    'stopless-schema-feedback-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`),
    "expect(JSON.stringify(result.chat)).not.toContain('routecodex hook run reasoningStop')"
  );

  const loopStateContract = readRequired(RUST_SERVERTOOL_LOOP_STATE);
  assertContains(
    'stopless-repeat-reset-lock',
    RUST_SERVERTOOL_LOOP_STATE,
    loopStateContract,
    'fn plan_increments_repeat_count_for_same_flow_and_payload()'
  );
  assertContains(
    'stopless-repeat-reset-lock',
    RUST_SERVERTOOL_LOOP_STATE,
    loopStateContract,
    'fn plan_resets_repeat_count_for_changed_payload()'
  );
  assertContains(
    'stopless-repeat-reset-lock',
    `${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`,
    readRequired(`${ROOT}/tests/servertool/stopless-cli-continuation.spec.ts`),
    'repeatCount: 2'
  );
}

function assertRuntimeMetadataSessionDirLock() {
  const proxy = readRequired(RUST_ROUTER_HOTPATH_NAPI_PROXY);
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'resolve_runtime_path_overrides(metadata: &Value)'
  );
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'read_runtime_string(metadata, &["rccUserDir", "rcc_user_dir"])'
  );
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'read_runtime_string(metadata, &["sessionDir", "session_dir"])'
  );
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'metadata.get("metadataCenterSnapshot")'
  );
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'snapshot_runtime_control'
  );
  assertContains(
    'runtime-metadata-session-dir-lock',
    RUST_ROUTER_HOTPATH_NAPI_PROXY,
    proxy,
    'snapshot.get("runtimeControl")'
  );
  const runtimeSource = proxy.split('#[cfg(test)]')[0];
  for (const forbidden of [
    'metadata.get("sessionDir")',
    'metadata.get("rccUserDir")',
    'metadata.get("session_dir")',
    'metadata.get("rcc_user_dir")',
  ]) {
    if (runtimeSource.includes(forbidden)) {
      fail(
        'runtime-metadata-session-dir-lock',
        `${RUST_ROUTER_HOTPATH_NAPI_PROXY.replace(`${ROOT}/`, '')} runtime source must not read top-level metadata fallback token ${forbidden}`
      );
    }
  }
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
  const executionStageShell = readRequired(TS_EXECUTION_STAGE_SHELL);
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
    'routecodex hook run {} --input-json {}'
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
    'pub fn build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03',
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
    'fn web_search_is_client_exec_cli_projection',
    'fn vision_auto_is_client_exec_cli_projection',
    'fn builds_web_search_client_exec_projection_plan',
    'fn builds_vision_auto_client_exec_projection_plan',
    'fn memory_cache_auto_is_not_a_servertool_outcome',
    'fn memory_cache_auto_is_rejected_by_client_projection_builder',
    'fn memory_cache_auto_is_rejected_by_server_io_builder',
    'fn unknown_tool_returns_none',
    'fn unknown_tool_is_rejected_by_projection_builder',
    'fn fake_exec_is_denied_by_projection_builder',
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
  const nativeRequiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const nativeStopMessageWrapper = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`
  );
  assertContains(
    'stop-schema-native-export',
    NATIVE_REQUIRED_EXPORTS,
    nativeRequiredExports,
    'evaluateStopSchemaGateJson'
  );
  assertContains(
    'stop-schema-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    '#[napi(js_name = "evaluateStopSchemaGateJson")]'
  );
  assertContains(
    'stop-schema-native-wrapper',
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`,
    nativeStopMessageWrapper,
    "const capability = 'evaluateStopSchemaGateJson'"
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
    ['cli-projection-runtime-branch-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'build_servertool_cli_projection_runtime_branch_json'],
    ['cli-projection-runtime-branch-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn build_servertool_cli_projection_runtime_branch_json'],
    ['cli-projection-runtime-branch-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'buildServertoolCliProjectionRuntimeBranchJson'],
    ['cli-projection-runtime-branch-native-wrapper', `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`, nativeServertoolWrapper, 'buildServertoolCliProjectionRuntimeBranchWithNative'],
    ['cli-projection-execution-context-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, 'pub fn build_servertool_cli_projection_execution_context'],
    ['cli-projection-execution-context-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'build_servertool_cli_projection_execution_context_json'],
    ['cli-projection-execution-context-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn build_servertool_cli_projection_execution_context_json'],
    ['cli-projection-execution-context-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'buildServertoolCliProjectionExecutionContextJson'],
    ['cli-projection-execution-context-native-wrapper', `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`, nativeServertoolWrapper, 'buildServertoolCliProjectionExecutionContextWithNative'],
    ['cli-projection-route-hint-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, 'fn route_hint_for_client_exec_tool(tool_name: &str) -> Option<&\'static str>'],
    ['cli-projection-route-hint-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, '"web_search" => Some("web_search")'],
    ['cli-projection-route-hint-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCliContract, '"vision_auto" => Some("multimodal")'],
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
  const rustPolicy = readRequired(RUST_SERVERTOOL_ORCHESTRATION_POLICY);
  for (const [check, file, content, needle] of [
    ['servertool-state-load-error-rust-owner', RUST_SERVERTOOL_ORCHESTRATION_POLICY, rustPolicy, 'pub fn plan_servertool_state_load_failed_error'],
    ['servertool-required-response-hook-empty-rust-owner', RUST_SERVERTOOL_ORCHESTRATION_POLICY, rustPolicy, 'pub fn plan_servertool_required_response_hook_empty_error'],
    ['servertool-state-load-error-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_state_load_failed_error_json'],
    ['servertool-required-response-hook-empty-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_required_response_hook_empty_error_json'],
    ['servertool-state-load-error-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_state_load_failed_error_json'],
    ['servertool-required-response-hook-empty-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_required_response_hook_empty_error_json'],
    ['servertool-state-load-error-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolStateLoadFailedErrorJson'],
    ['servertool-required-response-hook-empty-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolRequiredResponseHookEmptyErrorJson'],
    ['servertool-state-load-error-native-wrapper', `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`, nativeServertoolWrapper, 'planServertoolStateLoadFailedErrorWithNative'],
    ['servertool-required-response-hook-empty-native-wrapper', `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`, nativeServertoolWrapper, 'planServertoolRequiredResponseHookEmptyErrorWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }
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
  for (const file of DELETED_SERVERTOOL_CLI_PROJECTION_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-projection-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; cli projection planning is Rust/native-owned`
      );
    }
  }
  assertContains(
    'cli-projection-runtime-native-owner',
    TS_EXECUTION_STAGE_SHELL,
    executionStageShell,
    'buildServertoolCliProjectionRuntimeBranchWithNative'
  );
  if (executionStageShell.includes("from './cli-projection-runtime-shell.js'")) {
    fail('cli-projection-runtime-native-owner', 'execution-stage-shell.ts must not import deleted cli-projection-runtime-shell');
  }
  if (executionStageShell.includes('buildServertoolCliProjectionBranchResult')) {
    fail('cli-projection-runtime-native-owner', 'execution-stage-shell.ts must not call deleted TS cli projection branch result helper');
  }
  if (executionStageShell.includes("name: 'exec_command'") || executionStageShell.includes('"name": "exec_command"')) {
    fail('cli-projection-command-contract', 'execution-stage-shell.ts must not build exec_command tool call shape in TS');
  }
  if (executionStageShell.includes('routecodex servertool run')) {
    fail('cli-projection-command-contract', 'execution-stage-shell.ts must not build servertool CLI command strings in TS');
  }
  for (const keyword of [
    "args.flowId === 'stop_message_flow'",
    'const toolName = args.flowId',
    'typeof args.input?.repeatCount',
    'typeof args.input?.maxRepeats',
    'const repeatCount =',
    'const maxRepeats =',
    'function parseToolArguments(',
    'JSON.parse(value)',
    'randomUUID',
    'buildClientExecCliProjectionOutputWithNative',
    'parseServertoolCliProjectionToolArgumentsWithNative',
    'buildClientVisibleProjectionShellWithNative',
    'buildServertoolCliProjectionExecutionContextWithNative',
    'servertool_cli_projection',
    'reasoningText',
    '继续执行本地 hook',
  ]) {
    if (executionStageShell.includes(keyword)) {
      fail(
        'cli-projection-output-no-ts-owner',
        `Forbidden TS client exec projection semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts`
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

function checkLegacyStopMessageRuntimeMirrorsRemoved() {
  const forbidden = [
    'serverToolLoopState',
    'stopMessageState',
    'stopMessageUsed',
    'stopMessageText',
    'stopMessageMaxRepeats',
    'stopMessageStageMode',
  ];
  const cleanupAllowlist = new Set([
    `${ROOT}/src/server/runtime/http-server/executor/servertool-followup-metadata.ts`,
  ]);
  const metadataCenterServerToolLoopStateAllowlist = new Set([
    `${ROOT}/src/server/runtime/http-server/metadata-center/metadata-center-types.ts`,
    `${ROOT}/src/server/runtime/http-server/metadata-center/metadata-center.ts`,
  ]);
  const files = listFiles(`${ROOT}/src/server/runtime/http-server`);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = file.replace(`${ROOT}/`, '');
    for (const keyword of forbidden) {
      if (!content.includes(keyword)) {
        continue;
      }
      if (cleanupAllowlist.has(file) && keyword === 'serverToolLoopState') {
        const badLine = content
          .split('\n')
          .find((line) => line.includes(keyword) && !line.trim().match(/^'serverToolLoopState',$/));
        if (!badLine) {
          continue;
        }
      }
      if (metadataCenterServerToolLoopStateAllowlist.has(file) && keyword === 'serverToolLoopState') {
        continue;
      }
      fail(
        'legacy-stopmessage-runtime-mirror-removed',
        `Forbidden legacy stopmessage runtime mirror "${keyword}" found in ${rel}`
      );
    }
  }
  pass('legacy-stopmessage-runtime-mirror-removed', `scanned ${files.length} http runtime files`);
}

// ── Check 7: Migrated CLI paths must not reenter provider flow ──
function checkMigratedProjectionDoesNotReenter() {
  for (const file of DELETED_SERVERTOOL_CLI_PROJECTION_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-projection-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted`
      );
    }
  }
  const executionStageShell = readRequired(TS_EXECUTION_STAGE_SHELL);
  for (const keyword of ['reenterPipeline', 'providerInvoker']) {
    if (executionStageShell.includes(keyword)) {
      fail(
        'cli-projection-no-reenter',
        `${TS_EXECUTION_STAGE_SHELL.replace(`${ROOT}/`, '')} must not reference ${keyword}`
      );
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
  if (existsSync(CLI_PROJECTION)) {
    fail('apply-patch-not-cli-projected', 'servertool/cli-projection.ts must stay physically deleted');
  }
  const executionStageShell = readRequired(TS_EXECUTION_STAGE_SHELL);
  if (executionStageShell.includes('apply_patch')) {
    fail('apply-patch-not-cli-projected', 'servertool execution-stage CLI projection must not special-case or map apply_patch');
  } else {
    pass('apply-patch-not-cli-projected', 'execution-stage CLI projection does not reference apply_patch');
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
    'fn missing_continuation_prompt_still_succeeds_status_only',
    'fn invalid_stop_message_flow_id_fails_fast',
    'fn exhausted_stop_message_repeat_budget_returns_terminal_summary',
    'fn exhausted_explicit_repeat_args_return_terminal_summary',
    'fn stop_message_auto_explicit_repeat_args_override_input_json',
    'fn explicit_flow_arg_overrides_input_json_flow_id',
    'fn non_object_input_json_fails_fast',
    'fn malformed_input_json_fails_fast',
    'assert!(value["input"].get("continuationPrompt").is_none());',
    'assert!(value["input"].get("schemaGuidance").is_none());',
    'assert!(value.get("schemaGuidance").is_none());',
    'SERVERTOOL_CLI_INVALID_FIELD: flowId',
    '停止检查已收敛',
    'SERVERTOOL_CLI_INVALID_FIELD: inputJson',
    'SERVERTOOL_CLI_INVALID_JSON:',
  ]) {
    assertContains('servertool-cli-input-contract-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, needle);
  }
  if (rustCliBlackbox.includes('stopless budget exhausted')) {
    fail(
      'servertool-cli-input-contract-blackbox',
      `${RUST_SERVERTOOL_CLI_BLACKBOX} must not assert internal stopless budget text in client-visible CLI output`
    );
  }
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn non_client_exec_servertools_fail_fast');
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fn unknown_tool_fails_fast_without_client_stdout');
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'fake_exec');
  assertContains('servertool-cli-non-client-exec-blackbox', RUST_SERVERTOOL_CLI_BLACKBOX, rustCliBlackbox, 'SERVERTOOL_UNSUPPORTED_TOOL: {tool_name}');
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

// ── Check 10: responsesRequestContext must not become request session truth ──
function checkResponsesRequestContextSessionIsolation() {
  const content = readRequired(STOP_MESSAGE_RUNTIME_UTILS);
  for (const snippet of [
    '?? readNonEmptyString(responsesRequestContext?.sessionId)',
    '?? readNonEmptyString(responsesRequestContext?.conversationId)'
  ]) {
    if (content.includes(snippet)) {
      fail(
        'responses-request-context-session-isolation',
        `stop-message runtime utils must not promote continuation context into request session truth: ${snippet}`
      );
      return;
    }
  }
  pass(
    'responses-request-context-session-isolation',
    'responsesRequestContext session/conversation are not promoted into stop-message request truth'
  );
}

// ── Check 11: stop_message_flow must not revive reenter path ───
function checkStoplessNoReenterContract() {
  const deletedSpec = `${ROOT}/tests/servertool/stopless-goal-reenter.spec.ts`;
  if (existsSync(deletedSpec)) {
    fail('stopless-no-reenter-contract', 'obsolete stopless-goal-reenter.spec.ts must stay physically deleted');
  } else {
    pass('stopless-no-reenter-contract', 'obsolete stopless reenter spec is absent');
  }
  for (const file of DELETED_STOPLESS_TRANSPARENT_FILES) {
    if (existsSync(file)) {
      fail(
        'stopless-no-reenter-contract',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; stopless transparent continuation contract was removed`
      );
    }
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

// ── Check 12: persisted lookup policy is Rust-owned ───────────
function checkStopMessagePersistedLookupRustOwner() {
  const rustLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP);
  const orchestration = readRequired(CHAT_SERVERTOOL_ORCHESTRATION);
  const runtimeUtils = readRequired(STOP_MESSAGE_RUNTIME_UTILS);
  const routingState = readRequired(STOP_MESSAGE_ROUTING_STATE);
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
    'pub fn resolve_runtime_stop_message_state_from_metadata_center',
    'pub fn read_runtime_stop_message_stage_mode',
    'pub fn normalize_stop_message_stage_mode_value',
    'pub fn has_armed_stop_message_state',
    'pub fn plan_stop_message_routing_snapshot',
    'pub fn plan_stop_message_persisted_state_selection',
    'pub fn plan_stop_message_routing_state_apply',
    'pub fn plan_stop_message_routing_state_clear',
    'pub fn resolve_bd_working_directory_for_record',
    'pub fn resolve_stop_message_followup_provider_key',
    'pub fn resolve_client_connection_state',
    'pub fn has_compaction_flag',
    'pub fn resolve_entry_endpoint',
    'pub fn resolve_stop_message_followup_tool_content_max_chars',
    'pub fn plan_persist_stop_message_state',
    'pub fn resolve_default_stop_message_snapshot',
    'pub fn resolve_implicit_gemini_stop_message_snapshot',
    'STOPLESS_FLOW_ID',
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
  const stopMessageCore = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`);
  const stopMessagePersistPlan = readRequired(RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN);
  const routingStateStore = readRequired(`${RUST_SRC_DIR}/virtual_router_engine/routing_state_store.rs`);
  for (const needle of [
    'provider_change_preserves_persisted_snapshot_budget_inside_same_term',
    'provider_match_preserves_persisted_snapshot_budget',
    'fn bind_snapshot_to_current_provider',
  ]) {
    assertContains(
      'stop-message-provider-continuity-rust-gate',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`,
      stopMessageCore,
      needle
    );
  }
  for (const needle of [
    'current_provider_key',
    'provider_key',
  ]) {
    assertContains(
      'stop-message-provider-continuity-persist-gate',
      RUST_SERVERTOOL_STOP_MESSAGE_PERSIST_PLAN,
      stopMessagePersistPlan,
      needle
    );
  }
  assertContains(
    'stop-message-provider-continuity-routing-state-gate',
    `${RUST_SRC_DIR}/virtual_router_engine/routing_state_store.rs`,
    routingStateStore,
    'stopMessageProviderKey'
  );
  for (const needle of [
    'resolveServertoolStateKeyWithNative',
    'resolveRuntimeStopMessageStateWithNative',
    'resolveRuntimeStopMessageStateFromMetadataCenterWithNative',
    'readRuntimeStopMessageStageModeWithNative',
    'normalizeStopMessageStageModeValueWithNative',
    'hasArmedStopMessageStateWithNative',
    'planStopMessageRoutingSnapshotWithNative',
    'planStopMessageRoutingStateApplyWithNative',
    'planStopMessageRoutingStateClearWithNative',
    'planStoplessDecisionContextSignalsWithNative',
    'planStopMessageDefaultConfigWithNative',
    'planStopMessagePersistSnapshotWithNative',
    'resolveBdWorkingDirectoryForRecordWithNative',
    'resolveStopMessageFollowupProviderKeyWithNative',
    'resolveClientConnectionStateWithNative',
    'hasCompactionFlagWithNative',
    'resolveEntryEndpointWithNative',
    'resolveStopMessageFollowupToolContentMaxCharsWithNative',
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
    '"resolveRuntimeStopMessageStateFromMetadataCenterJson"',
    '"readRuntimeStopMessageStageModeJson"',
    '"normalizeStopMessageStageModeValueJson"',
    '"hasArmedStopMessageStateJson"',
    '"planStopMessageRoutingSnapshotJson"',
    '"planStopMessageRoutingStateApplyJson"',
    '"planStopMessageRoutingStateClearJson"',
    '"planStoplessDecisionContextSignalsJson"',
    '"planStopMessageDefaultConfigJson"',
    '"planStopMessagePersistSnapshotJson"',
    '"resolveBdWorkingDirectoryForRecordJson"',
    '"resolveStopMessageFollowupProviderKeyJson"',
    '"resolveClientConnectionStateJson"',
    '"hasCompactionFlagJson"',
    '"resolveEntryEndpointJson"',
    '"resolveStopMessageFollowupToolContentMaxCharsJson"',
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
  for (const [file, content] of [
    [STOP_MESSAGE_RUNTIME_UTILS, runtimeUtils],
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
  if (!stopMessageAuto.includes('candidateKeys: []')) {
    fail(
      'stop-message-persisted-lookup-ts-consumes-native-plan',
      'stop-message-auto.ts must pass empty candidateKeys into the Rust-owned native handler call'
    );
  }
  if (stopMessageAuto.includes('runStopMessageAutoHandlerWithNative')) {
    fail(
      'stop-message-persisted-state-selection-ts-thin-shell',
      'stop-message-auto.ts must not restore the deleted stopless followup handler wrapper'
    );
  }
  if (!stopMessageAuto.includes('planStoplessDecisionContextSignals({')) {
    fail(
      'stopless-decision-context-signals-ts-thin-shell',
      'stop-message-auto.ts must consume Rust-owned stopless decision context signal plan'
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
    'function getCapturedRequest',
    'getCapturedRequestWithNative',
    'getCapturedRequestJson',
    'toolOutputsDetailed.length',
    'routecodexPortStopMessageEnabled',
    'collaboration mode: plan',
    'function resolveStopMessageDefaultEnabledLive',
    'function resolveStopMessageDefaultTextLive',
    'function resolveStopMessageDefaultMaxRepeatsLive',
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

  const metadataCenterRuntimeStateBlock = extractFunctionBlock(runtimeUtils, 'resolveRuntimeStopMessageStateFromMetadataCenter');
  if (!metadataCenterRuntimeStateBlock.includes('resolveRuntimeStopMessageStateFromMetadataCenterWithNative')) {
    fail(
      'stop-message-cli-result-state-ts-thin-shell',
      'runtime-utils.ts resolveRuntimeStopMessageStateFromMetadataCenter must call resolveRuntimeStopMessageStateFromMetadataCenterWithNative'
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
    if (metadataCenterRuntimeStateBlock.includes(keyword)) {
      fail(
        'stop-message-cli-result-state-ts-thin-shell',
        `runtime-utils.ts resolveRuntimeStopMessageStateFromMetadataCenter must not contain TS CLI-result semantic "${keyword}"`
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

  for (const [file, content, marker] of [
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'readServertoolFollowupFlowIdWithNative'],
    [NATIVE_REQUIRED_EXPORTS, requiredExports, '"readServertoolFollowupFlowIdJson"'],
    [NATIVE_REQUIRED_EXPORTS, requiredExports, '"runStopMessageAutoHandlerJson"'],
    [STOP_MESSAGE_RUNTIME_UTILS, runtimeUtils, 'readServerToolFollowupFlowId'],
    [RUST_SERVERTOOL_CORE_LOOKUP, rustLookup, 'pub fn read_servertool_followup_flow_id'],
    [RUST_SERVERTOOL_CORE_LOOKUP, rustLookup, 'STOP_MESSAGE_FOLLOWUP_FLOW_ID'],
    [NATIVE_STOP_MESSAGE_AUTO, readRequired(NATIVE_STOP_MESSAGE_AUTO), 'followupFlowId'],
    [NATIVE_STOP_MESSAGE_AUTO, readRequired(NATIVE_STOP_MESSAGE_AUTO), 'runStopMessageAutoHandlerWithNative'],
  ]) {
    if (content.includes(marker)) {
      fail(
        'servertool-followup-flow-id-deleted',
        `${file.replace(`${ROOT}/`, '')} must not retain deleted followup flow id marker ${marker}`
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
  if (persistStopMessageStateBlock.trim()) {
    fail(
      'servertool-persist-stop-message-state-ts-thin-shell',
      'runtime-utils.ts persistStopMessageState must stay physically deleted'
    );
  }
  pass(
    'servertool-persist-stop-message-state-ts-thin-shell',
    'runtime-utils.ts persistStopMessageState TS shell is absent'
  );

  for (const forbidden of [
    'planStopMessagePersistedStateSelectionWithNative',
    'planPersistStopMessageStateWithNative'
  ]) {
    if (nativeWrapper.includes(forbidden)) {
      fail(
        'stop-message-runtime-state-bridge',
        `${NATIVE_SERVERTOOL_CORE_WRAPPER} must not revive deleted persisted-state bridge ${forbidden}`
      );
    }
  }
  for (const forbidden of [
    '"planStopMessagePersistedStateSelectionJson"',
    '"planPersistStopMessageStateJson"'
  ]) {
    if (readRequired(NATIVE_REQUIRED_EXPORTS).includes(forbidden)) {
      fail(
        'stop-message-runtime-state-required-export',
        `${NATIVE_REQUIRED_EXPORTS} must not revive deleted persisted-state export ${forbidden}`
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
  for (const file of DELETED_SERVERTOOL_LOOP_SCOPE_TS_FILES) {
    assertMissingFile(
      'servertool-loop-scope-ts-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; loop/scope control is Rust-owned`
    );
  }

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
    'stop-message-loop-warning-rust-owner',
    RUST_FOLLOWUP_CORE,
    rustFollowupCore,
    'pub fn inject_loop_warning'
  );
  pass('stop-message-loop-guard-no-ts-fallback', 'stop-message loop guard TS shells are deleted; Rust owns loop guard');
  pass('stop-message-loop-warning-no-ts-duplicate', 'stop-message loop warning text/count policy is Rust/native-owned');
}

// ── Check 12b: stop-gateway context is Rust-owned ─────────────
function checkStopGatewayContextRustOwner() {
  const rustStopGateway = readRequired(RUST_SERVERTOOL_STOP_GATEWAY);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const metadataCenterCarrier = readRequired(TS_METADATA_CENTER_CARRIER);

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
  for (const file of [TS_STOP_GATEWAY_CONTEXT]) {
    if (existsSync(file)) {
      fail(
        'stop-gateway-context-ts-wrapper-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; stop-gateway control belongs to metadata-center-carrier + Rust native`
      );
    }
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
    'function writeBoundRuntimeControl(',
    'export function resolveStopGatewayContext(',
    'export function isStopEligibleForServerTool(',
    'export function readStopGatewayContext(',
    'normalizeStopGatewayContextWithNative',
    "return value && typeof value === 'object'",
    "runtimeControl && typeof runtimeControl === 'object'",
    "requestTruth && typeof requestTruth === 'object'",
    "providerObservation && typeof providerObservation === 'object'",
  ]) {
    if (metadataCenterCarrier.includes(keyword)) {
      fail(
        'stop-gateway-context-carrier-no-ts-owner',
        `Forbidden TS stop-gateway semantic/fallback "${keyword}" found in metadata-center-carrier.ts`
      );
    }
  }
  assertContains(
    'stop-gateway-context-metadata-carrier',
    TS_METADATA_CENTER_CARRIER,
    metadataCenterCarrier,
    'inspectStopGatewaySignalWithNative'
  );
  assertContains(
    'stop-gateway-context-metadata-carrier',
    TS_METADATA_CENTER_CARRIER,
    metadataCenterCarrier,
    "key: 'stopGatewayContext'"
  );
  for (const marker of [
    "return value != null && typeof value === 'object'",
    "runtimeControl != null && typeof runtimeControl === 'object'",
    "requestTruth != null && typeof requestTruth === 'object'",
    "providerObservation != null && typeof providerObservation === 'object'",
  ]) {
    assertContains(
      'stop-gateway-context-metadata-carrier',
      TS_METADATA_CENTER_CARRIER,
      metadataCenterCarrier,
      marker
    );
  }
  pass('stop-gateway-context-rust-owner', 'servertool-core owns stop-gateway inspect and metadata normalization');
}

// ── Check 12c: stop-message compare context is Rust-owned ─────
function checkStopMessageCompareContextRustOwner() {
  const rustCompare = readRequired(RUST_SERVERTOOL_STOP_MESSAGE_COMPARE);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const metadataCenterCarrier = readRequired(TS_METADATA_CENTER_CARRIER);

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
  for (const file of [TS_STOP_MESSAGE_COMPARE_CONTEXT]) {
    if (existsSync(file)) {
      fail(
        'stop-message-compare-context-ts-wrapper-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; compare control belongs to metadata-center-carrier + Rust native`
      );
    }
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
    'export function formatStopMessageCompareContext(',
    '../conversion/runtime-metadata.js',
    'ensureRuntimeMetadata',
    'readRuntimeMetadata',
    '.__rt',
  ]) {
    if (metadataCenterCarrier.includes(keyword)) {
      fail(
        'stop-message-compare-context-carrier-no-ts-owner',
        `Forbidden TS stop-message compare semantic/fallback "${keyword}" found in metadata-center-carrier.ts`
      );
    }
  }
  for (const keyword of [
    'writeRuntimeControlToBoundMetadataCenter',
    'readRuntimeControlFromAnyBoundMetadataCenter',
    "key: STOP_MESSAGE_COMPARE_KEY",
    "required: true",
  ]) {
    if (!metadataCenterCarrier.includes(keyword)) {
      fail(
        'stop-message-compare-context-metadata-center-only',
        `metadata-center-carrier.ts must keep MetadataCenter runtime_control marker ${keyword}`
      );
    }
  }
  assertContains(
    'stop-message-compare-context-metadata-carrier',
    TS_METADATA_CENTER_CARRIER,
    metadataCenterCarrier,
    'normalizeStopMessageCompareContextWithNative'
  );
  pass(
    'stop-message-compare-context-metadata-center-only',
    'stop-message compare context uses MetadataCenter runtime_control, not runtime metadata'
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
  const engineShell = readRequired(TS_ENGINE_ORCHESTRATION_SHELL);
  const enginePreflightShell = readRequired(TS_ENGINE_PREFLIGHT_SHELL);
  const timeoutShell = readRequired(TS_TIMEOUT_ERROR_BLOCK);

  assertMissingFile(
    'servertool-orchestration-policy-ts-deleted',
    TS_ORCHESTRATION_POLICY,
    `${TS_ORCHESTRATION_POLICY.replace(`${ROOT}/`, '')} must stay physically deleted; timeout IO lives in engine-orchestration-shell and synthetic control detection calls native directly`
  );

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
    'resolveServertoolTimeoutMsFromEnvCandidatesWithNative',
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
    'resolveServertoolTimeoutMsFromEnvCandidatesJson',
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
    'SERVERTOOL_ORCHESTRATION_POLICY_FEATURE_ID',
    'function parseTimeoutMs',
    'function parseBooleanLike',
    'FOLLOWUP_ERROR_REASON_MAX_LENGTH',
    'httpCodeMatch',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'toLowerCase',
    'targetProviderKey',
    'inspectStopGatewaySignal',
    'const timeoutPolicyInput = {',
    'const followupTimeoutPolicyInput = {',
    'parseServertoolTimeoutMsWithNative(timeoutPolicyInput)',
    'parseServertoolTimeoutMsWithNative(followupTimeoutPolicyInput)',
    'export function resolveServerToolFollowupTimeoutMs(',
    'export function readClientInjectOnly(',
    'export function normalizeClientInjectText(',
    'export function compactFollowupErrorReason(',
    'export function resolveAdapterContextProviderKey(',
    'readClientInjectOnlyWithNative',
    'normalizeClientInjectTextWithNative',
    'compactFollowupErrorReasonWithNative',
    'resolveAdapterContextProviderKeyWithNative',
  ]) {
    if (engineShell.includes(keyword)) {
      fail(
        'servertool-orchestration-policy-ts-thin-shell',
        `Forbidden TS orchestration policy semantic "${keyword}" found in engine-orchestration-shell.ts`
      );
    }
  }
  for (const file of DELETED_SERVERTOOL_DATA_CONTEXT_FILES) {
    assertMissingFile(
      'servertool-data-context-ts-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; servertool must not carry context/request/response data or stale followup sanitize shells in TS`
    );
  }
  for (const file of listFiles(`${ROOT}/src`).concat(listFiles(`${ROOT}/sharedmodule/llmswitch-core/src`))) {
    const relativeFile = file.replace(`${ROOT}/`, '');
    const source = readFileSync(file, 'utf8');
    for (const marker of [
      'servertool/handlers/followup-sanitize',
      'sanitizeFollowupText',
      'servertool/handlers/memory/cache-writer',
      'origin-request-store',
    ]) {
      if (source.includes(marker)) {
        fail(
          'servertool-data-context-ts-deleted',
          `${relativeFile} must not reference deleted servertool data/context residue marker "${marker}"`
        );
      }
    }
  }
  for (const needle of [
    'resolveServertoolTimeoutMsFromEnvCandidatesWithNative',
    'return resolveServertoolTimeoutMsFromEnvCandidatesWithNative({',
  ]) {
    assertContains(
      'servertool-orchestration-policy-ts-thin-shell',
      TS_ENGINE_ORCHESTRATION_SHELL,
      engineShell,
      needle
    );
  }
  assertContains(
    'servertool-orchestration-policy-ts-thin-shell',
    TS_ENGINE_PREFLIGHT_SHELL,
    enginePreflightShell,
    'containsSyntheticRouteCodexControlTextWithNative'
  );
  for (const keyword of [
    'function resolveServerToolTimeoutMsFromEnv(',
    'parseServertoolTimeoutMsWithNative({ raw: raw || undefined })',
    '.map((key) => process.env[key]).find((value) => Boolean(value))',
    'SERVERTOOL_TIMEOUT_ERROR_FEATURE_ID',
    'Number.isFinite',
    'Math.floor',
    'Math.max',
    'toLowerCase',
    'clientConnectionState',
    'clientDisconnected',
    'disconnected',
    "flow=${options.flowId}",
    'timeout after ${options.timeoutMs}',
    'export function isServerToolClientDisconnectedError(',
    'export function createClientDisconnectWatcher(',
    'export function isServerToolTimeoutError(',
    'export function createStopMessageFetchFailedError(',
    'export function createServertoolStateLoadFailedError(',
    'export function createServerToolTimeoutError(',
    'export function createServertoolRequiredResponseHookEmptyError(',
    'export function createServerToolClientDisconnectedError(',
    'export function isAdapterClientDisconnected(',
    'isAdapterClientDisconnectedWithNative(adapterContext)',
    'planClientDisconnectWatcherWithNative',
    'planStopMessageFetchFailedErrorWithNative',
    'planServertoolStateLoadFailedErrorWithNative',
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
    'createServertoolProviderProtocolErrorFromPlan',
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
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    'isAdapterClientDisconnectedWithNative(args.options.adapterContext)'
  );
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

function checkServertoolExecutionDispatchRustOwner() {
  for (const file of DELETED_SERVERTOOL_DISPATCH_FACADE_FILES) {
    assertMissingFile(
      'servertool-dispatch-facade-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; execution queue runtime must import execution-queue-shell.ts directly`
    );
  }
  const executionQueueShell = readRequired(TS_EXECUTION_QUEUE_SHELL);
  const rustExecutionBranch = readRequired(RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT);
  const rustExecutionLoopEffect = readRequired(RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT);
  const rustExecutionLoopRuntimeAction = readRequired(RUST_SERVERTOOL_EXECUTION_LOOP_RUNTIME_ACTION_CONTRACT);
  const rustExecutionOutcomeRuntimeAction = readRequired(RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT);
  const rustExecutionState = readRequired(RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeCoreWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  assertContains(
    'servertool-execution-dispatch-rust-owner',
    `${SERVERTOOL_TS_DIR}/dispatch-preparation-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/dispatch-preparation-shell.ts`),
    'buildServertoolDispatchPlanInputWithNative'
  );
  assertContains(
    'servertool-execution-queue-shell-owner',
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
    'runServertoolIoExecutionQueue'
  );
  assertContains(
    'servertool-execution-queue-shell-owner',
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
    'planServertoolExecutionLoopRuntimeActionWithNative'
  );
  assertContains(
    'servertool-execution-queue-shell-owner',
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
    'createServertoolProviderProtocolErrorFromPlan'
  );
  assertContains(
    'servertool-execution-handler-outcome-rust-owner',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`),
    'buildServertoolOutcomePlanInputWithNative'
  );
  assertContains(
    'servertool-execution-handler-outcome-rust-owner',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`),
    'buildServertoolOutcomePlanInputWithNative({'
  );
  assertContains(
    'servertool-execution-handler-outcome-rust-owner',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`),
    'const outcomePlan = planServertoolOutcomeWithNative('
  );
  assertMissing(
    'servertool-execution-handler-outcome-rust-owner',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`),
    'function dehydrateExecutionLoopState('
  );
  for (const keyword of [
    'listRegisteredServerToolHandlerRecords()',
    'registeredToolCallHandlers: listRegisteredServerToolHandlerRecords()',
    '[servertool] dispatch spec mismatch:',
    '[servertool] invalid native mixed-client-tools outcome contract',
    '[servertool] missing native execution contract for servertool-only outcome',
    'export const buildServertoolOutcomePlanInput =',
    'export function materializeNativeToolCallExecutionOutcome(',
    "if (outcomePlan.outcomeMode === 'mixed_client_tools')",
    '? args.executionState.lastExecution.followup',
    "if (!entry || entry.trigger !== 'tool_call')",
    "entry.execution.kind === 'builtin'",
    "entry.execution?.kind !== 'adhoc'",
    "entry.execution?.kind !== 'handler'",
    'entry.execution.handler',
    'runServertoolHandler',
    'if (result) {',
    "if (initialLoopActionPlan.action === 'skip_non_tool_call_handler')",
    "if (initialLoopActionPlan.action === 'throw_dispatch_spec_mismatch')",
    "if (resultLoopActionPlan.action === 'apply_materialized_result')",
    "if (resultLoopActionPlan.action === 'apply_handler_error_tool_output')",
    'const initialLoopAction = initialLoopActionPlan.action',
    'const resultLoopAction = resultLoopActionPlan.action',
    'String(initialLoopActionPlan.action)',
    'String(resultLoopActionPlan.action)',
    'Boolean(entry)',
    'Boolean(result)',
    'planned ? await materializeServertoolPlannedResult',
    "nativeExecutionMode: entry?.registration.executionMode ?? ''",
    "toolCall: errorEffectPlan.toolCall as NativeServertoolExecutedRecord['toolCall']",
    'execution: errorEffectPlan.execution as ServerToolExecution',
    "toolCall: noopEffectPlan.toolCall as NativeServertoolExecutedRecord['toolCall']",
    'execution: noopEffectPlan.execution as ServerToolExecution',
    'result.chatResponse as JsonObject',
    'noopResult.chatResponse as JsonObject',
    'buildServertoolHandlerErrorToolOutputPayloadWithNative({\n          base: args.baseForExecution as Record<string, unknown>,\n          toolCallId: toolCall.id,\n          toolName: toolCall.name,\n          message: errorEffectPlan.handlerErrorMessage\n        }) as JsonObject',
    'base: args.baseForExecution as Record<string, unknown>',
    'if (lastErr) {',
    'Boolean(lastErr)',
    "String(lastErr ?? 'unknown')",
    "lastErr instanceof Error ? lastErr.message : String",
    'lastErr instanceof Error ? lastErr.message : lastErr',
    'executedToolCalls: [],',
    'executedIds: new Set<string>()',
    'executedFlowIds: []',
    'state.executedToolCalls.push({',
    'state.executedIds.add(toolCall.id)',
    'state.executedFlowIds.push(',
    'state.lastExecution = execution',
    'const newKeys = new Set(Object.keys(nextChatResponse));',
    "  ToolCall\n} from './types.js';",
  ]) {
    if (executionQueueShell.includes(keyword)) {
      fail(
        'servertool-execution-dispatch-no-ts-registry-truth',
        `Forbidden TS registry dispatch truth "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts`
      );
    }
  }
  pass(
    'servertool-execution-dispatch-rust-owner',
    'execution-queue-shell.ts builds dispatch-plan handler truth from Rust skeleton config without dispatch facade shell'
  );
  assertContains(
    'servertool-execution-dispatch-rust-owner',
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
    'message: errorEffectPlan.handlerErrorMessage'
  );
  for (const marker of [
    'hasHandlerEntry: entry != null',
    'nativeExecutionMode: entry.registration.executionMode',
    'planned != null ? await materializeServertoolPlannedResult',
    'hasMaterializedResult: result != null',
    'replaceJsonObjectInPlace(args.baseForExecution, result.chatResponse)',
    'replaceJsonObjectInPlace(args.baseForExecution, noopResult.chatResponse)',
    'const toolOutputPayload = buildServertoolHandlerErrorToolOutputPayloadWithNative({',
    'base: args.baseForExecution',
    'switch (initialLoopActionPlan.action)',
    'switch (resultLoopActionPlan.action)',
    'toolCall: errorEffectPlan.toolCall',
    'execution: errorEffectPlan.execution',
    'toolCall: noopEffectPlan.toolCall',
    'execution: noopEffectPlan.execution',
  ]) {
    assertContains(
      'servertool-execution-dispatch-rust-owner',
      TS_EXECUTION_QUEUE_SHELL,
      executionQueueShell,
      marker
    );
  }

  assertMissingFile(
    'servertool-execution-shell-deleted',
    TS_EXECUTION_SHELL,
    'execution-shell.ts must stay physically deleted after moving pre-command wrappers to pre-command-hooks.ts and direct imports to execution-handler-materialization-shell.ts'
  );

  assertMissingFile(
    'servertool-execution-branch-runtime-shell-deleted',
    TS_EXECUTION_BRANCH_RUNTIME_SHELL,
    'execution-branch-runtime-shell.ts must stay physically deleted after inlining native execution-branch planning into execution-stage-shell.ts'
  );

  for (const [check, file, content, needle] of [
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'feature_id: hub.servertool_execution_branch_contract'],
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'pub fn plan_servertool_execution_branch'],
    ['servertool-execution-branch-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_branch_contract'],
    ['servertool-execution-branch-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_branch_json'],
    ['servertool-execution-branch-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_branch_json'],
    ['servertool-execution-branch-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionBranchJson'],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionBranchWithNative'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'planServertoolExecutionBranchWithNative('],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'switch (preExecutionBranchPlan.action)'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'invalid pre-execution branch action'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'invalid post-execution branch action'],
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'pub projected_tool_call: Option<ServertoolProjectedToolCall>'],
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'pub struct ServertoolProjectedToolCall'],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, "action: 'client_exec_cli_projection';"],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'projectedToolCall: {'],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, "if (record.action !== 'client_exec_cli_projection')"],
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'projected_tool_call_index'],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'projectedToolCallIndex'],
    ['servertool-engine-preflight-rust-owner', RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT), 'feature_id: hub.servertool_engine_preflight_contract'],
    ['servertool-engine-preflight-rust-owner', RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT), 'pub fn plan_servertool_engine_preflight'],
    ['servertool-engine-preflight-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_preflight_contract'],
    ['servertool-engine-preflight-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_preflight_json'],
    ['servertool-engine-preflight-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_preflight_json'],
    ['servertool-engine-preflight-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEnginePreflightJson'],
    ['servertool-engine-preflight-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEnginePreflightWithNative'],
    ['servertool-engine-preflight-ts-thin-shell', TS_ENGINE_PREFLIGHT_SHELL, readRequired(TS_ENGINE_PREFLIGHT_SHELL), 'planServertoolEnginePreflightWithNative'],
    ['servertool-engine-orchestration-preflight-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_orchestration_preflight_action_contract.rs`, readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_orchestration_preflight_action_contract.rs`), 'pub fn plan_servertool_engine_orchestration_preflight_action'],
    ['servertool-engine-orchestration-preflight-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_orchestration_preflight_action_contract'],
    ['servertool-engine-orchestration-preflight-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_orchestration_preflight_action_json'],
    ['servertool-engine-orchestration-preflight-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_orchestration_preflight_action_json'],
    ['servertool-engine-orchestration-preflight-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineOrchestrationPreflightActionJson'],
    ['servertool-engine-orchestration-preflight-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineOrchestrationPreflightActionWithNative'],
    ['servertool-engine-skip-rust-owner', RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT), 'feature_id: hub.servertool_engine_skip_contract'],
    ['servertool-engine-skip-rust-owner', RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT), 'pub fn plan_servertool_engine_skip'],
    ['servertool-engine-skip-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_skip_contract'],
    ['servertool-engine-skip-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_skip_json'],
    ['servertool-engine-skip-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_skip_json'],
    ['servertool-engine-skip-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineSkipJson'],
    ['servertool-engine-skip-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineSkipWithNative'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'feature_id: hub.servertool_engine_runtime_action_contract'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'pub fn plan_servertool_engine_runtime_action'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'stopless_execution_flow_id'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'pub fn plan_servertool_engine_trigger_observation'],
    ['servertool-engine-runtime-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_runtime_action_contract'],
    ['servertool-engine-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_runtime_action_json'],
    ['servertool-engine-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_trigger_observation_json'],
    ['servertool-engine-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_runtime_action_json'],
    ['servertool-engine-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_trigger_observation_json'],
    ['servertool-engine-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineRuntimeActionJson'],
    ['servertool-engine-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineTriggerObservationJson'],
    ['servertool-engine-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineRuntimeActionWithNative'],
    ['servertool-engine-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineTriggerObservationWithNative'],
    ['servertool-execution-loop-effect-rust-owner', RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT, rustExecutionLoopEffect, 'feature_id: hub.servertool_execution_loop_effect_contract'],
    ['servertool-execution-loop-effect-rust-owner', RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT, rustExecutionLoopEffect, 'pub fn plan_servertool_execution_loop_effect'],
    ['servertool-execution-loop-effect-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_loop_effect_contract'],
    ['servertool-execution-loop-effect-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_loop_effect_json'],
    ['servertool-execution-loop-effect-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_loop_effect_json'],
    ['servertool-execution-loop-effect-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionLoopEffectJson'],
    ['servertool-execution-loop-effect-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionLoopEffectWithNative'],
    ['servertool-execution-loop-effect-ts-thin-shell', TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'planServertoolExecutionLoopEffectWithNative'],
    ['servertool-execution-loop-runtime-action-rust-owner', RUST_SERVERTOOL_EXECUTION_LOOP_RUNTIME_ACTION_CONTRACT, rustExecutionLoopRuntimeAction, 'feature_id: hub.servertool_execution_loop_runtime_action_contract'],
    ['servertool-execution-loop-runtime-action-rust-owner', RUST_SERVERTOOL_EXECUTION_LOOP_RUNTIME_ACTION_CONTRACT, rustExecutionLoopRuntimeAction, 'pub fn plan_servertool_execution_loop_runtime_action'],
    ['servertool-execution-loop-runtime-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_loop_runtime_action_contract'],
    ['servertool-execution-loop-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_loop_runtime_action_json'],
    ['servertool-execution-loop-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_loop_runtime_action_json'],
    ['servertool-execution-loop-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionLoopRuntimeActionJson'],
    ['servertool-execution-loop-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionLoopRuntimeActionWithNative'],
    ['servertool-execution-loop-runtime-action-ts-thin-shell', TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'planServertoolExecutionLoopRuntimeActionWithNative'],
    ['servertool-execution-outcome-runtime-action-rust-owner', RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT, rustExecutionOutcomeRuntimeAction, 'feature_id: hub.servertool_execution_outcome_runtime_action_contract'],
    ['servertool-execution-outcome-runtime-action-rust-owner', RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT, rustExecutionOutcomeRuntimeAction, 'pub fn plan_servertool_execution_outcome_runtime_action'],
    ['servertool-execution-outcome-runtime-action-rust-owner', RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT, rustExecutionOutcomeRuntimeAction, 'pub fn plan_servertool_execution_outcome_materialization'],
    ['servertool-execution-outcome-runtime-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_outcome_runtime_action_contract'],
    ['servertool-execution-outcome-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_outcome_runtime_action_json'],
    ['servertool-execution-outcome-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_outcome_materialization_json'],
    ['servertool-execution-outcome-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_outcome_runtime_action_json'],
    ['servertool-execution-outcome-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_outcome_materialization_json'],
    ['servertool-execution-outcome-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionOutcomeRuntimeActionJson'],
    ['servertool-execution-outcome-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionOutcomeMaterializationJson'],
    ['servertool-execution-outcome-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionOutcomeRuntimeActionWithNative'],
    ['servertool-execution-outcome-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionOutcomeMaterializationWithNative'],
    ['servertool-execution-outcome-runtime-action-ts-thin-shell', `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`, readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`), 'planServertoolExecutionOutcomeMaterializationWithNative'],
    ['servertool-execution-state-rust-owner', RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT, rustExecutionState, 'feature_id: hub.servertool_execution_state_contract'],
    ['servertool-execution-state-rust-owner', RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT, rustExecutionState, 'pub fn create_servertool_execution_loop_state'],
    ['servertool-execution-state-rust-owner', RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT, rustExecutionState, 'pub fn append_executed_tool_record'],
    ['servertool-execution-state-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_state_contract'],
    ['servertool-execution-state-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'create_servertool_execution_loop_state_json'],
    ['servertool-execution-state-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'append_servertool_executed_record_json'],
    ['servertool-execution-state-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn create_servertool_execution_loop_state_json'],
    ['servertool-execution-state-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn append_servertool_executed_record_json'],
    ['servertool-execution-state-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'createServertoolExecutionLoopStateJson'],
    ['servertool-execution-state-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'appendServertoolExecutedRecordJson'],
    ['servertool-execution-state-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'createServertoolExecutionLoopStateWithNative'],
    ['servertool-execution-state-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'appendServertoolExecutedRecordWithNative'],
    ['servertool-execution-state-ts-native-direct', TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'createServertoolExecutionLoopStateWithNative'],
    ['servertool-execution-state-ts-native-direct', TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'appendServertoolExecutedRecordWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }
  for (const marker of [
    'createServertoolExecutionLoopStateFromNative',
    'appendExecutedToolRecordFromNative',
    'function hydrateExecutionLoopState(',
    'new Set(state.executedIds)'
  ]) {
    assertMissing(
      'servertool-execution-state-wrapper-deleted',
      `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
      readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`),
      marker
    );
  }
  for (const marker of [
    'record.skipReason.trim()',
    'record.executionFlowId.trim()',
    "input.outcomeMode === 'mixed_client_tools'",
  ]) {
    assertMissing(
      'servertool-native-wrapper-no-ts-defaulting',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeCoreWrapper,
      marker
    );
  }
  for (const [file, content, marker] of [
    [TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'noopExecutionContext'],
    [TS_EXECUTION_QUEUE_SHELL, executionQueueShell, 'noopResult.executionContext'],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'noopExecutionContext?:'],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'noopExecutionContext'],
    [RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT, rustExecutionLoopEffect, 'noop_execution_context'],
    [RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT, rustExecutionLoopEffect, 'context: input.noop_execution_context'],
    [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, '"noopExecutionContext"'],
    [CHAT_SERVERTOOL_ORCHESTRATION, readRequired(CHAT_SERVERTOOL_ORCHESTRATION), 'execution_context: Value'],
    [CHAT_SERVERTOOL_ORCHESTRATION, readRequired(CHAT_SERVERTOOL_ORCHESTRATION), 'execution_context,'],
  ]) {
    if (content.includes(marker)) {
      fail(
        'servertool-noop-context-carrier-deleted',
        `Forbidden noop execution context carrier "${marker}" found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  for (const [file, content, marker] of [
    [RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT, rustExecutionState, 'pub context: Option<Value>'],
    [RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT, rustExecutionState, 'context: input.context'],
    [`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`, readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`), 'context?: unknown'],
  ]) {
    if (content.includes(marker)) {
      fail(
        'servertool-execution-state-context-carrier-deleted',
        `Forbidden execution loop context carrier "${marker}" found in ${file.replace(`${ROOT}/`, '')}`
      );
    }
  }
  assertMissing(
    'servertool-execution-state-ts-thin-shell-deleted-wrapper-guard',
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
    'export function applyServertoolExecutionResult('
  );
  assertMissing(
    'servertool-orchestration-blocks-no-ts-append-tool-output',
    `${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`),
    'export function appendToolOutput('
  );
  assertMissing(
    'servertool-orchestration-blocks-no-ts-append-tool-output',
    `${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`),
    "nativeRecord({ op: 'append_tool_output'"
  );
  assertMissing(
    'servertool-orchestration-blocks-native-array-failfast',
    `${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`),
    '.filter((entry): entry is JsonObject'
  );
  for (const marker of [
    'export function buildAssistantToolCallMessage(',
    'export function buildToolMessagesFromOutputs(',
      'export function stripToolOutputs(',
      'export function patchToolCallArgumentsById(',
      'export function filterOutExecutedToolCalls(',
      'function replaceJsonObjectInPlaceInternal(',
      'function nativeArray(',
    'function nativeRecord(',
    'runServertoolOrchestrationMutationWithNative'
  ]) {
    assertMissing(
      'servertool-orchestration-blocks-dead-mutation-facades-deleted',
      `${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`,
      readRequired(`${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`),
      marker
    );
  }
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
  assertMissingFile(
    'servertool-skeleton-config-deleted',
    TS_SERVERTOOL_SKELETON_CONFIG,
    'skeleton-config.ts must stay physically deleted; runtime consumers call native wrappers directly'
  );
  pass('servertool-skeleton-config-no-ts-owner', 'skeleton-config.ts is physically deleted; Rust/native wrappers own skeleton config semantics');
}

function checkServertoolHookSkeletonRustOwner() {
  const rustHookSkeleton = readRequired(RUST_SERVERTOOL_HOOK_SKELETON);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'pub enum ServertoolHookDirection',
    'pub enum ServertoolReqHookPhase',
    'pub enum ServertoolRespHookPhase',
    'pub enum ServertoolHookRequiredness',
    'pub struct ServertoolHookSpec',
    'pub struct ServertoolHookSchedulerInput',
    'pub struct ServertoolHookEffectPlan',
    'pub struct ServertoolHookEvent',
    'pub struct ServertoolHookProjection',
    'pub fn validate_servertool_hook_spec',
    'pub fn plan_servertool_hook_schedule',
    'DuplicateHookId',
    'MissingRequiredHookForPhase',
    '#[cfg(test)]',
    'fn schedules_hooks_by_priority_order_then_id()',
    'fn emits_noop_event_for_skipped_optional_hook()',
  ]) {
    assertContains('servertool-hook-skeleton-rust-owner', RUST_SERVERTOOL_HOOK_SKELETON, rustHookSkeleton, needle);
  }

  for (const needle of [
    'pub fn validate_servertool_hook_skeleton_phase_json',
    'pub fn plan_servertool_hook_schedule_json',
  ]) {
    assertContains('servertool-hook-skeleton-napi-blocks', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, needle);
  }

  for (const needle of [
    'pub fn validate_servertool_hook_skeleton_phase_json(input_json: String) -> NapiResult<String>',
    'pub fn plan_servertool_hook_schedule_json(input_json: String) -> NapiResult<String>',
  ]) {
    assertContains('servertool-hook-skeleton-napi-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, needle);
  }

  for (const needle of [
    'export function validateServertoolHookSkeletonPhaseWithNative(',
    'export function planServertoolHookScheduleWithNative(',
    'function parseServertoolHookEffectPlanPayload(',
  ]) {
    assertContains('servertool-hook-skeleton-native-wrapper', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, needle);
  }

  for (const needle of [
    '"validateServertoolHookSkeletonPhaseJson"',
    '"planServertoolHookScheduleJson"',
  ]) {
    assertContains('servertool-hook-skeleton-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, needle);
  }

  pass('servertool-hook-skeleton-rust-owner', 'servertool hook skeleton contract is Rust-owned with native export surface');
}

function checkPendingSessionRustOwner() {
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  assertMissingFile(
    'servertool-pending-session-retired',
    RUST_SERVERTOOL_PENDING_SESSION,
    'servertool-core pending_session_contract.rs must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pending-session-retired',
    TS_PENDING_SESSION,
    'servertool pending-session.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pending-session-retired',
    TS_PENDING_INJECTION,
    'servertool pending-injection-block.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-state-scope-metadata-center-only',
    SERVERTOOL_STATE_SCOPE,
    'state-scope.ts must stay deleted; Rust persisted_lookup owns stop-message/session sticky scope resolution'
  );
  for (const needle of [
    'pending_session_contract',
    'resolve_pending_session_file_name_json',
    'resolve_pending_session_max_age_ms_json',
    'plan_pending_session_save_json',
    'plan_pending_session_load_json',
    'plan_pending_injection_persist_json',
    'plan_pending_injection_persist_error_json',
    'resolvePendingSessionFileNameJson',
    'resolvePendingSessionMaxAgeMsJson',
    'planPendingSessionSaveJson',
    'planPendingSessionLoadJson',
    'planPendingInjectionPersistJson',
    'planPendingInjectionPersistErrorJson',
    'resolvePendingSessionFileNameWithNative',
    'resolvePendingSessionMaxAgeMsWithNative',
    'planPendingSessionSaveWithNative',
    'planPendingSessionLoadWithNative',
    'planPendingInjectionPersistWithNative',
    'planPendingInjectionPersistErrorWithNative',
  ]) {
    for (const [file, content] of [
      [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib],
      [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks],
      [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib],
      [NATIVE_REQUIRED_EXPORTS, requiredExports],
      [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
    ]) {
      if (content.includes(needle)) {
        fail(
          'servertool-pending-session-retired',
          `${file.replace(`${ROOT}/`, '')} must not retain retired pending-session marker ${needle}`
        );
      }
    }
  }
  pass(
    'servertool-pending-session-retired',
    'servertool pending-session and pending-injection persistence are physically retired'
  );
}

function checkPreCommandHooksRustOwner() {
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    RUST_SERVERTOOL_PRE_COMMAND,
    'servertool-core pre_command_hook_contract.rs must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    TS_PRE_COMMAND_HOOKS,
    'servertool pre-command-hooks.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    `${SERVERTOOL_TS_DIR}/pre-command-runtime-state-shell.ts`,
    'servertool pre-command-runtime-state-shell.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    `${ROOT}/tests/servertool/pre-command-hooks.spec.ts`,
    'servertool pre-command-hooks.spec.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    `${ROOT}/tests/servertool/pre-command-runtime-state-shell.spec.ts`,
    'servertool pre-command-runtime-state-shell.spec.ts must stay physically deleted'
  );
  assertMissingFile(
    'servertool-pre-command-hooks-retired',
    `${ROOT}/docs/SERVERTOOL_PRE_COMMAND_HOOKS.md`,
    'SERVERTOOL_PRE_COMMAND_HOOKS.md must stay physically deleted'
  );
  for (const needle of [
    'feature_id: hub.servertool_pre_command_hooks',
    'pre_command_hook_contract',
    'plan_pre_command_hooks_config_json',
    'plan_pre_command_hooks_config_text_json',
    'plan_runtime_pre_command_rule_json',
    'plan_runtime_pre_command_state_selection_json',
    'plan_runtime_pre_command_state_runtime_action_json',
    'plan_pre_command_hook_attempt_json',
    'plan_pre_command_hook_completion_json',
    'plan_pre_command_hook_event_payload_json',
    'parse_pre_command_jq_stdout_json',
    'parse_pre_command_runtime_script_stdout_json',
    'planPreCommandHooksConfigJson',
    'planPreCommandHooksConfigTextJson',
    'planRuntimePreCommandRuleJson',
    'planRuntimePreCommandStateSelectionJson',
    'planRuntimePreCommandStateRuntimeActionJson',
    'planPreCommandHookAttemptJson',
    'planPreCommandHookCompletionJson',
    'planPreCommandHookEventPayloadJson',
    'parsePreCommandJqStdoutJson',
    'parsePreCommandRuntimeScriptStdoutJson',
    'planPreCommandHooksConfigWithNative',
    'planPreCommandHooksConfigTextWithNative',
    'planRuntimePreCommandRuleWithNative',
    'planRuntimePreCommandStateRuntimeActionWithNative',
    'planPreCommandHookAttemptWithNative',
    'planPreCommandHookCompletionWithNative',
    'planPreCommandHookEventPayloadWithNative',
    'parsePreCommandJqStdoutWithNative',
    'parsePreCommandRuntimeScriptStdoutWithNative',
    'resolveServertoolRuntimePreCommandState',
    'applyPreCommandHooksToToolCalls',
    'runtimeControlPreCommandState',
  ]) {
    for (const [file, content] of [
      [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib],
      [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks],
      [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib],
      [NATIVE_REQUIRED_EXPORTS, requiredExports],
      [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
    ]) {
      if (content.includes(needle)) {
        fail(
          'servertool-pre-command-hooks-retired',
          `${file.replace(`${ROOT}/`, '')} must not retain retired pre-command marker ${needle}`
        );
      }
    }
  }
  pass(
    'servertool-pre-command-hooks-retired',
    'servertool pre-command hooks are physically retired from runtime, NAPI exports, and TS native wrappers'
  );
}

function checkAutoHookExecutionRustOwner() {
  const rustAutoHookExecution = readRequired(RUST_SERVERTOOL_AUTO_HOOK_EXECUTION);
  const rustAutoHookRuntime = readRequired(RUST_SERVERTOOL_AUTO_HOOK_RUNTIME);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const autoHookCaller = readRequired(`${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`);

  for (const needle of [
    'feature_id: hub.servertool_auto_hook_execution',
    'pub struct AutoHookExecutionDecisionInput',
    'pub struct AutoHookExecutionDecisionPlan',
    'pub struct AutoHookTraceEventPlan',
    'pub fn plan_auto_hook_execution_decision',
  ]) {
    assertContains('servertool-auto-hook-execution-rust-owner', RUST_SERVERTOOL_AUTO_HOOK_EXECUTION, rustAutoHookExecution, needle);
  }
  for (const needle of [
    'feature_id: hub.servertool_auto_hook_execution',
    'pub struct AutoHookRuntimeAttemptInput',
    'pub struct AutoHookRuntimeAttemptPlan',
    'pub enum AutoHookRuntimeAttemptAction',
    'pub struct AutoHookCallerFinalizationInput',
    'pub struct AutoHookCallerFinalizationPlan',
    'pub fn plan_auto_hook_runtime_attempt',
    'pub fn plan_auto_hook_caller_finalization',
  ]) {
    assertContains('servertool-auto-hook-execution-rust-owner', RUST_SERVERTOOL_AUTO_HOOK_RUNTIME, rustAutoHookRuntime, needle);
  }
  assertContains(
    'servertool-auto-hook-execution-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod auto_hook_execution_contract'
  );
  assertContains(
    'servertool-auto-hook-execution-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod auto_hook_runtime_contract'
  );
  for (const needle of [
    'plan_auto_hook_runtime_attempt_json',
    'plan_auto_hook_caller_finalization_json',
  ]) {
    assertContains('servertool-auto-hook-execution-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, needle);
    assertContains('servertool-auto-hook-execution-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, `pub fn ${needle}`);
  }
  assertContains('servertool-auto-hook-execution-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planAutoHookRuntimeAttemptJson');
  assertContains('servertool-auto-hook-execution-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planAutoHookCallerFinalizationJson');
  assertContains('servertool-auto-hook-execution-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planAutoHookRuntimeAttemptWithNative');
  assertContains('servertool-auto-hook-execution-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planAutoHookCallerFinalizationWithNative');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'const attemptPlan = planAutoHookRuntimeAttemptWithNative({');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'const result = planned != null');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'await materializeServertoolPlannedResult(planned, args.options)');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'result?.execution != null && typeof result.execution.flowId');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'if (result == null)');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'return result;');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'switch (attemptPlan.action)');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'const finalizationPlan = planAutoHookCallerFinalizationWithNative({');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'includeAutoHookIds: args.includeAutoHookIds != null ? [...args.includeAutoHookIds] : null');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'excludeAutoHookIds: args.excludeAutoHookIds != null ? [...args.excludeAutoHookIds] : null');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'queueIndex: queueIndex + 1');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'queueTotal: queueOrder.length');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'mode: finalizationPlan.resultMode');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'if (queueResult == null)');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'queueResult.metadataWritePlan != null');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'finalChatResponse: queueResult.chatResponse');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'execution: queueResult.execution');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'invalid auto-hook attempt action');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'invalid auto-hook caller finalization action');
  for (const keyword of [
    'export async function runAutoHookExecutionQueue(',
    'errorAttemptInput',
    'runtimeAttemptInput',
    'callerFinalizationInput',
    'function planAutoHookRuntimeAttempt(',
    'const attemptPlan = planAutoHookRuntimeAttempt({',
    'attemptPlan as { action: unknown }',
    'function planAutoHookCallerFinalization(',
    'const finalizationPlan = planAutoHookCallerFinalization({',
    'attemptPlan.traceEvent as ServerToolAutoHookTraceEvent',
    'finalizationPlan as { action: string }',
    'planned as any',
    'const queueResultForReturn = queueResult as ServerToolHandlerResult',
    'const toolFlowResult: ServerSideToolEngineResult = {',
    'return toolFlowResult;',
    'auto_hook_queue_contract',
    'plan_auto_hook_queue_progress',
    'plan_auto_hook_execution_decision_json',
    'plan_auto_hook_queue_progress_json',
    'planAutoHookExecutionDecisionWithNative',
    'planAutoHookQueueProgressWithNative',
    'decision.action',
    'progressPlan.action',
    'type AutoHookExecutionItem =',
    'hooks: args.hooks.map((hook)',
    'execution: hook.execution',
    "result: 'error'",
    "reason: 'predicate_false'",
    "reason: 'matched_without_flow'",
    "reason: 'empty_materialized_result'",
    'ServerToolHandlerPlan',
    "hook.execution.kind === 'builtin'",
    "hook.execution?.kind !== 'adhoc'",
    'hook.execution.handler',
    'runServertoolHandler',
    'if (planned) {',
    'if (!planned) {',
    'if (attemptPlan.returnResult)',
    'switch (attemptPlan.returnResult)',
    'Boolean(planned)',
    'Boolean(result)',
    'Boolean(queueResult)',
    'result?.execution && typeof result.execution.flowId',
    'queueResultForReturn.metadataWritePlan ?',
    '...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {})',
    '...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {})',
    'if (result) {',
    'if (!result)',
    'return result as ServerToolHandlerResult',
    'if (!queueResult)',
    'native auto-hook execution requested result but materialization was empty',
    'native auto-hook queue progress requested result but queue result was empty',
    'native auto-hook execution returned no materialized disposition',
    'if (optionalResult) {',
    'if (mandatoryResult) {',
    'result.execution.flowId.trim()',
    "mode: 'tool_flow'",
    "String(error ?? 'unknown')",
    'error instanceof Error ? error.message : String',
    "typeof error === 'string' ? error",
    '// best-effort',
  ]) {
    if (autoHookCaller.includes(keyword)) {
      fail(
        'servertool-auto-hook-execution-no-ts-owner',
        `Forbidden TS auto-hook execution semantic "${keyword}" found in auto-hook-caller.ts`
      );
    }
  }
  if (/onAutoHookTrace[\s\S]{0,140}catch\s*\{/.test(autoHookCaller)) {
    fail(
      'servertool-auto-hook-execution-no-ts-owner',
      'auto-hook-caller.ts must not swallow auto-hook trace callback failures'
    );
  }
  pass(
    'servertool-auto-hook-execution-no-ts-owner',
    'auto-hook-caller.ts delegates attempt outcome and optional->mandatory queue progression semantics to Rust native plan'
  );
}

function checkServertoolRegistryRustOwner() {
  const rustRegistry = readRequired(RUST_SERVERTOOL_REGISTRY_CONTRACT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const skeletonConfigRust = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  for (const file of DELETED_SERVERTOOL_REGISTRY_FACADE_FILES) {
    assertMissingFile(
      'servertool-registry-facades-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; runtime must import types/registry-orchestration-shell.ts directly`
    );
  }
  const servertoolTypes = readRequired(TS_SERVERTOOL_TYPES);
  const registryOrchestrationShell = readRequired(TS_REGISTRY_ORCHESTRATION_SHELL);

  for (const needle of [
    'feature_id: hub.servertool_registry_contract',
    'pub struct ServertoolRegistryLookupActionInput',
    'pub enum ServertoolRegistryLookupAction',
    'pub fn plan_servertool_registry_lookup_action',
    'pub struct ServertoolRegistryAutoHookDescriptorInput',
    'pub struct ServertoolRegistryAutoHookDescriptorPlan',
    'pub fn plan_servertool_registry_auto_hook_descriptors',
    'pub struct ServertoolRegistryProjectionInput',
    'pub struct ServertoolRegistryProjectionPlan',
    'pub fn plan_servertool_registry_projection',
    'pub struct ServertoolRegistrySourceProjectionInput',
    'pub struct ServertoolRegistrySourceProjectionPlan',
    'pub fn plan_servertool_registry_source_projection',
  ]) {
    assertContains('servertool-registry-rust-owner', RUST_SERVERTOOL_REGISTRY_CONTRACT, rustRegistry, needle);
  }
  for (const marker of [
    'pub struct ServertoolRegistryRegistrationActionInput',
    'pub enum ServertoolRegistryRegistrationAction',
    'pub fn plan_servertool_registry_registration_action',
    'RegisterAdhoc',
    'ReturnAdhoc',
    'ServertoolRegistrySourceKind::Adhoc',
    'pub ad_hoc_names',
    'pub ad_hoc_auto_handler_names',
    'pub ad_hoc_records',
  ]) {
    if (rustRegistry.includes(marker)) {
      fail(
        'servertool-registry-rust-no-adhoc-owner',
        `registry_contract.rs must not retain retired ad-hoc registry marker ${marker}`
      );
    }
  }
  assertContains(
    'servertool-registry-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod registry_contract'
  );
  for (const needle of [
    'plan_servertool_registry_lookup_action_json',
    'plan_servertool_registry_auto_hook_descriptors_json',
    'plan_servertool_registry_projection_json',
    'plan_servertool_registry_source_projection_json',
  ]) {
    assertContains('servertool-registry-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, needle);
    assertContains('servertool-registry-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, `pub fn ${needle}`);
  }
  for (const needle of [
    'planServertoolRegistryLookupActionJson',
    'planServertoolRegistryAutoHookDescriptorsJson',
    'planServertoolRegistryProjectionJson',
    'planServertoolRegistrySourceProjectionJson',
    'planServertoolRegistryLookupFromSkeletonJson',
    'resolveServertoolRegisteredNameJson',
  ]) {
    assertContains('servertool-registry-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, needle);
  }
  for (const needle of [
    'planServertoolRegistryLookupActionWithNative',
  ]) {
    assertContains('servertool-registry-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, needle);
  }
  for (const marker of [
    'plan_servertool_registry_registration_action_json',
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryRegistrationActionJson',
    'ServertoolRegistryRegistrationActionPlan',
    'planServertoolRegistryRegistrationFromSkeletonJson',
  ]) {
    if (
      nativeWrapper.includes(marker) ||
      requiredExports.includes(marker) ||
      napiBlocks.includes(marker) ||
      napiLib.includes(marker) ||
      skeletonConfigRust.includes(marker)
    ) {
      fail(
        'servertool-registry-native-bridge-no-registration-action',
        `servertool registry bridge/skeleton must not retain retired registration action marker ${marker}`
      );
    }
  }
  for (const marker of [
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryLookupActionWithNative',
    'planServertoolRegistryLookupFromSkeleton({',
    'builtinNameMatched',
    'builtinEntryPresent',
    'registrationAllowedByConfig',
    'isServertoolEnabledByConfig',
    'getServertoolToolSpec(name)?.enabled',
    'adHocEntryPresent',
    'register_adhoc',
    'return_adhoc',
    'registerServerToolHandlerViaNativePlan',
    'planServertoolRegistryRegistrationFromSkeleton',
    'hasHandler:',
    'handler: ServerToolHandler',
    'function resolveBuiltinEntry(',
    '.trim().toLowerCase()',
    'isRegisteredServerToolNameViaNativeConfig',
    'isServertoolRegisteredNameByConfig',
    'getServerToolHandlerViaNativePlan',
    'export function listRegisteredServerToolHandlerNames(',
    'export function listRegisteredServerToolHandlerRecords(',
    'export function isRegisteredServerToolName(',
    'resolveServertoolRegisteredNameWithNative',
    'export {\n  type ServerToolAutoHookDescriptor,',
    "if (actionPlan.action === 'return_builtin')",
  ]) {
    if (registryOrchestrationShell.includes(marker)) {
      fail(
        'servertool-registry-orchestration-shell',
        `registry-orchestration-shell.ts must not retain TS registry action precondition marker ${marker}`
      );
    }
  }
  for (const marker of [
    'ServerToolAdHocExecutionDescriptor',
    "kind: 'adhoc'",
    'handler: ServerToolHandler',
    '| ServerToolAdHocExecutionDescriptor',
  ]) {
    if (servertoolTypes.includes(marker)) {
      fail(
        'servertool-types-no-adhoc-execution',
        `types.ts must not retain retired ad-hoc execution marker ${marker}`
      );
    }
  }
  for (const needle of [
    'planServertoolRegistryLookupFromSkeletonWithNative({',
    'switch (actionPlan.action)',
    "case 'return_none':",
    'invalid registry lookup action',
    'planServertoolRegistryBuiltinAutoHookEntriesWithNative({',
  ]) {
    assertContains('servertool-registry-orchestration-shell', TS_REGISTRY_ORCHESTRATION_SHELL, registryOrchestrationShell, needle);
  }
  for (const marker of [
    '[...listBuiltinHandlerNames(), ...listAdHocHandlerNames()]',
    '[...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()]',
    'listAdHocHandler',
    'adHocNames',
    'adHocAutoHandlerEntries',
    'adHocHandlerRecords',
    'builtinEntries',
    'rawRecords = [',
    '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry))',
    '.map((name) => getBuiltinHandlerEntry(name))',
    'projectRegistryHandlerNames({',
    'projectAutoServerToolHandlers({',
    'projectRegisteredServerToolHandlerRecords({',
    'registerServerToolHandler',
    'ServerToolHandler,',
    'type ServerToolHandlerRegistrationSpec',
    'export const listAutoServerToolHandlers',
    'export function listRegisteredServerToolHandlerNames(',
    'export function listRegisteredServerToolHandlerRecords(',
    'projectCurrentRegistrySources',
    'projectRegistrySources',
    'listBuiltinHandlerNames',
    'listBuiltinHandlerRecordEntries',
    "from './registry-projection-shell.js'",
    'projectAutoServerToolHookDescriptors',
  ]) {
    if (registryOrchestrationShell.includes(marker)) {
      fail(
        'servertool-registry-orchestration-no-ts-source-merge',
        `registry-orchestration-shell.ts must not retain TS registry source composition marker ${marker}`
      );
    }
  }
  pass(
    'servertool-registry-orchestration-no-ts-source-merge',
    'registry-orchestration-shell.ts consumes native builtin auto-hook entries without TS registry projection shell'
  );
  for (const keyword of [
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryLookupActionWithNative',
    'planServertoolRegistryProjectionWithNative',
    'native registry auto handler order missing entry',
    'native registry record projection mismatch',
    'native registry lookup returned builtin without canonicalName',
    'native registry auto-hook descriptor missing entry',
    'descriptor.sourceIndex',
    'if (!actionPlan.canonicalName)',
    'if (builtinEntry) {',
    'return getAdHocHandlerEntry(canonicalName);',
    'registerServerToolHandler',
    'ServerToolHandler,',
    "phase: entry.autoHook?.phase ?? 'default'",
    "priority: entry.autoHook?.priority ?? 100",
    "order: entry.autoHook?.order ?? 0",
    'new Set([...listBuiltinHandlerNames(), ...listAdHocHandlerNames()])',
    '.sort()',
    'return [...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()]',
    "entry.registration.trigger === 'tool_call'",
    "entry.registration.trigger === 'auto'",
  ]) {
    if (registryOrchestrationShell.includes(keyword)) {
      fail(
        'servertool-registry-no-ts-owner',
        `Forbidden TS registry selection semantic "${keyword}" found in registry-orchestration-shell.ts`
      );
    }
  }
  pass(
    'servertool-registry-no-ts-owner',
    'registry-orchestration-shell.ts delegates register/get action selection to Rust native plan without registry facade files'
  );
  assertContains(
    'servertool-registry-no-ts-owner',
    TS_REGISTRY_ORCHESTRATION_SHELL,
    registryOrchestrationShell,
    'name: actionPlan.canonicalName'
  );
}

function checkServertoolEntryPreflightRustOwner() {
  const rustEntryPreflight = readRequired(RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT);
  const rustEnginePrepass = readRequired(RUST_SERVERTOOL_ENGINE_PREPASS_ACTION_CONTRACT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'feature_id: hub.servertool_server_side_tool_entry_contract',
    'pub struct ServertoolEntryPreflightInput',
    'pub struct ServertoolEntryPreflightPlan',
    'pub fn plan_servertool_entry_preflight',
    'pub struct ServertoolEntryContextInput',
    'pub struct ServertoolEntryContextPlan',
    'pub fn plan_servertool_entry_context',
  ]) {
    assertContains('servertool-entry-preflight-rust-owner', RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT, rustEntryPreflight, needle);
  }
  for (const needle of [
    'feature_id: hub.servertool_engine_prepass_action_contract',
    'pub struct ServertoolEnginePrepassActionInput',
    'pub struct ServertoolEnginePrepassActionPlan',
    'pub fn plan_servertool_engine_prepass_action',
  ]) {
    assertContains('servertool-engine-prepass-action-rust-owner', RUST_SERVERTOOL_ENGINE_PREPASS_ACTION_CONTRACT, rustEnginePrepass, needle);
  }
  assertContains(
    'servertool-entry-preflight-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod server_side_tool_entry_contract'
  );
  assertContains(
    'servertool-engine-prepass-action-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod engine_prepass_action_contract'
  );
  assertContains(
    'servertool-entry-preflight-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_entry_preflight_json'
  );
  assertContains(
    'servertool-entry-context-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_entry_context_json'
  );
  assertContains(
    'servertool-engine-prepass-action-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_engine_prepass_action_json'
  );
  assertContains(
    'servertool-entry-preflight-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_entry_preflight_json'
  );
  assertContains(
    'servertool-entry-context-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_entry_context_json'
  );
  assertContains(
    'servertool-engine-prepass-action-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_engine_prepass_action_json'
  );
  assertContains(
    'servertool-entry-preflight-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolEntryPreflightJson'
  );
  assertContains(
    'servertool-entry-context-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolEntryContextJson'
  );
  assertContains(
    'servertool-engine-prepass-action-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolEnginePrepassActionJson'
  );
  assertContains(
    'servertool-entry-preflight-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolEntryPreflightWithNative'
  );
  assertContains(
    'servertool-entry-preflight-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'readServertoolEntryBaseObjectWithNative'
  );
  assertContains(
    'servertool-entry-context-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolEntryContextWithNative'
  );
  assertContains(
    'servertool-engine-prepass-action-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolEnginePrepassActionWithNative'
  );
  assertContains(
    'servertool-entry-preflight-ts-thin-shell',
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    'isAdapterClientDisconnectedWithNative(args.options.adapterContext)'
  );
  assertContains(
    'servertool-entry-preflight-ts-thin-shell',
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    'readServertoolEntryBaseObjectWithNative(args.options.chatResponse)'
  );
  assertContains(
    'servertool-entry-preflight-ts-thin-shell',
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    'hasBaseObject: base != null'
  );
  for (const marker of [
    'Boolean(base)',
    "args.options.chatResponse && typeof args.options.chatResponse === 'object'",
    "args.options.chatResponse != null && typeof args.options.chatResponse === 'object'",
    'args.options.chatResponse as JsonObject',
    'base as JsonObject',
    'entryPreflightPlan as { action: unknown }',
  ]) {
    if (!readRequired(TS_ENTRY_PREFLIGHT_SHELL).includes(marker)) {
      continue;
    }
    fail(
      'servertool-entry-preflight-ts-thin-shell',
      `entry-preflight-shell.ts must not use TS truthiness marker ${marker} for native presence facts`
    );
  }
  pass('servertool-entry-preflight-no-ts-owner', 'entry preflight TS semantics stay out of deleted server-side-tools facade');
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
  for (const needle of [
    "record.action === 'rerun_excluding_primary_hooks'",
    "throw new Error('planEngineSelectionAfterRunJson native returned overrides for return_current action')",
  ]) {
    assertContains(
      'servertool-engine-selection-native-bridge',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      needle
    );
  }
  assertContains(
    'servertool-engine-selection-ts-thin-shell',
    TS_ENGINE_SELECTION,
    engineSelectionShell,
    'readServertoolPrimaryAutoHookIdsWithNative'
  );
  for (const keyword of [
    'SERVERTOOL_ENGINE_SELECTION_FEATURE_ID',
    'primaryAutoHookIds.length',
    'engineResult.mode',
    '!engineResult.execution',
    "mode === 'passthrough'",
    'function toEngineOverrides(',
    'planServertoolSkeletonDerivedConfigWithNative',
    'autoHookQueueConfig as',
    'optionalPrimaryOrder: string[]',
    'primaryAutoHookAttempt:',
    'disableToolCallHandlers: true',
    'includeAutoHookIds: primaryAutoHookIds',
    'excludeAutoHookIds: primaryAutoHookIds',
    'typeof startPlan.overrides.disableToolCallHandlers',
    'Array.isArray(startPlan.overrides.includeAutoHookIds)',
    'Array.isArray(startPlan.overrides.excludeAutoHookIds)',
    'typeof overrides.disableToolCallHandlers',
    'Array.isArray(overrides.includeAutoHookIds)',
    'Array.isArray(overrides.excludeAutoHookIds)',
    "if (afterRunPlan.action === 'rerun_excluding_primary_hooks')",
    'String(afterRunPlan.action)',
    'afterRunPlan.overrides ?? {}',
  ]) {
    if (engineSelectionShell.includes(keyword)) {
      fail(
        'servertool-engine-selection-no-ts-owner',
        `Forbidden TS engine selection semantic "${keyword}" found in engine-selection-block.ts`
      );
    }
  }
  assertContains(
    'servertool-engine-selection-ts-thin-shell',
    TS_ENGINE_SELECTION,
    engineSelectionShell,
    'switch (afterRunPlan.action)'
  );
  assertContains(
    'servertool-engine-selection-ts-thin-shell',
    TS_ENGINE_SELECTION,
    engineSelectionShell,
    'return await args.runEngine(afterRunPlan.overrides);'
  );
  pass(
    'servertool-engine-selection-no-ts-owner',
    'engine-selection-block.ts is native-plan shell for primary hook first-pass and rerun decisions'
  );
}

function checkServertoolFlowPresentationRustOwner() {
  const rustSkeletonConfig = readRequired(`${RUST_SRC_DIR}/servertool_skeleton_config.rs`);
  const progressLogShell = readRequired(`${SERVERTOOL_TS_DIR}/progress-log-block.ts`);
  const nativeWrapper = readRequired(NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const needle of [
    'pub fn resolve_servertool_progress_tool_name_json',
    'pub fn should_use_servertool_gold_progress_highlight_json',
    'pub fn resolve_servertool_progress_stage_json',
    'pub fn normalize_servertool_progress_result_json',
    'pub fn normalize_servertool_progress_token_json',
    'pub fn normalize_servertool_progress_flow_id_json',
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
    'resolveServertoolProgressStageJson',
    'normalizeServertoolProgressResultJson',
    'normalizeServertoolProgressTokenJson',
    'normalizeServertoolProgressFlowIdJson',
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
    'resolveServertoolProgressStageWithNative',
    'normalizeServertoolProgressResultWithNative',
    'normalizeServertoolProgressTokenWithNative',
    'normalizeServertoolProgressFlowIdWithNative',
  ]) {
    assertContains(
      'servertool-flow-presentation-native-bridge',
      NATIVE_CHAT_PROCESS_SERVERTOOL_ORCHESTRATION_WRAPPER,
      nativeWrapper,
      needle
    );
    assertContains(
      'servertool-flow-presentation-ts-thin-shell',
      `${SERVERTOOL_TS_DIR}/progress-log-block.ts`,
      progressLogShell,
      needle
    );
  }
  for (const keyword of [
    'extra.flowId.trim()',
    'flowId.trim()',
  ]) {
    if (progressLogShell.includes(keyword)) {
      fail(
        'servertool-flow-presentation-no-ts-owner',
        `Forbidden TS progress flow id normalization "${keyword}" found in progress-log-block.ts`
      );
    }
  }
  if (existsSync(TS_FLOW_PRESENTATION)) {
    fail(
      'servertool-flow-presentation-no-ts-owner',
      'flow-presentation-block.ts must stay deleted after direct native import closeout'
    );
  }
  for (const keyword of [
    'buildServertoolProgressConfig',
    'progressConfig:',
    'toolNameByFlowId:',
    'goldHighlightFlowIds:',
    'function resolveStage(',
    'function normalizeResult(',
    'event.reason.trim().toLowerCase().replace',
    'compareContext.reason.toLowerCase().replace',
  ]) {
    if (progressLogShell.includes(keyword)) {
      fail(
        'servertool-flow-presentation-no-skeleton-ts-owner',
        `Forbidden TS progress presentation semantic "${keyword}" found in progress shell`
      );
    }
  }
  pass(
    'servertool-flow-presentation-no-ts-owner',
    'flow-presentation-block.ts stays deleted; progress-log-block.ts directly uses native flow presentation wrappers'
  );
  pass(
    'servertool-flow-presentation-no-skeleton-ts-owner',
    'skeleton-config.ts is deleted and progress-log-block.ts has no progress presentation projection owner'
  );
}

// ── Check 14: backend-route policy surface is retired ─────────
function checkBackendRoutePolicyRustOwner() {
  const outcomeContract = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);

  for (const file of DELETED_BACKEND_ROUTE_POLICY_FILES) {
    assertMissingFile(
      'backend-route-policy-retired',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted after backend-route policy retirement`
    );
  }
  for (const [file, source] of [
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`, outcomeContract],
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
    [NATIVE_REQUIRED_EXPORTS, requiredExports],
  ]) {
    for (const marker of [
      'BackendRouteReenter',
      'ServertoolBackendRoute',
      'planServertoolBackendRoutePolicy',
      'planServertoolBackendRoutePolicyJson',
      'backend_route_contract',
      'plan_servertool_backend_route_policy',
      'ServertoolBackendRouteHint01Planned',
      'build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03',
    ]) {
      if (source.includes(marker)) {
        fail(
          'backend-route-policy-retired',
          `${file.replace(`${ROOT}/`, '')} must not retain retired backend-route policy marker ${marker}`
        );
      }
    }
  }
  assertMissing(
    'backend-route-outcome-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    outcomeContract,
    '"web_search" | "vision_auto" => Some(ServertoolOutcome::BackendRouteReenter)'
  );
  assertMissing(
    'backend-route-outcome-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`,
    outcomeContract,
    '"memory_cache_auto" => Some(ServertoolOutcome::ServerIoInternal)'
  );
  for (const file of [
    TS_BACKEND_ROUTE_SHAPE_GUARD,
    TS_BACKEND_ROUTE_FINALIZE,
    TS_BACKEND_ROUTE_FLOW_POLICY,
    TS_BACKEND_ROUTE_ORIGIN_DELTA,
    TS_BACKEND_ROUTE_RESPONSE,
    TS_BACKEND_ROUTE_SHADOW,
    `${SERVERTOOL_TS_DIR}/backend-route-seed.ts`,
    `${SERVERTOOL_TS_DIR}/backend-route-mainline-block.ts`,
    TS_BACKEND_ROUTE_REENTER,
    TS_BACKEND_ROUTE_BOOTSTRAP_REPLAY,
  ]) {
    if (existsSync(file)) {
      fail(
        'backend-route-ts-shells-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted after web/vision backend-route retirement`
      );
    }
  }
  pass(
    'backend-route-policy-retired',
    'web_search/vision_auto backend-route reenter is retired; old TS backend-route shells stay deleted'
  );
}

// ── Check 15: servertool text extraction has Rust owner ───────
function checkServertoolTextExtractionRustOwner() {
  const rustTextExtraction = readRequired(RUST_SERVERTOOL_TEXT_EXTRACTION);
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
  const servertoolEngine = readRequired(TS_ENGINE_ORCHESTRATION_SHELL);

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
  for (const [file, content] of [
    [STOP_MESSAGE_AUTO_HANDLER, stopMessageHandler],
    [TS_ENGINE_ORCHESTRATION_SHELL, servertoolEngine],
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

// ── Check 15d: stopless orchestration action has Rust owner ───
function checkStoplessOrchestrationActionRustOwner() {
  const rustStoplessOrchestration = readRequired(RUST_SERVERTOOL_STOPLESS_ORCHESTRATION);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const servertoolEngine = readRequired(TS_ENGINE_ORCHESTRATION_SHELL);

  for (const [check, file, content, needle] of [
    ['stopless-orchestration-action-rust-owner', RUST_SERVERTOOL_STOPLESS_ORCHESTRATION, rustStoplessOrchestration, 'pub fn plan_stopless_orchestration_action'],
    ['stopless-orchestration-action-rust-owner', RUST_SERVERTOOL_STOPLESS_ORCHESTRATION, rustStoplessOrchestration, 'pub fn plan_stopless_execution'],
    ['stopless-orchestration-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_stopless_execution_json'],
    ['stopless-orchestration-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_stopless_execution_json'],
    ['stopless-orchestration-action-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planStoplessExecutionJson'],
    ['stopless-orchestration-action-thin-shell', TS_ENGINE_ORCHESTRATION_SHELL, servertoolEngine, 'function planStoplessEngineRuntime('],
    ['stopless-orchestration-action-thin-shell', TS_ENGINE_ORCHESTRATION_SHELL, servertoolEngine, 'const stoplessExecutionPlan = planStoplessExecutionWithNative({'],
    ['stopless-orchestration-action-thin-shell', TS_ENGINE_ORCHESTRATION_SHELL, servertoolEngine, 'const { stoplessExecution, runtimeAction } = planStoplessEngineRuntime({'],
    ['stopless-orchestration-action-thin-shell', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'export function planStoplessExecutionWithNative'],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const keyword of [
    'planStoplessExecutionWithNativeLocal',
    "readNativeFunction('planStoplessExecutionJson')",
    'planStoplessOrchestrationActionWithNative',
    "readNativeFunction('planStoplessOrchestrationActionJson')",
    'const stoplessExecutionInput = {',
    'const hasServertoolCliProjectionContext =',
    'planStoplessExecutionWithNative(stoplessExecutionInput)',
    'requestTruth: { sessionId: requestTruthSessionId }',
    'const requestTruth = metadataCenterSnapshot?.requestTruth',
    'const rawSessionId = requestTruth?.sessionId',
    'requestTruthSessionId,',
    'stopless: {',
    'executionContext',
    'stoplessExecution.context',
    '.servertoolCliProjection',
    'executionContext?.stopless',
    'function isStopMessageTerminalFinal',
    'stopMessageTerminalFinal === true',
  ]) {
    if (servertoolEngine.includes(keyword)) {
      fail(
        'stopless-orchestration-action-no-ts-owner',
        `Forbidden TS stopless orchestration semantic "${keyword}" found in ${TS_ENGINE_ORCHESTRATION_SHELL.replace(`${ROOT}/`, '')}`
      );
    }
  }
  pass('stopless-orchestration-action-rust-owner', 'servertool-core owns stopless CLI/terminal/followup action planning');
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
  const executorMetadataSpec = readRequired(`${ROOT}/tests/server/http-server/executor-metadata.spec.ts`);

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
    'servertool-cli-result-route-hint-rust-owner',
    RUST_SERVERTOOL_CLI_RESULT_GUARD,
    rustCliResultGuard,
    'pub fn extract_servertool_cli_result_route_hint_from_request'
  );
  assertContains(
    'servertool-cli-result-guard-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'has_stop_message_auto_cli_result_in_request_json'
  );
  assertContains(
    'servertool-cli-result-route-hint-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'extract_servertool_cli_result_route_hint_from_request_json'
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
    'servertool-cli-result-route-hint-native-wrapper',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeServertoolWrapper,
    'extractServertoolCliResultRouteHintFromRequestWithNative'
  );
  assertContains(
    'servertool-cli-result-route-hint-spec',
    `${ROOT}/tests/server/http-server/executor-metadata.spec.ts`,
    executorMetadataSpec,
    "uses servertool web_search CLI result routeHint from submitted tool output"
  );
  assertContains(
    'servertool-cli-result-route-hint-spec',
    `${ROOT}/tests/server/http-server/executor-metadata.spec.ts`,
    executorMetadataSpec,
    "expect(metadata.routeHint).toBe('multimodal')"
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

function checkStoplessNoContextDataPlane() {
  const runtimeFiles = [
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/types.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_auto_handler.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_compare_context.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_decision_context_signals.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_learned_note_contract.rs`,
    `${ROOT}/sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`,
    `${ROOT}/src/server/runtime/http-server/executor/provider-response-converter.ts`,
  ];
  const forbidden = [
    'requestSemantics',
    'request_semantics',
    'capturedRequest',
    'captured_request',
    'hasCapturedRequest',
    'has_captured_request',
    '__raw_request_body',
    'capturedChatRequest',
    'capturedEntryRequest',
    'responsesRequestContext',
  ];
  for (const file of runtimeFiles) {
    const raw = readRequired(file);
    const runtimeSource = file.endsWith('.rs') ? raw.split('#[cfg(test)]')[0] : raw;
    for (const marker of forbidden) {
      if (!runtimeSource.includes(marker)) continue;
      fail(
        'stopless-no-context-data-plane',
        `${file.replace(`${ROOT}/`, '')} must not use context/data-plane marker ${marker}; stopless/servertool state must come from MetadataCenter runtime_control only`
      );
    }
  }
  const persistedLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP).split('#[cfg(test)]')[0];
  for (const marker of [
    'resolve_stopless_cli_result_snapshot_from_request',
    'resolve_stopless_cli_result_snapshot_from_responses_resume',
    'resolve_stopless_cli_result_snapshot_from_runtime_metadata',
    'read_stopless_cli_result_snapshot_from_tool_output_details',
    'pub adapter_context: Value',
  ]) {
    if (persistedLookup.includes(marker)) {
      fail(
        'stopless-no-context-data-plane',
        `persisted_lookup.rs must not restore stopless state from request/continuation data-plane helper ${marker}`
      );
    }
  }
  const stoplessBridge = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`).split('#[cfg(test)]')[0];
  for (const marker of [
    'pub adapter_context: Value',
    '"adapterContext": adapter_context',
    '"adapterContext": Value::Object',
  ]) {
    if (stoplessBridge.includes(marker)) {
      fail(
        'stopless-no-context-data-plane',
        `stopless_auto_handler_bridge.rs must not use adapterContext runtime input marker ${marker}`
      );
    }
  }
  const learnedNote = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_learned_note_contract.rs`).split('#[cfg(test)]')[0];
  for (const marker of [
    'adapter_context',
    'resolve_working_directory_from_adapter_context',
  ]) {
    if (learnedNote.includes(marker)) {
      fail(
        'stopless-no-context-data-plane',
        `stopless_learned_note_contract.rs must not derive learned-note control fields from adapterContext marker ${marker}`
      );
    }
  }
  const entryContextShell = readRequired(`${SERVERTOOL_TS_DIR}/entry-context-shell.ts`);
  for (const marker of [
    "from '../conversion/runtime-metadata.js'",
    'readRuntimeMetadata(',
  ]) {
    if (entryContextShell.includes(marker)) {
      fail(
        'stopless-no-context-data-plane',
        `entry-context-shell.ts must not restore servertool runtime metadata from internal meta marker ${marker}; use MetadataCenter snapshot only`
      );
    }
  }
  pass(
    'stopless-no-context-data-plane',
    'stopless/servertool runtime path does not carry requestSemantics/raw/context payload state'
  );
}

function checkDeletedStoplessMetadataWriterAbsent() {
  const deletedWriter = `${SERVERTOOL_TS_DIR}/stopless-metadata-center-writer.ts`;
  if (existsSync(deletedWriter)) {
    fail(
      'deleted-stopless-metadata-writer-absent',
      `${deletedWriter.replace(`${ROOT}/`, '')} must stay deleted; MetadataCenter writes use the generic runtime_control writer`
    );
  }

  const scanFiles = [
    ...listFiles(SERVERTOOL_TS_DIR),
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`,
    RUST_ROUTER_HOTPATH_NAPI_LIB,
  ].filter((file) => existsSync(file));
  for (const file of scanFiles) {
    const content = readFileSync(file, 'utf8');
    for (const marker of [
      'applyStoplessMetadataCenterWritePlan',
      'buildStoplessMetadataCenterWritePlanJson',
      'build_stopless_metadata_center_write_plan_json_bridge',
      'stopless-metadata-center-writer',
    ]) {
      if (content.includes(marker)) {
        fail(
          'deleted-stopless-metadata-writer-absent',
          `Forbidden stopless-specific MetadataCenter writer marker "${marker}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }

  pass(
    'deleted-stopless-metadata-writer-absent',
    'stopless-specific TS MetadataCenter writer and NAPI export stay deleted'
  );
}

function checkDeletedStopMessageTsOwnersAbsent() {
  const deletedOwners = [
    `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto.ts`,
    `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/config.ts`,
    `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/runtime-utils.ts`,
    `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/routing-state.ts`,
    `${SERVERTOOL_TS_DIR}/handlers/stop-message-auto/blocked-report.ts`,
    `${SERVERTOOL_TS_DIR}/stop-message-counter.ts`,
  ];
  for (const file of deletedOwners) {
    if (existsSync(file)) {
      fail(
        'deleted-stop-message-ts-owners-absent',
        `${file.replace(`${ROOT}/`, '')} must stay deleted; stopless runtime and counter semantics are Rust-owned`
      );
    }
  }
  const rustLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);

  for (const [check, file, content, needle] of [
    [
      'stop-message-metadata-center-runtime-state-rust-owner',
      RUST_SERVERTOOL_CORE_LOOKUP,
      rustLookup,
      'pub struct RuntimeStopMessageStateFromMetadataCenterInput',
    ],
    [
      'stop-message-metadata-center-runtime-state-rust-owner',
      RUST_SERVERTOOL_CORE_LOOKUP,
      rustLookup,
      'pub fn resolve_runtime_stop_message_state_from_metadata_center',
    ],
    [
      'stop-message-metadata-center-runtime-state-native-export',
      `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
      napiBlocks,
      'resolve_runtime_stop_message_state_from_metadata_center_json',
    ],
    [
      'stop-message-metadata-center-runtime-state-native-export',
      RUST_ROUTER_HOTPATH_NAPI_LIB,
      napiLib,
      'resolve_runtime_stop_message_state_from_metadata_center_json',
    ],
    [
      'stop-message-metadata-center-runtime-state-required-export',
      NATIVE_REQUIRED_EXPORTS,
      requiredExports,
      'resolveRuntimeStopMessageStateFromMetadataCenterJson',
    ],
    [
      'stop-message-metadata-center-runtime-state-wrapper',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      'RuntimeStopMessageStateFromMetadataCenterInput',
    ],
    [
      'stop-message-metadata-center-runtime-state-wrapper',
      NATIVE_SERVERTOOL_CORE_WRAPPER,
      nativeWrapper,
      'resolveRuntimeStopMessageStateFromMetadataCenterWithNative',
    ],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const [file, content] of [
    [RUST_SERVERTOOL_CORE_LOOKUP, rustLookup],
    [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks],
    [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib],
    [NATIVE_REQUIRED_EXPORTS, requiredExports],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
  ]) {
    for (const marker of [
      'RuntimeStopMessageStateFromAdapterContext',
      'resolve_runtime_stop_message_state_from_adapter_context',
      'resolveRuntimeStopMessageStateFromAdapterContext',
    ]) {
      if (content.includes(marker)) {
        fail(
          'stop-message-adapter-context-runtime-state-deleted',
          `${file.replace(`${ROOT}/`, '')} must not revive adapter-context stopless runtime state marker "${marker}"`
        );
      }
    }
  }
  pass(
    'deleted-stop-message-ts-owners-absent',
    'deleted stop-message TS owners stay absent and runtime state is MetadataCenter-native'
  );
}

function checkStopGatewayMetadataCenterOnly() {
  for (const file of DELETED_STOP_CONTEXT_WRAPPER_TS_FILES) {
    if (existsSync(file)) {
      fail(
        'stop-context-wrapper-ts-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; control wrappers are consolidated into metadata-center-carrier.ts`
      );
    }
  }
  const stopGatewayContext = readRequired(TS_METADATA_CENTER_CARRIER);
  for (const marker of [
    "from '../conversion/runtime-metadata.js'",
    'ensureRuntimeMetadata',
    'readRuntimeMetadata(',
    '__rt',
    'export function readRuntimeControlFromBoundMetadataCenter(',
    'export function readRequestTruthSessionIdFromBoundMetadataCenter(',
  ]) {
    if (stopGatewayContext.includes(marker)) {
      fail(
        'stop-gateway-metadata-center-only',
        `metadata-center-carrier.ts must not use legacy runtime metadata marker ${marker}; stopGatewayContext belongs to MetadataCenter runtime_control`
      );
    }
  }
  for (const marker of [
    'writeRuntimeControlToBoundMetadataCenter',
    "key: 'stopGatewayContext'",
    'readRuntimeControlFromAnyBoundMetadataCenter',
  ]) {
    if (!stopGatewayContext.includes(marker)) {
      fail(
        'stop-gateway-metadata-center-only',
        `metadata-center-carrier.ts must use MetadataCenter runtime_control marker ${marker}`
      );
    }
  }

  const providerResponse = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`);
  for (const marker of [
    'attachRustStopGatewayContextToRuntimeMetadata',
    'contextRecord.__rt',
  ]) {
    if (providerResponse.includes(marker)) {
      fail(
        'stop-gateway-metadata-center-only',
        `provider-response.ts must not revive legacy stop-gateway runtime metadata marker ${marker}`
      );
    }
  }
  if (!providerResponse.includes('writeRustStopGatewayContextToMetadataCenter')) {
    fail(
      'stop-gateway-metadata-center-only',
      'provider-response.ts must write Rust stopGatewayContext through MetadataCenter runtime_control'
    );
  }

  const routerGate = readRequired(`${RUST_SRC_DIR}/chat_servertool_orchestration.rs`).split('#[cfg(test)]')[0];
  const stopEligibleStart = routerGate.indexOf('fn read_stop_eligible_from_gate_input');
  const stopEligibleEnd = routerGate.indexOf('fn read_stop_gateway_context_from_runtime_control', stopEligibleStart);
  const stopEligibleBlock = stopEligibleStart >= 0 && stopEligibleEnd > stopEligibleStart
    ? routerGate.slice(stopEligibleStart, stopEligibleEnd)
    : '';
  if (stopEligibleBlock.includes('rt.get("stopGatewayContext")') || stopEligibleBlock.includes('get("__rt")')) {
    fail(
      'stop-gateway-metadata-center-only',
      'chat_servertool_orchestration.rs must not read stopGatewayContext from adapterContext.__rt'
    );
  }
  if (!stopEligibleBlock.includes('row.get("stopGatewayContext")')) {
    fail(
      'stop-gateway-metadata-center-only',
      'chat_servertool_orchestration.rs must read stopGatewayContext from runtime_control'
    );
  }

  const persistedLookup = readRequired(RUST_SERVERTOOL_CORE_LOOKUP).split('#[cfg(test)]')[0];
  if (persistedLookup.includes('get("__rt")') && persistedLookup.includes('stopGatewayContext')) {
    fail(
      'stop-gateway-metadata-center-only',
      'persisted_lookup.rs must not read stopGatewayContext from legacy __rt'
    );
  }

  pass(
    'stop-gateway-metadata-center-only',
    'stopGatewayContext uses MetadataCenter runtime_control, not __rt/runtime-metadata carriers'
  );
}

function checkStoplessNoTsRuntimeControlSpecialization() {
  const scanFiles = [
    `${SERVERTOOL_TS_DIR}/metadata-center-carrier.ts`,
    `${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`,
    `${SERVERTOOL_TS_DIR}/engine-postflight-shell.ts`,
    `${ROOT}/sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`,
  ];
  for (const file of scanFiles) {
    const content = readRequired(file);
    for (const marker of [
      'writeStoplessRuntimeControlToBoundMetadataCenter',
      'readStoplessRuntimeControlFromAnyBoundMetadataCenter',
      'StoplessRuntimeControlValue',
      'adapterContextForRust',
      'fallbackSkip(',
      "skipReason: 'native_unavailable'",
      "skipReason: 'native_returned_non_string'",
      "skipReason: 'native_parse_failed'",
    ]) {
      if (content.includes(marker)) {
        fail(
          'stopless-no-ts-runtime-control-specialization',
          `Forbidden stopless TS runtime-control/context/fallback marker "${marker}" found in ${file.replace(`${ROOT}/`, '')}`
        );
      }
    }
  }
  const engineShell = readRequired(TS_ENGINE_ORCHESTRATION_SHELL);
  assertMissing(
    'stopless-no-ts-runtime-control-specialization',
    TS_ENGINE_ORCHESTRATION_SHELL,
    engineShell,
    'options.adapterContext as Record<string, unknown>'
  );
  assertMissing(
    'stopless-no-ts-runtime-control-specialization',
    TS_ENGINE_ORCHESTRATION_SHELL,
    engineShell,
    'options.adapterContext as unknown as Record<string, unknown>'
  );
  if (!engineShell.includes('readRuntimeControlFromAnyBoundMetadataCenter(')) {
    fail(
      'stopless-no-ts-runtime-control-specialization',
      'engine-orchestration-shell.ts must pass generic runtime_control to Rust, not a TS-parsed stopless control shape'
    );
  }
  pass(
    'stopless-no-ts-runtime-control-specialization',
    'stopless runtime_control stays generic in TS and native failures stay fail-fast'
  );
}

function checkServertoolRustOutcomeCloseout() {
  const rustOutcome = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`);
  const rustCli = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`);
  const resultRestoreSpec = readRequired(`${ROOT}/tests/servertool/servertool-cli-result-restore.spec.ts`);
  const executionStageShell = readRequired(TS_EXECUTION_STAGE_SHELL);

  for (const needle of [
    'pub enum ServertoolOutcome',
    'ServertoolClientExecCliProjection01Planned',
    'ServertoolServerIoInternal01Observed',
    'pub fn build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03',
    'pub fn build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03',
    'fake_exec',
    'servertool_fixture',
    'web_search',
    'vision_auto',
  ]) {
    assertContains('servertool-outcome-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/outcome_contract.rs`, rustOutcome, needle);
  }

  for (const needle of [
    'pub struct ServertoolCliRunInput',
    'pub struct ServertoolCliRunOutput',
    'build_servertool_cli_binary_run_command_from_client_exec_result',
    'stopless_schema_guidance()',
    'SERVERTOOL_UNSUPPORTED_TOOL',
    '停止检查已收敛',
    'SERVERTOOL_CLI_MISSING_FIELD: flowId',
    'SERVERTOOL_DENIED_TOOL: fake_exec',
  ]) {
    assertContains('servertool-cli-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`, rustCli, needle);
  }
  if (rustCli.includes('stopless budget exhausted')) {
    fail(
      'servertool-cli-rust-owner',
      `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs must not expose internal stopless budget text`
    );
  }

  for (const file of DELETED_SERVERTOOL_CLI_PROJECTION_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-cli-projection-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted`
      );
    }
  }
  for (const file of DELETED_SERVERTOOL_ROOT_FACADE_FILES) {
    if (existsSync(file)) {
      fail(
        'servertool-root-facade-deleted',
        `${file.replace(`${ROOT}/`, '')} must stay physically deleted; callers must import the concrete Rust/native shell owner`
      );
    }
  }
  for (const marker of ['reenterPipeline', 'providerInvoker', 'serverToolFollowup', 'serverToolFollowupSource', '--ticket', 'stcli_', 'rcc_cli_']) {
    if (executionStageShell.includes(marker)) {
      fail('servertool-cli-runtime-shell', `execution-stage-shell.ts must not carry legacy servertool marker ${marker}`);
    }
  }
  if (executionStageShell.includes('}\n\n  return finalizeServertoolResponseStage({')) {
    fail(
      'servertool-execution-stage-no-implicit-finalize',
      'execution-stage-shell.ts must finalize only from explicit native continue_response_stage action'
    );
  }
  if (!executionStageShell.includes("case 'continue_response_stage':")) {
    fail(
      'servertool-execution-stage-explicit-continue-response-stage',
      'execution-stage-shell.ts must explicitly consume native continue_response_stage action'
    );
  }
  for (const marker of ['memory_cache_auto', 'executeServertoolBackendPlan']) {
    if (executionStageShell.includes(marker)) {
      fail(
        'servertool-cli-runtime-shell',
        `execution-stage-shell.ts must not revive retired marker ${marker}`
      );
    }
  }

  if (resultRestoreSpec.includes('restore the old CLI restoration implementation')) {
    fail('servertool-cli-result-restore-thin-shell', 'servertool-cli-result-restore.spec.ts must not reintroduce legacy CLI restoration behavior');
  }

  for (const marker of [
    'export function isClientExecCliProjectionToolCall(',
    'export const collectAdditionalClientToolCalls',
    'return isServertoolClientExecCliProjectionToolCallWithNative({',
    'executionMode: toolCall.executionMode',
    'contextBase: args.contextBase as ServerToolHandlerContext',
  ]) {
    if (executionStageShell.includes(marker)) {
      fail(
        'servertool-cli-projection-helper-deleted',
        `execution-stage-shell.ts must not revive deleted helper marker ${marker}`
      );
    }
  }
  for (const marker of [
    'buildServertoolCliProjectionRuntimeBranchWithNative({',
    'mode: branch.resultMode',
    'finalChatResponse: branch.chatResponse',
    'execution: branch.execution',
  ]) {
    if (!executionStageShell.includes(marker)) {
      fail(
        'servertool-cli-projection-thin-shell-guard',
        `execution-stage-shell.ts must keep CLI projection impl guard marker ${marker}`
      );
    }
  }
  for (const marker of [
    'const projectionShellInput = {',
    'buildClientVisibleProjectionShellWithNative(projectionShellInput)',
    'function buildClientVisibleProjectionShellForRuntime(',
    'const projectionInput = parseServertoolCliProjectionToolArgumentsWithNative({',
    'input: parseServertoolCliProjectionToolArgumentsWithNative({',
    'input: projectionInput',
    'const nativeProjection = buildClientExecCliProjectionOutputWithNative({',
    'buildClientExecCliProjectionOutputWithNative',
    'const chatResponse = buildClientVisibleProjectionShellWithNative({',
    'buildClientVisibleProjectionShellWithNative',
    'const execution = buildServertoolCliProjectionExecutionContextWithNative({',
    'buildServertoolCliProjectionExecutionContextWithNative',
    'randomUUID',
    'servertool_cli_projection',
    'reasoningText',
    '继续执行本地 hook',
    "mode: 'tool_flow'",
    'finalChatResponse: branch.chatResponse as JsonObject',
    'execution: branch.execution as {',
  ]) {
    if (executionStageShell.includes(marker)) {
      fail(
        'servertool-cli-projection-runtime-thin-shell',
        `execution-stage-shell.ts must not retain retired projection shell marker ${marker}`
      );
    }
  }
  const extractToolCallsShell = readRequired(TS_EXTRACT_TOOL_CALLS_SHELL);
  for (const marker of [
    'export const extractToolCallsFromResponseStage =',
    'runServertoolResponseStageWithNative',
    "stage.normalizedPayload != null && typeof stage.normalizedPayload === 'object'",
    '? stage.normalizedPayload',
    'replaceJsonObjectInPlace'
  ]) {
    if (!extractToolCallsShell.includes(marker)) {
      fail(
        'servertool-extract-tool-calls-shell-owner',
        `extract-tool-calls-shell.ts must keep extraction owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'function asObject(',
    "stage.normalizedPayload && typeof stage.normalizedPayload === 'object'",
    'stage.normalizedPayload as JsonObject',
  ]) {
    if (extractToolCallsShell.includes(marker)) {
      fail(
        'servertool-extract-tool-calls-shell-owner',
        `extract-tool-calls-shell.ts must not restore local carrier/truthiness marker ${marker}`
      );
    }
  }
  const dispatchPreparationShell = readRequired(TS_DISPATCH_PREPARATION_SHELL);
  for (const marker of [
    "from '../conversion/runtime-metadata.js'",
    'readRuntimeMetadata(',
    'buildServertoolDispatchPlanInput(',
    '...(args.includeToolCallNames ? { includeToolCallHandlerNames: [...args.includeToolCallNames] } : {})',
    '...(args.excludeToolCallNames ? { excludeToolCallHandlerNames: [...args.excludeToolCallNames] } : {})',
    'baseObject: JsonObject;',
    'baseForExecution: JsonObject;',
    'readProviderProtocolFromAnyBoundMetadataCenter',
    'Servertool dispatch preparation requires metadata center runtime_control.providerProtocol',
    'args.options.adapterContext as Record<string, unknown>',
  ]) {
    if (dispatchPreparationShell.includes(marker)) {
      fail(
        'servertool-dispatch-preparation-metadata-center-only',
        `dispatch-preparation-shell.ts must use MetadataCenter snapshot instead of runtime metadata marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export function prepareServertoolDispatchStage(',
    'readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter',
    'planServertoolToolCallDispatchWithNative',
    'buildServertoolDispatchPlanInputWithNative',
    'dispatchPlan: planServertoolToolCallDispatchWithNative('
  ]) {
    if (!dispatchPreparationShell.includes(marker)) {
      fail(
        'servertool-dispatch-preparation-shell-owner',
        `dispatch-preparation-shell.ts must keep dispatch preparation owner marker ${marker}`
      );
    }
  }
  const enginePreflightShell = readRequired(TS_ENGINE_PREFLIGHT_SHELL);
  const engineOrchestrationShell = readRequired(TS_ENGINE_ORCHESTRATION_SHELL);
  for (const marker of [
    'export async function runServerToolOrchestrationShell(',
    'createProgressObservation({',
    'createServertoolProgressLogger({',
    'runEnginePreflight({',
    'planServertoolEngineSkipWithNative({',
    'recordServertoolEngineMatchSkipped({',
    'recordServertoolEngineMatchHit({',
    'const stoplessExecutionPlan = planStoplessExecutionWithNative({',
    'const runtimeAction = planServertoolEngineRuntimeActionWithNative({',
    'planServertoolEngineTriggerObservationWithNative({',
    'engineResult: {',
    'runServertoolEnginePostflight({',
  ]) {
    if (!engineOrchestrationShell.includes(marker)) {
      fail(
        'servertool-engine-orchestration-shell-owner',
        `engine-orchestration-shell.ts must keep engine orchestration owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'effectiveServerToolTimeoutMs',
    'args.effectiveServerToolTimeoutMs || args.serverToolTimeoutMs',
    'function planStoplessEngineRuntime(',
    'const { stoplessExecution, runtimeAction } = planStoplessEngineRuntime({',
    'function createServerToolEngineRunner(',
    'type ServerToolEngineRunner =',
    'createServertoolObservation({',
    'export const runServerToolOrchestration = runServerToolOrchestrationShell;',
    "from './server-side-tools-impl.js'",
    'readProviderProtocolFromAnyBoundMetadataCenter',
    'providerProtocol: args.providerProtocol',
    'Servertool engine orchestration requires metadata center runtime_control.providerProtocol',
    'Boolean(engineResult.execution)',
    "engineResult.execution && typeof engineResult.execution === 'object'",
    "runtimeControl && typeof runtimeControl === 'object'",
  ]) {
    if (engineOrchestrationShell.includes(marker)) {
      fail(
        'servertool-engine-orchestration-no-dead-timeout-carrier',
        `engine-orchestration-shell.ts must not retain dead timeout carrier marker ${marker}`
      );
    }
  }
  if (/export interface ServerToolOrchestrationOptions\s*\{[\s\S]{0,220}providerProtocol:\s*string;/.test(engineOrchestrationShell)) {
    fail(
      'servertool-engine-orchestration-metadata-center-only',
      'ServerToolOrchestrationOptions must not accept providerProtocol as a second protocol truth'
    );
  }
  for (const marker of [
    "engineResult.execution != null && typeof engineResult.execution === 'object'",
    "runtimeControl != null && typeof runtimeControl === 'object'",
  ]) {
    if (!engineOrchestrationShell.includes(marker)) {
      fail(
        'servertool-engine-orchestration-no-dead-timeout-carrier',
        `engine-orchestration-shell.ts must keep explicit nullish presence marker ${marker}`
      );
    }
  }
  const servertoolOptionsTypes = readRequired(TS_SERVERTOOL_TYPES);
  if (/export interface ServerSideToolEngineOptions\s*\{[\s\S]{0,260}providerProtocol:\s*string;/.test(servertoolOptionsTypes)) {
    fail(
      'servertool-engine-options-metadata-center-only',
      'ServerSideToolEngineOptions must not accept providerProtocol as a second protocol truth'
    );
  }
  if (/export interface ServerToolHandlerContext\s*\{[\s\S]{0,260}providerProtocol:\s*string;/.test(servertoolOptionsTypes)) {
    fail(
      'servertool-handler-context-metadata-center-only',
      'ServerToolHandlerContext must not carry providerProtocol as a duplicated protocol truth'
    );
  }
  const engineObservationShell = readRequired(TS_ENGINE_OBSERVATION_SHELL);
  for (const marker of [
    'export function logServertoolNonBlocking(',
    '[servertool][non-blocking]',
    'readProviderProtocolFromAnyBoundMetadataCenter',
    "throw new Error('Servertool observation requires metadata center runtime_control.providerProtocol')",
  ]) {
    if (engineObservationShell.includes(marker)) {
      fail(
        'servertool-engine-observation-no-nonblocking-shell',
        `engine-observation-shell.ts must not retain non-blocking log shell marker ${marker}`
      );
    }
  }
  for (const marker of [
    "args.stageRecorder?.record('servertool.match'",
    'appendServertoolMatchSkippedProgressEvent({',
  ]) {
    if (!engineObservationShell.includes(marker)) {
      fail(
        'servertool-engine-observation-shell-owner',
        `engine-observation-shell.ts must keep engine observation owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export function createServertoolObservation(',
    'createServertoolProgressLogger({',
  ]) {
    if (engineObservationShell.includes(marker)) {
      fail(
        'servertool-engine-observation-no-progress-facade',
        `engine-observation-shell.ts must not restore public progress observation facade marker ${marker}`
      );
    }
  }
  if (/recordServertoolEngineMatchSkipped\(args:\s*\{[\s\S]{0,220}providerProtocol:\s*string;/.test(engineObservationShell)) {
    fail(
      'servertool-engine-observation-metadata-center-only',
      'recordServertoolEngineMatchSkipped must not accept providerProtocol as a second protocol truth'
    );
  }
  for (const marker of [
    'export function runEnginePreflight(',
    'function runPreflightSideEffects(',
    'planServertoolEnginePreflightWithNative',
    'inspectStopGatewaySignal(',
    'attachStopGatewayContext(',
    'containsSyntheticRouteCodexControlTextWithNative(',
    "case 'return_original_chat'",
    "case 'return_original_chat_direct_passthrough'",
    "case 'continue_to_engine'",
    'preflightAction.attachStopGatewayContext === true',
    'preflightAction.logStopEntry',
    'preflightAction.logStopCompare',
  ]) {
    if (!enginePreflightShell.includes(marker)) {
      fail(
        'servertool-engine-preflight-shell-owner',
        `engine-preflight-shell.ts must keep engine preflight owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'stopSignal.observed && preflightAction.action',
    'if (stopSignal.observed) {',
    "if (preflightAction.action === 'return_original_chat')",
    "if (preflightAction.action === 'return_original_chat_direct_passthrough')",
    'preflightAction.logStopEntry.stage',
    'preflightAction.logStopEntry.result',
    'String(preflightAction.action)',
    'args.adapterContext as Record<string, unknown>',
  ]) {
    if (enginePreflightShell.includes(marker)) {
      fail(
        'servertool-engine-preflight-shell-no-local-observed-branch',
        `engine-preflight-shell.ts must not derive preflight logging locally with marker ${marker}`
      );
    }
  }
  if (engineOrchestrationShell.includes('if (stopSignal.observed) {')) {
    fail(
      'servertool-engine-orchestration-no-local-trigger-observed-branch',
      'engine-orchestration-shell.ts must consume native trigger observation plans instead of branching on stopSignal.observed'
    );
  }
  const entryPreflightShell = readRequired(TS_ENTRY_PREFLIGHT_SHELL);
  for (const marker of [
    'export function runServertoolEntryPreflight(',
    'planServertoolEntryPreflightWithNative',
    'planServertoolClientDisconnectedErrorWithNative',
    'createServertoolProviderProtocolErrorFromPlan',
    'readServertoolEntryBaseObjectWithNative(args.options.chatResponse)',
    'hasBaseObject: base != null',
    'switch (entryPreflightPlan.action)',
    'result: { mode: entryPreflightPlan.resultMode, finalChatResponse: args.options.chatResponse }'
  ]) {
    if (!entryPreflightShell.includes(marker)) {
      fail(
        'servertool-entry-preflight-shell-owner',
        `entry-preflight-shell.ts must keep entry preflight owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'Boolean(base)',
    "args.options.chatResponse && typeof args.options.chatResponse === 'object'",
    "args.options.chatResponse != null && typeof args.options.chatResponse === 'object'",
    'args.options.chatResponse as JsonObject',
    'base as JsonObject',
    "if (entryPreflightPlan.action === 'return_passthrough_non_object_chat')",
    "if (entryPreflightPlan.action === 'throw_client_disconnected')",
    'entryPreflightPlan as { action: unknown }',
    "result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }",
  ]) {
    if (entryPreflightShell.includes(marker)) {
      fail(
        'servertool-entry-preflight-shell-owner',
        `entry-preflight-shell.ts must not retain TS action-if dispatch marker ${marker}`
      );
    }
  }
  const entryContextShell = readRequired(TS_ENTRY_CONTEXT_SHELL);
  for (const marker of [
    'export function resolveServertoolEntryContext(',
    'planServertoolEntryContextWithNative',
    'const includeToolCallNames =',
    'const excludeToolCallNames =',
    'const includeAutoHookIds =',
    'const excludeAutoHookIds =',
    'return tokens != null ? new Set(tokens) : null;',
  ]) {
    if (!entryContextShell.includes(marker)) {
      fail(
        'servertool-entry-context-shell-owner',
        `entry-context-shell.ts must keep entry context owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export function asServertoolJsonObject(',
    'asServertoolJsonObject(',
    'readProviderProtocolFromAnyBoundMetadataCenter',
    'Servertool entry context requires metadata center runtime_control.providerProtocol',
    'args.options.adapterContext as Record<string, unknown>',
  ]) {
    if (entryContextShell.includes(marker)) {
      fail(
        'servertool-entry-context-shell-owner',
        `entry-context-shell.ts must not restore local object helper marker ${marker}`
      );
    }
  }
  for (const marker of [
    'function normalizeFilterTokenSet(',
    "action: 'return_non_object_base'",
    'if (!args.base)',
    'entryContextPlan.includeToolCallNames.length > 0',
    'entryContextPlan.excludeToolCallNames.length > 0',
    'entryContextPlan.includeAutoHookIds.length > 0',
    'entryContextPlan.excludeAutoHookIds.length > 0',
    '.trim().toLowerCase()',
    '.filter((hook): hook is',
    '.filter(Boolean)',
    'return tokens ? new Set(tokens) : null;',
  ]) {
    if (entryContextShell.includes(marker)) {
      fail(
        'servertool-entry-context-no-ts-normalization-owner',
        `entry-context-shell.ts must not own filter normalization marker ${marker}`
      );
    }
  }
  const runServerSideToolEngineShell = readRequired(TS_RUN_SERVER_SIDE_TOOL_ENGINE_SHELL);
  for (const marker of [
    'export async function orchestrateServertoolEngine(',
    'runServertoolEntryPreflight',
    'extractToolCallsFromResponseStage',
    'resolveServertoolEntryContext',
    'runServertoolResponseStagePrePass',
    'runServertoolExecutionStage',
    'planServertoolEnginePrepassActionWithNative',
    'switch (entryPreflight.action)',
    'switch (enginePrepassAction.action)',
    'contextBase: entryContext.contextBase',
  ]) {
    if (!runServerSideToolEngineShell.includes(marker)) {
      fail(
        'servertool-run-server-side-tool-engine-shell-owner',
        `run-server-side-tool-engine-shell.ts must keep engine orchestration owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    "const passthroughResult = { mode: 'passthrough', finalChatResponse: options.chatResponse } as const;",
    "import type { JsonObject } from '../conversion/hub/types/json.js';",
    'const base =',
    "typeof options.chatResponse === 'object'",
    "if (entryPreflight.action === 'return_result')",
    "if (entryContext.action !== 'continue')",
    "case 'return_non_object_base':",
    'invalid entry context action',
    "if (responseStagePrePass.action === 'return_result')",
    'switch (responseStagePrePass.action)',
    'const entryPreflightAction = entryPreflight.action',
    'const entryContextAction = entryContext.action',
    'const responseStagePrePassAction = responseStagePrePass.action',
    'entryPreflight as { action: unknown }',
    'enginePrepassAction as { action: unknown }',
    'contextBase: entryContext.contextBase as ServerToolHandlerContext',
  ]) {
    if (runServerSideToolEngineShell.includes(marker)) {
      fail(
        'servertool-run-server-side-tool-engine-shell-no-local-carrier',
        `run-server-side-tool-engine-shell.ts must not restore local carrier marker ${marker}`
      );
    }
  }
  const responseStageOrchestrationShell = readRequired(`${SERVERTOOL_TS_DIR}/response-stage-orchestration-shell.ts`);
  for (const marker of [
    'export async function runServertoolExecutionStage(',
    'prepareServertoolDispatchStage',
    'planServertoolExecutionBranchWithNative',
    'const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({',
    'const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({',
    'runServertoolIoExecutionQueue',
    'materializeNativeToolCallExecutionOutcome',
    'finalizeServertoolResponseStage'
  ]) {
    if (!executionStageShell.includes(marker)) {
      fail(
        'servertool-execution-stage-shell-owner',
        `execution-stage-shell.ts must keep execution stage owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'structuredClone(args.baseObject)',
    'const baseForExecution = structuredClone',
    'const baseForExecution = args.baseObject;',
    'isStopMessageAutoPreProjection',
    'filterOutExecutedToolCalls',
    'stripToolOutputs',
    'function planExecutionBranchRuntimeAction(',
    'const preExecutionBranchPlan = planExecutionBranchRuntimeAction({',
    'const postExecutionBranchPlan = planExecutionBranchRuntimeAction({',
    'preExecutionBranchPlan.projectedToolCallIndex',
    'dispatchPlan.executableToolCalls[preExecutionBranchPlan.projectedToolCallIndex]',
    'if (!projectedToolCall)',
    'native execution-branch projected missing tool call',
    'String(preExecutionBranchPlan.action)',
    'String(postExecutionBranchPlan.action)',
  ]) {
    if (executionStageShell.includes(marker)) {
      fail(
        'servertool-execution-stage-no-payload-clone',
        `execution-stage-shell.ts must not deep-copy servertool payload marker ${marker}`
      );
    }
  }
  for (const marker of [
    'runServertoolResponseStageWithNative',
    'const responseStage =',
    'readFollowupClientInjectSourceWithNative',
    'providerProtocol: ProviderProtocol;',
    'const providerProtocol =',
    'Servertool response stage orchestration requires metadata center runtime_control.providerProtocol',
    "gatePlan.skipReason || 'followup_bypass'",
    "gatePlan.skipReason === 'no_servertool_support'",
    "gatePlan.skipReason === 'followup_bypass'",
    "throw new Error('[servertool] native response-stage gate bypass missing skipReason')",
    'typeof gatePlan.skipReason',
    'gatePlan.skipReason.trim()',
    "gatePlan.nextAction === 'bypass'",
    "if (gateRuntimeAction.action === 'return_passthrough_bypass')",
    'String(gateRuntimeAction.action)',
    'String(outputPlan.returnAction)',
    'chat: options.payload as JsonObject',
  ]) {
    if (responseStageOrchestrationShell.includes(marker)) {
      fail(
        'servertool-response-stage-orchestration-no-dead-stage',
        `response-stage-orchestration-shell.ts must not retain unused response stage marker ${marker}`
      );
    }
  }
  for (const marker of [
    'const gatePlan = planServertoolResponseStageGateWithNative({',
    'planServertoolResponseStageRuntimeActionWithNative',
    'switch (gateRuntimeAction.action)',
    "case 'return_passthrough_bypass'",
    "case 'run_auto_hooks'",
    'invalid response-stage orchestration action',
    'invalid response-stage orchestration output action',
    'detectProviderResponseShapeWithNative',
    'const orchestration = await runServerToolOrchestrationShell(',
    'runServerToolOrchestrationShell',
    'chat: options.payload',
    'payload: options.payload',
    'executed: false',
  ]) {
    if (!responseStageOrchestrationShell.includes(marker)) {
      fail(
        'servertool-response-stage-orchestration-thin-shell',
        `response-stage-orchestration-shell.ts must keep thin orchestration marker ${marker}`
      );
    }
  }
  for (const marker of [
    'const bypassResult: ServertoolResponseStageShellResult = {',
    'return bypassResult;',
    'const passthroughResult: ServertoolResponseStageShellResult = {',
    'return passthroughResult;',
  ]) {
    if (responseStageOrchestrationShell.includes(marker)) {
      fail(
        'servertool-response-stage-orchestration-no-local-carrier',
        `response-stage-orchestration-shell.ts must not restore local carrier marker ${marker}`
      );
    }
  }
  for (const keyword of [
    'responseStageGateInput',
    'orchestrationInput',
    'function planServertoolResponseStageGate(',
    'const gatePlan = planServertoolResponseStageGate({',
  ]) {
    if (responseStageOrchestrationShell.includes(keyword)) {
      fail(
        'servertool-response-stage-orchestration-thin-shell',
        `response-stage-orchestration-shell.ts must not retain retired input marker ${keyword}`
      );
    }
  }
  for (const marker of [
    'const postflightEngineResult = {',
    'engineResult: postflightEngineResult,',
  ]) {
    if (engineOrchestrationShell.includes(marker)) {
      fail(
        'servertool-engine-orchestration-no-local-carrier',
        `engine-orchestration-shell.ts must not restore local postflight carrier marker ${marker}`
      );
    }
  }
  const executionShell = existsSync(TS_EXECUTION_SHELL) ? readRequired(TS_EXECUTION_SHELL) : '';
  const executionMaterializationShell = readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`);
  const autoHookCaller = readRequired(`${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`);
  const executionQueueShell = readRequired(`${SERVERTOOL_TS_DIR}/execution-queue-shell.ts`);
  const rustExecutionHandlerContract = readRequired(RUST_SERVERTOOL_EXECUTION_HANDLER_CONTRACT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeCoreWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  for (const marker of [
    'const genericOps = followupConfig.genericInjectionOps',
    "requestIdSuffix: ':servertool_followup'",
    'const genericFollowup = {',
    'if (!options.reenterPipeline) return undefined;',
    "if (plan.kind === 'vision_analysis')",
    "if (plan.kind === 'web_search')",
    "typeof (planned as any).finalize === 'function'",
    'materializeServertoolPlannedResult',
    'runServertoolHandler',
  ]) {
    if (executionShell.includes(marker)) {
      fail(
        'servertool-execution-shell-no-residue',
        `execution-shell.ts must stay deleted; found residue marker ${marker}`
      );
    }
  }
  for (const marker of [
    'const servertoolBackendExecutors',
    'function throwServertoolExecutionDispatchError(',
    'planServertoolExecutionDispatchErrorWithNative(args)',
    'planServertoolExecutionDispatchErrorWithNative({',
    "outcomeRuntimeActionPlan.action === 'invalid_mixed_client_tools_outcome'",
    "outcomeRuntimeActionPlan.action === 'missing_servertool_execution_contract'",
    'function isServerToolHandlerPlan(',
    'function isServerToolHandlerResult(',
    'function assertValidServertoolHandlerContract(',
    'planServertoolHandlerContractWithNative',
    'planServertoolBackendExecutionWithNative',
    '[servertool] invalid handler plan contract: missing finalize',
    '[servertool] invalid handler plan/result contract',
    '[servertool] handler failed:',
    'ServerToolBackendPlan',
    'ServerToolBackendResult',
    'hasBackendPlan',
    'backendKind',
    'unsupported_backend_plan_kind',
    'plan_servertool_unsupported_backend_plan_kind_error',
    "if (planHandlerMaterializationAction(planned, options) === 'handler_plan')",
    'buildHandlerRuntimeActionInput',
    'buildProviderProtocolError',
    "import { ProviderProtocolError }",
    'planServertoolHandlerContractErrorWithNative(',
    'planServertoolHandlerRuntimeActionWithNative(',
    "actionPlan.action === 'invalid_plan_missing_finalize'",
    "actionPlan.action === 'invalid_plan_result'",
    'actionPlan as { action: string }',
    "if (materializationPlan.action === 'throw_dispatch_error')",
    'materializationPlan as { action: unknown }',
    'const materializationAction = materializationPlan.action',
    'planned as ServerToolHandlerResult',
    'const plan = planned as ServerToolHandlerPlan',
    'planned as ServerToolHandlerPlan',
    'isServerToolHandlerResultLike',
    'isServerToolHandlerPlanLike',
    'typeof (planned as Record<string, unknown>).finalize',
    'record.chatResponse != null',
    "mode: 'tool_flow'",
    "await import('./builtin-handler-catalog.js')",
    'getBuiltinHandlerEntry(args.builtinName)',
    'builtin handler missing execution descriptor',
    'structuredClone(args.base)',
    'planned as any',
  ]) {
    if (executionMaterializationShell.includes(marker)) {
      fail(
        'servertool-execution-shell-ts-orchestration-guard',
        `execution-handler-materialization-shell.ts must not retain TS materialization guard marker ${marker}`
      );
    }
  }
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'planServertoolHandlerMaterializationForPlannedWithNative'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'planned: unknown'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'switch (materializationPlan.action)'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'mode: materializationPlan.resultMode'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'invalid handler materialization action'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'finalizeServertoolHandlerPlanWithNative'
  );
  assertContains(
    'servertool-execution-shell-ts-orchestration-guard',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'materializeServertoolHandlerResultWithNative'
  );
  assertContains(
    'servertool-execution-handler-builtin-runtime-thin-shell',
    `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`,
    autoHookCaller,
    'runStoplessBuiltinHandlerForRuntimeWithNative({'
  );
  assertContains(
    'servertool-execution-handler-builtin-runtime-thin-shell',
    `${SERVERTOOL_TS_DIR}/execution-queue-shell.ts`,
    executionQueueShell,
    'runStoplessBuiltinHandlerForRuntimeWithNative({'
  );
  assertContains(
    'servertool-execution-handler-contract-rust-owner',
    RUST_SERVERTOOL_EXECUTION_HANDLER_CONTRACT,
    rustExecutionHandlerContract,
    'feature_id: hub.servertool_execution_handler_contract'
  );
  for (const needle of [
    'pub struct ServertoolHandlerContractInput',
    'pub fn plan_servertool_handler_contract',
    'pub fn plan_servertool_materialization_progress',
    'pub struct ServertoolHandlerRuntimeActionInput',
    'pub struct ServertoolHandlerRuntimeActionPlan',
    'pub fn plan_servertool_handler_runtime_action',
    'pub struct ServertoolHandlerMaterializationInput',
    'pub struct ServertoolHandlerMaterializationPlan',
    'pub fn plan_servertool_handler_materialization',
    'pub fn plan_servertool_handler_failed_error',
  ]) {
    assertContains(
      'servertool-execution-handler-contract-rust-owner',
      RUST_SERVERTOOL_EXECUTION_HANDLER_CONTRACT,
      rustExecutionHandlerContract,
      needle
    );
  }
  for (const marker of [
    'plan_servertool_backend_requires_reenter_pipeline_error',
    'backend_requires_reenter_pipeline',
    'has_backend_plan',
    'backend_kind',
    'UnsupportedBackendPlanKind',
    'unsupported_backend_plan_kind',
    'plan_servertool_unsupported_backend_plan_kind_error',
  ]) {
    if (rustExecutionHandlerContract.includes(marker)) {
      fail(
        'servertool-execution-handler-contract-rust-owner',
        `execution handler contract must not retain retired backend reenter marker ${marker}`
      );
    }
  }
  const servertoolTypes = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/servertool/types.ts`);
  for (const marker of [
    'ServerToolBackendPlan',
    'ServerToolBackendResult',
  ]) {
    assertMissing(
      'servertool-execution-handler-contract-rust-owner',
      `${ROOT}/sharedmodule/llmswitch-core/src/servertool/types.ts`,
      servertoolTypes,
      marker
    );
  }
  assertMissing(
    'servertool-execution-handler-contract-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`,
    readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`),
    'plan_servertool_backend_execution_json'
  );
  assertContains(
    'servertool-execution-handler-contract-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod execution_handler_contract'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_handler_contract_error_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_handler_runtime_action_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_handler_materialization_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_materialization_progress_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_handler_contract_error_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_handler_runtime_action_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_handler_materialization_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_materialization_progress_json'
  );
  assertMissing(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolHandlerContractErrorJson'
  );
  assertMissing(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolHandlerRuntimeActionJson'
  );
  assertContains(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolHandlerMaterializationJson'
  );
  assertMissing(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolMaterializationProgressJson'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerContractErrorWithNative'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerRuntimeActionForPlannedWithNative'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerRuntimeActionWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerMaterializationForPlannedWithNative'
  );
  assertMissing(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolMaterializationProgressWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-ts-thin-shell',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'planServertoolHandlerMaterializationForPlannedWithNative'
  );

  pass('servertool-outcome-rust-owner', 'servertool-core owns outcome planning and cli contract');
  pass('servertool-cli-projection-deleted', 'TS cli-projection facade is deleted; runtime shell calls Rust/native projection directly');
}

function checkResponseStageMetadataCenterOnly() {
  const responseStageShell = readRequired(`${SERVERTOOL_TS_DIR}/response-stage-orchestration-shell.ts`);
  for (const marker of [
    'function markServertoolResponseOrchestration(',
    'function projectRuntimeControlSideChannel(',
    'record.runtime_control = {',
    'projectRuntimeControlSideChannel(options.adapterContext, runtimeControl);',
    'projectRuntimeControlSideChannel(',
    'writeRuntimeControlToBoundMetadataCenter(',
    'servertoolResponseOrchestration',
  ]) {
    if (responseStageShell.includes(marker)) {
      fail(
        'servertool-response-stage-runtime-control-mirror',
        `response-stage-orchestration-shell.ts must not mirror MetadataCenter runtime_control via TS marker ${marker}`
      );
    }
  }
  for (const marker of [
    'readRuntimeControlFromAnyBoundMetadataCenter(',
  ]) {
    if (!responseStageShell.includes(marker)) {
      fail(
        'servertool-response-stage-metadata-center-owner',
        `response-stage-orchestration-shell.ts must keep MetadataCenter owner marker ${marker}`
      );
    }
  }
  pass(
    'servertool-response-stage-metadata-center-owner',
    'response-stage shell reads/writes servertool runtime control only through MetadataCenter'
  );
}

function checkServertoolAutoHookCallerThinShell() {
  assertMissingFile(
    'servertool-auto-hook-caller-thin-shell',
    `${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`,
    'server-side-tools-impl.ts must stay physically deleted; auto-hook caller must not re-enter a root facade'
  );
  const autoHookCallerShell = readRequired(`${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`);
  const orchestrationBlocks = readRequired(`${SERVERTOOL_TS_DIR}/orchestration-blocks.ts`);
  for (const marker of [
    'buildAutoHookQueuesFromConfig',
    'planServertoolAutoHookQueuesWithNative',
    'sourceIndex',
    'function scheduleAutoHookQueueWithNative',
    'planServertoolHookScheduleWithNative',
    "effectKind: `auto_hook:${normalizeServerToolCallName(hook.id)}:${requiredness}`",
    'function normalizeServerToolCallName(',
    '.trim().toLowerCase()',
  ]) {
    if (orchestrationBlocks.includes(marker)) {
      fail(
        'servertool-auto-hook-queue-single-rust-plan',
        `orchestration-blocks.ts must not reschedule Rust-planned auto-hook queues via TS marker ${marker}`
      );
    }
  }
  for (const marker of [
    'planServertoolAutoHookQueueItemsWithNative({',
    'queueOrder: nativePlan.queueOrder.map(',
  ]) {
    if (!autoHookCallerShell.includes(marker)) {
      fail(
        'servertool-auto-hook-queue-single-rust-plan',
        `auto-hook-caller.ts must consume Rust-planned auto-hook queues through native queue item bridge marker ${marker}`
      );
    }
  }
  for (const marker of [
    'planServertoolAutoHookQueuesWithNative({',
    'args.hooks[entry.sourceIndex]',
    'native auto-hook queue returned invalid sourceIndex',
  ]) {
    if (autoHookCallerShell.includes(marker)) {
      fail(
        'servertool-auto-hook-queue-single-rust-plan',
        `auto-hook-caller.ts must not rematch Rust auto-hook queue entries in TS via marker ${marker}`
      );
    }
  }
  for (const marker of [
    "{ queueName: 'A_optional'",
    "{ queueName: 'B_mandatory'",
    "queueName: 'A_optional'",
    "queueName: 'B_mandatory'",
  ]) {
    if (autoHookCallerShell.includes(marker)) {
      fail(
        'servertool-auto-hook-queue-single-rust-plan',
        `auto-hook-caller.ts must not locally hard-code Rust-owned auto-hook queue order marker ${marker}`
      );
    }
  }
  if (autoHookCallerShell.includes('export async function runServertoolAutoHookCallerViaThinShell(')) {
    fail(
      'servertool-auto-hook-caller-thin-shell',
      'auto-hook-caller.ts must not retain the deleted runServertoolAutoHookCallerViaThinShell export name'
    );
  }
  if (!autoHookCallerShell.includes('export async function runServertoolAutoHookCaller(')) {
    fail(
      'servertool-auto-hook-caller-thin-shell',
      'auto-hook-caller.ts must keep direct runServertoolAutoHookCaller export'
    );
  }
  pass(
    'servertool-auto-hook-caller-thin-shell',
    'auto-hook-caller.ts keeps direct runServertoolAutoHookCaller export without alias wrapper residue'
  );
}

function checkServertoolResponseStageGateThinShell() {
  assertMissingFile(
    'servertool-response-stage-gate-thin-shell',
    `${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`,
    'server-side-tools-impl.ts must stay physically deleted; response-stage gate semantics belong to concrete shells/native plans'
  );
  pass(
    'servertool-response-stage-gate-thin-shell',
    'deleted server-side-tools facade cannot retain response-stage wrapper alias'
  );

  const responseStageFinalizeShell = readRequired(TS_RESPONSE_STAGE_FINALIZE_SHELL);
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    "contextBase: Omit<ServerToolHandlerContext, 'toolCall'>"
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'NativeServertoolResponseStageGate'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'runServertoolResponseStageAutoHookPass'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'responseStageGatePlan: args.responseStageGatePlan'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'planServertoolResponseStageRuntimeActionWithNative'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    "hasAutoHookResult: responseStageAutoHook.action === 'return_auto_hook_result'"
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'return responseStageAutoHook.result'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'switch (finalizeRuntimeAction.action)'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'mode: finalizeRuntimeAction.resultMode'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'invalid response-stage finalize action'
  );
  for (const marker of [
    "const passthroughResult = { mode: 'passthrough', finalChatResponse: args.baseObject } as const;",
    'return passthroughResult;',
    "return { mode: 'passthrough', finalChatResponse: args.baseObject };",
    'initialResponseStageGatePlan',
    'planServertoolResponseStageGateWithNative',
    'readRuntimeControlFromAnyBoundMetadataCenter',
    'responseHookMatched === true',
    "responseStageAutoHook.action === 'return_passthrough_bypass'",
    "if (finalizeRuntimeAction.action === 'return_auto_hook_result')",
    'finalizeRuntimeAction as { action: string }',
    'autoHookResult == null',
    'autoHookResult as ServerSideToolEngineResult',
    'native response-stage finalize requested auto-hook result but result was empty',
    'responseStageGatePlan: Record<string, unknown>',
  ]) {
    if (responseStageFinalizeShell.includes(marker)) {
      fail(
        'servertool-response-stage-finalize-shell-no-local-carrier',
        `response-stage-finalize-shell.ts must not restore local carrier marker ${marker}`
      );
    }
  }

  const responseStagePrePassShell = readRequired(TS_RESPONSE_STAGE_PREPASS_SHELL);
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'planServertoolResponseStageGateWithNative'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'NativeServertoolResponseStageGate'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'planServertoolResponseStageRuntimeActionWithNative'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'switch (prepassRuntimeAction.action)'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'switch (responseStageAutoHook.action)'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'runServertoolResponseStageAutoHookPass'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'invalid response-stage prepass action'
  );
  assertContains(
    'servertool-response-stage-prepass-shell-owner',
    TS_RESPONSE_STAGE_PREPASS_SHELL,
    responseStagePrePassShell,
    'invalid response-stage prepass auto-hook action'
  );
  for (const marker of [
    'responseHookMatched !== true',
    'responseStageGatePlan.responseHookMatched !== true',
    "prepassRuntimeAction.action !== 'run_auto_hooks'",
    "if (responseStageAutoHook.action === 'return_auto_hook_result')",
    'autoHookResult as ServerSideToolEngineResult',
    'postAutoHookRuntimeAction',
    'prepassRuntimeAction as { action: string }',
    'responseStageAutoHook as { action: string }',
    '}) as Record<string, unknown>',
    'args.options.adapterContext as Record<string, unknown>',
    'responseStageGatePlan: Record<string, unknown>',
  ]) {
    if (responseStagePrePassShell.includes(marker)) {
      fail(
        'servertool-response-stage-prepass-shell-owner',
        `response-stage-prepass-shell.ts must not branch on Rust-owned hook match marker ${marker}`
      );
    }
  }
  const responseStageAutoHookShell = readRequired(`${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`);
  for (const marker of [
    'responseHookRequired: args.responseStageGatePlan.responseHookRequired === true',
    "responseHookName: String(args.responseStageGatePlan.responseHookName ?? 'unknown')",
    '[servertool] native response-stage requested auto-hook result but result was empty',
    'if (!autoHookResult)',
    'Boolean(autoHookResult)',
    'responseHookName: postAutoHookRuntimeAction.responseHookName as string',
    'result: autoHookResult as ServerSideToolEngineResult',
    'preAutoHookRuntimeAction as { action: string }',
    'postAutoHookRuntimeAction as { action: string }',
    "if (preAutoHookRuntimeAction.action === 'return_passthrough_bypass')",
    "if (postAutoHookRuntimeAction.action === 'return_required_response_hook_empty')",
    "if (postAutoHookRuntimeAction.action === 'return_auto_hook_result')",
    'function hasServerSideToolEngineResult(',
    'hasServerSideToolEngineResult(autoHookResult)',
  ]) {
    if (responseStageAutoHookShell.includes(marker)) {
      fail(
      'servertool-response-stage-auto-hook-shell-owner',
        `response-stage-auto-hook-shell.ts must not derive Rust-owned required hook fields via TS marker ${marker}`
      );
    }
  }
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'switch (preAutoHookRuntimeAction.action)'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'switch (postAutoHookRuntimeAction.action)'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'responseHookName: postAutoHookRuntimeAction.responseHookName'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'result: autoHookResult'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'hasAutoHookResult: autoHookResult != null'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'if (autoHookResult == null)'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'invalid response-stage pre auto-hook action'
  );
  assertContains(
    'servertool-response-stage-auto-hook-shell-owner',
    `${SERVERTOOL_TS_DIR}/response-stage-auto-hook-shell.ts`,
    responseStageAutoHookShell,
    'invalid response-stage post auto-hook action'
  );
}

function checkServertoolEngineStoplessSessionThinShell() {
  assertMissingFile(
    'servertool-engine-facade-deleted',
    `${SERVERTOOL_TS_DIR}/engine.ts`,
    'engine.ts must stay physically deleted; import engine-orchestration-shell.ts directly'
  );
  const engineSource = readRequired(`${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`);
  const postflightSource = readRequired(`${SERVERTOOL_TS_DIR}/engine-postflight-shell.ts`);
  const executionMaterializationShell = readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`);
  const registryOrchestrationShell = readRequired(`${SERVERTOOL_TS_DIR}/registry-orchestration-shell.ts`);
  const autoHookCaller = readRequired(`${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`);
  const executionQueueShell = readRequired(`${SERVERTOOL_TS_DIR}/execution-queue-shell.ts`);
  const rustProjectionContextSource = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`
  );
  const rustProjectionBridgeSource = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`
  );
  for (const marker of [
    'function logServerToolNonBlocking(',
    "args.stageRecorder?.record('servertool.match'",
    'appendServerToolProgressFileEvent({',
  ]) {
    if (engineSource.includes(marker)) {
      fail(
        'servertool-engine-observation-inline-semantic',
        `engine-orchestration-shell.ts must not retain engine observation inline semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'function normalizeStoplessSessionToken(',
    'function readStoplessSessionId(',
  ]) {
    if (engineSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-inline-semantic',
        `engine-orchestration-shell.ts must not retain stopless session inline semantic marker ${marker}`
      );
    }
  }
  assertContains(
    'servertool-engine-stopless-session-thin-shell',
    `${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`,
    engineSource,
    'export async function runServerToolOrchestrationShell('
  );
  if (engineSource.includes("if (preflight.kind === 'return_original_chat' || preflight.kind === 'return_original_chat_direct_passthrough')")) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine-orchestration-shell.ts must not restore direct preflight kind if-dispatch; keep native-planned preflight dispatch as a switch'
    );
  }
  for (const marker of [
    'const preflightKind = preflight.kind',
    'switch (preflightKind)',
    'invalid engine preflight result kind',
    'String(preflightOrchestrationAction.action)',
    'const preflightChat = (preflight as { chat?: JsonObject }).chat',
    'const preflightStopSignal = (preflight as { stopSignal?: typeof stopSignal }).stopSignal',
    'chat: preflightChat as JsonObject',
    'stopSignal = preflightStopSignal as typeof stopSignal',
    'hasServertoolCliProjectionContext:',
  ]) {
    if (engineSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-thin-shell',
        `engine-orchestration-shell.ts must not restore local preflight kind dispatch marker ${marker}`
      );
    }
  }
  if (!engineSource.includes('planServertoolEngineOrchestrationPreflightActionWithNative({')) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine-orchestration-shell.ts must keep preflight orchestration dispatch on Rust action plan'
    );
  }
  if (!engineSource.includes('switch (preflightOrchestrationAction.action)')) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine-orchestration-shell.ts must dispatch preflight orchestration action as a thin switch over native plan'
    );
  }
  for (const marker of [
    'chat: preflight.chat',
    'stopSignal = preflight.stopSignal',
  ]) {
    if (!engineSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-thin-shell',
        `engine-orchestration-shell.ts must consume typed preflight union marker ${marker}`
      );
    }
  }
  for (const marker of [
    'const engineSkipAction = engineSkipPlan.action as',
    "engineSkipPlan.action === 'return_skipped_passthrough' ||",
    "engineSkipPlan.action === 'return_skipped_no_execution'",
  ]) {
    if (engineSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-thin-shell',
        `engine-orchestration-shell.ts must not restore direct engine skip if-dispatch marker ${marker}`
      );
    }
  }
  if (!engineSource.includes('switch (engineSkipPlan.action)')) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine-orchestration-shell.ts must keep engine skip dispatch as a thin switch over native-planned result'
    );
  }
  if (!engineSource.includes('stoplessExecutionFlowId:')) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine-orchestration-shell.ts must pass stoplessExecutionFlowId into Rust runtime action planning'
    );
  }
  for (const marker of [
    'switch (runtimeAction.action)',
    "case 'build_stop_message_cli_projection'",
    'buildStoplessAutoCliProjectionFromEngineWithNative({',
  ]) {
    if (!postflightSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-thin-shell',
        `engine-postflight-shell.ts must keep stopless session thin-shell marker ${marker}`
      );
    }
  }
  for (const marker of [
    'logNonBlocking:',
    'resolveStoplessCliProjectionContext(',
    'planStoplessCliProjectionContextWithNative(',
    'buildServertoolCliProjectionForAutoFlowShell({',
    'buildStoplessAutoCliProjectionJson',
    "readNativeFunction('buildStoplessAutoCliProjectionFromEngineJson')",
    'JSON.parse(raw)',
    'function readSessionAndRequestId(',
    'const requestTruth = metadataCenterSnapshot?.requestTruth',
    'const rawSessionId = requestTruth?.sessionId',
    'rawSessionId.trim()',
    'const nativeMetadataCenterSnapshot = metadataCenterSnapshot ?? (',
    'runtimeControl ? { runtimeControl } : null',
    'executionContext?.stopless',
    'executionContext?.assistantStopText',
    'executionContext?.stoplessRuntimeState',
  ]) {
    if (postflightSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-no-ts-owner',
        `engine-postflight-shell.ts must not retain stopless projection semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'execution_context',
    'executionContext',
    'servertoolCliProjection',
    'serverToolLoopState',
    'stopSchemaTriggerHint',
    'stopSchemaFeedback',
    'stoplessRuntimeState',
    'runtime_snapshot',
    'runtimeSnapshot',
    'pub trigger_hint',
  ]) {
    if (rustProjectionContextSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-no-rust-internal-meta',
        `stopless_cli_projection_context_contract.rs must read only MetadataCenter/write-plan control, found ${marker}`
      );
    }
  }
  for (const marker of [
    '"executionContext": { "stopless"',
    '"runtimeSnapshot"',
    'context.get("stopless")',
    'context.get("stopSchemaTriggerHint")',
    'context.get("stoplessRuntimeState")',
  ]) {
    if (rustProjectionBridgeSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-no-rust-internal-meta',
        `stopless_auto_handler_bridge.rs must not source CLI projection control from execution context, found ${marker}`
      );
    }
  }
  for (const marker of [
    'runtime.action',
    'switch (runtime.action)',
    "runtime.action === 'return_null'",
    "runtime.action === 'throw_error'",
    "runtime.action !== 'return_handler_result'",
    "name === 'stop_message_auto'",
    "plan.action === 'return_none'",
    "plan.action !== 'return_entry'",
    "'return_terminal_final'",
    "'return_schema_fail_fast'",
    "'return_schema_allow_stop'",
    "'return_handler_plan'",
    "'throw_goal_active_loop'",
    'runtime.chatResponse ?? ctx.base',
    'runtime.execution ??',
    'stopMessageTerminalFinal: true',
    '.map((name) => getBuiltinHandlerEntry(name))',
    '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook))',
    '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry))',
    'function runBuiltinHandlerForRuntimeNapi(',
    'function runBuiltinHandler(',
  ]) {
    if (executionMaterializationShell.includes(marker) || registryOrchestrationShell.includes(marker)) {
      fail(
        'servertool-builtin-handler-stopless-no-ts-action-owner',
        `servertool TS runtime shells must not retain builtin handler action semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'function isBuiltinRuntimeSupported(',
    'function readSkeletonOwnedRegistration(',
    'getServertoolToolSpec',
    'listServertoolToolSpecs',
  ]) {
    if (executionMaterializationShell.includes(marker) || registryOrchestrationShell.includes(marker)) {
      fail(
        'servertool-builtin-handler-catalog-rust-plan',
        `servertool TS runtime shells must not retain builtin catalog semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'runStoplessBuiltinHandlerForRuntimeWithNative(',
    'resolveServertoolBuiltinHandlerEntryWithNative(',
    'planServertoolBuiltinAutoHandlerEntriesWithNative(',
  ]) {
    if (
      !executionMaterializationShell.includes(marker) &&
      !registryOrchestrationShell.includes(marker) &&
      !autoHookCaller.includes(marker) &&
      !executionQueueShell.includes(marker)
    ) {
      fail(
        'servertool-builtin-handler-stopless-thin-shell',
        `servertool TS runtime shells must keep direct native builtin thin-shell marker ${marker}`
      );
    }
  }
  pass(
    'servertool-engine-stopless-session-thin-shell',
    'engine orchestration and postflight shells keep stopless session truth through native stopless orchestration plan'
  );
}

function checkServertoolActiveOrchestrationAuditRedGate() {
  const forbiddenByFile = new Map([
    [
      `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
      [
        'const SERVERTOOL_BACKEND_EXECUTORS',
        'const servertoolBackendExecutors',
        'const materializePlannedServertoolResult',
        'const executeBackendPlanViaThinShell',
        'const runServertoolHandlerThinShell',
        'export async function executeBuiltinServerToolHandler(',
        'function materializeServertoolPlannedResult(',
        'function executeServertoolBackendPlan(',
        'export async function runServertoolHandler(',
      ],
    ],
  ]);
  for (const [file, markers] of forbiddenByFile) {
    const source = readRequired(file);
    for (const marker of markers) {
      if (source.includes(marker)) {
        fail(
          'servertool-active-orchestration-audit',
          `${file.replace(`${ROOT}/`, '')} still contains active orchestration marker ${marker}; this TS owner must be physically reduced to a thin shell before closeout`
        );
      }
    }
  }
  pass(
    'servertool-active-orchestration-audit',
    'servertool active orchestration audit is wired as a red gate for the remaining TS active owner residues'
  );
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

  for (const [file, content] of [
    [`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib],
    [`${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks],
    [RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib],
    [NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper],
    [NATIVE_REQUIRED_EXPORTS, requiredExports],
    [`${RUST_SRC_DIR}/servertool_skeleton_config.rs`, skeletonConfig],
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

function checkServertoolProgressFileLoggingFailFast() {
  const progressFile = `${SERVERTOOL_TS_DIR}/log/progress-file.ts`;
  const progressFileSource = readRequired(progressFile);
  const progressLoggingSpec = readRequired(`${ROOT}/tests/servertool/servertool-progress-logging.spec.ts`);
  for (const keyword of [
    '// best-effort file logging',
    'best-effort file logging',
    '.catch(() => {',
  ]) {
    if (progressFileSource.includes(keyword)) {
      fail(
        'servertool-progress-file-fail-fast',
        `progress-file.ts must not swallow enabled JSONL file logging failures with "${keyword}"`
      );
    }
  }
  assertContains(
    'servertool-progress-file-fail-fast',
    `${ROOT}/tests/servertool/servertool-progress-logging.spec.ts`,
    progressLoggingSpec,
    'enabled servertool JSONL file logging exposes write failures'
  );
  pass(
    'servertool-progress-file-fail-fast',
    'enabled servertool JSONL file logging failures are exposed to the flush/test boundary'
  );
}

function checkServertoolMatchLoggingFailFast() {
  const matchLogFile = `${SERVERTOOL_TS_DIR}/match-log-block.ts`;
  if (existsSync(matchLogFile)) {
    fail(
      'servertool-match-log-fail-fast',
      'match-log-block.ts must stay physically deleted; match logging belongs to engine-observation-shell.ts'
    );
  }
  const observationShellSource = readRequired(`${SERVERTOOL_TS_DIR}/engine-observation-shell.ts`);
  const observationSpec = readRequired(`${ROOT}/tests/servertool/engine-observation-shell.spec.ts`);
  for (const keyword of [
    'record_servertool_match_skipped',
    'record_servertool_match_hit',
  ]) {
    if (observationShellSource.includes(keyword)) {
      fail(
        'servertool-match-log-fail-fast',
        `engine-observation-shell.ts must not convert stageRecorder failure into non-blocking marker "${keyword}"`
      );
    }
  }
  if (/stageRecorder\?\.record[\s\S]{0,180}catch\s*\(/.test(observationShellSource)) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-observation-shell.ts must not catch stageRecorder failures'
    );
  }
  if (observationShellSource.includes("flowId ?? 'unknown'")) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-observation-shell.ts must not fallback missing execution.flowId to unknown'
    );
  }
  if (observationShellSource.includes("args.engineMode === 'passthrough' ? 'passthrough' : 'no_execution'")) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-observation-shell.ts must consume native skipReason instead of deriving it from engineMode'
    );
  }
  if (observationShellSource.includes('args.skipReason.trim()')) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-observation-shell.ts must not normalize native skipReason in TS'
    );
  }
  const engineOrchestrationSource = readRequired(`${SERVERTOOL_TS_DIR}/engine-orchestration-shell.ts`);
  if (engineOrchestrationSource.includes("engineSkipPlan.skipReason ?? 'no_execution'")) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-orchestration-shell.ts must not fallback missing native skipReason to no_execution'
    );
  }
  if (engineOrchestrationSource.includes('engineSkipPlan.skipReason.trim()')) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-orchestration-shell.ts must not normalize native skipReason in TS'
    );
  }
  if (engineOrchestrationSource.includes("throw new Error('[servertool] native engine skip plan missing skipReason')")) {
    fail(
      'servertool-match-log-fail-fast',
      'engine-orchestration-shell.ts must not retain local missing skipReason contract throw'
    );
  }
  assertContains(
    'servertool-match-log-fail-fast',
    `${ROOT}/tests/servertool/engine-observation-shell.spec.ts`,
    observationSpec,
    'match stage recorder failures are fail-fast'
  );
  assertContains(
    'servertool-match-log-fail-fast',
    `${ROOT}/tests/servertool/engine-observation-shell.spec.ts`,
    observationSpec,
    'match hit requires execution flowId instead of falling back to unknown'
  );
  assertContains(
    'servertool-match-log-fail-fast',
    `${ROOT}/tests/servertool/engine-observation-shell.spec.ts`,
    observationSpec,
    'match skipped consumes native skipReason instead of deriving it from engine mode'
  );
  pass(
    'servertool-match-log-fail-fast',
    'servertool match stageRecorder failures fail fast'
  );
}

function checkServertoolProgressLoggingFailFast() {
  const progressLogFile = `${SERVERTOOL_TS_DIR}/progress-log-block.ts`;
  const progressLogSource = readRequired(progressLogFile);
  const progressLogSpec = readRequired(`${ROOT}/tests/servertool/progress-log-block.failfast.spec.ts`);
  for (const keyword of [
    'log_progress_console',
    'log_auto_hook_trace_stage_recorder',
    'log_stop_compare_console',
    'log_stop_compare_stage_recorder',
  ]) {
    if (progressLogSource.includes(keyword)) {
      fail(
        'servertool-progress-log-fail-fast',
        `progress-log-block.ts must not convert progress logger failure into non-blocking marker "${keyword}"`
      );
    }
  }
  if (/printServertoolLine[\s\S]{0,240}catch\s*\(/.test(progressLogSource)) {
    fail(
      'servertool-progress-log-fail-fast',
      'progress-log-block.ts must not catch console logging failures'
    );
  }
  if (/stageRecorder\?\.record[\s\S]{0,260}catch\s*\(/.test(progressLogSource)) {
    fail(
      'servertool-progress-log-fail-fast',
      'progress-log-block.ts must not catch stageRecorder failures'
    );
  }
  assertContains(
    'servertool-progress-log-fail-fast',
    `${ROOT}/tests/servertool/progress-log-block.failfast.spec.ts`,
    progressLogSpec,
    'progress-log-block fail-fast behavior'
  );
  pass(
    'servertool-progress-log-fail-fast',
    'progress logger console and stageRecorder failures fail fast'
  );
}

function checkServertoolPostflightLoggingFailFast() {
  const postflightFile = `${SERVERTOOL_TS_DIR}/engine-postflight-shell.ts`;
  const postflightSource = readRequired(postflightFile);
  const observationSpec = readRequired(`${ROOT}/tests/servertool/engine-observation-shell.spec.ts`);
  for (const marker of [
    'logNonBlocking:',
    'function applyServertoolPostflightMetadataWritePlan(',
    'function buildStoplessProjectionMetadataCenterSnapshot(',
    'function printServertoolLine(',
    "symbol: 'applyServertoolPostflightMetadataWritePlan'",
    'const followupSummary: Record<string, unknown> = {',
    "if ('payload' in followup)",
    'payloadRecord.messages',
    'payloadRecord.input',
    "if ('injection' in followup)",
    'followup.injection?.ops',
    'const engineFinalResult = {',
    'return engineFinalResult;',
    "engineResult.metadataWritePlan && typeof engineResult.metadataWritePlan === 'object'",
    'options.adapterContext as unknown as Record<string, unknown>',
    'String((args.runtimeAction as { flowIdSource: unknown }).flowIdSource)',
    'executed: true',
  ]) {
    if (postflightSource.includes(marker)) {
      fail(
        'servertool-postflight-observation-rust-owner',
        `engine-postflight-shell.ts must not retain TS postflight observation semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'buildServertoolPostflightObservationSummaryWithNative({',
    "args.stageRecorder.record('servertool.execution', summary);",
    "engineResult.metadataWritePlan != null && typeof engineResult.metadataWritePlan === 'object'",
    'chat: engineResult.finalChatResponse',
    'executed: runtimeAction.executed',
    'resolvePostflightFlowId({',
  ]) {
    if (!postflightSource.includes(marker)) {
      fail(
        'servertool-postflight-observation-rust-owner',
        `engine-postflight-shell.ts must keep native postflight observation marker ${marker}`
      );
    }
  }
  if (postflightSource.includes('record_servertool_execution_snapshot')) {
    fail(
      'servertool-postflight-log-fail-fast',
      'engine-postflight-shell.ts must not convert execution snapshot recorder failures into non-blocking logs'
    );
  }
  if (/stageRecorder\)[\s\S]{0,300}try\s*\{/.test(postflightSource)) {
    fail(
      'servertool-postflight-log-fail-fast',
      'engine-postflight-shell.ts must not catch stageRecorder failures'
    );
  }
  assertContains(
    'servertool-postflight-log-fail-fast',
    `${ROOT}/tests/servertool/engine-observation-shell.spec.ts`,
    observationSpec,
    'postflight stage recorder failures are fail-fast'
  );
  pass(
    'servertool-postflight-log-fail-fast',
    'servertool postflight stageRecorder failures fail fast'
  );
}

// ── Run ────────────────────────────────────────────────────────
console.log('\n=== verify-servertool-rust-only ===\n');

checkNoBakFiles();
checkNoTSHandlerRuntimeImport();
checkNoDuplicateSemantics();
assertStoplessSessionIdLock();
assertStoplessSchemaFeedbackLock();
assertRuntimeMetadataSessionDirLock();
checkServertoolCliProjectionMap();
checkServertoolRustificationVerificationRegistry();
checkBuildIncludesServertoolGate();
checkNoOldCliRestorationRuntime();
checkLegacyStopMessageRuntimeMirrorsRemoved();
checkMigratedProjectionDoesNotReenter();
checkApplyPatchNotCliProjected();
checkStandaloneServertoolBinary();
checkLegacyReviewToolDeleted();
checkOrchestrationPolicyRustOwner();
checkServertoolExecutionDispatchRustOwner();
checkFollowupMainlineNativeBridgeRustOwner();
checkServertoolSkeletonConfigRustOwner();
checkServertoolHookSkeletonRustOwner();
checkPendingSessionRustOwner();
checkPreCommandHooksRustOwner();
checkAutoHookExecutionRustOwner();
checkServertoolRegistryRustOwner();
checkServertoolEntryPreflightRustOwner();
checkEngineSelectionRustOwner();
checkServertoolFlowPresentationRustOwner();
checkBackendRoutePolicyRustOwner();
checkServertoolTextExtractionRustOwner();
checkServertoolCliResultGuardRustOwner();
checkStoplessNoContextDataPlane();
checkDeletedStoplessMetadataWriterAbsent();
checkDeletedStopMessageTsOwnersAbsent();
checkStopGatewayMetadataCenterOnly();
checkStoplessNoTsRuntimeControlSpecialization();
checkServertoolRustOutcomeCloseout();
checkResponseStageMetadataCenterOnly();
checkServertoolAutoHookCallerThinShell();
checkServertoolResponseStageGateThinShell();
checkServertoolEngineStoplessSessionThinShell();
checkServertoolActiveOrchestrationAuditRedGate();
checkServertoolProgressFileLoggingFailFast();
checkServertoolMatchLoggingFailFast();
checkServertoolProgressLoggingFailFast();
checkServertoolPostflightLoggingFailFast();
checkDeletedEmptyReplyContinueAbsent();

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

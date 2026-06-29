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
const RUST_SERVERTOOL_AUTO_HOOK_QUEUE = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/auto_hook_queue_contract.rs`;
const RUST_SERVERTOOL_REGISTRY_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/registry_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_HANDLER_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_handler_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_branch_contract.rs`;
const RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/server_side_tool_entry_contract.rs`;
const RUST_SERVERTOOL_ENGINE_PREFLIGHT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_preflight_contract.rs`;
const RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_skip_contract.rs`;
const RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/engine_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_LOOP_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_LOOP_EFFECT_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_loop_effect_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_OUTCOME_RUNTIME_ACTION_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_outcome_runtime_action_contract.rs`;
const RUST_SERVERTOOL_EXECUTION_STATE_CONTRACT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/execution_state_contract.rs`;
const RUST_SERVERTOOL_STOPLESS_CLI_PROJECTION_CONTEXT = `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`;
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
const TS_BACKEND_ROUTE_SHADOW = `${SERVERTOOL_TS_DIR}/backend-route-shadow.ts`;
const TS_VISION_ELIGIBILITY = `${SERVERTOOL_TS_DIR}/handlers/vision-eligibility.ts`;
const TS_LOOP_STATE_BLOCK = `${SERVERTOOL_TS_DIR}/loop-state-block.ts`;
const TS_STOP_GATEWAY_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-gateway-context.ts`;
const TS_STOP_MESSAGE_COMPARE_CONTEXT = `${SERVERTOOL_TS_DIR}/stop-message-compare-context.ts`;
const TS_STOP_MESSAGE_LOOP_GUARD = `${SERVERTOOL_TS_DIR}/stop-message-loop-guard-block.ts`;
const TS_STOP_MESSAGE_LOOP_PAYLOAD = `${SERVERTOOL_TS_DIR}/stop-message-loop-payload-block.ts`;
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
const TS_REGISTRY_REGISTRATION_SHELL = `${SERVERTOOL_TS_DIR}/registry-registration-shell.ts`;
const TS_REGISTRY_PROJECTION_SHELL = `${SERVERTOOL_TS_DIR}/registry-projection-shell.ts`;
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
  `${ROOT}/tests/servertool/servertool-cli-projection.spec.ts`,
];
const DELETED_SERVERTOOL_ROOT_FACADE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`,
];
const DELETED_SERVERTOOL_REGISTRY_FACADE_FILES = [
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry.ts`,
  `${ROOT}/sharedmodule/llmswitch-core/src/servertool/registry-impl.ts`,
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
const SERVERTOOL_RUSTIFICATION_REQUIRED_VERIFICATION = Object.freeze({
  'hub.servertool_cli_projection': [
    'tests/cli/servertool-command.spec.ts',
    'tests/servertool/cli-projection-runtime-shell.spec.ts',
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
  `${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`,
  `${SERVERTOOL_TS_DIR}/engine.ts`,
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
    "expect((result.chat as any).choices?.[0]?.message?.reasoning_text).toContain('need more evidence')"
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

  const loopState = readRequired(`${ROOT}/tests/servertool/loop-state-block.spec.ts`);
  assertContains(
    'stopless-repeat-reset-lock',
    `${ROOT}/tests/servertool/loop-state-block.spec.ts`,
    loopState,
    'plans repeat state through native policy'
  );
  assertContains(
    'stopless-repeat-reset-lock',
    `${ROOT}/tests/servertool/loop-state-block.spec.ts`,
    loopState,
    'repeatCount: 2'
  );
  assertContains(
    'stopless-repeat-reset-lock',
    `${ROOT}/tests/servertool/loop-state-block.spec.ts`,
    loopState,
    'repeatCount: 1'
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
  const cliProjectionRuntimeShell = readRequired(`${SERVERTOOL_TS_DIR}/cli-projection-runtime-shell.ts`);
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
    `${SERVERTOOL_TS_DIR}/cli-projection-runtime-shell.ts`,
    cliProjectionRuntimeShell,
    'buildClientExecCliProjectionOutputWithNative'
  );
  assertContains(
    'cli-projection-runtime-native-owner',
    `${SERVERTOOL_TS_DIR}/cli-projection-runtime-shell.ts`,
    cliProjectionRuntimeShell,
    'buildClientVisibleProjectionShellWithNative'
  );
  if (cliProjectionRuntimeShell.includes("name: 'exec_command'") || cliProjectionRuntimeShell.includes('"name": "exec_command"')) {
    fail('cli-projection-command-contract', 'cli-projection runtime shell must not build exec_command tool call shape in TS');
  }
  if (cliProjectionRuntimeShell.includes('routecodex servertool run')) {
    fail('cli-projection-command-contract', 'cli-projection runtime shell must not build servertool CLI command strings in TS');
  }
  for (const keyword of [
    "args.flowId === 'stop_message_flow'",
    'const toolName = args.flowId',
    'typeof args.input?.repeatCount',
    'typeof args.input?.maxRepeats',
    'const repeatCount =',
    'const maxRepeats =',
  ]) {
    if (cliProjectionRuntimeShell.includes(keyword)) {
      fail(
        'cli-projection-output-no-ts-owner',
        `Forbidden TS client exec projection semantic "${keyword}" found in sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts`
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
    `${ROOT}/src/server/runtime/http-server/metadata-center/metadata-center.js`,
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
  for (const file of [`${SERVERTOOL_TS_DIR}/cli-projection-runtime-shell.ts`]) {
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
  if (existsSync(CLI_PROJECTION)) {
    fail('apply-patch-not-cli-projected', 'servertool/cli-projection.ts must stay physically deleted');
  }
  const cliProjectionRuntimeShell = readRequired(`${SERVERTOOL_TS_DIR}/cli-projection-runtime-shell.ts`);
  if (cliProjectionRuntimeShell.includes('apply_patch')) {
    fail('apply-patch-not-cli-projected', 'servertool CLI projection must not special-case or map apply_patch');
  } else {
    pass('apply-patch-not-cli-projected', 'cli projection runtime shell does not reference apply_patch');
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
    '../conversion/runtime-metadata.js',
    'ensureRuntimeMetadata',
    'readRuntimeMetadata',
    '.__rt',
  ]) {
    if (tsShell.includes(keyword)) {
      fail(
        'stop-message-compare-context-ts-thin-shell',
        `Forbidden TS stop-message compare semantic/fallback "${keyword}" found in stop-message-compare-context.ts`
      );
    }
  }
  for (const keyword of [
    'writeRuntimeControlToBoundMetadataCenter',
    'readRuntimeControlFromAnyBoundMetadataCenter',
    "key: STOP_MESSAGE_COMPARE_KEY",
    "required: true",
  ]) {
    if (!tsShell.includes(keyword)) {
      fail(
        'stop-message-compare-context-metadata-center-only',
        `stop-message-compare-context.ts must keep MetadataCenter runtime_control marker ${keyword}`
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
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    "from './timeout-error-block.js'"
  );
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);
  const serverSideToolsClientDisconnectBlock = extractFunctionBlock(serverSideToolsImpl, 'isClientDisconnected');
  if (serverSideToolsClientDisconnectBlock) {
    fail(
      'server-side-tools-client-disconnect-native-shell',
      'server-side-tools-impl.ts must not restore local isClientDisconnected; use timeout-error native wrapper'
    );
  }
  for (const keyword of [
    'clientConnectionState',
    'clientDisconnected',
    "trim().toLowerCase() === 'true'",
  ]) {
    if (serverSideToolsImpl.includes(keyword)) {
      fail(
        'server-side-tools-client-disconnect-native-shell',
        `Forbidden server-side-tools impl TS client disconnect semantic "${keyword}" found`
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

function checkServertoolExecutionDispatchRustOwner() {
  for (const file of DELETED_SERVERTOOL_DISPATCH_FACADE_FILES) {
    assertMissingFile(
      'servertool-dispatch-facade-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; execution queue runtime must import execution-queue-shell.ts directly`
    );
  }
  const executionQueueShell = readRequired(TS_EXECUTION_QUEUE_SHELL);
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);
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
    TS_EXECUTION_QUEUE_SHELL,
    executionQueueShell,
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
  for (const keyword of [
    'listRegisteredServerToolHandlerRecords()',
    'registeredToolCallHandlers: listRegisteredServerToolHandlerRecords()',
    '[servertool] dispatch spec mismatch:',
    '[servertool] invalid native mixed-client-tools outcome contract',
    '[servertool] missing native followup contract for servertool-only outcome',
    'export const buildServertoolOutcomePlanInput =',
    'export function materializeNativeToolCallExecutionOutcome(',
    "if (outcomePlan.outcomeMode === 'mixed_client_tools')",
    "outcomePlan.followupStrategy === 'reuse_last_execution'",
    '? args.executionState.lastExecution.followup',
    "if (!entry || entry.trigger !== 'tool_call')",
    'if (result) {',
    'if (lastErr) {',
    'executedToolCalls: [],',
    'executedIds: new Set<string>()',
    'executedFlowIds: []',
    'state.executedToolCalls.push({',
    'state.executedIds.add(toolCall.id)',
    'state.executedFlowIds.push(',
    'state.lastExecution = execution',
    'const newKeys = new Set(Object.keys(nextChatResponse));',
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

  assertMissingFile(
    'servertool-execution-shell-deleted',
    TS_EXECUTION_SHELL,
    'execution-shell.ts must stay physically deleted after moving pre-command wrappers to pre-command-hooks.ts and direct imports to execution-handler-materialization-shell.ts'
  );

  assertContains(
    'servertool-execution-branch-runtime-shell-owner',
    TS_EXECUTION_BRANCH_RUNTIME_SHELL,
    readRequired(TS_EXECUTION_BRANCH_RUNTIME_SHELL),
    'planServertoolExecutionBranchWithNative'
  );

  for (const [check, file, content, needle] of [
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'feature_id: hub.servertool_execution_branch_contract'],
    ['servertool-execution-branch-rust-owner', RUST_SERVERTOOL_EXECUTION_BRANCH_CONTRACT, rustExecutionBranch, 'pub fn plan_servertool_execution_branch'],
    ['servertool-execution-branch-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_branch_contract'],
    ['servertool-execution-branch-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_branch_json'],
    ['servertool-execution-branch-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_branch_json'],
    ['servertool-execution-branch-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionBranchJson'],
    ['servertool-execution-branch-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionBranchWithNative'],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_STAGE_SHELL, readRequired(TS_EXECUTION_STAGE_SHELL), 'planServertoolExecutionBranchRuntimeAction('],
    ['servertool-execution-branch-ts-thin-shell', TS_EXECUTION_BRANCH_RUNTIME_SHELL, readRequired(TS_EXECUTION_BRANCH_RUNTIME_SHELL), 'planServertoolExecutionBranchWithNative('],
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
    ['servertool-engine-skip-rust-owner', RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT), 'feature_id: hub.servertool_engine_skip_contract'],
    ['servertool-engine-skip-rust-owner', RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_SKIP_CONTRACT), 'pub fn plan_servertool_engine_skip'],
    ['servertool-engine-skip-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_skip_contract'],
    ['servertool-engine-skip-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_skip_json'],
    ['servertool-engine-skip-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_skip_json'],
    ['servertool-engine-skip-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineSkipJson'],
    ['servertool-engine-skip-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineSkipWithNative'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'feature_id: hub.servertool_engine_runtime_action_contract'],
    ['servertool-engine-runtime-action-rust-owner', RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT, readRequired(RUST_SERVERTOOL_ENGINE_RUNTIME_ACTION_CONTRACT), 'pub fn plan_servertool_engine_runtime_action'],
    ['servertool-engine-runtime-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod engine_runtime_action_contract'],
    ['servertool-engine-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_engine_runtime_action_json'],
    ['servertool-engine-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_engine_runtime_action_json'],
    ['servertool-engine-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolEngineRuntimeActionJson'],
    ['servertool-engine-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolEngineRuntimeActionWithNative'],
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
    ['servertool-execution-outcome-runtime-action-rust-owner', `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`, servertoolCoreLib, 'pub mod execution_outcome_runtime_action_contract'],
    ['servertool-execution-outcome-runtime-action-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_servertool_execution_outcome_runtime_action_json'],
    ['servertool-execution-outcome-runtime-action-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_servertool_execution_outcome_runtime_action_json'],
    ['servertool-execution-outcome-runtime-action-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planServertoolExecutionOutcomeRuntimeActionJson'],
    ['servertool-execution-outcome-runtime-action-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeCoreWrapper, 'planServertoolExecutionOutcomeRuntimeActionWithNative'],
    ['servertool-execution-outcome-runtime-action-ts-thin-shell', `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`, readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`), 'planServertoolExecutionOutcomeRuntimeActionWithNative'],
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
    ['servertool-execution-state-ts-thin-shell', `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`, readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`), 'createServertoolExecutionLoopStateFromNative'],
    ['servertool-execution-state-ts-thin-shell', `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`, readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`), 'appendExecutedToolRecordFromNative'],
  ]) {
    assertContains(check, file, content, needle);
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
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);

  for (const needle of [
    'feature_id: hub.servertool_pre_command_hooks',
    'pub struct PreCommandHooksConfigPlanInput',
    'pub struct PreCommandHooksConfigPlan',
    'pub struct PreCommandHookRulePlan',
    'pub struct PreCommandRegexPlan',
    'pub struct RuntimePreCommandRulePlanInput',
    'pub struct RuntimePreCommandStateSelectionInput',
    'pub struct RuntimePreCommandStateSelectionPlan',
    'pub struct RuntimePreCommandStateRuntimeActionInput',
    'pub struct RuntimePreCommandStateRuntimeActionPlan',
    'pub fn plan_pre_command_hooks_config',
    'pub fn plan_runtime_pre_command_rule',
    'pub fn plan_runtime_pre_command_state_selection',
    'pub fn plan_runtime_pre_command_state_runtime_action',
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
    'plan_runtime_pre_command_state_selection_json',
    'plan_runtime_pre_command_state_runtime_action_json',
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
    'pub fn plan_runtime_pre_command_state_selection_json',
    'pub fn plan_runtime_pre_command_state_runtime_action_json',
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
    'planRuntimePreCommandStateSelectionJson',
    'planRuntimePreCommandStateRuntimeActionJson',
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
  assertContains(
    'servertool-pre-command-hooks-runtime-selection-thin-shell',
    `${SERVERTOOL_TS_DIR}/pre-command-runtime-state-shell.ts`,
    readRequired(`${SERVERTOOL_TS_DIR}/pre-command-runtime-state-shell.ts`),
    'planRuntimePreCommandStateRuntimeActionWithNative({'
  );
  const preCommandRuntimeShell = readRequired(`${SERVERTOOL_TS_DIR}/pre-command-runtime-state-shell.ts`);
  for (const keyword of [
    'loadRoutingInstructionStateSync',
    'resolveServertoolPersistentScopeKey',
    'createServertoolProviderProtocolErrorFromPlan',
    'readProviderProtocolFromAnyBoundMetadataCenter',
    'readRuntimeMetadata',
    'directRuntimePreCommandState',
    'runtimeMetadataPreCommandState',
    'persistedState',
    'persistedLoad',
    '.__rt',
  ]) {
    if (preCommandRuntimeShell.includes(keyword)) {
      fail(
        'servertool-pre-command-runtime-control-only',
        `pre-command-runtime-state-shell.ts must not read ${keyword}; preCommandState belongs to MetadataCenter runtime_control`
      );
    }
  }
  for (const keyword of [
    'readRuntimeControlFromAnyBoundMetadataCenter',
    'runtimeControlPreCommandState',
    'runtimeControl?.preCommandState',
  ]) {
    if (!preCommandRuntimeShell.includes(keyword)) {
      fail(
        'servertool-pre-command-runtime-control-only',
        `pre-command-runtime-state-shell.ts must keep MetadataCenter runtime_control marker ${keyword}`
      );
    }
  }
  pass(
    'servertool-pre-command-runtime-control-only',
    'preCommandState reads only MetadataCenter runtime_control and never __rt/runtime-metadata/persisted state'
  );
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

function checkAutoHookExecutionRustOwner() {
  const rustAutoHookExecution = readRequired(RUST_SERVERTOOL_AUTO_HOOK_EXECUTION);
  const rustAutoHookQueue = readRequired(RUST_SERVERTOOL_AUTO_HOOK_QUEUE);
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
    'feature_id: hub.servertool_auto_hook_queue_progress',
    'pub struct AutoHookQueueProgressInput',
    'pub struct AutoHookQueueProgressPlan',
    'pub fn plan_auto_hook_queue_progress',
  ]) {
    assertContains('servertool-auto-hook-execution-rust-owner', RUST_SERVERTOOL_AUTO_HOOK_QUEUE, rustAutoHookQueue, needle);
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
    'pub mod auto_hook_queue_contract'
  );
  for (const needle of [
    'plan_auto_hook_execution_decision_json',
    'plan_auto_hook_queue_progress_json',
  ]) {
    assertContains('servertool-auto-hook-execution-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, needle);
    assertContains('servertool-auto-hook-execution-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, `pub fn ${needle}`);
  }
  assertContains('servertool-auto-hook-execution-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planAutoHookExecutionDecisionJson');
  assertContains('servertool-auto-hook-execution-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planAutoHookQueueProgressJson');
  assertContains('servertool-auto-hook-execution-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planAutoHookExecutionDecisionWithNative');
  assertContains('servertool-auto-hook-execution-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, 'planAutoHookQueueProgressWithNative');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'planAutoHookExecutionDecisionWithNative({');
  assertContains('servertool-auto-hook-execution-thin-shell', `${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`, autoHookCaller, 'planAutoHookQueueProgressWithNative({');
  for (const keyword of [
    "result: 'error'",
    "reason: 'predicate_false'",
    "reason: 'matched_without_flow'",
    "reason: 'empty_materialized_result'",
    'if (!planned) {',
    'if (result) {',
    'if (optionalResult) {',
    'if (mandatoryResult) {',
  ]) {
    if (autoHookCaller.includes(keyword)) {
      fail(
        'servertool-auto-hook-execution-no-ts-owner',
        `Forbidden TS auto-hook execution semantic "${keyword}" found in auto-hook-caller.ts`
      );
    }
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
  for (const file of DELETED_SERVERTOOL_REGISTRY_FACADE_FILES) {
    assertMissingFile(
      'servertool-registry-facades-deleted',
      file,
      `${file.replace(`${ROOT}/`, '')} must stay physically deleted; runtime must import registry-orchestration-shell.ts directly`
    );
  }
  const registryRegistrationShell = readRequired(TS_REGISTRY_REGISTRATION_SHELL);
  const registryProjectionShell = readRequired(TS_REGISTRY_PROJECTION_SHELL);
  const registryOrchestrationShell = readRequired(TS_REGISTRY_ORCHESTRATION_SHELL);

  for (const needle of [
    'feature_id: hub.servertool_registry_contract',
    'pub struct ServertoolRegistryRegistrationActionInput',
    'pub enum ServertoolRegistryRegistrationAction',
    'pub fn plan_servertool_registry_registration_action',
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
  assertContains(
    'servertool-registry-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod registry_contract'
  );
  for (const needle of [
    'plan_servertool_registry_registration_action_json',
    'plan_servertool_registry_lookup_action_json',
    'plan_servertool_registry_auto_hook_descriptors_json',
    'plan_servertool_registry_projection_json',
    'plan_servertool_registry_source_projection_json',
  ]) {
    assertContains('servertool-registry-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, needle);
    assertContains('servertool-registry-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, `pub fn ${needle}`);
  }
  for (const needle of [
    'planServertoolRegistryRegistrationActionJson',
    'planServertoolRegistryLookupActionJson',
    'planServertoolRegistryAutoHookDescriptorsJson',
    'planServertoolRegistryProjectionJson',
    'planServertoolRegistrySourceProjectionJson',
    'planServertoolRegistryRegistrationFromSkeletonJson',
    'planServertoolRegistryLookupFromSkeletonJson',
    'resolveServertoolRegisteredNameJson',
  ]) {
    assertContains('servertool-registry-required-export', NATIVE_REQUIRED_EXPORTS, requiredExports, needle);
  }
  for (const needle of [
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryLookupActionWithNative',
  ]) {
    assertContains('servertool-registry-native-bridge', NATIVE_SERVERTOOL_CORE_WRAPPER, nativeWrapper, needle);
  }
  for (const marker of [
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryLookupActionWithNative',
    'builtinNameMatched',
    'builtinEntryPresent',
    'registrationAllowedByConfig',
    'isServertoolEnabledByConfig',
    'getServertoolToolSpec(name)?.enabled',
  ]) {
    if (registryRegistrationShell.includes(marker)) {
      fail(
        'servertool-registry-registration-shell',
        `registry-registration-shell.ts must not retain TS registry action precondition marker ${marker}`
      );
    }
  }
  for (const needle of [
    'planServertoolRegistryRegistrationFromSkeleton(',
    'planServertoolRegistryLookupFromSkeleton(',
    'isServertoolRegisteredNameByConfig(',
  ]) {
    assertContains('servertool-registry-registration-shell', TS_REGISTRY_REGISTRATION_SHELL, registryRegistrationShell, needle);
  }
  for (const needle of [
    'registerServerToolHandlerViaNativePlan',
    'getServerToolHandlerViaNativePlan',
  ]) {
    assertContains('servertool-registry-registration-shell', TS_REGISTRY_REGISTRATION_SHELL, registryRegistrationShell, needle);
  }
  for (const needle of [
    'planServertoolRegistryAutoHookDescriptorsWithNative',
    'planServertoolRegistrySourceProjectionWithNative',
    'projectAutoServerToolHookDescriptors',
    'projectRegistrySources',
  ]) {
    assertContains('servertool-registry-projection-shell', TS_REGISTRY_PROJECTION_SHELL, registryProjectionShell, needle);
  }
  assertContains(
    'servertool-registry-orchestration-shell',
    TS_REGISTRY_ORCHESTRATION_SHELL,
    registryOrchestrationShell,
    'projectRegistrySources('
  );
  for (const marker of [
    '[...listBuiltinHandlerNames(), ...listAdHocHandlerNames()]',
    '[...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()]',
    'builtinEntries',
    'rawRecords = [',
    '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry))',
    '.map((name) => getBuiltinHandlerEntry(name))',
    'projectRegistryHandlerNames({',
    'projectAutoServerToolHandlers({',
    'projectRegisteredServerToolHandlerRecords({',
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
    'registry-orchestration-shell.ts delegates source merge/order/grouping to Rust source projection'
  );
  for (const keyword of [
    'planServertoolRegistryRegistrationActionWithNative',
    'planServertoolRegistryLookupActionWithNative',
    'planServertoolRegistryAutoHookDescriptorsWithNative',
    'planServertoolRegistryProjectionWithNative',
    'native registry auto handler order missing entry',
    'native registry auto-hook descriptor missing entry',
    'native registry record projection mismatch',
    'if (builtinEntry) {',
    'return getAdHocHandlerEntry(canonicalName);',
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
}

function checkServertoolEntryPreflightRustOwner() {
  const rustEntryPreflight = readRequired(RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT);
  const servertoolCoreLib = readRequired(`${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`);
  const napiBlocks = readRequired(`${RUST_SRC_DIR}/servertool_core_blocks.rs`);
  const napiLib = readRequired(RUST_ROUTER_HOTPATH_NAPI_LIB);
  const nativeWrapper = readRequired(NATIVE_SERVERTOOL_CORE_WRAPPER);
  const requiredExports = readRequired(NATIVE_REQUIRED_EXPORTS);
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);

  for (const needle of [
    'feature_id: hub.servertool_server_side_tool_entry_contract',
    'pub struct ServertoolEntryPreflightInput',
    'pub struct ServertoolEntryPreflightPlan',
    'pub fn plan_servertool_entry_preflight',
  ]) {
    assertContains('servertool-entry-preflight-rust-owner', RUST_SERVERTOOL_ENTRY_PREFLIGHT_CONTRACT, rustEntryPreflight, needle);
  }
  assertContains(
    'servertool-entry-preflight-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod server_side_tool_entry_contract'
  );
  assertContains(
    'servertool-entry-preflight-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_entry_preflight_json'
  );
  assertContains(
    'servertool-entry-preflight-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_entry_preflight_json'
  );
  assertContains(
    'servertool-entry-preflight-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolEntryPreflightJson'
  );
  assertContains(
    'servertool-entry-preflight-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeWrapper,
    'planServertoolEntryPreflightWithNative'
  );
  assertContains(
    'servertool-entry-preflight-ts-thin-shell',
    TS_ENTRY_PREFLIGHT_SHELL,
    readRequired(TS_ENTRY_PREFLIGHT_SHELL),
    'planServertoolEntryPreflightWithNative'
  );
  for (const keyword of [
    'if (!base) {',
    'if (isAdapterClientDisconnected(options.adapterContext)) {',
  ]) {
    assertMissing(
      'servertool-entry-preflight-no-ts-owner',
      `${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`,
      serverSideToolsImpl,
      keyword
    );
  }
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
  const skeletonConfigShell = readRequired(TS_SERVERTOOL_SKELETON_CONFIG);
  const progressLogShell = readRequired(`${SERVERTOOL_TS_DIR}/progress-log-block.ts`);
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
      `${SERVERTOOL_TS_DIR}/progress-log-block.ts`,
      progressLogShell,
      needle
    );
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
    'flow-presentation-block.ts stays deleted; progress-log-block.ts directly uses native flow presentation wrappers'
  );
  pass(
    'servertool-flow-presentation-no-skeleton-ts-owner',
    'skeleton-config.ts has no progress presentation projection shell'
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
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);
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
  if (!serverSideToolsImpl.includes('extractTextFromChatLikeWithNative(payload)')) {
    fail(
      'servertool-text-extraction-thin-wrapper',
      'server-side-tools-impl.ts must delegate extractTextFromChatLike to extractTextFromChatLikeWithNative(payload)'
    );
  }

  const functionBlock = extractFunctionBlock(serverSideToolsImpl, 'extractTextFromChatLike');
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
    ['stopless-orchestration-action-thin-shell', TS_ENGINE_ORCHESTRATION_SHELL, servertoolEngine, "readNativeFunction('planStoplessExecutionJson')"],
  ]) {
    assertContains(check, file, content, needle);
  }

  for (const keyword of [
    'planStoplessOrchestrationActionWithNative',
    "readNativeFunction('planStoplessOrchestrationActionJson')",
    'requestTruth: { sessionId: requestTruthSessionId }',
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
  const builtinCatalog = readRequired(`${SERVERTOOL_TS_DIR}/builtin-handler-catalog.ts`);
  for (const marker of [
    'readMetadataCenterSnapshot',
    'buildMetadataCenterRustSnapshot',
    'readBoundMetadataCenter',
    'ctx.adapterContext',
    'adapterContext: {}',
  ]) {
    if (builtinCatalog.includes(marker)) {
      fail(
        'stopless-no-context-data-plane',
        `builtin-handler-catalog.ts must not read adapterContext/MetadataCenter for stopless runtime marker ${marker}`
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
  const stopGatewayContext = readRequired(`${SERVERTOOL_TS_DIR}/stop-gateway-context.ts`);
  for (const marker of [
    "from '../conversion/runtime-metadata.js'",
    'ensureRuntimeMetadata',
    'readRuntimeMetadata',
    '__rt',
  ]) {
    if (stopGatewayContext.includes(marker)) {
      fail(
        'stop-gateway-metadata-center-only',
        `stop-gateway-context.ts must not use legacy runtime metadata marker ${marker}; stopGatewayContext belongs to MetadataCenter runtime_control`
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
        `stop-gateway-context.ts must use MetadataCenter runtime_control marker ${marker}`
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
  const cliProjectionRuntimeShell = readRequired(`${ROOT}/sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts`);
  const tsServerSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);

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
    if (cliProjectionRuntimeShell.includes(marker)) {
      fail('servertool-cli-runtime-shell', `cli-projection-runtime-shell.ts must not carry legacy servertool marker ${marker}`);
    }
  }
  for (const marker of ['memory_cache_auto', 'executeServertoolBackendPlan']) {
    if (cliProjectionRuntimeShell.includes(marker) || tsServerSideToolsImpl.includes(marker)) {
      fail(
        'servertool-cli-runtime-shell',
        `servertool runtime shell must not revive retired marker ${marker}`
      );
    }
  }

  if (resultRestoreSpec.includes('restore the old CLI restoration implementation')) {
    fail('servertool-cli-result-restore-thin-shell', 'servertool-cli-result-restore.spec.ts must not reintroduce legacy CLI restoration behavior');
  }

  for (const marker of [
    "return toolCall.name === 'servertool_fixture';",
    "return name !== 'servertool_fixture' && name !== 'stop_message_auto';",
    "return executionMode === 'client_exec_cli_projection' || executionMode === 'client_inject_only';",
  ]) {
    if (tsServerSideToolsImpl.includes(marker)) {
      fail(
        'servertool-cli-ts-name-fallback',
        `server-side-tools*.ts must not retain TS tool-name fallback marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export function isClientExecCliProjectionToolCall(',
    'return isServertoolClientExecCliProjectionToolCallWithNative({',
    'executionMode: toolCall.executionMode',
  ]) {
    if (!cliProjectionRuntimeShell.includes(marker)) {
      fail(
        'servertool-cli-projection-thin-shell-guard',
        `cli-projection-runtime-shell.ts must keep CLI projection impl guard marker ${marker}`
      );
    }
  }
  for (const marker of [
    'collectAdditionalClientToolCalls',
    'isClientExecCliProjectionToolCall'
  ]) {
    if (!cliProjectionRuntimeShell.includes(marker)) {
      fail(
        'servertool-cli-projection-thin-shell-guard',
        `cli-projection-runtime-shell.ts must keep CLI projection runtime marker ${marker}`
      );
    }
  }
  for (const marker of ['export const runServerSideToolEngine =', 'export const extractToolCalls =']) {
    if (!tsServerSideToolsImpl.includes(marker)) {
      fail(
        'servertool-cli-projection-thin-shell-guard',
        `server-side-tools-impl.ts must keep thin-shell owner marker ${marker}`
      );
    }
  }
  const extractToolCallsShell = readRequired(TS_EXTRACT_TOOL_CALLS_SHELL);
  for (const marker of [
    'export const extractToolCallsFromResponseStage =',
    'runServertoolResponseStageWithNative',
    'replaceJsonObjectInPlace'
  ]) {
    if (!extractToolCallsShell.includes(marker)) {
      fail(
        'servertool-extract-tool-calls-shell-owner',
        `extract-tool-calls-shell.ts must keep extraction owner marker ${marker}`
      );
    }
  }
  const dispatchPreparationShell = readRequired(TS_DISPATCH_PREPARATION_SHELL);
  for (const marker of [
    'export function prepareServertoolDispatchStage(',
    'readRuntimeMetadata',
    'resolveServertoolRuntimePreCommandState',
    'applyPreCommandHooksToToolCalls',
    'planServertoolToolCallDispatchWithNative'
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
    'createServertoolObservation({',
    'runEnginePreflight({',
    'planServertoolEngineSkipWithNative({',
    'recordServertoolEngineMatchSkipped({',
    'recordServertoolEngineMatchHit({',
    'runServertoolEnginePostflight({',
  ]) {
    if (!engineOrchestrationShell.includes(marker)) {
      fail(
        'servertool-engine-orchestration-shell-owner',
        `engine-orchestration-shell.ts must keep engine orchestration owner marker ${marker}`
      );
    }
  }
  const engineObservationShell = readRequired(TS_ENGINE_OBSERVATION_SHELL);
  for (const marker of [
    'export function logServertoolNonBlocking(',
    'export function createServertoolObservation(',
    'createServertoolProgressLogger({',
    'recordServertoolMatchSkipped({',
    'recordServertoolMatchHit({',
  ]) {
    if (!engineObservationShell.includes(marker)) {
      fail(
        'servertool-engine-observation-shell-owner',
        `engine-observation-shell.ts must keep engine observation owner marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export function runEnginePreflight(',
    'planServertoolEnginePreflightWithNative',
    'inspectStopGatewaySignal(',
    'attachStopGatewayContext(',
    'containsSyntheticRouteCodexControlText(',
    'return_original_chat_direct_passthrough',
  ]) {
    if (!enginePreflightShell.includes(marker)) {
      fail(
        'servertool-engine-preflight-shell-owner',
        `engine-preflight-shell.ts must keep engine preflight owner marker ${marker}`
      );
    }
  }
  const entryPreflightShell = readRequired(TS_ENTRY_PREFLIGHT_SHELL);
  for (const marker of [
    'export function runServertoolEntryPreflight(',
    'planServertoolEntryPreflightWithNative',
    'createServerToolClientDisconnectedError',
    "result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }"
  ]) {
    if (!entryPreflightShell.includes(marker)) {
      fail(
        'servertool-entry-preflight-shell-owner',
        `entry-preflight-shell.ts must keep entry preflight owner marker ${marker}`
      );
    }
  }
  const entryContextShell = readRequired(TS_ENTRY_CONTEXT_SHELL);
  for (const marker of [
    'export function resolveServertoolEntryContext(',
    'export function asServertoolJsonObject(',
    'normalizeFilterTokenSet',
    'includeToolCallNames: normalizeFilterTokenSet',
    'excludeToolCallNames: normalizeFilterTokenSet',
    'includeAutoHookIds: normalizeFilterTokenSet',
    'excludeAutoHookIds: normalizeFilterTokenSet'
  ]) {
    if (!entryContextShell.includes(marker)) {
      fail(
        'servertool-entry-context-shell-owner',
        `entry-context-shell.ts must keep entry context owner marker ${marker}`
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
    'runServertoolExecutionStage'
  ]) {
    if (!runServerSideToolEngineShell.includes(marker)) {
      fail(
        'servertool-run-server-side-tool-engine-shell-owner',
        `run-server-side-tool-engine-shell.ts must keep engine orchestration owner marker ${marker}`
      );
    }
  }
  const executionStageShell = readRequired(TS_EXECUTION_STAGE_SHELL);
  for (const marker of [
    'export async function runServertoolExecutionStage(',
    'prepareServertoolDispatchStage',
    'planServertoolExecutionBranchRuntimeAction',
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
  if (!cliProjectionRuntimeShell.includes('export const collectAdditionalClientToolCalls =')) {
    fail(
      'servertool-cli-projection-thin-shell-guard',
      'cli-projection-runtime-shell.ts must keep thin-shell owner marker export const collectAdditionalClientToolCalls ='
    );
  }

  const executionShell = existsSync(TS_EXECUTION_SHELL) ? readRequired(TS_EXECUTION_SHELL) : '';
  const executionMaterializationShell = readRequired(`${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`);
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
    'function isServerToolHandlerPlan(',
    'function isServerToolHandlerResult(',
    'function assertValidServertoolHandlerContract(',
    'planServertoolHandlerContractWithNative',
    'planServertoolBackendExecutionWithNative',
    '[servertool] invalid handler plan contract: missing finalize',
    '[servertool] invalid handler plan/result contract',
    '[servertool] handler failed:',
    '[servertool] vision_analysis backend requires reenterPipeline',
    '[servertool] unsupported backend plan kind:',
    "if (planHandlerMaterializationAction(planned, options) === 'handler_plan')",
    "await import('./builtin-handler-catalog.js')",
    'getBuiltinHandlerEntry(args.builtinName)',
    'builtin handler missing execution descriptor',
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
    'planServertoolHandlerRuntimeActionWithNative'
  );
  assertContains(
    'servertool-execution-handler-builtin-runtime-thin-shell',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    '__executeBuiltinHandlerForRuntime(args.builtinName, args.ctx)'
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
    'pub fn plan_servertool_handler_failed_error',
    'pub fn plan_servertool_unsupported_backend_plan_kind_error',
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
  ]) {
    if (rustExecutionHandlerContract.includes(marker)) {
      fail(
        'servertool-execution-handler-contract-rust-owner',
        `execution handler contract must not retain retired backend reenter marker ${marker}`
      );
    }
  }
  assertContains(
    'servertool-execution-handler-contract-rust-owner',
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`,
    servertoolCoreLib,
    'pub mod execution_handler_contract'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_handler_contract_error_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_handler_runtime_action_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    `${RUST_SRC_DIR}/servertool_core_blocks.rs`,
    napiBlocks,
    'plan_servertool_materialization_progress_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_handler_contract_error_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_handler_runtime_action_json'
  );
  assertContains(
    'servertool-execution-handler-contract-native-export',
    RUST_ROUTER_HOTPATH_NAPI_LIB,
    napiLib,
    'pub fn plan_servertool_materialization_progress_json'
  );
  assertContains(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolHandlerContractErrorJson'
  );
  assertContains(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolHandlerRuntimeActionJson'
  );
  assertContains(
    'servertool-execution-handler-contract-required-export',
    NATIVE_REQUIRED_EXPORTS,
    requiredExports,
    'planServertoolMaterializationProgressJson'
  );
  assertContains(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerContractErrorWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolHandlerRuntimeActionWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-native-bridge',
    NATIVE_SERVERTOOL_CORE_WRAPPER,
    nativeCoreWrapper,
    'planServertoolMaterializationProgressWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-ts-thin-shell',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'planServertoolHandlerContractErrorWithNative'
  );
  assertContains(
    'servertool-execution-handler-contract-ts-thin-shell',
    `${SERVERTOOL_TS_DIR}/execution-handler-materialization-shell.ts`,
    executionMaterializationShell,
    'planServertoolHandlerRuntimeActionWithNative'
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
  ]) {
    if (responseStageShell.includes(marker)) {
      fail(
        'servertool-response-stage-runtime-control-mirror',
        `response-stage-orchestration-shell.ts must not mirror MetadataCenter runtime_control via TS marker ${marker}`
      );
    }
  }
  for (const marker of [
    'readRuntimeControlFromBoundMetadataCenter(',
    'writeRuntimeControlToBoundMetadataCenter(',
    'servertoolResponseOrchestration',
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
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);
  for (const marker of [
    'const autoHookExecutionList = listAutoServerToolHooks();',
    'const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromConfig({',
    "const optionalResult = await runAutoHookExecutionQueue({",
    "const mandatoryResult = await runAutoHookExecutionQueue({",
  ]) {
    if (serverSideToolsImpl.includes(marker)) {
      fail(
        'servertool-auto-hook-caller-inline-orchestration',
        `server-side-tools-impl.ts must not retain inline auto-hook caller orchestration marker ${marker}`
      );
    }
  }
  for (const marker of [
    'runServertoolAutoHookCallerViaThinShell as runServertoolAutoHookCaller',
  ]) {
    if (serverSideToolsImpl.includes(marker)) {
      fail(
        'servertool-auto-hook-caller-thin-shell',
        `server-side-tools-impl.ts must not retain deleted auto-hook caller alias marker ${marker}`
      );
    }
  }
  for (const marker of [
    'export const runServertoolAutoHookCallerImpl =',
  ]) {
    if (serverSideToolsImpl.includes(marker)) {
      fail(
        'servertool-auto-hook-caller-thin-shell',
        `*Impl alias export must not revive: ${marker}`
      );
    }
  }
  if (serverSideToolsImpl.includes('runServertoolAutoHookCallerViaImplThinShell')) {
    fail(
      'servertool-auto-hook-caller-thin-shell',
      'server-side-tools-impl.ts must not retain the deleted runServertoolAutoHookCallerViaImplThinShell wrapper'
    );
  }
  if (serverSideToolsImpl.includes('runServertoolAutoHookCallerViaThinShell')) {
    fail(
      'servertool-auto-hook-caller-thin-shell',
      'server-side-tools-impl.ts must not retain deleted runServertoolAutoHookCallerViaThinShell import/call marker'
    );
  }
  const autoHookCallerShell = readRequired(`${SERVERTOOL_TS_DIR}/auto-hook-caller.ts`);
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
  const serverSideToolsImpl = readRequired(`${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`);
  for (const marker of [
    'detectEmptyAssistantPayloadContractSignalWithNative',
    'isStopEligibleForServerTool',
  ]) {
    if (serverSideToolsImpl.includes(marker)) {
      fail(
        'servertool-response-stage-gate-inline-semantic',
        `server-side-tools-impl.ts must not retain response-stage inline semantic marker ${marker}`
      );
    }
  }
  if (serverSideToolsImpl.includes('bindResponseStageGateNativeShell(')) {
    fail(
      'servertool-response-stage-gate-thin-shell',
      'server-side-tools-impl.ts must not retain deleted bindResponseStageGateNativeShell wrapper'
    );
    return;
  }
  pass(
    'servertool-response-stage-gate-thin-shell',
    'server-side-tools-impl.ts does not retain response-stage wrapper alias'
  );

  const responseStageFinalizeShell = readRequired(TS_RESPONSE_STAGE_FINALIZE_SHELL);
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'planServertoolResponseStageGateWithNative'
  );
  assertContains(
    'servertool-response-stage-finalize-shell-owner',
    TS_RESPONSE_STAGE_FINALIZE_SHELL,
    responseStageFinalizeShell,
    'runServertoolResponseStageAutoHookPass'
  );

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
    'runServertoolResponseStageAutoHookPass'
  );
}

function checkServertoolEngineStoplessSessionThinShell() {
  const engineSource = readRequired(`${SERVERTOOL_TS_DIR}/engine.ts`);
  const postflightSource = readRequired(`${SERVERTOOL_TS_DIR}/engine-postflight-shell.ts`);
  const builtinHandlerCatalogSource = readRequired(`${SERVERTOOL_TS_DIR}/builtin-handler-catalog.ts`);
  const rustProjectionContextSource = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_cli_projection_context_contract.rs`
  );
  const rustProjectionBridgeSource = readRequired(
    `${ROOT}/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`
  );
  for (const marker of [
    'function logServerToolNonBlocking(',
    'createServertoolProgressLogger({',
    'recordServertoolMatchSkipped({',
    'recordServertoolMatchHit({',
  ]) {
    if (engineSource.includes(marker)) {
      fail(
        'servertool-engine-observation-inline-semantic',
        `engine.ts must not retain engine observation inline semantic marker ${marker}`
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
        `engine.ts must not retain stopless session inline semantic marker ${marker}`
      );
    }
  }
  if (!engineSource.includes('from \'./engine-orchestration-shell.js\'')) {
    fail(
      'servertool-engine-stopless-session-thin-shell',
      'engine.ts must re-export orchestration from engine-orchestration-shell.ts'
    );
  }
  for (const marker of [
    "if (runtimeAction.action === 'build_stop_message_cli_projection')",
    "readNativeFunction('buildStoplessAutoCliProjectionFromEngineJson')",
  ]) {
    if (!postflightSource.includes(marker)) {
      fail(
        'servertool-engine-stopless-session-thin-shell',
        `engine-postflight-shell.ts must keep stopless session thin-shell marker ${marker}`
      );
    }
  }
  for (const marker of [
    'resolveStoplessCliProjectionContext(',
    'planStoplessCliProjectionContextWithNative(',
    'buildServertoolCliProjectionForAutoFlowShell({',
    'buildStoplessAutoCliProjectionJson',
    'function readSessionAndRequestId(',
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
  ]) {
    if (builtinHandlerCatalogSource.includes(marker)) {
      fail(
        'servertool-builtin-handler-stopless-no-ts-action-owner',
        `builtin-handler-catalog.ts must not retain stopless runtime action semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    'function isBuiltinRuntimeSupported(',
    'function readSkeletonOwnedRegistration(',
    'getServertoolToolSpec',
    'listServertoolToolSpecs',
  ]) {
    if (builtinHandlerCatalogSource.includes(marker)) {
      fail(
        'servertool-builtin-handler-catalog-rust-plan',
        `builtin-handler-catalog.ts must not retain TS builtin catalog semantic marker ${marker}`
      );
    }
  }
  for (const marker of [
    "readNativeFunction('runStoplessBuiltinHandlerForRuntimeJson')",
    'resolveServertoolBuiltinHandlerEntry(',
    'planServertoolBuiltinHandlerNames(',
    'planServertoolBuiltinAutoHandlerEntries(',
    'planServertoolBuiltinHandlerRecordEntries(',
  ]) {
    if (!builtinHandlerCatalogSource.includes(marker)) {
      fail(
        'servertool-builtin-handler-stopless-thin-shell',
        `builtin-handler-catalog.ts must keep Rust stopless runtime thin-shell marker ${marker}`
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
        'function materializeServertoolPlannedResult(',
        'function executeServertoolBackendPlan(',
        'export async function runServertoolHandler(',
      ],
    ],
    [
      `${SERVERTOOL_TS_DIR}/server-side-tools-impl.ts`,
      [
        "import './handlers/stop-message-auto.js';",
        "import './handlers/vision.js';",
        'const gatePlan = planServertoolResponseStageGateWithNative(',
        'hasServertoolSupport:',
        "typeof options.providerInvoker === 'function' || typeof options.reenterPipeline === 'function'",
        "return name !== 'stop_message_auto';",
        'if (!base) {',
        'if (isAdapterClientDisconnected(options.adapterContext)) {',
        'responseStageNextAction:',
        "(responseStagePlan as Record<string, unknown>).nextAction",
        'const responseStagePlan = responseHookStagePlan.responseHookMatched ? responseHookStagePlan : planServertoolResponseStageGateWithNative(',
        "if (responseStageAutoHook.action === 'return_passthrough_bypass') {",
        "postAutoHookRuntimeAction.action === 'return_auto_hook_result' && autoHookResult",
        "const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative(",
        "const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative(",
        'await runServertoolAutoHookCaller({',
        "'SERVERTOOL_CLIENT_DISCONNECTED'",
        "'[servertool] client disconnected before servertool execution'",
        '.find(isClientExecCliProjectionToolCall)',
        'toolCall.id === preExecutionBranchPlan.projectedToolCallId',
        '[servertool] native execution-branch projected missing tool call index:',
        'buildServertoolCliProjectionForToolCall(',
        'buildServertoolCliProjectionExecutionContextWithNative(',
        'executionState.executedToolCalls.length > 0',
        "flowId: 'servertool_cli_projection'",
        'servertoolCliProjection: {',
        '[servertool] native execution-branch projected missing tool call id:',
        'readRuntimeControlFromAnyBoundMetadataCenter(',
        'runtimeControlPreCommandState',
        'planRuntimePreCommandStateRuntimeActionWithNative({',
        "import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';",
        'function getArray(value: unknown): JsonValue[] {',
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

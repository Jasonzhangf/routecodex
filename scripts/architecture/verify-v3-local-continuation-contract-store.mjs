#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/local_continuation.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/local_continuation_contract_store.rs';
const designPath = 'docs/goals/v3-local-continuation-contract-store-test-design.md';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const tests = readFileSync(resolve(root, testPath), 'utf8');
const design = readFileSync(resolve(root, designPath), 'utf8');
const failures = [];

function fail(message) {
  failures.push(message);
}

function requireAll(text, owner, phrases) {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbid(text, owner, pattern, label) {
  if (pattern.test(text)) fail(`${owner}: forbidden ${label}`);
}

function rustFilesBelow(relative) {
  const absolute = resolve(root, relative);
  const files = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) files.push(...rustFilesBelow(join(relative, entry)));
    else if (entry.endsWith('.rs')) files.push(path);
  }
  return files;
}

requireAll(source, sourcePath, [
  'V3LocalContinuationResp04SaveInput',
  'V3LocalContinuationReq04RestoreRequest',
  'V3LocalContinuationReq04Restored',
  'commit_at_resp04',
  'restore_at_req04',
  'V3LocalContinuationSaveBoundary::Resp04',
  'V3LocalContinuationRestoreOwner::RouteCodexLocal',
  'V3LocalContinuationTerminalOutcome::NonTerminal',
  'V3LocalContinuationResp04CommitResult::NotStored',
  'AlreadyCommitted',
  'ScopeMismatch',
  'Expired',
  'CrossOwner',
  'serde_json::to_vec',
  'serde_json::from_slice',
]);

const denyUnknownCount = (source.match(/#\[serde\(deny_unknown_fields\)\]/g) ?? []).length;
if (denyUnknownCount < 2) {
  fail(`${sourcePath}: immutable record and scope must both deny unknown fields`);
}

requireAll(tests, testPath, [
  'non_terminal_resp04_save_and_req04_restore_are_round_trip_equivalent',
  'terminal_success_failure_and_already_terminal_are_explicit_non_save_results',
  'already_terminal_input_cannot_revive_or_overwrite_existing_truth',
  'every_entry_session_conversation_port_and_group_scope_mismatch_is_rejected',
  'expired_context_fails_without_repair_or_fallback',
  'duplicate_resp04_commit_cannot_overwrite_immutable_context',
  'remote_owner_cannot_restore_local_context',
  'corrupt_or_forbidden_codec_fields_fail_closed',
]);
requireAll(design, designPath, [
  'V3LocalContinuationResp04SaveInput',
  'V3LocalContinuationStore::commit_at_resp04',
  'V3LocalContinuationStore::restore_at_req04',
  'does not prove live Relay',
]);

forbid(
  source,
  sourcePath,
  /\bfallback(?:_[a-z0-9]+)*\b|\b(?:unwrap_or_default|unwrap_or_else)\b/i,
  'fallback',
);
forbid(source, sourcePath, /\b(?:debug_snapshot|snapshot_payload|snapshot_truth)\b/i, 'Debug or snapshot truth');
forbid(source, sourcePath, /\b(?:provider_id|model_id|auth_handle_id|provider_pin)\b/i, 'provider pin inference');
forbid(source, sourcePath, /pub\s+fn\s+(?:save|restore|load)\s*\(/, 'generic continuation save/restore API');
forbid(source, sourcePath, /commit_at_resp0[1-35-9]|restore_at_req0[1-35-9]/, 'wrong save or restore boundary');
forbid(source, sourcePath, /serde_json::(?:to_value|from_value)/, 'semantic JSON value rebuild');

const crossOwnerGuard = 'if request.owner != V3LocalContinuationRestoreOwner::RouteCodexLocal';
if (!source.includes(crossOwnerGuard)) {
  fail(`${sourcePath}: missing explicit cross-owner restore rejection`);
}

const lib = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/src/lib.rs'), 'utf8');
requireAll(lib, 'runtime lib export', ['pub mod local_continuation;', 'pub use local_continuation::*;']);

for (const path of [
  ...rustFilesBelow('v3/crates/routecodex-v3-server/src'),
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
]) {
  const text = readFileSync(path, 'utf8');
  if (/V3LocalContinuationStore|commit_at_resp04|restore_at_req04/.test(text)) {
    fail(`${path}: local continuation contract/store must remain unwired in this slice`);
  }
}

if (failures.length > 0) {
  console.error('[verify:v3-local-continuation-contract-store] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-local-continuation-contract-store] ok');

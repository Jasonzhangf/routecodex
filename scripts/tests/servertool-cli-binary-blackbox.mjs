#!/usr/bin/env node
/**
 * Blackbox regression test for the standalone `routecodex-servertool` Rust binary.
 * Spawns the compiled binary and asserts JSON output contract.
 *
 * Usage:
 *   node scripts/tests/servertool-cli-binary-blackbox.mjs [--bin <path>]
 *
 * If --bin is not given, looks for the binary in the standard Cargo output location.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── resolve binary ──────────────────────────────────────────────────────────

function resolveBinary() {
  const idx = process.argv.indexOf('--bin');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  // standard cargo build location
  const defaultPath = path.resolve(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
  );
  if (fs.existsSync(defaultPath)) return defaultPath;
  throw new Error(
    `Binary not found at ${defaultPath}. Run: cargo build -p servertool-cli\n` +
    `Or pass --bin <path>`
  );
}

const bin = resolveBinary();

function run(toolName, args = {}, options = {}) {
  const inputJson = JSON.stringify(args);
  const flow = options.flow || 'stop_message_flow';
  return execFileSync(
    bin,
    ['run', toolName, '--flow', flow, '--input-json', inputJson],
    { encoding: 'utf8', timeout: 10_000 }
  );
}

function runExpectFailure(toolName, args = {}, options = {}) {
  const inputJson = JSON.stringify(args);
  const flow = options.flow || 'stop_message_flow';
  try {
    execFileSync(
      bin,
      ['run', toolName, '--flow', flow, '--input-json', inputJson],
      { encoding: 'utf8', timeout: 10_000 }
    );
    throw new Error('expected non-zero exit');
  } catch (err) {
    if (err.status === 0) throw new Error('expected non-zero exit');
    return err.stderr || err.message;
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

console.log(`[servertool-cli-blackbox] using binary: ${bin}`);

// RED TEST 1: stop_message_auto outputs Rust-owned schema
{
  const raw = run('stop_message_auto', {
    continuationPrompt: 'continue with schema',
    repeatCount: 1,
    maxRepeats: 3,
  });
  const out = JSON.parse(raw);
  assert.equal(out.toolName, 'stop_message_auto', 'toolName must be stop_message_auto');
  assert.equal(out.flowId, 'stop_message_flow', 'flowId must be stop_message_flow');
  assert.equal(out.repeatCount, 1, 'repeatCount');
  assert.equal(out.maxRepeats, 3, 'maxRepeats');
  // schema must be Rust-owned
  assert.ok(out.schemaGuidance, 'schemaGuidance present');
  assert.ok(Array.isArray(out.schemaGuidance.requiredFields), 'requiredFields is array');
  assert.ok(out.schemaGuidance.requiredFields.includes('stopreason'), 'must include stopreason');
  assert.equal(out.schemaGuidance.stopreasonValues.continueNeeded, 2);
  console.log('  [PASS] stop_message_auto Rust-owned schema');
}

// RED TEST 2: missing continuationPrompt fails fast
{
  const stderr = runExpectFailure('stop_message_auto', {
    repeatCount: 1,
    maxRepeats: 3,
  });
  assert.ok(stderr.includes('SERVERTOOL_CLI_MISSING_FIELD: continuationPrompt'), stderr);
  console.log('  [PASS] missing continuationPrompt fails fast');
}

// RED TEST 3: web_search is NOT ClientExecCliProjection
{
  const stderr = runExpectFailure('web_search', {
    continuationPrompt: 'continue with schema',
    repeatCount: 1,
    maxRepeats: 3,
  });
  assert.ok(stderr.includes('SERVERTOOL_UNSUPPORTED_TOOL: web_search'), stderr);
  console.log('  [PASS] web_search rejected (not ClientExecCliProjection)');
}

// RED TEST 4: invalid flowId fails fast
{
  const stderr = runExpectFailure('stop_message_auto', {
    continuationPrompt: 'continue with schema',
    repeatCount: 1,
    maxRepeats: 3,
  }, { flow: 'wrong_flow' });
  assert.ok(stderr.includes('SERVERTOOL_CLI_INVALID_FIELD: flowId'), stderr);
  console.log('  [PASS] invalid flowId fails fast');
}

// RED TEST 5: repeatCount > maxRepeats fails fast
{
  const stderr = runExpectFailure('stop_message_auto', {
    continuationPrompt: 'continue with schema',
    repeatCount: 4,
    maxRepeats: 3,
  });
  assert.ok(stderr.includes('SERVERTOOL_CLI_INVALID_FIELD: repeatCount/maxRepeats'), stderr);
  console.log('  [PASS] repeatCount > maxRepeats fails fast');
}

console.log('[servertool-cli-blackbox] all tests passed');

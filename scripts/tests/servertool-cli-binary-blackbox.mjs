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

const forbiddenStoplessTokens = [
  'schema',
  'hook',
  'stopless',
  'servertool',
  '第一轮',
  '第二轮',
  '第三轮',
  '必须调用',
  '证据不足',
  '用户目标',
  '已排除因素',
  '排查顺序',
];

// RED TEST 1: stop_message_auto emits natural-user prompt without internal markers
{
  const raw = run('stop_message_auto', {
    continuationPrompt: '继续做下一步',
    repeatCount: 1,
    maxRepeats: 3,
  });
  const out = JSON.parse(raw);
  assert.equal(out.toolName, 'stop_message_auto', 'toolName must be stop_message_auto');
  assert.equal(out.flowId, 'stop_message_flow', 'flowId must be stop_message_flow');
  assert.equal(out.repeatCount, 1, 'repeatCount');
  assert.equal(out.maxRepeats, 3, 'maxRepeats');
  assert.equal(typeof out.continuationPrompt, 'string', 'stdout must return natural continuationPrompt');
  assert.ok(out.continuationPrompt.length > 0, 'continuationPrompt must be non-empty');
  for (const token of forbiddenStoplessTokens) {
    assert.ok(!out.continuationPrompt.includes(token), `continuationPrompt must not contain ${token}: ${out.continuationPrompt}`);
  }
  assert.ok(!('schemaGuidance' in out), 'stdout must not leak schemaGuidance');
  assert.ok(!('injectedPromptPreview' in out), 'stdout must not leak injectedPromptPreview');
  assert.deepEqual(out.input, {
    flowId: 'stop_message_flow',
    repeatCount: 1,
    maxRepeats: 3,
    triggerHint: 'no_schema',
  }, 'internal input stays status-only');
  console.log('  [PASS] stop_message_auto natural-user stdout');
}

// RED TEST 2: missing continuationPrompt still succeeds with natural-user output
{
  const raw = run('stop_message_auto', {
    repeatCount: 1,
    maxRepeats: 3,
  });
  const out = JSON.parse(raw);
  assert.equal(out.ok, true, 'stop_message_auto still succeeds');
  assert.equal(out.flowId, 'stop_message_flow', 'default flowId');
  assert.equal(out.repeatCount, 1, 'repeatCount');
  assert.equal(out.maxRepeats, 3, 'maxRepeats');
  assert.equal(typeof out.continuationPrompt, 'string', 'stdout returns natural continuationPrompt');
  for (const token of forbiddenStoplessTokens) {
    assert.ok(!out.continuationPrompt.includes(token), `continuationPrompt must not contain ${token}: ${out.continuationPrompt}`);
  }
  console.log('  [PASS] missing continuationPrompt stays natural-user');
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

// RED TEST 4: servertool_fixture is an executable client projection fixture
{
  const raw = run('servertool_fixture', { value: 1 }, { flow: 'servertool_cli_projection' });
  const out = JSON.parse(raw);
  assert.equal(out.ok, true, 'fixture ok');
  assert.equal(out.kind, 'servertool_fixture', 'fixture kind');
  assert.equal(out.tool, 'servertool_fixture', 'fixture tool');
  assert.equal(out.toolName, 'servertool_fixture', 'fixture toolName');
  assert.equal(out.flowId, 'servertool_cli_projection', 'fixture flowId');
  assert.deepEqual(out.input, { value: 1 }, 'fixture input is preserved');
  assert.equal(out.schemaGuidance, undefined, 'fixture has no stopless schema');
  console.log('  [PASS] servertool_fixture outputs ordinary exec_command JSON');
}

// RED TEST 5: old restoration markers fail fast
{
  const stderr = runExpectFailure('servertool_fixture', {
    value: 'old_cli_result_123',
  }, { flow: 'servertool_cli_projection' });
  assert.ok(stderr.includes('SERVERTOOL_DENIED_CLI_MARKER: old_cli_'), stderr);
  console.log('  [PASS] old restoration markers fail fast');
}

// RED TEST 6: invalid flowId fails fast
{
  const stderr = runExpectFailure('stop_message_auto', {
    continuationPrompt: 'continue with schema',
    repeatCount: 1,
    maxRepeats: 3,
  }, { flow: 'wrong_flow' });
  assert.ok(stderr.includes('SERVERTOOL_CLI_INVALID_FIELD: flowId'), stderr);
  console.log('  [PASS] invalid flowId fails fast');
}

// RED TEST 7: repeatCount at/above maxRepeats fails fast because stopless must
// pass the third consecutive stop through instead of projecting another CLI.
{
  const stderr = runExpectFailure('stop_message_auto', {
    continuationPrompt: 'continue with schema',
    repeatCount: 3,
    maxRepeats: 3,
  });
  assert.ok(stderr.includes('SERVERTOOL_CLI_INVALID_FIELD: repeatCount/maxRepeats'), stderr);
  console.log('  [PASS] repeatCount >= maxRepeats fails fast');
}

console.log('[servertool-cli-blackbox] all tests passed');

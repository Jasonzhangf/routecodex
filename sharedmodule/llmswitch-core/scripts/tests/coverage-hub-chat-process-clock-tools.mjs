#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-tools.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function buildClockConfig() {
  return {
    enabled: true,
    baseDir: '.routecodex/clock',
    tickSeconds: 5,
    dueWindowSeconds: 300,
    graceSeconds: 600
  };
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-tools');
  const { buildClockOperations, buildClockOperationsWithPlan, buildClockStandardToolsOperations } = mod;

  assert.equal(typeof buildClockOperations, 'function');
  assert.equal(typeof buildClockOperationsWithPlan, 'function');
  assert.equal(typeof buildClockStandardToolsOperations, 'function');

  {
    const out = buildClockOperations({
      __rt: { serverToolFollowup: true, clockFollowupInjectTool: false, clock: buildClockConfig() }
    });
    assert.deepEqual(out, []);
  }

  {
    const out = buildClockOperations({
      clientInjectReady: false,
      clientInjectReason: 'tmux_session_missing',
      __rt: { clock: buildClockConfig() }
    });
    assert.deepEqual(out, []);
  }

  {
    const out = buildClockOperations({
      __rt: { serverToolFollowup: true, clockFollowupInjectTool: true, clock: buildClockConfig() }
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].op, 'set_request_metadata_fields');
    assert.equal(out[0].fields.clockEnabled, true);
    assert.equal(out[0].fields.serverToolRequired, undefined);
    assert.equal(out[1].op, 'append_tool_if_missing');
    assert.equal(out[1].toolName, 'clock');
    assert.equal(out[1].tool.function.strict, true);
  }

  {
    const out = buildClockOperations({
      __rt: { clock: buildClockConfig() },
      sessionId: 'session-1'
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].fields.clockEnabled, true);
    assert.equal(out[0].fields.serverToolRequired, true);
  }

  {
    const out = buildClockOperations({
      __rt: { clock: buildClockConfig() },
      sessionId: '   '
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].fields.serverToolRequired, undefined);
  }

  {
    const out = buildClockOperations({
      __rt: { clock: { enabled: false } }
    });
    assert.deepEqual(out, []);
  }

  {
    const out = buildClockOperations({});
    assert.equal(out.length, 2);
    assert.equal(out[0].fields.clockEnabled, true);
    assert.equal(out[0].fields.serverToolRequired, undefined);
  }

  {
    const out = buildClockStandardToolsOperations();
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 9);
    assert.ok(out.every((entry) => entry.op === 'append_tool_if_missing'));
    const names = out.map((entry) => entry.toolName);
    assert.deepEqual(names, [
      'clock',
      'shell',
      'exec_command',
      'apply_patch',
      'update_plan',
      'view_image',
      'list_mcp_resources',
      'list_mcp_resource_templates',
      'read_mcp_resource'
    ]);
  }

  {
    const out = buildClockOperationsWithPlan(
      { __rt: { clock: buildClockConfig() }, sessionId: 'session-plan-1' },
      { shouldInject: true }
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].op, 'set_request_metadata_fields');
    assert.equal(out[1].toolName, 'clock');
  }

  {
    const out = buildClockOperationsWithPlan(
      { __rt: { clock: buildClockConfig() }, sessionId: 'session-plan-2' },
      { shouldInject: false }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildClockOperationsWithPlan({
      __rt: { clock: buildClockConfig() },
      clientInjectReady: false
    });
    assert.deepEqual(out, []);
  }

  {
    const out = buildClockOperationsWithPlan(
      { __rt: { clock: buildClockConfig() }, sessionId: 'session-plan-3' },
      undefined
    );
    assert.equal(Array.isArray(out), true);
  }

  console.log('✅ coverage-hub-chat-process-clock-tools passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-tools failed:', error);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACTUAL_CALL_ID,
  ACTUAL_PROVIDER_SSE_UPSTREAM,
  ACTUAL_TOOL_TEXT,
  actualToolFixture,
  runActualToolFixture,
  tempEvidenceRoot,
} from './case-runner-test-support.mjs';

test('runCase executes the declared echo once from the actual response and sends actual call id/output', async () => {
  const root = tempEvidenceRoot();
  try {
    const actualFixture = actualToolFixture();
    const { report, mock } = await runActualToolFixture(actualFixture, root);

    assert.equal(report.status, 'passed');
    assert.equal(report.turn_results.length, 2);
    assert.equal(report.turn_results[1].request_source, 'tool-consumer');
    assert.deepEqual(mock.calls.map((call) => call.turn_index), [0, 1]);
    assert.deepEqual(
      mock.calls.map((call) => new URL(call.url).pathname),
      ['/v1/responses', '/v1/responses'],
    );
    assert.deepEqual(mock.captures.map((capture) => capture.path), [
      '/v1/responses',
      '/v1/responses',
    ]);
    assert.equal(mock.captures[0].body.model, 'chat-model');
    assert.equal(mock.captures[1].body.model, 'chat-model');
    assert.equal(mock.captures[1].body.input.length, 3);

    const sentFollowup = JSON.parse(mock.calls[1].body);
    assert.deepEqual(sentFollowup.input.slice(-2), [
      {
        type: 'function_call',
        call_id: ACTUAL_CALL_ID,
        name: 'echo',
        arguments: JSON.stringify({ text: ACTUAL_TOOL_TEXT }),
      },
      { type: 'function_call_output', call_id: ACTUAL_CALL_ID, output: ACTUAL_TOOL_TEXT },
    ]);
    assert.equal(sentFollowup.stream, false);
    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.ok(toolExecution, 'tool execution observation must be present');
    assert.equal(toolExecution.executions.length, 1);
    assert.equal(toolExecution.executions[0].output, ACTUAL_TOOL_TEXT);

    const firstProviderEvidence = JSON.parse(readFileSync(join(root, 'captures', 'module-tool-followup-actual-turn-1-provider.json'), 'utf8'));
    assert.equal(firstProviderEvidence.business_attempts, 1);
    assert.equal(firstProviderEvidence.scripted_attempts, 1);
    const secondProviderEvidence = JSON.parse(readFileSync(join(root, 'captures', 'module-tool-followup-actual-turn-2-provider.json'), 'utf8'));
    assert.equal(secondProviderEvidence.turn, 2);
    assert.equal(secondProviderEvidence.provider_captures[0].body.input[1].call_id, ACTUAL_CALL_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase keeps the case-wide terminal and forbidden contract for a turn with expected_client_must', async () => {
  const root = tempEvidenceRoot();
  try {
    const actualFixture = actualToolFixture();
    const { report, mock } = await runActualToolFixture(actualFixture, root);

    assert.equal(report.status, 'passed', report.diagnostic);
    assert.equal(report.turn_results[0].status, 'passed');
    assert.equal(report.turn_results[1].status, 'passed');
    // The first turn is a function call, so the tool consumer must still run.
    assert.equal(report.turn_results[1].request_source, 'tool-consumer');
    assert.equal(mock.calls.length, 2);

    const missingTerminalFixture = actualToolFixture();
    missingTerminalFixture.case_id = 'module-tool-followup-missing-terminal';
    missingTerminalFixture.upstream_response = {
      ...structuredClone(ACTUAL_PROVIDER_SSE_UPSTREAM),
      sse_events: ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.filter((event) => event.event !== 'response.completed'),
    };
    const missingTerminal = await runActualToolFixture(missingTerminalFixture, root);
    assert.equal(missingTerminal.report.status, 'failed');
    assert.match(missingTerminal.report.diagnostic, /semantic terminal missing/u);
    // The dropped terminal must not silently authorize tool execution.
    assert.equal(missingTerminal.mock.calls.length, 1);
    assert.equal(missingTerminal.report.turn_results.length, 1);
    assert.equal(
      missingTerminal.report.observations.live.some((entry) => entry.kind === 'tool_execution'),
      false,
    );

    const forbiddenContentFixture = actualToolFixture();
    forbiddenContentFixture.case_id = 'module-tool-followup-forbidden-content';
    forbiddenContentFixture.upstream_response = {
      ...structuredClone(ACTUAL_PROVIDER_SSE_UPSTREAM),
      sse_events: [
        ...ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.slice(0, -1),
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'provider_error: upstream leaked' },
        },
        ...ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.slice(-1),
      ],
    };
    const forbiddenContent = await runActualToolFixture(forbiddenContentFixture, root);
    assert.equal(forbiddenContent.report.status, 'failed');
    assert.match(forbiddenContent.report.diagnostic, /forbidden provider_error/u);
    assert.equal(forbiddenContent.mock.calls.length, 1);
    assert.equal(
      forbiddenContent.report.observations.live.some((entry) => entry.kind === 'tool_execution'),
      false,
    );

    const invalidTransportFixture = actualToolFixture();
    invalidTransportFixture.case_id = 'module-tool-followup-invalid-transport';
    invalidTransportFixture.turns[0].expected_client_contract = {
      transport: 'bogus',
    };
    const invalidTransport = await runActualToolFixture(invalidTransportFixture, root);
    assert.equal(invalidTransport.report.status, 'failed');
    assert.match(invalidTransport.report.diagnostic, /unknown expected client transport bogus/u);
    assert.equal(invalidTransport.mock.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

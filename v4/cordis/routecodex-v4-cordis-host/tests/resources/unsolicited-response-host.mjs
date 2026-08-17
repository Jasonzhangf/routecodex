#!/usr/bin/env node
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
lines.once('line', () => {
  const unknownField = process.argv[2] === 'unknown-field';
  const failureMode = process.argv[2];
  if (failureMode === 'malformed-output') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      request_id: 'host-1',
      state: 'accepting',
      in_flight: 0,
      output: {
        data: {},
        control: {},
        diagnostics: [{ kind: 1 }],
      },
    })}\n`);
    return;
  }
  if (failureMode === 'missing-output') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      request_id: 'host-1',
      state: 'accepting',
      in_flight: 0,
    })}\n`);
    return;
  }
  if (failureMode === 'lifecycle-with-output') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      request_id: 'host-1',
      state: 'accepting',
      in_flight: 0,
      output: { data: {}, control: {}, diagnostics: [] },
    })}\n`);
    return;
  }
  const failure = failureMode === 'malformed-failure'
    ? {
        resource_id: 'v4.node_container.lifecycle_failure',
        request_id: 'host-1',
        operation: 'status',
        code: 'not_a_lifecycle_failure_code',
        message: 'invalid typed failure code',
      }
    : failureMode === 'wrong-failure-resource'
      ? { resource_id: 'other.failure', request_id: 'host-1', operation: 'status', code: 'invalid_state', message: 'wrong' }
      : undefined;
  process.stdout.write(`${JSON.stringify({
    ok: false,
    request_id: unknownField || failure ? 'host-1' : 'not-the-pending-request',
    state: 'accepting',
    in_flight: 0,
    ...(failure ? { failure } : {}),
    ...(unknownField ? { metadata: { route: 'forbidden' } } : {}),
  })}\n`);
});

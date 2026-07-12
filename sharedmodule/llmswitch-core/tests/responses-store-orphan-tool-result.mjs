import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeResponsesStoreOperationEnvelope } from '../../../scripts/helpers/llmswitch-direct-native.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.chdir(repoRoot);

const storePath = path.join(
  os.tmpdir(),
  `routecodex-responses-store-orphan-${process.pid}-${Date.now()}.json`,
);
process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = storePath;

function run(operation, payload) {
  return executeResponsesStoreOperationEnvelope(operation, payload);
}

try {
  const capture = run('capture_request_context', {
    requestId: 'req_orphan_capture',
    payload: {
      model: 'gpt-5.5',
      tools: [{ type: 'function', name: 'exec_command' }],
    },
    context: {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] },
        { type: 'function_call', id: 'fc_expected', call_id: 'call_expected', name: 'exec_command', arguments: '{"cmd":"pwd"}' }
      ],
    },
  });
  assert.equal(capture.ok, true, 'capture_request_context must succeed');

  const record = run('record_response', {
    requestId: 'req_orphan_capture',
    response: {
      id: 'resp_orphan_resume',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.5',
      output: [
        { type: 'function_call', call_id: 'call_expected', name: 'exec_command', arguments: '{"cmd":"pwd"}' }
      ],
      finish_reason: 'tool_calls',
    },
    providerKey: 'minimax.MiniMax-M3',
    entryKind: 'responses',
    continuationOwner: 'relay',
  });
  assert.equal(record.ok, true, 'record_response must succeed');

  const resumed = run('resume_conversation', {
    responseId: 'resp_orphan_resume',
    submitPayload: {
      response_id: 'resp_orphan_resume',
      tool_outputs: [
        { tool_call_id: 'call_function_snr978zyv21w_1', output: 'cwd' }
      ],
    },
    options: {
      requestId: 'req_orphan_resume',
      entryKind: 'responses',
    },
  });

  assert.equal(resumed.ok, false, 'orphan tool result must fail fast');
  assert.equal(resumed.error?.code, 'MALFORMED_REQUEST');
  assert.equal(resumed.error?.details?.reason, 'orphan_tool_result');
  assert.match(
    String(resumed.error?.message ?? ''),
    /call_function_snr978zyv21w_1/
  );

  console.log('[responses-store-orphan-tool-result] ok');
} finally {
  fs.rmSync(storePath, { force: true });
}

process.exit(0);

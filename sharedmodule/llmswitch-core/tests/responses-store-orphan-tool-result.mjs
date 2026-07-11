import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const coreRoot = path.join(repoRoot, 'sharedmodule/llmswitch-core');
const candidates = [
  path.join(coreRoot, 'dist/native/router_hotpath_napi.node'),
  path.join(coreRoot, 'rust-core/target/release/router_hotpath_napi.node'),
  path.join(coreRoot, 'rust-core/target/debug/router_hotpath_napi.node'),
];

let binding;
const loadErrors = [];
for (const candidate of candidates) {
  try {
    binding = require(candidate);
    break;
  } catch (error) {
    loadErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert.ok(
  binding,
  `router_hotpath_napi native binding must load from a direct native path:\n${loadErrors.join('\n')}`
);
const execStore = binding.executeResponsesConversationStoreOperationJson;

assert.equal(typeof execStore, 'function', 'executeResponsesConversationStoreOperationJson must exist');

function run(operation, payload) {
  return JSON.parse(execStore(JSON.stringify({
    operation,
    payload,
  })));
}

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

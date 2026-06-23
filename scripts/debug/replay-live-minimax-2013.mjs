import fs from 'node:fs';
import path from 'node:path';

import {
  executeHubPipelineWithNative,
} from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import {
  runResponsesOpenAIRequestCodecWithNative,
  buildAnthropicFromOpenAIChatWithNative,
} from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-compat-action-semantics.js';
import {
  runReqOutboundStage3CompatWithNative,
} from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';
import { readDebugErrorDiagArtifact } from '../../src/debug/diag/index.js';

const diagPath = process.argv[2];
if (!diagPath || !diagPath.trim()) {
  console.error('usage: node scripts/debug/replay-live-minimax-2013.mjs <diag-json-path>');
  process.exit(1);
}

function findAnthropicViolation(messages) {
  let pending = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const ids = content
        .filter((block) => block?.type === 'tool_use' && typeof block.id === 'string')
        .map((block) => block.id);
      if (ids.length > 0) {
        pending = ids.slice();
        continue;
      }
      if (pending.length > 0) {
        return { index, kind: 'assistant_non_tool_use_before_result', pending, message };
      }
      continue;
    }
    if (message.role === 'user' && pending.length > 0) {
      const resultIds = content
        .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
        .map((block) => block.tool_use_id);
      if (resultIds.length === 0) {
        return { index, kind: 'missing_tool_result_after_tool_use', pending, message };
      }
      const miss = pending.filter((id) => !resultIds.includes(id));
      if (miss.length > 0) {
        return { index, kind: 'mismatched_tool_result_after_tool_use', pending: miss, message };
      }
      pending = [];
    }
  }
  return null;
}

function logStage(label, messages) {
  const violation = findAnthropicViolation(messages);
  console.log(`\n[stage] ${label}`);
  console.log(`messages=${messages.length}`);
  if (!violation) {
    console.log('violation=none');
    return;
  }
  console.log(`violation=${violation.kind} index=${violation.index} pending=${JSON.stringify(violation.pending)}`);
  const from = Math.max(0, violation.index - 2);
  const to = Math.min(messages.length, violation.index + 2);
  for (let i = from; i < to; i += 1) {
    console.log(`msg[${i}]`, JSON.stringify(messages[i]).slice(0, 1500));
  }
}

function findMessageByToolUseId(messages, toolUseId) {
  return messages.findIndex((message) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.some((part) => part?.type === 'tool_result' && part?.tool_use_id === toolUseId);
  });
}

const diag = await readDebugErrorDiagArtifact(diagPath);
const requestBody = diag.requestBody;

const requestCodec = runResponsesOpenAIRequestCodecWithNative(
  requestBody,
  { requestId: 'debug_live_minimax_2013' },
);
logStage('responses_openai_request_codec', requestCodec.request.messages ?? []);

const anthropicCodec = buildAnthropicFromOpenAIChatWithNative(
  requestCodec.request,
  null,
);
logStage('anthropic_openai_codec_direct', anthropicCodec.messages ?? []);

const compat = runReqOutboundStage3CompatWithNative({
  payload: anthropicCodec,
  adapterContext: {
    providerProtocol: 'anthropic-messages',
    compatibilityProfile: 'anthropic:claude-code',
    providerKey: 'minimax.key1.MiniMax-M2.7',
    runtimeKey: 'minimax.key1',
  },
  explicitProfile: 'anthropic:claude-code',
});
logStage('req_outbound_stage3_compat', compat.payload?.messages ?? []);
const compatNoProfile = runReqOutboundStage3CompatWithNative({
  payload: anthropicCodec,
  adapterContext: {
    providerProtocol: 'anthropic-messages',
    providerKey: 'minimax.key1.MiniMax-M2.7',
    runtimeKey: 'minimax.key1',
  },
  explicitProfile: null,
});
logStage('req_outbound_stage3_compat_no_profile', compatNoProfile.payload?.messages ?? []);
const directIdx = findMessageByToolUseId(anthropicCodec.messages ?? [], 'call_FsQloAYsPGPhG38vIczxbsIL');
const compatIdx = findMessageByToolUseId(compat.payload?.messages ?? [], 'call_FsQloAYsPGPhG38vIczxbsIL');
const compatNoProfileIdx = findMessageByToolUseId(compatNoProfile.payload?.messages ?? [], 'call_FsQloAYsPGPhG38vIczxbsIL');
console.log(`\n[diff] direct_tool_result_index=${directIdx} compat_tool_result_index=${compatIdx} compat_no_profile_tool_result_index=${compatNoProfileIdx}`);

const pipelineInput = {
  config: {
    virtualRouter: {
      target: {
        providerKey: 'minimax.key1.MiniMax-M2.7',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'minimax.key1',
        compatibilityProfile: 'anthropic:claude-code',
      },
      routeName: 'search/gateway-priority-5555-priority-search',
    },
  },
  request: {
    requestId: 'debug_live_minimax_2013_pipeline',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    stream: true,
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    payload: requestBody,
    metadata: {
      stream: true,
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses',
    },
  },
};
const pipeline = executeHubPipelineWithNative(pipelineInput);
logStage('hub_pipeline_final_provider_payload', pipeline.payload.messages ?? []);

const outPath = path.join(process.cwd(), 'tmp', 'live-minimax-2013-replay.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      requestCodec,
      anthropicCodec,
      compat,
      pipeline,
    },
    null,
    2,
  ),
);
console.log(`\nartifact=${outPath}`);

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createNativeResponseMapper } from './native-response-mapper-test-helper.js';
import { runRespInboundStage1SseDecode } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage1_sse_decode/index.js';
import { runRespInboundStage2FormatParse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage2_format_parse/index.js';
import { runRespInboundStage3SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage3_semantic_map/index.js';
import { runRespProcessStage2Finalize } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  recordResponsesResponse,
  resumeResponsesConversation
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

const SAMPLE_ROOTS = [
  '/Volumes/extension/.rcc/codex-samples',
  path.join(process.env.HOME || '', '.rcc', 'codex-samples')
].filter((entry) => entry && fs.existsSync(entry));

const SAMPLE_CASES = [
  {
    requestId: 'openai-responses-mimo.key1-mimo-v2.5-pro-20260428T232748953-157870-2456',
    providerKey: 'mimo.key1.mimo-v2.5-pro',
    dirName: 'req_1777390068952_a89a8004',
    expectedCallId: 'call_46401110981045ebae5f2445'
  },
  {
    requestId: 'openai-responses-mimo.key1-mimo-v2.5-pro-20260428T232754116-157871-2457',
    providerKey: 'mimo.key1.mimo-v2.5-pro',
    dirName: 'req_1777390074115_91f93c69',
    expectedCallId: 'call_b0a1cd8b5a9c4d1791501810'
  }
];

function resolveSampleDir(providerKey: string, dirName: string): string | undefined {
  for (const root of SAMPLE_ROOTS) {
    const dir = path.join(root, 'openai-responses', providerKey, dirName);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
}

async function replayAnthropicProviderResponseToResponsesClient(dir: string, requestId: string) {
  const responseDoc = JSON.parse(fs.readFileSync(path.join(dir, 'provider-response.json'), 'utf8'));
  const adapterContext = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'anthropic-messages'
  };

  const stage1 = await runRespInboundStage1SseDecode({
    providerProtocol: 'anthropic-messages',
    payload: {
      ...responseDoc.body,
      __sse_stream: Readable.from([responseDoc.body.raw])
    } as any,
    adapterContext: adapterContext as any,
    wantsStream: false
  });

  const stage2 = await runRespInboundStage2FormatParse({
    adapterContext: adapterContext as any,
    payload: stage1.payload as any
  });

  const chatResponse = await runRespInboundStage3SemanticMap({
    adapterContext: adapterContext as any,
    formatEnvelope: stage2,
    mapper: createNativeResponseMapper('anthropic-messages')
  });

  const finalized = await runRespProcessStage2Finalize({
    payload: chatResponse as any,
    originalPayload: chatResponse as any,
    entryEndpoint: '/v1/responses',
    requestId,
    wantsStream: false,
    reasoningMode: 'keep'
  });

  return runRespOutboundStage1ClientRemap({
    payload: finalized.finalizedPayload as any,
    clientProtocol: 'openai-responses',
    requestId,
    responseSemantics: (finalized.processedRequest as any)?.semantics
  }) as Record<string, unknown>;
}

describe('responses conversation store real dangling-tool-call sample replay', () => {
  afterEach(() => {
    for (const sample of SAMPLE_CASES) {
      clearResponsesConversationByRequestId(sample.requestId);
    }
  });

  for (const sample of SAMPLE_CASES) {
    const sampleDir = resolveSampleDir(sample.providerKey, sample.dirName);
    (sampleDir ? it : it.skip)(
      `replays ${sample.requestId} without dangling_tool_call and resumes submit_tool_outputs`,
      async () => {
        const clientPayload = await replayAnthropicProviderResponseToResponsesClient(
          sampleDir!,
          sample.requestId
        );

        expect(clientPayload.status).toBe('requires_action');
        expect((clientPayload as any).required_action?.submit_tool_outputs?.tool_calls?.[0]?.id).toBe(
          sample.expectedCallId
        );

        captureResponsesRequestContext({
          requestId: sample.requestId,
          sessionId: sample.requestId,
          conversationId: sample.requestId,
          payload: {
            model: 'gpt-5.3-codex',
            stream: true
          },
          context: {
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'replay tool call sample' }]
              }
            ]
          }
        });

        expect(() =>
          recordResponsesResponse({
            requestId: sample.requestId,
            response: clientPayload
          })
        ).not.toThrow();

        const resumed = resumeResponsesConversation(
          String(clientPayload.id),
          {
            response_id: clientPayload.id,
            tool_outputs: [
              {
                tool_call_id: sample.expectedCallId,
                output: '{"stdout":"ok"}'
              }
            ]
          },
          { requestId: `${sample.requestId}:resume` }
        );

        expect((resumed.payload as any).previous_response_id).toBe(clientPayload.id);
        expect((resumed.payload as any).input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              call_id: sample.expectedCallId,
              output: '{"stdout":"ok"}'
            })
          ])
        );
      }
    );
  }
});

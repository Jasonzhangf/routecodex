import fs from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/anthropic-mapper.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import { AnthropicResponseMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.js';
import { runRespInboundStage1SseDecode } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage1_sse_decode/index.js';
import { runRespInboundStage2FormatParse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage2_format_parse/index.js';
import { runRespInboundStage3SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage3_semantic_map/index.js';
import { runRespProcessStage2Finalize } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';

const REAL_SAMPLE_DIR =
  '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.glm-5/req_1776432690174_0c203ba9';
const REQUEST_SAMPLE_PATH = `${REAL_SAMPLE_DIR}/provider-request.json`;
const RESPONSE_SAMPLE_PATH = `${REAL_SAMPLE_DIR}/provider-response.json`;
const hasRealSample = fs.existsSync(REQUEST_SAMPLE_PATH) && fs.existsSync(RESPONSE_SAMPLE_PATH);

const RESPONSES_REQUEST_SAMPLE_DIR =
  '/Volumes/extension/.rcc/codex-samples/openai-responses/duck.key2.gpt-5.3-codex/req_1776413309443_7e67d997';
const RESPONSES_REQUEST_SAMPLE_PATH = `${RESPONSES_REQUEST_SAMPLE_DIR}/provider-request.json`;
const hasResponsesRequestSample = fs.existsSync(RESPONSES_REQUEST_SAMPLE_PATH);

const RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR =
  '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.qwen3.6-plus/routecheck-1776519312';
const RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH =
  `${RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR}/provider-request.json`;
const RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH =
  `${RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR}/provider-response.json`;
const hasResponsesCrossProtocolSample =
  fs.existsSync(RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH) &&
  fs.existsSync(RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH);

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeAnthropicProviderRequest(payload: Record<string, unknown>) {
  return {
    model: payload.model,
    max_tokens: payload.max_tokens,
    messages: payload.messages,
    system: payload.system,
    thinking: payload.thinking,
    output_config: payload.output_config,
    stream: payload.stream
  };
}

function normalizeResponsesProviderRequest(payload: Record<string, unknown>) {
  return {
    input: payload.input,
    model: payload.model,
    store: payload.store,
    stream: payload.stream
  };
}

function snapshotAnthropicResponse(payload: any) {
  return {
    id: payload.id,
    model: payload.model,
    finish_reason: payload.choices?.[0]?.finish_reason,
    content: payload.choices?.[0]?.message?.content,
    reasoning_content: payload.choices?.[0]?.message?.reasoning_content,
    usage: payload.usage
  };
}

function snapshotOpenAIChatPayload(payload: any) {
  return {
    id: payload.id,
    model: payload.model,
    finish_reason: payload.choices?.[0]?.finish_reason,
    content: payload.choices?.[0]?.message?.content,
    reasoning_content: payload.choices?.[0]?.message?.reasoning_content,
    usage: payload.usage
  };
}

function snapshotResponsesPayload(payload: any) {
  return {
    id: payload.id,
    object: payload.object,
    model: payload.model,
    output_text: payload.output_text,
    status: payload.status,
    usage: payload.usage
  };
}

const OPENAI_CHAT_ANTHROPIC_CASES = [
  {
    label: 'glm-5 text',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.glm-5/req_1776432690174_0c203ba9',
    hasResponse: true
  },
  {
    label: 'qwen3.6 text',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.qwen3.6-plus/req_1776493884023_0f2dc23b',
    hasResponse: true
  },
  {
    label: 'qwen3.6 multimodal',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.qwen3.6-plus/req_1776494122835_3dd6afc0',
    hasResponse: false
  },
  {
    label: 'qwen3.6 auth image',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.qwen3.6-plus/req_1776494250851_1316c8dd',
    hasResponse: true
  },
  {
    label: 'qwen3.6 image text',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-chat/ali-coding-plan.key1.qwen3.6-plus/req_1776494648292_34c429ea',
    hasResponse: true
  }
] as const;

const OPENAI_RESPONSES_ANTHROPIC_CASES = [
  {
    label: 'glm-5 responses',
    requestDir: '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.glm-5/req_1776521873753_af4ffc40'
  },
  {
    label: 'qwen3.5 guard 1',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.qwen3.5-plus/openai-responses-ali-coding-plan.key1-kimi-k2.5-20260416T235604657-140854-2423_reasoning_stop_guard'
  },
  {
    label: 'qwen3.5 guard 2',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.qwen3.5-plus/openai-responses-ali-coding-plan.key1-kimi-k2.5-20260416T235703379-140860-2429_reasoning_stop_guard'
  },
  {
    label: 'qwen3.6 routecheck',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.qwen3.6-plus/routecheck-1776519312'
  },
  {
    label: 'qwen3.6 routecheck2',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/ali-coding-plan.key1.qwen3.6-plus/routecheck2-1776519459'
  }
] as const;

const OPENAI_RESPONSES_NATIVE_REQUEST_CASES = [
  {
    label: 'gpt-5.3-codex native',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/duck.key2.gpt-5.3-codex/req_1776413309443_7e67d997'
  },
  {
    label: 'gpt-5.4 reasoning_stop_guard',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/duck.key2.gpt-5.4/openai-responses-duck.key2-gpt-5.3-codex-20260417T001938402-140950-2519_reasoning_stop_guard'
  },
  {
    label: 'crs gpt-5.4 reasoning_stop_guard',
    requestDir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/crs.key2.gpt-5.4/openai-responses-crs.key2-gpt-5.3-codex-20260417T001424231-140936-2505_reasoning_stop_guard'
  }
] as const;

function hasRequestSample(dir: string): boolean {
  return fs.existsSync(`${dir}/provider-request.json`);
}

function hasRequestAndResponseSamples(dir: string): boolean {
  return hasRequestSample(dir) && fs.existsSync(`${dir}/provider-response.json`);
}

async function replayAnthropicRequestFromSample(options: {
  dir: string;
  requestId: string;
  entryEndpoint: '/v1/chat/completions' | '/v1/responses' | '/v1/messages';
}) {
  const requestDoc = loadJson(`${options.dir}/provider-request.json`);
  const mapper = new AnthropicSemanticMapper();
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: 'anthropic-messages'
  };

  const chat = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: requestDoc.body
    } as any,
    adapterContext as any
  );

  const roundtrip = await mapper.fromChat(chat, adapterContext as any);
  return { requestDoc, chat, roundtrip };
}

async function replayAnthropicResponseToClient(options: {
  dir: string;
  requestId: string;
  entryEndpoint: '/v1/chat/completions' | '/v1/responses';
  clientProtocol: 'openai-chat' | 'openai-responses';
}) {
  const responseDoc = loadJson(`${options.dir}/provider-response.json`);
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
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
    mapper: new AnthropicResponseMapper()
  });

  const finalized = await runRespProcessStage2Finalize({
    payload: chatResponse as any,
    originalPayload: chatResponse as any,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    wantsStream: false,
    reasoningMode: 'keep'
  });

  const clientPayload = runRespOutboundStage1ClientRemap({
    payload: finalized.finalizedPayload as any,
    clientProtocol: options.clientProtocol,
    requestId: options.requestId,
    responseSemantics: (finalized.processedRequest as any)?.semantics
  });

  return { chatResponse, clientPayload };
}

async function replayResponsesRequestFromSample(options: {
  dir: string;
  requestId: string;
}) {
  const requestDoc = loadJson(`${options.dir}/provider-request.json`);
  const mapper = new ResponsesSemanticMapper();
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };

  const chat = await mapper.toChat(
    {
      protocol: 'openai-responses',
      direction: 'request',
      payload: requestDoc.body
    } as any,
    adapterContext as any
  );

  const roundtrip = await mapper.fromChat(chat, adapterContext as any);
  return { requestDoc, chat, roundtrip };
}

describe('real sample hub input/output compare', () => {
  (hasRealSample ? it : it.skip)(
    'replays real provider-request through anthropic mapper and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(REQUEST_SAMPLE_PATH);
      const mapper = new AnthropicSemanticMapper();
      const adapterContext = {
        requestId: 'real-sample-request-replay',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      };

      const chat = await mapper.toChat(
        {
          protocol: 'anthropic-messages',
          direction: 'request',
          payload: requestDoc.body
        } as any,
        adapterContext as any
      );

      expect(chat.messages).toEqual([
        {
          role: 'system',
          content: "You are Claude Code, Anthropic's official CLI for Claude."
        },
        {
          role: 'user',
          content: '只回复 OK'
        }
      ]);
      expect((chat.semantics as any)?.system?.blocks).toEqual([
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude."
        }
      ]);

      const roundtrip = await mapper.fromChat(chat, adapterContext as any);
      expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
      );
    }
  );

  (hasRealSample ? it : it.skip)(
    'replays real provider-response through response hub stages and compares hub input/output fields',
    async () => {
      const responseDoc = loadJson(RESPONSE_SAMPLE_PATH);
      const adapterContext = {
        requestId: 'real-sample-response-replay',
        entryEndpoint: '/v1/chat/completions',
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
        mapper: new AnthropicResponseMapper()
      });

      expect(chatResponse).toMatchObject({
        id: 'msg_b52e7036-3eda-4a4e-a860-9a5fb6a0d04f',
        model: 'glm-5',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'OK',
              reasoning_content: expect.stringContaining('用户要求我只回复 "OK"')
            }
          }
        ],
        usage: {
          input_tokens: 22,
          output_tokens: 20
        }
      });

      const finalized = await runRespProcessStage2Finalize({
        payload: chatResponse as any,
        originalPayload: chatResponse as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'real-sample-response-replay',
        wantsStream: false,
        reasoningMode: 'keep'
      });

      const clientPayload = runRespOutboundStage1ClientRemap({
        payload: finalized.finalizedPayload as any,
        clientProtocol: 'openai-chat',
        requestId: 'real-sample-response-replay',
        responseSemantics: (finalized.processedRequest as any)?.semantics
      });

      expect(clientPayload).toMatchObject({
        id: 'msg_b52e7036-3eda-4a4e-a860-9a5fb6a0d04f',
        object: 'chat.completion',
        model: 'glm-5',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'OK',
              reasoning_content: expect.stringContaining('用户要求我只回复 "OK"')
            }
          }
        ],
        usage: {
          input_tokens: 22,
          output_tokens: 20
        }
      });
    }
  );
});

describe('real sample responses hub input/output compare', () => {
  (hasResponsesRequestSample ? it : it.skip)(
    'replays real openai responses provider-request through responses mapper and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(RESPONSES_REQUEST_SAMPLE_PATH);
      const mapper = new ResponsesSemanticMapper();
      const adapterContext = {
        requestId: 'real-sample-responses-request-replay',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      };

      const chat = await mapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: requestDoc.body
        } as any,
        adapterContext as any
      );

      expect(chat.messages).toEqual([
        {
          role: 'user',
          content: 'Reply with exactly OK and nothing else.'
        }
      ]);
      expect((chat.semantics as any)?.responses?.context?.input).toEqual(
        (requestDoc.body as any).input
      );
      expect((chat.semantics as any)?.responses?.context?.parameters).toMatchObject({
        store: false
      });

      const roundtrip = await mapper.fromChat(chat, adapterContext as any);
      expect(normalizeResponsesProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeResponsesProviderRequest(requestDoc.body as Record<string, unknown>)
      );
      expect((roundtrip.payload as any).metadata).toMatchObject({
        context: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          requestId: 'real-sample-responses-request-replay'
        }
      });
    }
  );

  (hasResponsesCrossProtocolSample ? it : it.skip)(
    'replays real anthropic provider request/response for /v1/responses and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH);
      const responseDoc = loadJson(RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH);
      const adapterContext = {
        requestId: 'real-sample-responses-cross-protocol-replay',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      };

      const mapper = new AnthropicSemanticMapper();
      const chat = await mapper.toChat(
        {
          protocol: 'anthropic-messages',
          direction: 'request',
          payload: requestDoc.body
        } as any,
        adapterContext as any
      );

      expect(chat.messages).toEqual([
        {
          role: 'system',
          content: "You are Claude Code, Anthropic's official CLI for Claude."
        },
        {
          role: 'user',
          content: '只回复OK'
        }
      ]);
      expect((chat.semantics as any)?.system?.blocks).toEqual([
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude."
        }
      ]);

      const roundtrip = await mapper.fromChat(chat, adapterContext as any);
      expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
      );

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
        mapper: new AnthropicResponseMapper()
      });

      expect(chatResponse).toMatchObject({
        id: 'msg_6dc5699e-cbfc-4189-9eae-c68deaaad0be',
        model: 'qwen3.6-plus',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'OK',
              reasoning_content: expect.stringContaining('Reply exactly with "OK"')
            }
          }
        ],
        usage: {
          input_tokens: 287,
          output_tokens: 483
        }
      });

      const finalized = await runRespProcessStage2Finalize({
        payload: chatResponse as any,
        originalPayload: chatResponse as any,
        entryEndpoint: '/v1/responses',
        requestId: 'real-sample-responses-cross-protocol-replay',
        wantsStream: false,
        reasoningMode: 'keep'
      });

      const clientPayload = runRespOutboundStage1ClientRemap({
        payload: finalized.finalizedPayload as any,
        clientProtocol: 'openai-responses',
        requestId: 'real-sample-responses-cross-protocol-replay',
        responseSemantics: (finalized.processedRequest as any)?.semantics
      });

      expect(clientPayload).toMatchObject({
        id: 'msg_6dc5699e-cbfc-4189-9eae-c68deaaad0be',
        object: 'response',
        model: 'qwen3.6-plus',
        output_text: 'OK',
        request_id: 'real-sample-responses-cross-protocol-replay',
        status: 'completed',
        usage: {
          input_tokens: 287,
          output_tokens: 483
        }
      });
      expect((clientPayload as any).output).toMatchObject([
        {
          type: 'reasoning',
          status: 'completed',
          summary: [
            {
              type: 'summary_text',
              text: expect.stringContaining('Reply exactly with "OK"')
            }
          ]
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'OK'
            }
          ]
        }
      ]);
    }
  );
});

describe('real sample matrix compare: openai-chat -> anthropic', () => {
  const requestCases = OPENAI_CHAT_ANTHROPIC_CASES.filter((entry) => hasRequestSample(entry.requestDir));
  const responseCases = OPENAI_CHAT_ANTHROPIC_CASES.filter((entry) => entry.hasResponse && hasRequestAndResponseSamples(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayAnthropicRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-chat-request-${label}`,
          entryEndpoint: '/v1/chat/completions'
        });

        expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no openai-chat anthropic samples found', () => {});
  }

  if (responseCases.length > 0) {
    it.each(responseCases)(
      '$label response roundtrip',
      async ({ requestDir, label }) => {
        const { chatResponse, clientPayload } = await replayAnthropicResponseToClient({
          dir: requestDir,
          requestId: `real-sample-openai-chat-response-${label}`,
          entryEndpoint: '/v1/chat/completions',
          clientProtocol: 'openai-chat'
        });

        expect(snapshotOpenAIChatPayload(clientPayload)).toEqual(snapshotAnthropicResponse(chatResponse));
      }
    );
  } else {
    it.skip('response roundtrip skipped: no openai-chat anthropic samples found', () => {});
  }
});

describe('real sample matrix compare: openai-responses -> anthropic -> openai-responses', () => {
  const requestCases = OPENAI_RESPONSES_ANTHROPIC_CASES.filter((entry) => hasRequestSample(entry.requestDir));
  const responseCases = OPENAI_RESPONSES_ANTHROPIC_CASES.filter((entry) => hasRequestAndResponseSamples(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayAnthropicRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-responses-request-${label}`,
          entryEndpoint: '/v1/responses'
        });

        expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no openai-responses anthropic samples found', () => {});
  }

  if (responseCases.length > 0) {
    it.each(responseCases)(
      '$label response roundtrip',
      async ({ requestDir, label }) => {
        const { chatResponse, clientPayload } = await replayAnthropicResponseToClient({
          dir: requestDir,
          requestId: `real-sample-openai-responses-response-${label}`,
          entryEndpoint: '/v1/responses',
          clientProtocol: 'openai-responses'
        });

        expect(snapshotResponsesPayload(clientPayload)).toMatchObject({
          id: chatResponse.id,
          object: 'response',
          model: chatResponse.model,
          output_text: chatResponse.choices?.[0]?.message?.content,
          status: 'completed',
          usage: chatResponse.usage
        });
      }
    );
  } else {
    it.skip('response roundtrip skipped: no openai-responses anthropic samples found', () => {});
  }
});

describe('real sample matrix compare: openai-responses native request roundtrip', () => {
  const requestCases = OPENAI_RESPONSES_NATIVE_REQUEST_CASES.filter((entry) => hasRequestSample(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayResponsesRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-responses-native-${label}`
        });

        expect(normalizeResponsesProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeResponsesProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no native openai-responses samples found', () => {});
  }
});

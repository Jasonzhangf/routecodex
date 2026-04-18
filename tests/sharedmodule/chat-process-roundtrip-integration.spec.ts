import { afterEach, describe, expect, it } from '@jest/globals';

import { HubPipeline } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js';
import { runRespInboundStage2FormatParse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage2_format_parse/index.js';
import { runRespInboundStage3SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage3_semantic_map/index.js';
import { runRespProcessStage2Finalize } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';
import {
  AnthropicResponseMapper,
  GeminiResponseMapper
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.js';

function createPipeline(providerType: 'anthropic' | 'gemini', model: string): HubPipeline {
  const providerKey = `mock.key1.${model}`;

  return new HubPipeline({
    virtualRouter: {
      routing: {
        default: [{ id: 'default-primary', targets: [providerKey], priority: 1, mode: 'round-robin' }]
      },
      providers: {
        [providerKey]: {
          providerKey,
          providerType,
          endpoint: `mock://${providerType}`,
          auth: { type: 'apiKey', value: 'mock' },
          outboundProfile: providerType === 'anthropic' ? 'anthropic-messages' : 'gemini-chat',
          modelId: model
        }
      },
      classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
      loadBalancing: { strategy: 'round-robin' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any
  });
}

async function runResponseRoundtrip(options: {
  requestId: string;
  entryEndpoint: '/v1/responses' | '/v1/chat/completions';
  providerProtocol: 'anthropic-messages' | 'gemini-chat';
  providerPayload: Record<string, unknown>;
  requestSemantics: Record<string, unknown> | undefined;
}) {
  const formatEnvelope = await runRespInboundStage2FormatParse({
    adapterContext: {
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    } as any,
    payload: options.providerPayload as any
  });

  const mapper =
    options.providerProtocol === 'anthropic-messages'
      ? new AnthropicResponseMapper()
      : new GeminiResponseMapper();

  const chatResponse = await runRespInboundStage3SemanticMap({
    adapterContext: {
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    } as any,
    formatEnvelope,
    mapper,
    requestSemantics: options.requestSemantics as any
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
    clientProtocol:
      options.entryEndpoint === '/v1/responses' ? 'openai-responses' : 'openai-chat',
    requestId: options.requestId,
    requestSemantics: options.requestSemantics as any,
    responseSemantics: (finalized.processedRequest as any)?.semantics
  });

  return {
    formatEnvelope,
    chatResponse,
    finalizedPayload: finalized.finalizedPayload,
    responseProcessedRequest: finalized.processedRequest,
    clientPayload
  };
}

const pipelinesToDispose = new Set<HubPipeline>();

afterEach(() => {
  for (const pipeline of pipelinesToDispose) {
    pipeline.dispose();
  }
  pipelinesToDispose.clear();
});

describe('chat process protocol roundtrip integration', () => {
  it('round-trips responses request-chain semantics through anthropic provider request/response chain', async () => {
    const pipeline = createPipeline('anthropic', 'claude-sonnet-4-5');
    pipelinesToDispose.add(pipeline);

    const result = await pipeline.execute({
      id: 'roundtrip-responses-anthropic',
      endpoint: '/v1/responses',
      payload: {
        model: 'claude-sonnet-4-5',
        previous_response_id: 'resp_prev_entry_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续处理 anthropic 整链' }] }],
        reasoning: { effort: 'medium' },
        prompt_cache_key: 'cache-key-roundtrip',
        response_format: { type: 'json_object' }
      },
      metadata: {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        processMode: 'chat',
        routeHint: 'default',
        responsesResume: {
          previousRequestId: 'req_chain_roundtrip_1',
          restoredFromResponseId: 'resp_restored_roundtrip_1'
        }
      }
    });

    expect((result.processedRequest as any)?.semantics?.continuation).toMatchObject({
      chainId: 'req_chain_roundtrip_1',
      stickyScope: 'request_chain',
      stateOrigin: 'openai-responses',
      resumeFrom: {
        requestId: 'req_chain_roundtrip_1',
        responseId: 'resp_restored_roundtrip_1',
        previousResponseId: 'resp_prev_entry_1'
      }
    });
    expect((result.providerPayload as any)?.messages?.[0]?.role).toBe('user');
    expect((result.providerPayload as any)?.thinking).toBeDefined();
    expect((result.providerPayload as any)?.prompt_cache_key).toBeUndefined();
    expect((result.providerPayload as any)?.response_format).toBeUndefined();
    expect((result.metadata as any)?.capturedChatRequest?.messages?.[0]?.role).toBe('user');

    const roundtrip = await runResponseRoundtrip({
      requestId: 'roundtrip-responses-anthropic-resp',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      providerPayload: {
        id: 'msg_roundtrip_1',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'anthropic 整链响应完成' }],
        stop_reason: 'end_turn'
      },
      requestSemantics: (result.processedRequest as any)?.semantics
    });

    expect((roundtrip.chatResponse as any)?.semantics?.continuation).toMatchObject({
      chainId: 'req_chain_roundtrip_1',
      stickyScope: 'request_chain',
      stateOrigin: 'openai-responses'
    });
    expect((roundtrip.responseProcessedRequest as any)?.semantics?.continuation).toMatchObject({
      chainId: 'req_chain_roundtrip_1',
      stickyScope: 'request_chain'
    });
    expect((roundtrip.clientPayload as any).object).toBe('response');
    expect(JSON.stringify(roundtrip.clientPayload)).toContain('anthropic 整链响应完成');
  });

  it('round-trips openai-chat session semantics through gemini provider request/response chain', async () => {
    const pipeline = createPipeline('gemini', 'gemini-2.5-pro');
    pipelinesToDispose.add(pipeline);

    const result = await pipeline.execute({
      id: 'roundtrip-openai-chat-gemini',
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '继续处理 gemini 整链' }]
      },
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        processMode: 'chat',
        routeHint: 'default',
        sessionId: 'session_roundtrip_chat_1'
      }
    });

    expect((result.processedRequest as any)?.semantics?.continuation).toMatchObject({
      chainId: 'session_roundtrip_chat_1',
      stickyScope: 'session',
      stateOrigin: 'openai-chat',
      resumeFrom: {
        protocol: 'openai-chat'
      }
    });
    expect(Array.isArray((result.providerPayload as any)?.contents)).toBe(true);
    expect(JSON.stringify((result.providerPayload as any)?.contents ?? [])).toContain('继续处理 gemini 整链');
    expect((result.metadata as any)?.capturedChatRequest?.messages?.[0]?.content).toContain('继续处理 gemini 整链');

    const roundtrip = await runResponseRoundtrip({
      requestId: 'roundtrip-openai-chat-gemini-resp',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerPayload: {
        id: 'gem_roundtrip_1',
        model: 'gemini-2.5-pro',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ text: 'gemini 整链响应完成' }]
            }
          }
        ]
      },
      requestSemantics: (result.processedRequest as any)?.semantics
    });

    expect((roundtrip.chatResponse as any)?.semantics?.continuation).toMatchObject({
      chainId: 'session_roundtrip_chat_1',
      stickyScope: 'session',
      stateOrigin: 'openai-chat'
    });
    expect((roundtrip.responseProcessedRequest as any)?.semantics?.continuation).toMatchObject({
      chainId: 'session_roundtrip_chat_1',
      stickyScope: 'session'
    });
    expect((roundtrip.clientPayload as any).object).toBe('chat.completion');
    expect((roundtrip.clientPayload as any).choices?.[0]?.message?.content).toBe('gemini 整链响应完成');
  });
});

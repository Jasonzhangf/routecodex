import { describe, expect, it } from '@jest/globals';

import { REQUEST_STAGE_HOOKS } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-stage-hooks.js';
import { executeRequestStageInbound } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.js';
import { runReqInboundStage2SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.js';

describe('request continuation semantics', () => {
  it('lifts responses resume and previous_response_id into unified continuation semantics', async () => {
    const adapterContext = {
      requestId: 'req-stage2-continuation',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gpt-4o-mini',
          previous_response_id: 'resp_prev_1',
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: '继续' }]
            }
          ]
        }
      } as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [{ role: 'user', content: '继续' }],
            parameters: { model: 'gpt-4o-mini' },
            metadata: { context: adapterContext }
          } as any;
        }
      } as any,
      responsesResume: {
        previousRequestId: 'req_chain_root_1',
        restoredFromResponseId: 'resp_restored_1',
        toolOutputsDetailed: [{ callId: 'tool_call_1', outputText: 'done' }]
      } as any
    });

    expect((stage2.chatEnvelope as any).semantics?.continuation).toMatchObject({
      chainId: 'req_chain_root_1',
      stickyScope: 'request_chain',
      stateOrigin: 'openai-responses',
      restored: true,
      resumeFrom: {
        protocol: 'openai-responses',
        requestId: 'req_chain_root_1',
        responseId: 'resp_restored_1',
        previousResponseId: 'resp_prev_1'
      },
      toolContinuation: {
        mode: 'submit_tool_outputs',
        submittedToolCallIds: ['tool_call_1'],
        resumeOutputs: ['done']
      }
    });
    expect((stage2.chatEnvelope as any).semantics?.responses?.resume).toMatchObject({
      previousRequestId: 'req_chain_root_1',
      restoredFromResponseId: 'resp_restored_1'
    });
    expect((stage2.chatEnvelope as any).toolOutputs).toEqual([
      { tool_call_id: 'tool_call_1', content: 'done' }
    ]);
    expect((stage2.standardizedRequest as any).semantics?.continuation?.chainId).toBe(
      'req_chain_root_1'
    );
  });

  it('cleans metadata.responsesResume after inbound semantic lift and keeps continuation on working request', async () => {
    const normalized = {
      id: 'req-inbound-continuation-cleanup',
      endpoint: '/v1/responses',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      payload: {
        model: 'gpt-4o-mini',
        previous_response_id: 'resp_prev_cleanup',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续处理' }]
          }
        ]
      },
      metadata: {
        responsesResume: {
          previousRequestId: 'req_chain_cleanup',
          restoredFromResponseId: 'resp_restored_cleanup',
          toolOutputsDetailed: [{ callId: 'tool_cleanup_1', outputText: 'ok' }]
        }
      },
      processMode: 'passthrough',
      direction: 'request',
      stage: 'inbound',
      stream: false
    } as any;

    const result = await executeRequestStageInbound({
      normalized,
      hooks: REQUEST_STAGE_HOOKS['openai-responses'],
      config: { virtualRouter: {} as any }
    });

    expect((normalized.metadata as Record<string, unknown>).responsesResume).toBeUndefined();
    expect((result.workingRequest as any).semantics?.continuation).toMatchObject({
      chainId: 'req_chain_cleanup',
      stickyScope: 'request_chain',
      resumeFrom: {
        responseId: 'resp_restored_cleanup',
        previousResponseId: 'resp_prev_cleanup'
      }
    });
    expect((result.workingRequest as any).semantics?.responses?.resume).toMatchObject({
      previousRequestId: 'req_chain_cleanup',
      restoredFromResponseId: 'resp_restored_cleanup'
    });
  });

  it('lifts session-scoped continuation for openai-chat into unified continuation semantics', async () => {
    const adapterContext = {
      requestId: 'req-openai-chat-session-cont',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 'session_chat_1'
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: {
        protocol: 'openai-chat',
        direction: 'request',
        payload: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: '继续' }]
        }
      } as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [{ role: 'user', content: '继续' }],
            parameters: { model: 'gpt-4o-mini' },
            metadata: { context: adapterContext }
          } as any;
        }
      } as any
    });

    expect((stage2.chatEnvelope as any).semantics?.continuation).toMatchObject({
      chainId: 'session_chat_1',
      stickyScope: 'session',
      stateOrigin: 'openai-chat',
      restored: false,
      resumeFrom: {
        protocol: 'openai-chat'
      }
    });
    expect((stage2.standardizedRequest as any).semantics?.continuation).toMatchObject({
      chainId: 'session_chat_1',
      stickyScope: 'session'
    });
  });

  it('lifts conversation-scoped continuation for anthropic requests into unified continuation semantics', async () => {
    const adapterContext = {
      requestId: 'req-anthropic-conversation-cont',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      conversationId: 'conversation_anthropic_1'
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: {
        protocol: 'anthropic-messages',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续' }]
        }
      } as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [{ role: 'user', content: '继续' }],
            parameters: { model: 'claude-sonnet-4-5' },
            metadata: { context: adapterContext }
          } as any;
        }
      } as any
    });

    expect((stage2.chatEnvelope as any).semantics?.continuation).toMatchObject({
      chainId: 'conversation_anthropic_1',
      stickyScope: 'conversation',
      stateOrigin: 'anthropic-messages',
      restored: false,
      resumeFrom: {
        protocol: 'anthropic-messages'
      }
    });
  });

  it('lifts session continuation for gemini requests into unified continuation semantics', async () => {
    const adapterContext = {
      requestId: 'req-gemini-session-cont',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      sessionId: 'session_gemini_1'
    };

    const stage2 = await runReqInboundStage2SemanticMap({
      adapterContext: adapterContext as any,
      formatEnvelope: {
        protocol: 'gemini-chat',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          contents: [{ role: 'user', parts: [{ text: '继续' }] }]
        }
      } as any,
      semanticMapper: {
        async toChat() {
          return {
            messages: [{ role: 'user', content: '继续' }],
            parameters: { model: 'gemini-2.5-pro' },
            metadata: { context: adapterContext }
          } as any;
        }
      } as any
    });

    expect((stage2.chatEnvelope as any).semantics?.continuation).toMatchObject({
      chainId: 'session_gemini_1',
      stickyScope: 'session',
      stateOrigin: 'gemini-chat',
      restored: false,
      resumeFrom: {
        protocol: 'gemini-chat'
      }
    });
  });
});

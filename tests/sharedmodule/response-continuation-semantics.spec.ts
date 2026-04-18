import { describe, expect, it } from '@jest/globals';

import { buildProcessedRequestFromChatResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/chat-response-utils.js';
import {
  AnthropicResponseMapper,
  GeminiResponseMapper,
  OpenAIChatResponseMapper
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.js';
import { buildChatResponseFromResponses } from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';

describe('response continuation semantics', () => {
  it('lifts responses payload continuity and required_action into response-side continuation semantics', () => {
    const chat = buildChatResponseFromResponses({
      id: 'resp_out_1',
      object: 'response',
      request_id: 'req_chain_resp_1',
      previous_response_id: 'resp_prev_1',
      created_at: 1710000000,
      model: 'gpt-4o-mini',
      status: 'requires_action',
      output: [],
      required_action: {
        submit_tool_outputs: {
          tool_calls: [
            {
              call_id: 'call_resp_1',
              function: {
                name: 'shell_command',
                arguments: { cmd: 'pwd' }
              }
            }
          ]
        }
      }
    }) as any;

    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.semantics?.continuation).toMatchObject({
      chainId: 'req_chain_resp_1',
      previousTurnId: 'resp_prev_1',
      stickyScope: 'request_chain',
      stateOrigin: 'openai-responses',
      restored: true,
      resumeFrom: {
        protocol: 'openai-responses',
        requestId: 'req_chain_resp_1',
        responseId: 'resp_out_1',
        previousResponseId: 'resp_prev_1'
      },
      toolContinuation: {
        mode: 'required_action',
        pendingToolCallIds: ['call_resp_1']
      }
    });
  });

  it('preserves response semantics on processedRequest built from chat response', () => {
    const processed = buildProcessedRequestFromChatResponse({
      id: 'chat_resp_sem_keep',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ],
      semantics: {
        continuation: {
          chainId: 'req_chain_processed_1',
          stickyScope: 'request_chain',
          resumeFrom: {
            responseId: 'resp_processed_1',
            previousResponseId: 'resp_processed_prev_1'
          }
        }
      }
    } as any);

    expect((processed as any).semantics?.continuation).toMatchObject({
      chainId: 'req_chain_processed_1',
      resumeFrom: {
        responseId: 'resp_processed_1',
        previousResponseId: 'resp_processed_prev_1'
      }
    });
  });

  it('restores previous_response_id from response continuation semantics during responses outbound remap', () => {
    const payload = runRespOutboundStage1ClientRemap({
      payload: {
        id: 'chat_resp_to_responses_1',
        object: 'chat.completion',
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_remap_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      } as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-resp-out-remap-1',
      responseSemantics: {
        continuation: {
          chainId: 'req_chain_remap_1',
          stickyScope: 'request_chain',
          resumeFrom: {
            protocol: 'openai-responses',
            responseId: 'resp_curr_1',
            previousResponseId: 'resp_prev_remap_1'
          },
          toolContinuation: {
            mode: 'required_action',
            pendingToolCallIds: ['call_remap_1']
          }
        }
      }
    });

    expect((payload as any).previous_response_id).toBe('resp_prev_remap_1');
    expect((payload as any).status).toBe('requires_action');
    expect((payload as any).required_action.submit_tool_outputs.tool_calls[0]).toMatchObject({
      id: 'call_remap_1',
      name: 'exec_command'
    });
  });

  it('restores session continuation semantics on openai-chat responses from request semantics', () => {
    const mapper = new OpenAIChatResponseMapper();
    const chat = mapper.toChatCompletion(
      {
        format: 'openai-chat',
        direction: 'response',
        payload: {
          id: 'chat_openai_resp_1',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'done' }
            }
          ]
        }
      } as any,
      { requestId: 'req-openai-chat-response-continuation' } as any,
      {
        requestSemantics: {
          continuation: {
            chainId: 'session_chat_resp_1',
            stickyScope: 'session',
            stateOrigin: 'openai-chat',
            restored: false,
            resumeFrom: {
              protocol: 'openai-chat',
              requestId: 'session_chat_resp_1'
            }
          }
        } as any
      }
    ) as any;

    expect(chat.semantics?.continuation).toMatchObject({
      chainId: 'session_chat_resp_1',
      stickyScope: 'session',
      stateOrigin: 'openai-chat',
      resumeFrom: {
        protocol: 'openai-chat',
        requestId: 'session_chat_resp_1'
      }
    });
  });

  it('restores conversation continuation semantics on anthropic responses from request semantics', () => {
    const mapper = new AnthropicResponseMapper();
    const chat = mapper.toChatCompletion(
      {
        format: 'anthropic-messages',
        direction: 'response',
        payload: {
          id: 'msg_anthropic_resp_1',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn'
        }
      } as any,
      { requestId: 'req-anthropic-response-continuation' } as any,
      {
        requestSemantics: {
          continuation: {
            chainId: 'conversation_resp_1',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            restored: false,
            resumeFrom: {
              protocol: 'anthropic-messages',
              requestId: 'conversation_resp_1'
            }
          }
        } as any
      }
    ) as any;

    expect(chat.semantics?.continuation).toMatchObject({
      chainId: 'conversation_resp_1',
      stickyScope: 'conversation',
      stateOrigin: 'anthropic-messages',
      resumeFrom: {
        protocol: 'anthropic-messages',
        requestId: 'conversation_resp_1'
      }
    });
  });

  it('restores session continuation semantics on gemini responses from request semantics', () => {
    const mapper = new GeminiResponseMapper();
    const chat = mapper.toChatCompletion(
      {
        format: 'gemini-chat',
        direction: 'response',
        payload: {
          id: 'gem_resp_state_1',
          model: 'gemini-2.5-pro',
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                role: 'model',
                parts: [{ text: 'done' }]
              }
            }
          ]
        }
      } as any,
      { requestId: 'req-gemini-response-continuation' } as any,
      {
        requestSemantics: {
          continuation: {
            chainId: 'session_gem_resp_1',
            stickyScope: 'session',
            stateOrigin: 'gemini-chat',
            restored: false,
            resumeFrom: {
              protocol: 'gemini-chat',
              requestId: 'session_gem_resp_1'
            }
          }
        } as any
      }
    ) as any;

    expect(chat.semantics?.continuation).toMatchObject({
      chainId: 'session_gem_resp_1',
      stickyScope: 'session',
      stateOrigin: 'gemini-chat',
      resumeFrom: {
        protocol: 'gemini-chat',
        requestId: 'session_gem_resp_1'
      }
    });
  });

  it('preserves restored non-responses continuation through processedRequest build', () => {
    const cases = [
      {
        mapper: new OpenAIChatResponseMapper(),
        format: {
          format: 'openai-chat',
          direction: 'response',
          payload: {
            id: 'chat_openai_resp_2',
            object: 'chat.completion',
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'done' }
              }
            ]
          }
        },
        requestSemantics: {
          continuation: {
            chainId: 'session_chat_resp_2',
            stickyScope: 'session',
            stateOrigin: 'openai-chat',
            resumeFrom: { protocol: 'openai-chat', requestId: 'session_chat_resp_2' }
          }
        },
        expected: { chainId: 'session_chat_resp_2', stickyScope: 'session' }
      },
      {
        mapper: new AnthropicResponseMapper(),
        format: {
          format: 'anthropic-messages',
          direction: 'response',
          payload: {
            id: 'msg_anthropic_resp_2',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn'
          }
        },
        requestSemantics: {
          continuation: {
            chainId: 'conversation_resp_2',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            resumeFrom: { protocol: 'anthropic-messages', requestId: 'conversation_resp_2' }
          }
        },
        expected: { chainId: 'conversation_resp_2', stickyScope: 'conversation' }
      },
      {
        mapper: new GeminiResponseMapper(),
        format: {
          format: 'gemini-chat',
          direction: 'response',
          payload: {
            id: 'gem_resp_state_2',
            model: 'gemini-2.5-pro',
            candidates: [
              {
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: 'done' }] }
              }
            ]
          }
        },
        requestSemantics: {
          continuation: {
            chainId: 'session_gem_resp_2',
            stickyScope: 'session',
            stateOrigin: 'gemini-chat',
            resumeFrom: { protocol: 'gemini-chat', requestId: 'session_gem_resp_2' }
          }
        },
        expected: { chainId: 'session_gem_resp_2', stickyScope: 'session' }
      }
    ] as const;

    for (const testCase of cases) {
      const chat = testCase.mapper.toChatCompletion(
        testCase.format as any,
        { requestId: 'req-non-resp-processed-preserve' } as any,
        { requestSemantics: testCase.requestSemantics as any }
      ) as any;
      const processed = buildProcessedRequestFromChatResponse(chat);
      expect((processed as any).semantics?.continuation).toMatchObject(testCase.expected);
    }
  });
});

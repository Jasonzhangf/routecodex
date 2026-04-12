import { describe, it, expect } from '@jest/globals';
import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import {
  buildChatRequestFromResponses,
  buildResponsesRequestFromChat,
  captureResponsesContext
} from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  recordResponsesResponse,
  rebindResponsesConversationRequestId,
  resumeResponsesConversation
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

function createSubmitContext(overrides?: Partial<AdapterContext>): AdapterContext {
  return {
    requestId: 'req-submit-test',
    entryEndpoint: '/v1/responses.submit_tool_outputs',
    providerProtocol: 'openai-responses',
    responsesResume: {
      restoredFromResponseId: 'resp-test-id'
    },
    ...overrides
  };
}

function createChatEnvelope(ctx: AdapterContext, seed?: Partial<ChatEnvelope>): ChatEnvelope {
  const baseContext = {
    metadata: {
      originalEndpoint: 'openai-responses'
    }
  };
  const responsesContext = (seed?.metadata as Record<string, unknown> | undefined)?.responsesContext ?? baseContext;
  const responsesSemantics = seed?.semantics?.responses ?? {
    context: responsesContext,
    ...(ctx.responsesResume ? { resume: ctx.responsesResume } : {})
  };
  return {
    messages: seed?.messages ?? [{ role: 'user', content: 'hello' }],
    parameters: seed?.parameters ?? { model: 'gpt-4o-mini', stream: true },
    metadata: {
      context: ctx,
      responsesContext,
      ...(seed?.metadata ?? {})
    },
    semantics: {
      ...(seed?.semantics ?? {}),
      responses: responsesSemantics
    },
    ...seed
  };
}

describe('ResponsesSemanticMapper submit tool outputs', () => {
  it('preserves responses reasoning fields when building chat request from responses payload', () => {
    const payload = {
      model: 'gpt-5.4',
      reasoning: { effort: 'high', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'high' },
      prompt_cache_key: '019cdff4-1bd5-7b70-97fd-32e04f9d702d',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }]
        }
      ]
    };

    const context = captureResponsesContext(payload as Record<string, unknown>, {
      route: { requestId: 'req-responses-build-chat-parameters' }
    });
    const { request } = buildChatRequestFromResponses(payload as Record<string, unknown>, context);

    expect(request).toMatchObject({
      model: 'gpt-5.4',
      reasoning: { effort: 'high', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'high' },
      prompt_cache_key: '019cdff4-1bd5-7b70-97fd-32e04f9d702d',
      stream: true
    });
  });

  it('captures responses context into semantics and metadata on inbound', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx = createSubmitContext();
    const format = {
      protocol: 'openai-responses',
      direction: 'request',
      payload: {
        model: 'gpt-4o-mini',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hello'
              }
            ]
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'sample',
            schema: {
              type: 'object'
            }
          }
        }
      }
    } as const;
    const chat = await mapper.toChat(format, ctx);
    const semantics = chat.semantics?.responses as Record<string, unknown> | undefined;
    expect(semantics).toBeDefined();
    expect(semantics?.context).toBeDefined();
    expect((chat.metadata as Record<string, unknown> | undefined)?.responsesContext).toBeUndefined();
    expect(semantics?.resume).toBeUndefined();
  });

  it('builds submit payload from chat toolOutputs', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx = createSubmitContext();
    const chat = createChatEnvelope(ctx, {
      toolOutputs: [
        {
          tool_call_id: 'tool-1',
          content: '{"ok":true}',
          name: 'shell_command'
        }
      ]
    });
    const envelope = await mapper.fromChat(chat, ctx);
    expect(envelope.payload).toMatchObject({
      response_id: 'resp-test-id',
      model: 'gpt-4o-mini',
      stream: true,
      metadata: {
        originalEndpoint: 'openai-responses'
      }
    });
    const outputs = (envelope.payload as Record<string, unknown>).tool_outputs as Array<Record<string, unknown>>;
    expect(Array.isArray(outputs)).toBe(true);
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'tool-1',
      output: '{"ok":true}',
      name: 'shell_command'
    });
  });

  it('falls back to resume metadata when chat.toolOutputs missing', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx = createSubmitContext({
      responsesResume: {
        restoredFromResponseId: 'resp-fallback',
        toolOutputsDetailed: [
          {
            callId: 'resume-1',
            outputText: 'fallback'
          }
        ]
      }
    });
    const chat = createChatEnvelope(ctx, {
      toolOutputs: undefined
    });
    const envelope = await mapper.fromChat(chat, ctx);
    expect(envelope.payload).toMatchObject({
      response_id: 'resp-fallback'
    });
    const outputs = (envelope.payload as Record<string, unknown>).tool_outputs as Array<Record<string, unknown>>;
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'resume-1',
      output: 'fallback'
    });
  });

  it('preserves structured exec_command tool results across Responses↔Chat roundtrip', () => {
    const structuredResult = {
      status: 'completed',
      exit_code: 0,
      stdout: 'total 8\n-rw-r--r--  focus.md\n-rw-r--r--  README.md',
      result: {
        cwd: '/Users/example/project',
        lines: ['focus.md', 'README.md']
      }
    };

    const chatPayload = {
      model: 'glm-4.7',
      stream: false,
      messages: [
        { role: 'system', content: 'You are Codex, a local coding agent.' },
        { role: 'user', content: '列出 workspace 根目录文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_demo_exec',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'ls -la', workdir: '/Users/example/project' })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_demo_exec',
          content: JSON.stringify(structuredResult)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Runs a shell command inside the workspace.',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' },
                workdir: { type: 'string' }
              },
              required: ['cmd']
            }
          }
        }
      ]
    };

    const { request: responsesRequest, originalSystemMessages } = buildResponsesRequestFromChat(chatPayload, {});
    const originalOutput = (responsesRequest as any).input.find((entry: any) => entry?.type === 'function_call_output');
    expect(originalOutput.call_id).toBe('call_demo_exec');
    expect(JSON.parse(originalOutput.output)).toEqual(structuredResult);

    const responsesContext = captureResponsesContext(responsesRequest as Record<string, unknown>, {
      route: { requestId: 'host-exec-command-roundtrip' }
    });
    if (Array.isArray(originalSystemMessages) && originalSystemMessages.length) {
      (responsesContext as Record<string, unknown>).originalSystemMessages = originalSystemMessages;
    }

    const { request: chatRoundtrip } = buildChatRequestFromResponses(
      responsesRequest as Record<string, unknown>,
      responsesContext as any
    );
    const assistantToolCall = (chatRoundtrip as any).messages.find((entry: any) => entry?.role === 'assistant')?.tool_calls?.[0];
    expect(assistantToolCall?.id).toBe('call_demo_exec');
    const toolMessage = (chatRoundtrip as any).messages.find((entry: any) => entry?.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_demo_exec');
    expect(JSON.parse(toolMessage.content)).toEqual(structuredResult);

    const { request: responsesRoundtrip } = buildResponsesRequestFromChat(
      chatRoundtrip as Record<string, unknown>,
      responsesContext as any
    );
    const roundtripOutput = (responsesRoundtrip as any).input.find((entry: any) => entry?.type === 'function_call_output');
    expect(roundtripOutput.call_id).toBe('call_demo_exec');
    expect(JSON.parse(roundtripOutput.output)).toEqual(structuredResult);
    expect(JSON.parse(roundtripOutput.output)).toMatchObject({
      status: 'completed',
      exit_code: 0,
      result: {
        cwd: '/Users/example/project',
        lines: ['focus.md', 'README.md']
      }
    });
  });

  it('can resume submit_tool_outputs after requestId rebind', () => {
    const initialRequestId = `req-submit-rebind-${Date.now()}`;
    const reboundRequestId = `${initialRequestId}-provider`;
    const responseId = `resp-submit-rebind-${Date.now()}`;

    captureResponsesRequestContext({
      requestId: initialRequestId,
      payload: { model: 'gpt-5.4', stream: false },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'run a command' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run a shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        ]
      }
    });

    rebindResponsesConversationRequestId(initialRequestId, reboundRequestId);
    recordResponsesResponse({
      requestId: reboundRequestId,
      response: {
        id: responseId,
        object: 'response',
        status: 'requires_action',
        output: [
          {
            id: 'fc_call_exec_1',
            type: 'function_call',
            call_id: 'call_exec_1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'bash -lc \'echo hello\'' }),
            status: 'in_progress'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'bash -lc \'echo hello\'' })
              }
            ]
          }
        }
      }
    });

    const resumed = resumeResponsesConversation(
      responseId,
      {
        response_id: responseId,
        tool_outputs: [
          {
            tool_call_id: 'call_exec_1',
            output: 'ok'
          }
        ]
      },
      { requestId: `${initialRequestId}-resume` }
    );

    expect((resumed.payload as any).previous_response_id).toBe(responseId);
    expect(Array.isArray((resumed.payload as any).input)).toBe(true);
    expect((resumed.payload as any).input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_exec_1',
          output: 'ok'
        })
      ])
    );

    clearResponsesConversationByRequestId(reboundRequestId);
  });
});

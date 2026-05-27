import { afterEach, describe, expect, jest, test } from '@jest/globals';

const mockResumeLatestResponsesContinuationByScope = jest.fn();
const mockMaterializeLatestResponsesContinuationByScope = jest.fn();

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js', () => ({
  captureResponsesRequestContext: jest.fn(),
  clearResponsesConversationByRequestId: jest.fn(),
  recordResponsesResponse: jest.fn(),
  resumeLatestResponsesContinuationByScope: mockResumeLatestResponsesContinuationByScope,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
}));

describe('route-aware responses continuation', () => {
  const sessionId = 'sess_route_aware_seed_1';

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('RED: plain /v1/responses create must not consult scope continuation store without explicit continuation evidence', async () => {
    mockResumeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        previous_response_id: 'resp_should_not_resume',
        input: [{ type: 'function_call_output', call_id: 'call_should_not_resume', output: 'bad' }],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      meta: {
        previousResponseId: 'resp_should_not_resume',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const plainCreate = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '普通首发，不该续接' }],
        },
      ],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: plainCreate as any,
      rawRequest: plainCreate as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      },
      requestId: 'req_route_aware_plain_create_no_explicit_resume',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
    }) as Record<string, unknown>;

    expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
    expect(result.previous_response_id).toBeUndefined();
    expect(result.input).toEqual(plainCreate.input);
  });

  test('RED: explicit previous_response_id direct continuation must stay remote and must not consult local scope store', async () => {
    mockResumeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        previous_response_id: 'resp_local_scope_should_not_win',
        input: [{ type: 'function_call_output', call_id: 'call_local_scope_should_not_win', output: 'bad' }],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      meta: {
        previousResponseId: 'resp_local_scope_should_not_win',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_remote_direct_truth',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '远程 direct continuation' }] }],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      },
      requestId: 'req_route_aware_direct_previous_response_id_remote_only',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
    }) as Record<string, unknown>;

    expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
    expect(result.previous_response_id).toBe('resp_remote_direct_truth');
    expect(result.input).toEqual(request.input);
  });

  test('RED: explicit previous_response_id must not materialize local relay continuation across ownership boundary', async () => {
    mockMaterializeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        input: [{ type: 'function_call_output', call_id: 'call_local_scope_materialized', output: 'bad' }],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      meta: {
        previousResponseId: 'resp_local_scope_materialized',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_remote_direct_truth_forbidden_to_relay',
      messages: [{ role: 'user', content: '不能跨 direct/relay 恢复' }],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      },
      requestId: 'req_route_aware_cross_protocol_previous_response_id_forbidden',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-chat',
    }) as Record<string, unknown>;

    expect(mockMaterializeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
    expect(result.messages).toEqual(request.messages);
    expect(result.previous_response_id).toBe('resp_remote_direct_truth_forbidden_to_relay');
  });



  test('RED: direct previous_response_id continuation must fail fast when responsesResume pins a different provider', async () => {
    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_remote_direct_truth',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '远程 direct continuation provider mismatch' }] }],
    } as Record<string, unknown>;

    expect(() => resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        responsesResume: {
          resumeFrom: {
            providerKey: 'provider.expected.gpt-5.4'
          }
        }
      },
      requestId: 'req_route_aware_direct_previous_response_id_provider_mismatch',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
      outboundProviderKey: 'provider.actual.gpt-5.4',
    } as any)).toThrow(/provider mismatch/i);
    expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
  });

  test('keeps direct previous_response_id continuation when responsesResume pins the same provider', async () => {
    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_remote_direct_truth',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '远程 direct continuation provider match' }] }],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        responsesResume: {
          resumeFrom: {
            providerKey: 'provider.expected.gpt-5.4'
          }
        }
      },
      requestId: 'req_route_aware_direct_previous_response_id_provider_match',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
      outboundProviderKey: 'provider.expected.gpt-5.4',
    } as any) as Record<string, unknown>;

    expect(result.previous_response_id).toBe('resp_remote_direct_truth');
    expect(result.input).toEqual(request.input);
    expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
  });
  test('keeps explicit previous_response_id continuation for openai-responses outbound', async () => {
    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_explicit_1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续上一轮' }],
        },
      ],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      },
      requestId: 'req_route_aware_explicit_continue',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
    }) as Record<string, unknown>;

    expect(result.previous_response_id).toBe('resp_explicit_1');
    expect(result.input).toEqual(request.input);
  });



  test('RED: servertool followup metadata alone must not consult scope continuation store for plain responses create', async () => {
    mockResumeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        previous_response_id: 'resp_scope_should_not_win',
        input: [{ type: 'function_call_output', call_id: 'call_scope_should_not_win', output: 'bad' }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      },
      meta: {
        previousResponseId: 'resp_scope_should_not_win',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
            additionalProperties: false,
          },
        },
      ],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'stop_message_flow',
        },
      },
      requestId: 'req_route_aware_servertool_followup_plain_create',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
    }) as Record<string, unknown>;

    expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
    expect(result.previous_response_id).toBeUndefined();
    expect(result.input).toEqual(request.input);
    expect(result.tools).toEqual(request.tools);
  });

  test('RED: servertool followup metadata alone must not materialize local relay continuation across protocol boundary', async () => {
    mockMaterializeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        input: [{ type: 'function_call_output', call_id: 'call_scope_materialized', output: 'bad' }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
      },
      meta: {
        previousResponseId: 'resp_scope_materialized',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false,
            },
          },
        },
      ],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'stop_message_flow',
        },
      },
      requestId: 'req_route_aware_servertool_followup_cross_protocol_plain_create',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'anthropic-messages',
    }) as Record<string, unknown>;

    expect(mockMaterializeLatestResponsesContinuationByScope).not.toHaveBeenCalled();
    expect(result.messages).toEqual(request.messages);
    expect(result.tools).toEqual(request.tools);
  });

    test('consults continuation store when submit_tool_outputs/responsesResume provide explicit continuation evidence', async () => {
    mockResumeLatestResponsesContinuationByScope.mockReturnValue({
      payload: {
        previous_response_id: 'resp_explicit_resume_ok',
        input: [{ type: 'function_call_output', call_id: 'call_explicit_resume_ok', output: 'ok' }],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      meta: {
        previousResponseId: 'resp_explicit_resume_ok',
        restoredFromScopeKey: `session:${sessionId}`,
      },
    });

    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const explicitResume = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'submit_tool_outputs continuation' }],
        },
      ],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: explicitResume as any,
      rawRequest: explicitResume as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        providerProtocol: 'openai-responses',
        responsesResume: { previousResponseId: 'resp_explicit_resume_ok' },
      },
      requestId: 'req_route_aware_explicit_resume_ok',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
    }) as Record<string, unknown>;

    expect(mockResumeLatestResponsesContinuationByScope).toHaveBeenCalledTimes(1);
    expect(result).toBeTruthy();
  });

  test('accepts direct submit_tool_outputs provider pin carried as flat responsesResume.providerKey', async () => {
    const { resolveRouteAwareResponsesContinuation } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js');

    const request = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_submit_direct_provider_pin_flat',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'flat provider pin' }] }],
    } as Record<string, unknown>;

    const result = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId,
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        providerProtocol: 'openai-responses',
        responsesResume: {
          providerKey: 'dibittai.crsa.gpt-5.4'
        }
      },
      requestId: 'req_route_aware_submit_tool_outputs_provider_pin_flat',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'openai-responses',
      outboundProviderKey: 'dibittai.crsa.gpt-5.4',
    } as any) as Record<string, unknown>;

    expect(result.previous_response_id).toBe('resp_submit_direct_provider_pin_flat');
    expect(result.input).toEqual(request.input);
  });
});

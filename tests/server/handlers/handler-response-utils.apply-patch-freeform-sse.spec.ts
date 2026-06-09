import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

const convertResponseToJsonToSseMock = jest.fn(async () => Readable.from(['event: response.completed\n', 'data: {}\n\n']));
const projectResponsesClientBodyForClientWithNativeMock = jest.fn((payload: any, toolsRaw: unknown[]) => {
  const hasFreeformApplyPatch = toolsRaw.some((tool: any) =>
    tool?.name === 'apply_patch' && tool?.format?.type === 'grammar'
  );
  if (!hasFreeformApplyPatch) return payload;
  const unwrap = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).patch === 'string') {
        return (parsed as any).patch;
      }
    } catch {
      return value;
    }
    return value;
  };
  const visit = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    if (value.type === 'function_call' && value.name === 'apply_patch') {
      return {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: typeof value.call_id === 'string' ? value.call_id : 'call_apply_patch',
        input: unwrap(value.arguments),
      };
    }
    const out: any = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = key === 'arguments' || (value.type === 'custom_tool_call' && value.name === 'apply_patch' && key === 'input')
        ? unwrap(child)
        : visit(child);
    }
    return out;
  };
  return visit(payload);
});
const projectResponsesSseFrameForClientWithNativeMock = jest.fn((input: any) => {
  const data = input.data;
  const hasFreeformApplyPatch = input.toolsRaw.some((tool: any) =>
    tool?.name === 'apply_patch' && tool?.format?.type === 'grammar'
  );
  if (!hasFreeformApplyPatch) {
    return { emit: true, frame: input.frame, state: input.state };
  }
  const state = {
    pendingApplyPatchArgumentDeltas: { ...(input.state?.pendingApplyPatchArgumentDeltas ?? {}) },
    applyPatchCallIds: [...(input.state?.applyPatchCallIds ?? [])],
    emittedApplyPatchDoneCallIds: [...(input.state?.emittedApplyPatchDoneCallIds ?? [])],
  };
  const unwrap = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).patch === 'string') {
        return (parsed as any).patch;
      }
    } catch {
      return value;
    }
    return value;
  };
  const callId = typeof data.call_id === 'string'
    ? data.call_id
    : typeof data.item?.call_id === 'string'
      ? data.item.call_id
      : 'call_apply_patch';
  if (data.item?.type === 'function_call' && data.item?.name === 'apply_patch' && !state.applyPatchCallIds.includes(callId)) {
    state.applyPatchCallIds.push(callId);
  }
  if (input.eventName === 'response.function_call_arguments.delta' && state.applyPatchCallIds.includes(callId)) {
    state.pendingApplyPatchArgumentDeltas[callId] = `${state.pendingApplyPatchArgumentDeltas[callId] ?? ''}${data.delta ?? ''}`;
    return { emit: false, frame: '', state };
  }
  if (data.name === 'apply_patch' || data.item?.name === 'apply_patch') {
    const rawArguments = typeof data.arguments === 'string' ? data.arguments : data.item?.arguments;
    const inputText = unwrap(rawArguments);
    if (input.eventName === 'response.function_call_arguments.done') {
      if (state.emittedApplyPatchDoneCallIds.includes(callId)) {
        return { emit: false, frame: '', state };
      }
      state.emittedApplyPatchDoneCallIds.push(callId);
      delete state.pendingApplyPatchArgumentDeltas[callId];
      state.applyPatchCallIds = state.applyPatchCallIds.filter((id) => id !== callId);
      const frameData = { type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: inputText } };
      return { emit: true, frame: `event: response.output_item.done\ndata: ${JSON.stringify(frameData)}\n\n`, state };
    }
    const next = JSON.parse(JSON.stringify(data));
    if (next.item?.type === 'function_call') {
      next.item = { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: inputText };
    }
    if (next.response) {
      next.response = projectResponsesClientBodyForClientWithNativeMock(next.response, input.toolsRaw);
    }
    return { emit: true, frame: `event: ${input.eventName}\ndata: ${JSON.stringify(next)}\n\n`, state };
  }
  if (data.response) {
    const next = { ...data, response: projectResponsesClientBodyForClientWithNativeMock(data.response, input.toolsRaw) };
    return { emit: true, frame: `event: ${input.eventName}\ndata: ${JSON.stringify(next)}\n\n`, state };
  }
  return { emit: true, frame: input.frame, state };
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(async () => ({
    convertResponseToJsonToSse: convertResponseToJsonToSseMock,
  })),
  deriveFinishReasonNative: jest.fn(() => 'tool_calls'),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  importCoreDist: jest.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      projectResponsesClientBodyForClientWithNative: projectResponsesClientBodyForClientWithNativeMock,
      projectResponsesSseFrameForClientWithNative: projectResponsesSseFrameForClientWithNativeMock,
    };
  }),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  recordResponsesResponseForRequest: jest.fn(async () => undefined),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  requireCoreDist: jest.fn(),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
}));

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }
}

async function waitForEnd(stream: PassThrough): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
    stream.resume();
  });
}

describe('handler response utils apply_patch freeform SSE projection', () => {
  it('passes original Responses tools into native normalization before JSON-to-SSE bridge', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const patch = '*** Begin Patch\n*** Add File: tmp/routecodex-online-apply-patch-smoke.txt\n+hello\n*** End Patch';
    const res = new MockResponse();

    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_apply_patch_sse',
          object: 'response',
          status: 'requires_action',
          output: [{ type: 'function_call', name: 'apply_patch', call_id: 'call_patch', arguments: JSON.stringify({ patch }) }],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [{
                id: 'call_patch',
                type: 'function',
                name: 'apply_patch',
                arguments: JSON.stringify({ patch }),
                function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) },
              }],
            },
          },
        },
      } as any,
      'req_apply_patch_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
          },
          context: {},
        },
      },
    );
    await waitForEnd(res);

    expect(projectResponsesClientBodyForClientWithNativeMock).toHaveBeenCalledWith(
      expect.any(Object),
      [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
    );
    expect(convertResponseToJsonToSseMock.mock.calls[0][0].output[0]).toMatchObject({
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call_patch',
      input: patch,
    });
    expect(JSON.stringify(convertResponseToJsonToSseMock.mock.calls[0][0])).not.toContain('{\\"patch\\"');
    expect(JSON.stringify(convertResponseToJsonToSseMock.mock.calls[0][0])).not.toContain('"type":"function_call","name":"apply_patch"');
  });

  it('normalizes live __sse_responses function_call frames before writing to client', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const patch = '*** Begin Patch\n*** Add File: tmp/routecodex-online-apply-patch-smoke.txt\n+hello\n*** End Patch';
    const upstream = new PassThrough();
    const res = new MockResponse();
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        headers: {},
        body: { __sse_responses: upstream },
      } as any,
      'req_apply_patch_live_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
          },
          context: {},
        },
      },
    );

    upstream.write('event: response.function_call_arguments.done\n');
    upstream.write(`data: ${JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'apply_patch',
      call_id: 'call_patch',
      arguments: JSON.stringify({ patch }),
    })}\n\n`);
    upstream.end();
    await waitForEnd(res);
    const text = Buffer.concat(chunks).toString('utf8');

    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('"type":"custom_tool_call"');
    expect(text).toContain('"input":');
    expect(text).toContain(JSON.stringify(patch));
    expect(text).not.toContain('{\\"patch\\"');
    expect(text).not.toContain('"type":"response.function_call_arguments.done"');
  });

  it('normalizes live output_item and required_action frames before writing to client', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const patch = '*** Begin Patch\n*** Add File: tmp/routecodex-online-apply-patch-smoke.txt\n+hello\n*** End Patch';
    const wrapped = JSON.stringify({ patch });
    const upstream = new PassThrough();
    const res = new MockResponse();
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await sendPipelineResponse(
      res as any,
      { status: 200, headers: {}, body: { __sse_responses: upstream } } as any,
      'req_apply_patch_nested_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
          },
          context: {},
        },
      },
    );

    upstream.write('event: response.output_item.done\n');
    upstream.write(`data: ${JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'apply_patch', call_id: 'call_patch', arguments: wrapped },
    })}\n\n`);
    upstream.write('event: response.required_action\n');
    upstream.write(`data: ${JSON.stringify({
      type: 'response.required_action',
      response: {
        id: 'resp_patch',
        object: 'response',
        output: [
          { type: 'function_call', name: 'apply_patch', call_id: 'call_patch', arguments: wrapped },
          { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_custom', input: wrapped },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{
              id: 'call_patch',
              type: 'function',
              name: 'apply_patch',
              arguments: wrapped,
              function: { name: 'apply_patch', arguments: wrapped },
            }],
          },
        },
      },
    })}\n\n`);
    upstream.end();
    await waitForEnd(res);
    const text = Buffer.concat(chunks).toString('utf8');

    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('event: response.required_action');
    expect(text).toContain('"type":"custom_tool_call"');
    expect(text).toContain('"input":');
    expect(text).toContain(JSON.stringify(patch));
    expect(text).not.toContain('{\\"patch\\"');
    expect(text).not.toContain('"type":"function_call","name":"apply_patch"');
  });

  it('rewrites JSON-wrapped argument delta stream into one raw freeform delta before done', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const patch = '*** Begin Patch\n*** Add File: tmp/routecodex-online-apply-patch-smoke.txt\n+hello\n*** End Patch';
    const wrapped = JSON.stringify({ patch });
    const upstream = new PassThrough();
    const res = new MockResponse();
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await sendPipelineResponse(
      res as any,
      { status: 200, headers: {}, body: { __sse_responses: upstream } } as any,
      'req_apply_patch_delta_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
          },
          context: {},
        },
      },
    );

    upstream.write('event: response.output_item.added\n');
    upstream.write(`data: ${JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'apply_patch', call_id: 'call_patch', arguments: '' },
    })}\n\n`);
    upstream.write('event: response.function_call_arguments.delta\n');
    upstream.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', call_id: 'call_patch', delta: wrapped.slice(0, 12) })}\n\n`);
    upstream.write('event: response.function_call_arguments.delta\n');
    upstream.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', call_id: 'call_patch', delta: wrapped.slice(12) })}\n\n`);
    upstream.write('event: response.function_call_arguments.done\n');
    upstream.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.done', name: 'apply_patch', call_id: 'call_patch', arguments: wrapped })}\n\n`);
    upstream.end();
    await waitForEnd(res);
    const text = Buffer.concat(chunks).toString('utf8');

    expect(text).not.toContain('event: response.function_call_arguments.delta');
    expect(text).not.toContain('event: response.function_call_arguments.done');
    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('"type":"custom_tool_call"');
    expect(text).toContain('"input":');
    expect(text).toContain(JSON.stringify(patch));
    expect(text).not.toContain('{\\"patch\\"');
  });

  it('preserves live SSE frame order when normalized tool frames precede terminal frames', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const patch = '*** Begin Patch\n*** Add File: tmp/routecodex-online-apply-patch-smoke.txt\n+hello\n*** End Patch';
    const wrapped = JSON.stringify({ patch });
    const upstream = new PassThrough();
    const res = new MockResponse();
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await sendPipelineResponse(
      res as any,
      { status: 200, headers: {}, body: { __sse_responses: upstream } } as any,
      'req_apply_patch_terminal_order_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
          },
          context: {},
        },
      },
    );

    upstream.write([
      'event: response.function_call_arguments.done\n',
      `data: ${JSON.stringify({
        type: 'response.function_call_arguments.done',
        name: 'apply_patch',
        call_id: 'call_patch_order',
        arguments: wrapped,
      })}\n\n`,
      'event: response.completed\n',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_apply_patch_order',
          object: 'response',
          status: 'completed',
        },
      })}\n\n`,
      'event: response.done\n',
      `data: ${JSON.stringify({
        type: 'response.done',
        response: {
          id: 'resp_apply_patch_order',
          object: 'response',
          status: 'completed',
        },
      })}\n\n`,
    ].join(''));
    upstream.end();
    await waitForEnd(res);
    const text = Buffer.concat(chunks).toString('utf8');

    const outputDoneIndex = text.indexOf('event: response.output_item.done');
    const completedIndex = text.indexOf('event: response.completed');
    const doneIndex = text.indexOf('event: response.done');
    expect(outputDoneIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(outputDoneIndex);
    expect(doneIndex).toBeGreaterThan(completedIndex);
    expect(text).not.toContain('stream closed before response.completed');
    expect(text).not.toContain('sse_stream_error');
  });

  it('preserves live SSE frame order when generic function_call done precedes terminal frames', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    const res = new MockResponse();
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await sendPipelineResponse(
      res as any,
      { status: 200, headers: {}, body: { __sse_responses: upstream } } as any,
      'req_function_call_terminal_order_sse',
      {
        entryEndpoint: '/v1/responses',
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [],
            tools: [{
              type: 'function',
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd'],
                additionalProperties: false,
              },
            }],
          },
          context: {},
        },
      },
    );

    upstream.write([
      'event: response.output_item.done\n',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_order_1',
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_order_1',
          arguments: '{"cmd":"pwd"}',
          status: 'completed',
        },
      })}\n\n`,
      'event: response.completed\n',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_function_call_order',
          object: 'response',
          status: 'completed',
          output: [],
        },
      })}\n\n`,
      'event: response.done\n',
      `data: ${JSON.stringify({
        type: 'response.done',
        response: {
          id: 'resp_function_call_order',
          object: 'response',
          status: 'completed',
        },
      })}\n\n`,
    ].join(''));
    upstream.end();
    await waitForEnd(res);
    const text = Buffer.concat(chunks).toString('utf8');

    const outputDoneIndex = text.indexOf('event: response.output_item.done');
    const completedIndex = text.indexOf('event: response.completed');
    const doneIndex = text.indexOf('event: response.done');
    expect(outputDoneIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(outputDoneIndex);
    expect(doneIndex).toBeGreaterThan(completedIndex);
    expect(text).not.toContain('stream closed before response.completed');
    expect(text).not.toContain('sse_stream_error');
  });
});

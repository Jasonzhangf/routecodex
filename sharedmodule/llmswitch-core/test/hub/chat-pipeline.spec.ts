import { runInboundPipeline, type InboundPlan } from '../../src/conversion/hub/pipelines/inbound.js';
import { runOutboundPipeline, type OutboundPlan } from '../../src/conversion/hub/pipelines/outbound.js';
import type { AdapterContext, ChatEnvelope } from '../../src/conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../../src/conversion/hub/format-adapters/index.js';
import { ChatFormatAdapter } from '../../src/conversion/hub/format-adapters/chat-format-adapter.js';
import { ChatSemanticMapper } from '../../src/conversion/hub/semantic-mappers/chat-mapper.js';

class MemoryRecorder implements StageRecorder {
  public stages: Array<{ stage: string; payload: object }> = [];
  record(stage: string, payload: object): void {
    this.stages.push({ stage, payload });
  }
}

const ctx: AdapterContext = {
  requestId: 'req_hub_chat',
  entryEndpoint: '/v1/chat/completions',
  providerProtocol: 'openai-chat',
  providerId: 'glm.key1',
  routeId: 'default'
};

const sampleChatRequest = {
  model: 'glm-4.6',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hi' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'noop',
        description: 'no operation',
        parameters: { type: 'object', properties: {} }
      }
    }
  ]
};

describe('Chat hub pipeline', () => {
  const formatAdapter = new ChatFormatAdapter();
  const semanticMapper = new ChatSemanticMapper();
  const inboundPlan: InboundPlan = {
    protocol: 'openai-chat',
    stages: ['format_parse', 'semantic_map_to_chat'],
    formatAdapter,
    semanticMapper
  };
  const outboundPlan: OutboundPlan = {
    protocol: 'openai-chat',
    stages: ['semantic_map_from_chat', 'format_build'],
    formatAdapter,
    semanticMapper
  };

  test('inbound -> outbound preserves chat payload', async () => {
    const recorder = new MemoryRecorder();
    const inboundEnvelope = await runInboundPipeline({
      rawRequest: sampleChatRequest,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    expect(inboundEnvelope.messages.length).toBe(2);
    expect(inboundEnvelope.parameters?.model).toBe('glm-4.6');
    expect(inboundEnvelope.metadata.systemInstructions).toEqual(['You are a helpful assistant.']);
    expect(recorder.stages.map(s => s.stage)).toEqual(['format_parse', 'semantic_map_to_chat']);

    const outboundPayload = await runOutboundPipeline({
      chat: inboundEnvelope,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    expect(outboundPayload).toEqual({
      messages: sampleChatRequest.messages,
      tools: sampleChatRequest.tools,
      model: 'glm-4.6'
    });
    expect(recorder.stages.map(s => s.stage)).toEqual([
      'format_parse',
      'semantic_map_to_chat',
      'semantic_map_from_chat',
      'format_build'
    ]);
  });

  test('tool outputs survive roundtrip from field', async () => {
    const recorder = new MemoryRecorder();
    const requestWithTool = {
      ...sampleChatRequest,
      tool_outputs: [{ tool_call_id: 'call_1', content: 'done', name: 'noop' }]
    };
    const inbound = await runInboundPipeline({
      rawRequest: requestWithTool,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    expect(inbound.toolOutputs?.[0]?.tool_call_id).toBe('call_1');

    const outbound = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    expect(outbound).toEqual({
      messages: requestWithTool.messages,
      tools: requestWithTool.tools,
      tool_outputs: requestWithTool.tool_outputs,
      model: 'glm-4.6'
    });
  });

  test('tool role messages recorded as tool outputs', async () => {
    const recorder = new MemoryRecorder();
    const requestWithToolMessage = {
      ...sampleChatRequest,
      messages: [
        ...sampleChatRequest.messages,
        { role: 'assistant', content: 'Calling tool...' },
        { role: 'tool', tool_call_id: 'call_msg_1', content: { result: 'ok' } }
      ]
    };
    const inbound = await runInboundPipeline({
      rawRequest: requestWithToolMessage,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    expect(inbound.toolOutputs?.[0]?.tool_call_id).toBe('call_msg_1');
    expect(inbound.toolOutputs?.[0]?.content).toContain('{"result":"ok"');
    const outbound = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    expect(outbound.messages).toEqual(requestWithToolMessage.messages);
  });

  test('tool call ids persist even when tool function metadata is incomplete', async () => {
    const recorder = new MemoryRecorder();
    const requestWithInvalidTool = {
      ...sampleChatRequest,
      messages: [
        ...sampleChatRequest.messages,
        {
          role: 'assistant',
          content: 'Tool call 2: unknown',
          tool_calls: [
            {
              id: 'tool-call-1',
              type: 'function',
              function: {
                name: '',
                arguments: '{}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'tool-call-1',
          content: 'unsupported call: '
        }
      ]
    };
    const inbound = await runInboundPipeline({
      rawRequest: requestWithInvalidTool,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    const assistantWithToolCall = inbound.messages.find(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    );
    expect(assistantWithToolCall?.tool_calls?.[0]?.id).toBe('tool-call-1');
    const outbound = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    expect(Array.isArray(outbound.messages)).toBe(true);
    const outboundAssistant = (outbound.messages as Array<Record<string, unknown>>).find(
      (message) => Array.isArray((message as Record<string, unknown>).tool_calls)
    ) as Record<string, unknown> | undefined;
    const outboundToolCalls = Array.isArray(outboundAssistant?.tool_calls)
      ? (outboundAssistant?.tool_calls as Array<Record<string, unknown>>)
      : undefined;
    expect(outboundToolCalls?.[0]?.id).toBe('tool-call-1');
    const outboundFunction = outboundToolCalls?.[0]?.function as Record<string, unknown> | undefined;
    const outboundFunctionName =
      typeof outboundFunction?.name === 'string' ? (outboundFunction?.name as string) : undefined;
    expect(outboundFunctionName ?? '').toBe('');
  });
});

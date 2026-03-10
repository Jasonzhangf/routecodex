import { convertProviderResponse } from '../../src/conversion/hub/response/provider-response.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../src/conversion/hub/types/json.js';
import { buildResponsesPayloadFromChat, buildChatResponseFromResponses } from '../../src/conversion/responses/responses-openai-bridge.js';

function buildChatResponse(): JsonObject {
  return {
    id: 'chatcmpl_hub_roundtrip',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'Hub response pipeline rocks.'
        }
      }
    ],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 8,
      total_tokens: 12
    }
  } as JsonObject;
}

async function collectStream(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return '';
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

describe('Hub provider response pipeline', () => {
  const baseContext: AdapterContext = {
    requestId: 'resp_test_req',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat'
  };

  test('openai-chat provider returns chat payload for JSON clients', async () => {
    const chatResponse = buildChatResponse();
    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: chatResponse,
      context: baseContext,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false
    });
    expect(result.body).toBeDefined();
    expect(result.body?.choices?.[0]?.message?.content).toBe('Hub response pipeline rocks.');
  });

  test('openai-chat provider emits SSE stream when requested', async () => {
    const chatResponse = buildChatResponse();
    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: chatResponse,
      context: baseContext,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: true
    });
    expect(result.__sse_responses).toBeDefined();
    const payload = await collectStream(result.__sse_responses);
    expect(payload).toContain('"Hub response pipeline rocks."');
    expect(payload).toContain('data:');
  });

  test('responses provider maps to Anthropic shape when client endpoint is /v1/messages', async () => {
    const chatResponse = buildChatResponse();
    const responsesPayload = buildResponsesPayloadFromChat(chatResponse);
    const ctx: AdapterContext = {
      ...baseContext,
      providerProtocol: 'openai-responses'
    };
    const converted = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: responsesPayload as JsonObject,
      context: ctx,
      entryEndpoint: '/v1/messages',
      wantsStream: false
    });
    expect(converted.body).toBeDefined();
    expect(converted.body?.type).toBe('message');
    expect(converted.body?.role).toBe('assistant');
  });

  test('responses roundtrip preserves chat payload', () => {
    const chatResponse = buildChatResponse();
    const responsesPayload = buildResponsesPayloadFromChat(chatResponse);
    const mapped = buildChatResponseFromResponses(responsesPayload) as JsonObject;
    expect(mapped?.choices?.[0]?.message?.content?.[0]?.text).toBe('Hub response pipeline rocks.');
    expect(mapped?.choices?.[0]?.finish_reason).toBe('stop');
  });

  test('responses provider is converted back to chat payload for /v1/chat/completions', async () => {
    const chatResponse = buildChatResponse();
    const responsesPayload = buildResponsesPayloadFromChat(chatResponse);
    const ctx: AdapterContext = {
      ...baseContext,
      providerProtocol: 'openai-responses'
    };
    const converted = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: responsesPayload as JsonObject,
      context: ctx,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false
    });
    expect(converted.body?.choices?.[0]?.message?.content?.[0]?.text).toContain('Hub response pipeline rocks.');
    expect(converted.body?.choices?.[0]?.finish_reason).toBe('stop');
  });

  test('responses provider re-bridges payload for /v1/responses endpoint', async () => {
    const chatResponse = buildChatResponse();
    const responsesPayload = buildResponsesPayloadFromChat(chatResponse);
    const ctx: AdapterContext = {
      ...baseContext,
      providerProtocol: 'openai-responses'
    };
    const converted = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: responsesPayload as JsonObject,
      context: ctx,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });
    expect(converted.body?.object).toBe('response');
    expect(converted.body?.output_text).toContain('Hub response pipeline rocks.');
  });

  test('responses /v1/responses preserves OpenAI call_* ids for required_action tool calls', async () => {
    const responsesPayload: JsonObject = {
      id: 'resp_toolcall_preserve',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'lmstudio-qwen',
      output: [
        {
          id: 'fc_provider_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1234567890',
          name: 'exec_command',
          arguments: '{"command":"pwd"}'
        }
      ]
    } as unknown as JsonObject;

    const ctx: AdapterContext = {
      ...baseContext,
      providerProtocol: 'openai-responses'
    };

    const converted = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: responsesPayload,
      context: ctx,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(converted.body?.object).toBe('response');
    expect(converted.body?.status).toBe('requires_action');
    expect(converted.body?.output?.[0]?.type).toBe('function_call');
    expect(converted.body?.output?.[0]?.call_id).toBe('call_1234567890');
    expect(converted.body?.required_action?.submit_tool_outputs?.tool_calls?.[0]?.id).toBe('call_1234567890');
    expect(converted.body?.required_action?.submit_tool_outputs?.tool_calls?.[0]?.tool_call_id).toBe('call_1234567890');
  });
});

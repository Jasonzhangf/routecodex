import { runInboundPipeline, type InboundPlan } from '../../src/conversion/hub/pipelines/inbound.js';
import { runOutboundPipeline, type OutboundPlan } from '../../src/conversion/hub/pipelines/outbound.js';
import { GeminiFormatAdapter } from '../../src/conversion/hub/format-adapters/gemini-format-adapter.js';
import { GeminiSemanticMapper } from '../../src/conversion/hub/semantic-mappers/gemini-mapper.js';
import { GeminiResponseMapper } from '../../src/conversion/hub/response/response-mappers.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';

const ctx: AdapterContext = {
  requestId: 'req_gemini_1',
  entryEndpoint: '/v1/models/gemini:generateContent',
  providerProtocol: 'gemini-chat',
  providerId: 'gemini.quickstart',
  routeId: 'default'
};

const geminiRequest = {
  model: 'models/gemini-1.5-pro',
  systemInstruction: {
    role: 'system',
    parts: [{ text: 'You are a helpful assistant.' }]
  },
  contents: [
    {
      role: 'user',
      parts: [{ text: 'List files.' }]
    }
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: 'list_files',
          description: 'List files from directory.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' }
            },
            required: ['path']
          }
        }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 512,
    stopSequences: ['END']
  },
  metadata: {
    experiment: 'gemini-hub'
  }
};

describe('Gemini hub pipeline', () => {
  const formatAdapter = new GeminiFormatAdapter();
  const semanticMapper = new GeminiSemanticMapper();
  const inboundPlan: InboundPlan = {
    protocol: 'gemini-chat',
    stages: ['format_parse', 'semantic_map_to_chat'],
    formatAdapter,
    semanticMapper
  };
  const outboundPlan: OutboundPlan = {
    protocol: 'gemini-chat',
    stages: ['semantic_map_from_chat', 'format_build'],
    formatAdapter,
    semanticMapper
  };

  test('roundtrip preserves key fields', async () => {
    const inbound = await runInboundPipeline({
      rawRequest: geminiRequest,
      context: ctx,
      plan: inboundPlan
    });
    expect(inbound.metadata.systemInstructions).toEqual(['You are a CLI assistant.']);
    const protocolState = inbound.metadata.protocolState as Record<string, any> | undefined;
    expect(protocolState?.gemini?.systemInstruction).toBeDefined();
    expect(inbound.parameters?.model).toBe('models/gemini-1.5-pro');

    const outbound = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan
    });
    expect(outbound.model).toBe('models/gemini-1.5-pro');
    expect(outbound.systemInstruction).toBeDefined();
    expect(outbound.contents?.[0]?.parts?.[0]?.text).toContain('List files');
    expect(outbound.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('list_files');
    expect(outbound.metadata?.experiment).toBe('gemini-hub');
  });

  test('GeminiResponseMapper maps finishReason and tool_calls correctly', async () => {
    const mapper = new GeminiResponseMapper();
    const ctxForResponse: AdapterContext = {
      ...ctx,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat'
    };

    const geminiResponse = {
      id: 'resp_gemini_toolcall',
      model: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'web_search',
                  id: 'call_web_1',
                  args: { query: 'today news' }
                }
              }
            ]
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8
      }
    };

    const format = {
      protocol: 'gemini-chat',
      direction: 'response',
      payload: geminiResponse
    } as any;

    const chatLike = await mapper.toChatCompletion(format, ctxForResponse);
    const choice = (chatLike.choices || [])[0] as any;

    expect(choice.finish_reason).toBe('tool_calls');
    expect(Array.isArray(choice.message?.tool_calls)).toBe(true);
    expect(choice.message.tool_calls[0].function.name).toBe('web_search');
  });

  test('GeminiResponseMapper preserves functionResponse as structured tool_outputs', async () => {
    const mapper = new GeminiResponseMapper();
    const ctxForResponse: AdapterContext = {
      ...ctx,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat'
    };

    const geminiResponseWithToolResult = {
      id: 'resp_gemini_tool_result',
      model: 'gemini-3-pro-high',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'apply_patch',
                  id: 'call_apply_1',
                  args: { patch: 'diff --git a b' }
                }
              },
              {
                functionResponse: {
                  name: 'apply_patch',
                  id: 'call_apply_1',
                  response: { status: 'ok', changedFiles: 3 }
                }
              }
            ]
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 42,
        candidatesTokenCount: 10,
        totalTokenCount: 52
      }
    };

    const format = {
      protocol: 'gemini-chat',
      direction: 'response',
      payload: geminiResponseWithToolResult
    } as any;

    const chatLike = await mapper.toChatCompletion(format, ctxForResponse);
    const choice = (chatLike.choices || [])[0] as any;

    // Tool call is preserved and finish_reason stays in tool_calls mode.
    expect(choice.finish_reason).toBe('tool_calls');
    expect(Array.isArray(choice.message?.tool_calls)).toBe(true);
    expect(choice.message.tool_calls[0].id).toBe('call_apply_1');

    // Structured tool_outputs are emitted so /v1/responses can build function_call_output items.
    const toolOutputs = (chatLike as any).tool_outputs;
    expect(Array.isArray(toolOutputs)).toBe(true);
    expect(toolOutputs.length).toBe(1);
    expect(toolOutputs[0].tool_call_id).toBe('call_apply_1');
    expect(toolOutputs[0].id).toBe('call_apply_1');
    expect(toolOutputs[0].name).toBe('apply_patch');
    expect(typeof toolOutputs[0].content).toBe('string');
    expect(toolOutputs[0].content).toContain('"status":"ok"');
  });
});

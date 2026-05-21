import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/responses-mapper.js';
import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper.js';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.js';
import { ChatSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper.js';
import { readProtocolMappingAudit } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/protocol-mapping-audit.js';
import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

function createResponsesContext(requestId: string): AdapterContext {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };
}

function extractFieldSet(items: unknown): Set<string> {
  const rows = Array.isArray(items) ? items : [];
  return new Set(
    rows
      .map((entry) => (entry && typeof entry === 'object' ? String((entry as any).field || '') : ''))
      .filter((field) => field.length > 0)
  );
}

function buildResponsesToolsPayload(toolChoice: 'auto' | 'required') {
  return {
    model: 'gpt-5',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'use tool' }] }],
    tool_choice: toolChoice,
    tools: [
      {
        type: 'function',
        name: 'exec_command',
        description: 'execute command',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false
        }
      }
    ]
  };
}

function pickToolNames(payload: any): string[] {
  const names = new Set<string>();
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  for (const tool of tools) {
    const n = tool?.name ?? tool?.function?.name;
    if (typeof n === 'string' && n.length > 0) names.add(n);
    const decls = Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : [];
    for (const decl of decls) {
      if (typeof decl?.name === 'string' && decl.name.length > 0) names.add(decl.name);
    }
  }
  return Array.from(names);
}

async function collectStream(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return '';
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

function readFixtureJson(caseDir: string, fileName: string): Record<string, any> {
  const filePath = path.join(process.cwd(), 'tests', 'fixtures', 'conversion-matrix', caseDir, fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function seedResponsesConversationRequest(args: {
  requestId: string;
  tools?: Array<Record<string, unknown>>;
  inputText?: string;
}): void {
  captureResponsesRequestContext({
    requestId: args.requestId,
    payload: {
      model: 'gpt-5.3-codex',
      stream: true,
      input: args.inputText ?? '继续执行',
      ...(Array.isArray(args.tools) ? { tools: args.tools } : {})
    } as any,
    context: {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: args.inputText ?? '继续执行' }]
        }
      ],
      ...(Array.isArray(args.tools) ? { tools: args.tools } : {})
    } as any
  });
}

describe('responses cross-protocol dropped/lossy audit matrix', () => {
  it.each([
    {
      name: 'function selector object',
      payload: {
        model: 'gpt-5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'run exec_command' }] }],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'exec_command' } }
      }
    },
    {
      name: 'auto with declared tools',
      payload: {
        model: 'gpt-5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'use tools when needed' }] }],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        ],
        tool_choice: 'auto'
      }
    }
  ])('sample req roundtrip keeps tool semantics: $name', async ({ payload }) => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();

    const chatFromResponses = await responsesMapper.toChat(
      { protocol: 'openai-responses', direction: 'request', payload } as any,
      createResponsesContext(`req-sample-${payload.tool_choice === 'auto' ? 'auto' : 'fn'}`)
    );
    const anthropicOutbound = await anthropicMapper.fromChat(chatFromResponses as any, {
      requestId: 'req-sample-chat-to-anthropic',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);
    const chatFromAnthropic = await anthropicMapper.toChat(
      { protocol: 'anthropic-messages', direction: 'request', payload: (anthropicOutbound as any).payload } as any,
      {
        requestId: 'req-sample-anthropic-to-chat',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as AdapterContext
    );
    const responsesRoundtrip = await responsesMapper.fromChat(
      chatFromAnthropic as any,
      createResponsesContext('req-sample-chat-to-responses')
    );

    expect((responsesRoundtrip as any).payload?.tools?.[0]?.name).toBe('exec_command');
    const finalChoice = (responsesRoundtrip as any).payload?.tool_choice;
    if (payload.tool_choice === 'auto') {
      expect(finalChoice).toBe('auto');
    } else {
      expect(finalChoice).toEqual({ type: 'function', function: { name: 'exec_command' } });
    }
  });

  it('blackbox req matrix: responses -> chat -> anthropic -> chat -> responses keeps tool selector and tool schema', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();

    const inboundResponsesPayload = {
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'run exec_command' }] }],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          description: 'execute command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
            additionalProperties: false
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'exec_command' } }
    };

    const chatFromResponses = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: inboundResponsesPayload
      } as any,
      createResponsesContext('req-blackbox-responses-to-chat')
    );

    const anthropicOutbound = await anthropicMapper.fromChat(chatFromResponses as any, {
      requestId: 'req-blackbox-chat-to-anthropic',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    expect((anthropicOutbound as any).payload?.tool_choice).toEqual({ type: 'tool', name: 'exec_command' });
    expect((anthropicOutbound as any).payload?.tools?.[0]?.name).toBe('exec_command');
    expect((anthropicOutbound as any).payload?.tools?.[0]?.input_schema?.type).toBe('object');

    const chatFromAnthropic = await anthropicMapper.toChat(
      {
        protocol: 'anthropic-messages',
        direction: 'request',
        payload: (anthropicOutbound as any).payload
      } as any,
      {
        requestId: 'req-blackbox-anthropic-to-chat',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as AdapterContext
    );

    const responsesRoundtrip = await responsesMapper.fromChat(
      chatFromAnthropic as any,
      createResponsesContext('req-blackbox-chat-to-responses')
    );

    expect((responsesRoundtrip as any).payload?.tools?.[0]?.type).toBe('function');
    expect((responsesRoundtrip as any).payload?.tools?.[0]?.name).toBe('exec_command');
    expect((responsesRoundtrip as any).payload?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'exec_command' }
    });
  });

  it('records anthropic dropped/lossy audit for non-equivalent responses fields', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const ctx = createResponsesContext('req-resp-anthropic-audit-matrix');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-101',
          response_format: { type: 'json_object' },
          parallel_tool_calls: true,
          service_tier: 'default',
          truncation: 'disabled',
          include: ['output_text'],
          store: true,
          reasoning: { effort: 'medium' }
        }
      } as any,
      ctx
    );

    const outbound = await anthropicMapper.fromChat(chat, {
      requestId: 'req-resp-anthropic-out-audit-matrix',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.response_format).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.service_tier).toBeUndefined();
    expect(payload.truncation).toBeUndefined();
    expect(payload.include).toBeUndefined();
    expect(payload.store).toBeUndefined();
    expect(payload.thinking).toBeDefined();

    const audit = readProtocolMappingAudit(chat as any);
    expect(audit).toBeDefined();
    const dropped = extractFieldSet(audit?.dropped);
    for (const field of [
      'prompt_cache_key',
      'parallel_tool_calls',
      'service_tier',
      'truncation',
      'include',
      'store'
    ]) {
      expect(dropped.has(field)).toBe(true);
    }
    const unsupported = extractFieldSet(audit?.unsupported);
    expect(unsupported.has('response_format')).toBe(true);

    const lossy = extractFieldSet(audit?.lossy);
    expect(lossy.has('reasoning')).toBe(true);
  });

  it('records gemini dropped/lossy audit for non-equivalent responses fields', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const ctx = createResponsesContext('req-resp-gemini-audit-matrix');

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-202',
          response_format: { type: 'json_object' },
          parallel_tool_calls: true,
          service_tier: 'default',
          truncation: 'disabled',
          include: ['output_text'],
          store: true,
          reasoning: { effort: 'high' }
        }
      } as any,
      ctx
    );

    const outbound = await geminiMapper.fromChat(chat, {
      requestId: 'req-resp-gemini-out-audit-matrix',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini'
    } as AdapterContext);

    const payload = outbound.payload as any;
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.response_format).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.service_tier).toBeUndefined();
    expect(payload.truncation).toBeUndefined();
    expect(payload.include).toBeUndefined();
    expect(payload.store).toBeUndefined();
    expect(payload.generationConfig?.thinkingConfig).toBeDefined();

    const audit = readProtocolMappingAudit(chat as any);
    expect(audit).toBeDefined();
    const dropped = extractFieldSet(audit?.dropped);
    for (const field of [
      'prompt_cache_key',
      'parallel_tool_calls',
      'service_tier',
      'truncation',
      'include',
      'store'
    ]) {
      expect(dropped.has(field)).toBe(true);
    }
    const unsupported = extractFieldSet(audit?.unsupported);
    expect(unsupported.has('response_format')).toBe(true);

    const lossy = extractFieldSet(audit?.lossy);
    expect(lossy.has('reasoning')).toBe(true);
  });

  it.each([
    { entryEndpoint: '/v1/chat/completions', providerProtocol: 'openai-chat', mapperType: 'chat' },
    { entryEndpoint: '/v1/messages', providerProtocol: 'anthropic-messages', mapperType: 'anthropic' },
    { entryEndpoint: '/v1/chat/completions', providerProtocol: 'gemini-chat', mapperType: 'gemini' },
    { entryEndpoint: '/v1/responses', providerProtocol: 'openai-responses', mapperType: 'responses' }
  ] as const)(
    'req matrix keeps non-empty tools for tool_choice=auto|required ($providerProtocol)',
    async ({ entryEndpoint, providerProtocol, mapperType }) => {
      const responsesMapper = new ResponsesSemanticMapper();
      for (const toolChoice of ['auto', 'required'] as const) {
        const chat = await responsesMapper.toChat(
          {
            protocol: 'openai-responses',
            direction: 'request',
            payload: buildResponsesToolsPayload(toolChoice)
          } as any,
          createResponsesContext(`req-matrix-${providerProtocol}-${toolChoice}`)
        );

        const context: AdapterContext = {
          requestId: `req-matrix-out-${providerProtocol}-${toolChoice}`,
          entryEndpoint,
          providerProtocol
        } as AdapterContext;

        const mapper =
          mapperType === 'chat'
            ? new ChatSemanticMapper()
            : mapperType === 'anthropic'
              ? new AnthropicSemanticMapper()
              : mapperType === 'gemini'
                ? new GeminiSemanticMapper()
                : new ResponsesSemanticMapper();

        const outbound = await mapper.fromChat(chat, context);
        const payload: any = outbound.payload;
        const toolNames = pickToolNames(payload);
        expect(toolNames).toContain('exec_command');
      }
    }
  );

  it.each([
    { entryEndpoint: '/v1/chat/completions', providerProtocol: 'openai-chat', mapperType: 'chat' },
    { entryEndpoint: '/v1/messages', providerProtocol: 'anthropic-messages', mapperType: 'anthropic' },
    { entryEndpoint: '/v1/chat/completions', providerProtocol: 'gemini-chat', mapperType: 'gemini' },
    { entryEndpoint: '/v1/responses', providerProtocol: 'openai-responses', mapperType: 'responses' }
  ] as const)(
    'req matrix keeps explicit no-tools state without fabricating tools ($providerProtocol)',
    async ({ entryEndpoint, providerProtocol, mapperType }) => {
      const responsesMapper = new ResponsesSemanticMapper();
      const chat = await responsesMapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: {
            model: 'gpt-5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'plain text only' }] }],
            tool_choice: 'none',
            tools: []
          }
        } as any,
        createResponsesContext(`req-matrix-no-tools-${providerProtocol}`)
      );

      const context: AdapterContext = {
        requestId: `req-matrix-no-tools-out-${providerProtocol}`,
        entryEndpoint,
        providerProtocol
      } as AdapterContext;

      const mapper =
        mapperType === 'chat'
          ? new ChatSemanticMapper()
          : mapperType === 'anthropic'
            ? new AnthropicSemanticMapper()
            : mapperType === 'gemini'
              ? new GeminiSemanticMapper()
              : new ResponsesSemanticMapper();

      const outbound = await mapper.fromChat(chat, context);
      const payload: any = outbound.payload;
      const toolNames = pickToolNames(payload);
      expect(toolNames).toHaveLength(0);
    }
  );

  it('req matrix keeps submit_tool_outputs / function_call_output continuity in responses path', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const payload = {
      model: 'gpt-5',
      previous_response_id: 'resp_prev_001',
      input: [
        {
          type: 'function_call',
          call_id: 'call_submit_001',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_submit_001',
          output: '{"ok":true}'
        }
      ]
    };

    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload
      } as any,
      createResponsesContext('req-matrix-submit-tool-outputs')
    );

    const outbound = await responsesMapper.fromChat(
      chat,
      createResponsesContext('req-matrix-submit-tool-outputs-out')
    );

    const roundtripInput = Array.isArray((outbound.payload as any)?.input) ? (outbound.payload as any).input : [];
    const functionCallOutput = roundtripInput.find((entry: any) => entry?.type === 'function_call_output');
    expect(functionCallOutput).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_submit_001'
    });
  });

  it.each([
    { providerProtocol: 'openai-chat', entryEndpoint: '/v1/responses' },
    { providerProtocol: 'openai-chat', entryEndpoint: '/v1/chat/completions' }
  ] as const)(
    'resp matrix keeps tool-call surface for $providerProtocol -> $entryEndpoint',
    async ({ providerProtocol, entryEndpoint }) => {
      const requestId = `resp-matrix-${entryEndpoint}`;
      const chatToolCallResponse = {
        id: 'chatcmpl_resp_matrix_toolcall',
        object: 'chat.completion',
        created: 1715932800,
        model: 'MiniMax-M2.7',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1234567890',
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
      };

      if (entryEndpoint === '/v1/responses') {
        seedResponsesConversationRequest({
          requestId,
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                parameters: { type: 'object' }
              }
            }
          ]
        });
      }

      const converted = await convertProviderResponse({
        providerProtocol,
        providerResponse: chatToolCallResponse as any,
        context: {
          requestId,
          entryEndpoint,
          providerProtocol
        } as AdapterContext,
        entryEndpoint,
        wantsStream: false
      });

      if (entryEndpoint === '/v1/responses') {
        expect((converted.body as any)?.status).toBe('requires_action');
        expect((converted.body as any)?.output?.[0]?.type).toBe('function_call');
        expect((converted.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0]).toMatchObject({
          id: 'call_1234567890',
          tool_call_id: 'call_1234567890',
          name: 'exec_command'
        });
      } else {
        expect((converted.body as any)?.choices?.[0]?.finish_reason).toBe('tool_calls');
        expect((converted.body as any)?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
      }
      clearResponsesConversationByRequestId(requestId);
    }
  );

  it('resp matrix keeps SSE completed semantics equivalent to JSON final for tool_calls', async () => {
    seedResponsesConversationRequest({
      requestId: 'resp-matrix-sse-equivalence',
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object' }
          }
        }
      ]
    });
    seedResponsesConversationRequest({
      requestId: 'resp-matrix-sse-equivalence-stream',
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object' }
          }
        }
      ]
    });
    const chatToolCallResponse = {
      id: 'chatcmpl_resp_matrix_sse_toolcall',
      object: 'chat.completion',
      created: 1715932800,
      model: 'MiniMax-M2.7',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_sse_1',
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
    };

    const context = {
      requestId: 'resp-matrix-sse-equivalence',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    } as AdapterContext;

    const jsonResult = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: chatToolCallResponse as any,
      context,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    const sseResult = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: chatToolCallResponse as any,
      context: { ...context, requestId: 'resp-matrix-sse-equivalence-stream' },
      entryEndpoint: '/v1/responses',
      wantsStream: true
    });

    expect((jsonResult.body as any)?.status).toBe('requires_action');
    expect((sseResult.body as any)?.status).toBe('requires_action');
    expect((sseResult.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0]?.name).toBe('exec_command');
    expect((jsonResult.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0]?.name).toBe('exec_command');

    const streamPayload = await collectStream((sseResult as any).__sse_responses);
    expect(streamPayload).toContain('response.completed');
    expect(streamPayload).toContain('requires_action');
    clearResponsesConversationByRequestId('resp-matrix-sse-equivalence');
    clearResponsesConversationByRequestId('resp-matrix-sse-equivalence-stream');
  });

  it('blackbox resp matrix: anthropic tool_use -> chat -> responses keeps submit_tool_outputs surface', async () => {
    seedResponsesConversationRequest({
      requestId: 'resp-blackbox-anthropic-to-responses',
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object' }
          }
        }
      ]
    });
    const anthropicResponse = {
      id: 'msg_blackbox_resp_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_blackbox_1',
          name: 'exec_command',
          input: { cmd: 'pwd' }
        }
      ],
      stop_reason: 'tool_use'
    };

    const converted = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: anthropicResponse as any,
      context: {
        requestId: 'resp-blackbox-anthropic-to-responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      } as AdapterContext,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect((converted.body as any)?.status).toBe('requires_action');
    expect((converted.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0]).toMatchObject({
      id: 'fc_toolu_blackbox_1',
      tool_call_id: 'fc_toolu_blackbox_1',
      name: 'exec_command'
    });
    expect((converted.body as any)?.output?.[0]?.type).toBe('function_call');
    clearResponsesConversationByRequestId('resp-blackbox-anthropic-to-responses');
  });

  it('errorsample matrix: responses_empty_output fixture keeps tool contract and captures empty-output response shape', async () => {
    const reqDoc = readFixtureJson('2026-05-17-responses-empty-output', 'provider-request.json');
    const respDoc = readFixtureJson('2026-05-17-responses-empty-output', 'provider-response.json');
    const reqBody = (reqDoc?.body ?? reqDoc) as Record<string, any>;
    const reqTools = Array.isArray(reqBody?.tools) ? reqBody.tools : [];
    expect(reqTools.length).toBeGreaterThan(0);
    expect(reqBody?.tool_choice).toBeDefined();

    const probe = (respDoc?.body?.__routecodex_stream_contract_probe_body ?? {}) as Record<string, any>;
    expect(probe?.status).toBe('completed');
    expect(Array.isArray(probe?.output)).toBe(true);
    expect((probe?.output ?? []).length).toBe(0);
  });

  it('errorsample matrix: provider_request_empty_messages fixture preserves empty messages signal', async () => {
    const reqDoc = readFixtureJson('2026-05-17-provider-request-empty-messages', 'errorsample.json');
    const payload = reqDoc?.observation?.providerPayload?.data as Record<string, any>;
    expect(Array.isArray(payload?.messages)).toBe(true);
    expect(payload.messages.length).toBe(0);
    expect(reqDoc?.marker).toBe('provider_request_empty_messages');
  });
});

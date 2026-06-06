import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { bootstrapVirtualRouterConfig, clearAllResponsesConversationState, getHubPipelineCtor, resetResponsesConversationStateForRestartSimulation } from '../../../src/modules/llmswitch/bridge.js';

type HubPipelineCtor = new (config: any) => {
  execute: (request: any) => Promise<any>;
  dispose?: () => void;
};

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function findDanglingAnthropicToolUse(payload: unknown): string | null {
  const messages = (payload as any)?.messages;
  if (!Array.isArray(messages)) return null;
  const resultIds = new Set<string>();
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultIds.add(block.tool_use_id);
      }
    }
  }
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && !resultIds.has(block.id)) {
        return block.id;
      }
    }
  }
  return null;
}

function findMixedAnthropicToolResultAndText(payload: unknown): string | null {
  const messages = (payload as any)?.messages;
  if (!Array.isArray(messages)) return null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = Array.isArray(message?.content) ? message.content : [];
    const hasToolResult = content.some((block) => block?.type === 'tool_result');
    const hasText = content.some((block) => block?.type === 'text');
    if (hasToolResult && hasText) return `mixed_tool_result_text_at_${index}`;
  }
  return null;
}

function findOpenAiChatToolOrderingViolation(payload: unknown): string | null {
  const messages = (payload as any)?.messages;
  if (!Array.isArray(messages)) return null;
  const pending = new Set<string>();
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (pending.size > 0) return 'assistant_tool_calls_before_previous_results';
      for (const toolCall of message.tool_calls) {
        if (typeof toolCall?.id === 'string') pending.add(toolCall.id);
      }
      continue;
    }
    if (message?.role === 'tool') {
      const id = message.tool_call_id;
      if (typeof id !== 'string' || !pending.has(id)) return 'orphan_tool_result';
      pending.delete(id);
      continue;
    }
    if (pending.size > 0) return 'non_tool_message_before_tool_results';
  }
  return null;
}

describe('responses HTTP Anthropic tool history blackbox', () => {
  it('rejects unknown previous_response_id tool outputs before provider send', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'openai',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'openai-compatible',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        search: [{ id: 'search-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let providerSendCount = 0;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_unknown_previous_tool_output',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'search',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          providerSendCount += 1;
          return {
            status: 500,
            headers: {},
            body: { error: { message: 'provider should not be reached', providerPayload: result.providerPayload } }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          previous_response_id: 'resp_unknown_previous',
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_function_snr978zyv21w_1',
              output: '/Users/fanzhang/Documents/github/routecodex'
            }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain('Responses conversation expired or not found');
      expect(providerSendCount).toBe(0);
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
      clearAllResponsesConversationState();
    }
  });

  it('rejects mismatched resumed tool output ids before provider send', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'openai',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'openai-compatible',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        search: [{ id: 'search-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let providerSendCount = 0;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: `req_http_mismatched_resumed_tool_output_${providerSendCount}`,
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'search',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          providerSendCount += 1;
          if (providerSendCount === 1) {
            return {
              status: 200,
              headers: {},
              body: {
                id: 'resp_mismatched_resume_1',
                object: 'response',
                status: 'completed',
                model: 'MiniMax-M3',
                output: [{ type: 'function_call', call_id: 'call_expected', name: 'exec_command', arguments: '{"cmd":"pwd"}' }],
                finish_reason: 'tool_calls'
              }
            };
          }
          return {
            status: 400,
            headers: {},
            body: { error: { message: 'tool result tool id not found (2013)', providerPayload: result.providerPayload } }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] }],
          tools: [{ name: 'exec_command', description: 'run command', input_schema: { type: 'object' } }]
        })
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          previous_response_id: 'resp_mismatched_resume_1',
          input: [{ type: 'function_call_output', call_id: 'call_function_snr978zyv21w_1', output: 'cwd' }]
        })
      });
      const text = await second.text();

      expect(second.status).toBe(400);
      expect(text).toContain('orphan_tool_result');
      expect(text).toContain('call_function_snr978zyv21w_1');
      expect(providerSendCount).toBe(1);
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
      clearAllResponsesConversationState();
    }
  });

  it('persists pending Responses tool call ids across store reset before previous_response_id resume', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-responses-store-'));
    const previousStorePath = process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE;
    process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = path.join(persistDir, 'responses-store.json');
    clearAllResponsesConversationState();

    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'openai',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'openai-compatible',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let callCount = 0;
    let secondProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: `req_http_persisted_resume_${callCount}`,
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          callCount += 1;
          if (callCount === 1) {
            return {
              status: 200,
              headers: {},
              metadata: result.metadata,
              usageLogInfo: { providerKey: 'minimax.key1.MiniMax-M3', timingRequestIds: ['req_http_persisted_resume_0'] },
              body: {
                id: 'resp_persisted_resume_1',
                object: 'response',
                status: 'completed',
                model: 'MiniMax-M3',
                output: [{ type: 'function_call', call_id: 'call_function_snr978zyv21w_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }],
                finish_reason: 'tool_calls'
              }
            };
          }
          secondProviderPayload = result.providerPayload;
          const orderingViolation = findOpenAiChatToolOrderingViolation(result.providerPayload);
          return {
            status: orderingViolation ? 400 : 200,
            headers: {},
            body: orderingViolation
              ? { error: { message: 'tool id not found', orderingViolation } }
              : {
                id: 'resp_persisted_resume_2',
                object: 'response',
                status: 'completed',
                model: 'MiniMax-M3',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
              }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] }],
          tools: [{ name: 'exec_command', description: 'run command', input_schema: { type: 'object' } }]
        })
      });
      expect(first.status).toBe(200);
      expect(fs.existsSync(process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE!)).toBe(true);
      await resetResponsesConversationStateForRestartSimulation();

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          previous_response_id: 'resp_persisted_resume_1',
          input: [{ type: 'function_call_output', call_id: 'call_function_snr978zyv21w_1', output: '/Users/fanzhang/Documents/github/routecodex' }]
        })
      });
      const text = await second.text();

      expect(second.status).toBe(200);
      expect(text).toContain('resp_persisted_resume_2');
      const providerMessages = (secondProviderPayload as any)?.messages;
      expect(providerMessages?.[1]?.role).toBe('assistant');
      expect(providerMessages?.[1]?.tool_calls?.[0]?.id).toBe('call_function_snr978zyv21w_1');
      expect(providerMessages?.[2]?.role).toBe('tool');
      expect(providerMessages?.[2]?.tool_call_id).toBe('call_function_snr978zyv21w_1');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
      clearAllResponsesConversationState();
      if (previousStorePath === undefined) {
        delete process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE;
      } else {
        process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = previousStorePath;
      }
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });

  it('preserves paired Responses function_call_output through the Anthropic provider payload', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'anthropic:claude-code',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_anthropic_paired_tool_history',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: true,
              inboundStream: true,
              outboundStream: true,
            }
          });
          capturedProviderPayload = result.providerPayload;
          const danglingId = findDanglingAnthropicToolUse(result.providerPayload);
          if (danglingId) {
            return {
              status: 400,
              headers: {},
              body: {
                error: {
                  message: 'invalid params, tool call result does not follow tool call (2013)',
                  type: 'invalid_request_error',
                  code: 'HTTP_400',
                  danglingId
                }
              }
            };
          }
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_http_anthropic_paired_tool_history',
              object: 'response',
              status: 'completed',
              model: 'MiniMax-M3',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
            }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
            { type: 'function_call', name: 'exec_command', call_id: 'call_first', arguments: '{"cmd":"pwd"}' },
            { type: 'function_call', name: 'exec_command', call_id: 'call_second', arguments: '{"cmd":"whoami"}' },
            { type: 'function_call_output', call_id: 'call_first', output: 'first ok' },
            { type: 'function_call_output', call_id: 'call_second', output: 'second ok' },
            { role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
          ],
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_paired_tool_history');
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      expect(findMixedAnthropicToolResultAndText(capturedProviderPayload)).toBeNull();
      expect(serializedProviderPayload).not.toContain('data:image/');
      expect(serializedProviderPayload).toContain('call_second');
      expect(serializedProviderPayload).toContain('second ok');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('preserves paired Responses custom_tool_call_output through the Anthropic provider payload', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'anthropic:claude-code',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_anthropic_paired_custom_tool_history',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: true,
              inboundStream: true,
              outboundStream: true,
            }
          });
          capturedProviderPayload = result.providerPayload;
          const danglingId = findDanglingAnthropicToolUse(result.providerPayload);
          if (danglingId) {
            return {
              status: 400,
              headers: {},
              body: {
                error: {
                  message: 'invalid params, tool call result does not follow tool call (2013)',
                  type: 'invalid_request_error',
                  code: 'HTTP_400',
                  danglingId
                }
              }
            };
          }
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_http_anthropic_paired_custom_tool_history',
              object: 'response',
              status: 'completed',
              model: 'MiniMax-M3',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
            }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const patch = '*** Begin Patch\n*** Add File: apply_patch_test/01-add.txt\n+hello\n*** End Patch';
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
            { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_1', input: patch },
            { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA apply_patch_test/01-add.txt\n' },
            { role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
          ],
          tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch.' }]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_paired_custom_tool_history');
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(serializedProviderPayload).toContain('call_patch_1');
      expect(serializedProviderPayload).toContain('apply_patch');
      expect(serializedProviderPayload).toContain('Success. Updated the following files');
      expect(serializedProviderPayload).toContain('apply_patch_test/01-add.txt');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('does not forward client MCP tools into Anthropic provider tools', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'anthropic:claude-code',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_client_mcp_tool_filter',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          capturedProviderPayload = result.providerPayload;
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_http_client_mcp_tool_filter',
              object: 'response',
              status: 'completed',
              model: 'MiniMax-M3',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
            }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          tools: [
            {
              type: 'function',
              name: 'mcp__node_repl',
              description: 'client-side MCP tool',
              tools: [{ name: 'js', description: 'Run JavaScript' }]
            }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_client_mcp_tool_filter');
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(serializedProviderPayload).not.toContain('mcp__node_repl');
      expect((capturedProviderPayload as any)?.tools).toBeUndefined();
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('does not forward namespace MCP aggregator tools into Anthropic provider tools', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'anthropic:claude-code',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_namespace_mcp_tool_filter',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          capturedProviderPayload = result.providerPayload;
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_http_namespace_mcp_tool_filter',
              object: 'response',
              status: 'completed',
              model: 'MiniMax-M3',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
            }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          tools: [
            {
              name: 'exec_command',
              description: 'Runs a command in a PTY, returning output.',
              input_schema: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            },
            {
              name: 'mcp__node_repl',
              description: 'Tools in the mcp__node_repl namespace.',
              input_schema: {}
            }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_namespace_mcp_tool_filter');
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(serializedProviderPayload).toContain('exec_command');
      expect(serializedProviderPayload).not.toContain('mcp__node_repl');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('normalizes OpenAI chat tool history before MiniMax-style provider validation', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'openai',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'openai-compatible',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_openai_chat_tool_ordering',
            endpoint: '/v1/responses',
            payload: input.body,
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'thinking',
              stream: false,
              inboundStream: false,
              outboundStream: false,
            }
          });
          capturedProviderPayload = result.providerPayload;
          const orderingViolation = findOpenAiChatToolOrderingViolation(result.providerPayload);
          if (orderingViolation) {
            return {
              status: 400,
              headers: {},
              body: {
                error: {
                  message: 'invalid params, tool call result does not follow tool call (2013)',
                  type: 'invalid_request_error',
                  code: 'HTTP_400',
                  orderingViolation
                }
              }
            };
          }
          return {
            status: 200,
            headers: {},
            body: {
              id: 'resp_http_openai_chat_tool_ordering',
              object: 'response',
              status: 'completed',
              model: 'MiniMax-M3',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
            }
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start' }] },
            { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
            { type: 'function_call', call_id: 'call_b', name: 'exec_command', arguments: '{"cmd":"ls"}' },
            { type: 'function_call_output', call_id: 'call_a', output: 'cwd' },
            { type: 'function_call_output', call_id: 'call_b', output: 'files' }
          ],
          tools: [
            {
              name: 'exec_command',
              description: 'Runs a command in a PTY, returning output.',
              input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
            },
            {
              name: 'mcp__node_repl',
              description: 'Tools in the mcp__node_repl namespace.',
              input_schema: {}
            }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_openai_chat_tool_ordering');
      const providerMessages = (capturedProviderPayload as any)?.messages;
      expect(JSON.stringify(capturedProviderPayload)).toContain('call_a');
      expect(providerMessages?.[1]?.role).toBe('assistant');
      expect(providerMessages?.[1]?.tool_calls).toHaveLength(2);
      expect(providerMessages?.[2]?.role).toBe('tool');
      expect(providerMessages?.[3]?.role).toBe('tool');
      expect(JSON.stringify(capturedProviderPayload)).not.toContain('mcp__node_repl');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });
});

import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/helpers/virtual-router-bootstrap-direct-native.js';
import {
  clearAllResponsesConversationState,
  resetResponsesConversationStateForRestartSimulation
} from '../../../src/modules/llmswitch/bridge/runtime-integrations.js';
import {
  buildMetadataCenterTransportSnapshot,
  writeMetadataCenterSlot
} from '../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';
import { DirectNativeHubPipelineTestWrapper as HubPipeline } from '../../sharedmodule/helpers/hub-pipeline-handle-direct-native.js';

const TEST_RUNTIME_CONTROL_WRITER = {
  module: 'tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts',
  symbol: 'buildNativeResponsesRequest',
  stage: 'test_native_responses_request'
} as const;

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

function findAnthropicToolOrderingViolation(payload: unknown): string | null {
  const messages = (payload as any)?.messages;
  if (!Array.isArray(messages)) return null;
  const pending = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const content = Array.isArray(message?.content) ? message.content : [];
    if (message?.role === 'assistant') {
      const toolUseIds = content
        .filter((block) => block?.type === 'tool_use' && typeof block.id === 'string')
        .map((block) => String(block.id));
      if (toolUseIds.length > 0) {
        if (pending.size > 0) {
          return `assistant_tool_use_before_previous_results_at_${index}`;
        }
        for (const id of toolUseIds) pending.add(id);
      } else if (pending.size > 0) {
        return `assistant_text_before_tool_results_at_${index}`;
      }
      continue;
    }
    if (message?.role === 'user') {
      const resultIds = content
        .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
        .map((block) => String(block.tool_use_id));
      const hasNonResultContent = content.some((block) => block?.type !== 'tool_result');
      if (pending.size > 0) {
        if (resultIds.length === 0) {
          return `non_tool_result_user_content_before_tool_results_at_${index}`;
        }
        for (const id of resultIds) {
          if (!pending.has(id)) return `orphan_tool_result_at_${index}`;
          pending.delete(id);
        }
        if (hasNonResultContent && pending.size > 0) {
          return `mixed_user_content_before_all_tool_results_at_${index}`;
        }
      }
      continue;
    }
    if (pending.size > 0) {
      return `non_tool_message_before_tool_results_at_${index}`;
    }
  }
  return pending.size > 0 ? 'dangling_tool_use_at_end' : null;
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

function buildNativeResponsesRequest(request: {
  id: string;
  payload: unknown;
  metadata: Record<string, unknown>;
  routeHint: string;
  stream: boolean;
}): Record<string, unknown> {
  const sessionId = typeof request.metadata.sessionId === 'string' && request.metadata.sessionId.trim()
    ? request.metadata.sessionId.trim()
    : `sess_${request.id}`;
  const runtimeControl = {
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    routeHint: request.routeHint
  };
  Object.assign(request.metadata, {
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    routeHint: request.routeHint,
    sessionId,
    stream: request.stream,
    inboundStream: request.stream,
    outboundStream: request.stream,
  });
  for (const [key, value] of Object.entries(runtimeControl)) {
    writeMetadataCenterSlot({
      target: request.metadata,
      family: 'runtime_control',
      key,
      value,
      writer: TEST_RUNTIME_CONTROL_WRITER,
      reason: 'test native responses runtime control'
    });
  }
  const metadataCenterSnapshot = buildMetadataCenterTransportSnapshot(request.metadata);
  return {
    requestId: request.id,
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: request.payload,
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    metadata: request.metadata,
    metadataCenterSnapshot
  };
}

function buildResponseSseStream(id: string, model = 'MiniMax-M3'): Readable {
  return Readable.from([
    'event: response.completed\n',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      }
    })}\n\n`,
    'event: response.done\n',
    `data: ${JSON.stringify({
      type: 'response.done',
      response: { id, object: 'response', status: 'completed' }
    })}\n\n`
  ]);
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
          models: { 'MiniMax-M3': { capabilities: ['text', 'custom_tool'] } }
        }
      },
      routing: {
        search: [{ id: 'search-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_unknown_previous_tool_output',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'search',
            stream: false
          }));
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: `req_http_mismatched_resumed_tool_output_${providerSendCount}`,
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'search',
            stream: false
          }));
          providerSendCount += 1;
          if (providerSendCount === 1) {
            return {
              status: 200,
              headers: {},
              metadata: result.metadata,
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
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'resume the tool result check' }] },
            { type: 'function_call_output', call_id: 'call_function_snr978zyv21w_1', output: 'cwd' }
          ]
        })
      });
      const text = await second.text();

      expect(second.status).toBe(400);
      expect(text).toContain('MALFORMED_REQUEST');
      expect(text).toContain('call_function_snr978zyv21w_1');
      expect(text).toContain('does not match any pending function_call');
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
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }],
        coding: [{ id: 'coding-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: `req_http_persisted_resume_${callCount}`,
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'resume persisted tool result' }] },
            { type: 'function_call_output', call_id: 'call_function_snr978zyv21w_1', output: '/Users/fanzhang/Documents/github/routecodex' }
          ]
        })
      });
      const text = await second.text();

      expect(second.status).toBe(200);
      expect(text).toContain('resp_persisted_resume_2');
      expect(secondProviderPayload).toBeTruthy();
      expect(text).not.toContain('expired_or_unknown_response_id');
      expect(text).not.toContain('tool id not found');
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
          type: 'responses',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'openai-compatible',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }],
        coding: [{ id: 'coding-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_paired_tool_history',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: true
          }));
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
            metadata: { outboundStream: true, stream: true },
            sseStream: buildResponseSseStream('resp_http_anthropic_paired_tool_history')
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

  it('does not corrupt plain-text tool results that merely mention image_url/video_url in a new session', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'responses',
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
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_plain_text_tool_result_mentions_media_keys',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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
              id: 'resp_http_anthropic_plain_text_tool_result_mentions_media_keys',
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
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Skill already has rich content. Let me inspect the file.' }] },
            { type: 'function_call', call_id: 'call_docs_1', name: 'exec_command', arguments: '{"cmd":"cat .agents/skills/rcc-dev-skills/SKILL.md | head -5"}' },
            { type: 'function_call_output', call_id: 'call_docs_1', output: 'documentation mentioning "image_url" and "video_url" should stay plain text' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continue with note review.' }] },
            { type: 'function_call', call_id: 'call_docs_2', name: 'exec_command', arguments: '{"cmd":"cat note.md | head -5"}' },
            { type: 'function_call_output', call_id: 'call_docs_2', output: 'note head ok' }
          ],
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_plain_text_tool_result_mentions_media_keys');
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(serializedProviderPayload).toContain('call_docs_1');
      expect(serializedProviderPayload).toContain('documentation mentioning \\"image_url\\" and \\"video_url\\" should stay plain text');
      expect(serializedProviderPayload).not.toContain('[Image omitted]');
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
          type: 'responses',
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_paired_custom_tool_history',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: true
          }));
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
            metadata: { outboundStream: true, stream: true },
            sseStream: buildResponseSseStream('resp_http_anthropic_paired_custom_tool_history')
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

  it('RED: preserves reopened apply_patch tool history after prior assistant text and multiple tool turns', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'responses',
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
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_reopened_apply_patch_history',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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
              id: 'resp_http_anthropic_reopened_apply_patch_history',
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
      const firstPatch = '*** Begin Patch\n*** Add File: apply_patch_test/01-add.txt\n+hello\n*** End Patch';
      const secondPatch = '*** Begin Patch\n*** Update File: apply_patch_test/01-add.txt\n@@\n-hello\n+hello world\n*** End Patch';
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先检查当前补丁状态。' }] },
            { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_1', input: firstPatch },
            { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA apply_patch_test/01-add.txt\n' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续核对并追加修改。' }] },
            { type: 'function_call', call_id: 'call_exec_1', name: 'exec_command', arguments: '{"cmd":"cat apply_patch_test/01-add.txt"}' },
            { type: 'function_call_output', call_id: 'call_exec_1', output: 'hello\n' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '准备第二次 apply_patch。' }] },
            { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_2', input: secondPatch },
            { type: 'custom_tool_call_output', call_id: 'call_patch_2', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM apply_patch_test/01-add.txt\n' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成，继续下一步。' }] }
          ],
          tools: [
            { type: 'custom', name: 'apply_patch', description: 'Apply a patch.' },
            { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_reopened_apply_patch_history');
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      expect(findAnthropicToolOrderingViolation(capturedProviderPayload)).toBeNull();
      const serializedProviderPayload = JSON.stringify(capturedProviderPayload);
      expect(serializedProviderPayload).toContain('call_patch_1');
      expect(serializedProviderPayload).toContain('call_exec_1');
      expect(serializedProviderPayload).toContain('call_patch_2');
      expect(serializedProviderPayload).toContain('apply_patch_test/01-add.txt');
      expect(serializedProviderPayload).toContain('hello world');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('does not replace pending Anthropic tool_result turns with plain user placeholder text', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'compat:passthrough',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_placeholder_tool_result_history',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: true
          }));
          capturedProviderPayload = result.providerPayload;
          const orderingViolation = findAnthropicToolOrderingViolation(result.providerPayload);
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
            metadata: { outboundStream: true, stream: true },
            sseStream: buildResponseSseStream('resp_http_anthropic_placeholder_tool_result_history')
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const hugeToolOutput = [
        'Chunk ID: 43a0cd',
        'Wall time: 0.0000 seconds',
        'Process exited with code 0',
        'Original token count: 8993',
        'Output:',
        '---',
        'name: rcc-dev-skills',
        'description: RouteCodex/llmswitch-core',
        'Total output lines: 624',
        '[Image omitted]'
      ].join('\n');

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
            { role: 'user', content: [{ type: 'input_text', text: '整理 rcc-dev-skills' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: '继续读取上下文' }] },
            { type: 'function_call', name: 'exec_command', call_id: 'call_list_sizes', arguments: '{"cmd":"wc -l note.md CACHE.md MEMORY.md"}' },
            { type: 'function_call_output', call_id: 'call_list_sizes', output: '624 note.md\n109 CACHE.md\n3188 MEMORY.md' },
            { type: 'function_call', name: 'exec_command', call_id: 'call_paths', arguments: '{"cmd":"find .agents -maxdepth 2 -type f"}' },
            { type: 'function_call_output', call_id: 'call_paths', output: '.agents/skills/rcc-dev-skills/SKILL.md' },
            { type: 'function_call', name: 'exec_command', call_id: 'call_skill_dump', arguments: '{"cmd":"sed -n 1,260p .agents/skills/rcc-dev-skills/SKILL.md"}' },
            { type: 'function_call_output', call_id: 'call_skill_dump', output: hugeToolOutput }
          ],
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_placeholder_tool_result_history');
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      expect(findMixedAnthropicToolResultAndText(capturedProviderPayload)).toBeNull();
      expect(findAnthropicToolOrderingViolation(capturedProviderPayload)).toBeNull();
      expect(JSON.stringify(capturedProviderPayload)).toContain('call_skill_dump');
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });

  it('keeps HTML exec_command tool_result adjacent before later stopless continuation turns', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        minimax: {
          id: 'minimax',
          enabled: true,
          type: 'anthropic',
          baseURL: 'mock://minimax',
          auth: { type: 'apikey', apiKey: 'mock' },
          compatibilityProfile: 'compat:passthrough',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_anthropic_html_exec_tool_result_history',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: true
          }));
          capturedProviderPayload = result.providerPayload;
          const orderingViolation = findAnthropicToolOrderingViolation(result.providerPayload);
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
            metadata: { outboundStream: true, stream: true },
            sseStream: buildResponseSseStream('resp_http_anthropic_html_exec_tool_result_history')
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const htmlToolOutput = [
        'Total output lines: 170',
        '',
        '<!DOCTYPE html><html><head><title>Static Residential Proxies</title></head><body>',
        '<img src="data:image/svg+xml,%3csvg%20xmlns=\'http://www.w3.org/2000/svg\'%3e" />',
        '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" />',
        '<p>gateway.iproyal.com:19123</p>',
        '</body></html>'
      ].join('\n');
      const htmlExecArguments = JSON.stringify({
        cmd: "curl -s 'https://iproyal.com/static-residential-proxies/' 2>/dev/null | head -200",
        yield_time_ms: 10000,
      });
      const stoplessOutput = JSON.stringify({
        ok: true,
        toolName: 'stop_message_auto',
        flowId: 'stop_message_flow',
        summary: 'stopless continuation ready',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        schemaGuidance: {
          requiredFields: ['stopreason', 'reason', 'next_step'],
          stopreasonValues: { finished: 0, blocked: 1, continueNeeded: 2 },
          triggerHint: 'no_schema'
        },
        input: {
          flowId: 'stop_message_flow',
          repeatCount: 2,
          maxRepeats: 3,
          triggerHint: 'no_schema'
        }
      });

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
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我其实想知道，我如何配置和它的连接IPRoyal 的静态 IP' }] },
            { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Thinking** search static proxy details' }] },
            { type: 'function_call', call_id: 'call_html_exec_1', name: 'exec_command', arguments: htmlExecArguments },
            { type: 'function_call_output', call_id: 'call_html_exec_1', output: htmlToolOutput },
            { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Thinking** summarize proxy setup' }] },
            { type: 'function_call', call_id: 'call_stopless_1', name: 'reasoningStop', arguments: '{"stopreason":2,"reason":"continue_needed"}' },
            { type: 'function_call_output', call_id: 'call_stopless_1', output: stoplessOutput },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: '它是用一个特殊的协议做单次请求，请求本身包括鉴权和内容？无状态请求？' }] }
          ],
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_anthropic_html_exec_tool_result_history');
      expect(findDanglingAnthropicToolUse(capturedProviderPayload)).toBeNull();
      expect(findMixedAnthropicToolResultAndText(capturedProviderPayload)).toBeNull();
      expect(findAnthropicToolOrderingViolation(capturedProviderPayload)).toBeNull();
      expect(JSON.stringify(capturedProviderPayload)).toContain('call_html_exec_1');
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
          compatibilityProfile: 'compat:passthrough',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_client_mcp_tool_filter',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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
          compatibilityProfile: 'compat:passthrough',
          models: { 'MiniMax-M3': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking-minimax', targets: ['minimax.MiniMax-M3'] }]
      }
    } as any) as any;
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_namespace_mcp_tool_filter',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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
          const result = await pipeline.execute(buildNativeResponsesRequest({
            id: 'req_http_openai_chat_tool_ordering',
            payload: input.body,
            metadata: input.metadata,
            routeHint: 'thinking',
            stream: false
          }));
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

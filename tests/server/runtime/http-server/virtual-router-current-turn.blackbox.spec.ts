import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponseIfNeeded = jest.fn();

jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-response-converter.js', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-response-converter.ts', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));

const { handleResponses } = await import('../../../../src/server/handlers/responses-handler.js');
const { HubPipeline } = await import('../../../helpers/native-hub-pipeline-test-wrapper.js');

type RouteCapture = {
  routeName?: string;
  providerKey?: string;
  reason?: string;
  standardized?: unknown;
  payload?: Record<string, unknown>;
};

async function withServer(run: (baseUrl: string, captures: RouteCapture[]) => Promise<void>): Promise<void> {
  const captures: RouteCapture[] = [];
  const pipeline = new HubPipeline({
    virtualRouter: {
      routing: {
        thinking: [{ id: 'thinking-primary', priority: 100, mode: 'priority', targets: ['think.key1.think-model'] }],
        coding: [{ id: 'coding-primary', priority: 100, mode: 'priority', targets: ['code.key1.code-model'] }],
        web_search: [{ id: 'web-primary', priority: 100, mode: 'priority', force: true, targets: ['web.key1.web-model'] }],
        tools: [{ id: 'tools-primary', priority: 100, mode: 'priority', targets: ['tools.key1.tools-model'] }],
        default: [{ id: 'default-primary', priority: 100, mode: 'priority', targets: ['default.key1.default-model'] }]
      },
      providers: {
        'think.key1.think-model': {
          providerKey: 'think.key1.think-model',
          providerType: 'openai',
          endpoint: 'https://example.invalid/think',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'think.key1',
          modelId: 'think-model'
        },
        'code.key1.code-model': {
          providerKey: 'code.key1.code-model',
          providerType: 'openai',
          endpoint: 'https://example.invalid/code',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'code.key1',
          modelId: 'code-model'
        },
        'web.key1.web-model': {
          providerKey: 'web.key1.web-model',
          providerType: 'openai',
          endpoint: 'https://example.invalid/web',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'web.key1',
          modelId: 'web-model'
        },
        'tools.key1.tools-model': {
          providerKey: 'tools.key1.tools-model',
          providerType: 'openai',
          endpoint: 'https://example.invalid/tools',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'tools.key1',
          modelId: 'tools-model'
        },
        'default.key1.default-model': {
          providerKey: 'default.key1.default-model',
          providerType: 'openai',
          endpoint: 'https://example.invalid/default',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'default.key1',
          modelId: 'default-model'
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'round-robin' }
    }
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post('/v1/responses', async (req, res) => {
    await handleResponses(req as any, res as any, {
      executePipeline: async (input: any) => {
        const result = await pipeline.execute({
          id: input.requestId,
          endpoint: '/v1/responses',
          payload: input.body,
          metadata: {
            ...input.metadata,
            entryEndpoint: '/v1/responses',
            direction: 'request',
            stage: 'inbound',
            providerProtocol: 'openai-responses',
            stream: false
          }
        });
        captures.push({
          routeName: result.routingDecision?.routeName,
          providerKey: result.target?.providerKey,
          reason: result.routingDecision?.reasoning,
          standardized: result.standardizedRequest,
          payload: result.providerPayload
        });
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            id: 'resp_blackbox_current_turn',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
          }
        };
      },
      errorHandling: null
    });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, captures);
  } finally {
    pipeline.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function postResponses(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('virtual router current-turn HTTP blackbox', () => {
  beforeEach(() => {
    mockConvertProviderResponseIfNeeded.mockReset();
  });

  afterEach(() => {
    mockConvertProviderResponseIfNeeded.mockReset();
  });

  it('does not route to coding or web_search from tool declarations on a fresh user request', async () => {
    await withServer(async (baseUrl, captures) => {
      const response = await postResponses(baseUrl, {
        model: 'gpt-test',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please answer normally.' }] }],
        tools: [
          { type: 'function', function: { name: 'apply_patch', description: 'write files', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'web_search', description: 'search web', parameters: { type: 'object' } } }
        ]
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'completed' });
      expect(captures).toHaveLength(1);
      expect(captures[0]?.routeName).toBe('thinking');
      expect(captures[0]?.providerKey).toBe('think.key1.think-model');
    });
  });

  it('routes coding only from current-turn tool call output after an assistant write tool call', async () => {
    await withServer(async (baseUrl, captures) => {
      const response = await postResponses(baseUrl, {
        model: 'gpt-test',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Patch this file.' }] },
          {
            type: 'message',
            role: 'assistant',
            content: [],
            tool_calls: [{ id: 'call_apply_patch_1', type: 'function', function: { name: 'apply_patch', arguments: '{"patch":"*** Begin Patch"}' } }]
          },
          { type: 'function_call_output', call_id: 'call_apply_patch_1', output: 'ok' }
        ],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'completed' });
      expect(captures).toHaveLength(1);
      expect(captures[0]?.routeName).toBe('coding');
      expect(captures[0]?.providerKey).toBe('code.key1.code-model');
    });
  });
});

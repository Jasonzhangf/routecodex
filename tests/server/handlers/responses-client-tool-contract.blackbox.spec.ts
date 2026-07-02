import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { projectResponsesClientPayloadForClientWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import { ResponsesJsonToSseConverterRefactored } from '../../../sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.js';

describe('HTTP Responses client tool contract', () => {
  async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
    const app = express();
    app.get('/responses', async (req, res) => {
      const mode = String(req.query.mode ?? 'pending');
      const rawPayload = mode === 'resolved'
        ? {
            id: 'resp_tool_resolved',
            object: 'response',
            created_at: 1781149537,
            status: 'completed',
            model: 'gpt-5.5',
            tool_outputs: [
              { tool_call_id: 'call_exec_1', output: '/Users/fanzhang/Documents/github/routecodex' },
            ],
            output: [
              {
                id: 'fc_call_exec_1',
                type: 'function_call',
                status: 'completed',
                name: 'exec_command',
                call_id: 'call_exec_1',
                arguments: '{"cmd":"pwd"}',
              },
            ],
          }
        : {
            id: 'resp_tool_pending',
            object: 'response',
            created_at: 1781149537,
            status: 'completed',
            model: 'gpt-5.5',
            output: [
              {
                id: 'fc_call_exec_1',
                type: 'function_call',
                status: 'completed',
                name: 'exec_command',
                call_id: 'call_exec_1',
                arguments: '{"cmd":"pwd"}',
              },
            ],
          };
      const toolsRaw = [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' },
              },
              required: ['cmd'],
              additionalProperties: false,
            },
          },
        },
      ];
      const projected = projectResponsesClientPayloadForClientWithNative(rawPayload, toolsRaw, {});
      const converter = new ResponsesJsonToSseConverterRefactored();
      const sse = await converter.convertResponseToJsonToSse(projected as any, {
        requestId: `req_tool_contract_${mode}`,
      });
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      (sse as any).pipe(res, { end: true });
    });

    const server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
      const address = server.address() as AddressInfo;
      return await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  it('HTTP blackbox: pending function_call response must surface standard tool events before terminal completion', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses?mode=pending`, {
        headers: { accept: 'text/event-stream' },
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(text).toContain('event: response.output_item.added');
      expect(text).toContain('event: response.function_call_arguments.done');
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('"name":"exec_command"');
      expect(text).not.toContain('event: response.required_action');
      expect(text.indexOf('event: response.output_item.done')).toBeLessThan(text.indexOf('event: response.completed'));
    });
  });

  it('HTTP blackbox negative: resolved tool output must remain completed and must not synthesize required_action', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses?mode=resolved`, {
        headers: { accept: 'text/event-stream' },
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain('event: response.required_action');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('"status":"completed"');
    });
  });
});

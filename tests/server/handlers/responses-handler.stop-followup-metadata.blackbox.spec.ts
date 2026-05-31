import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { executeServerToolReenterPipeline } from '../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js';

jest.unstable_mockModule(
  '../../../src/server/runtime/http-server/executor/client-injection-flow.js',
  () => ({
    runClientInjectionFlowBeforeReenter: jest.fn(async () => ({ clientInjectOnlyHandled: false }))
  })
);

jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge/module-loader.js',
  () => ({
    importCoreDist: jest.fn(async (subpath: string) => {
      if (subpath === 'conversion/shared/responses-conversation-store') {
        return {
          captureResponsesRequestContext: jest.fn(),
          rebindResponsesConversationRequestId: jest.fn()
        };
      }
      throw new Error(`unexpected importCoreDist ${subpath}`);
    })
  })
);

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

describe('responses HTTP stop_followup metadata blackbox', () => {
  it('does not pass legacy responses metadata into stop_followup hub reentry', async () => {
    let nestedMetadata: Record<string, any> | undefined;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          return executeServerToolReenterPipeline({
            entryEndpoint: '/v1/responses',
            fallbackEntryEndpoint: '/v1/responses',
            requestId: `${input.requestId}:stop_followup`,
            body: input.body,
            metadata: input.metadata,
            baseMetadata: input.metadata,
            requestSemantics: {
              __routecodex: {
                serverToolFollowup: true,
                serverToolFollowupSource: 'servertool.stop_message_flow'
              },
              responses: { context: { previous_response_id: 'resp_semantics' } }
            },
            executeNested: async (nestedInput: any) => {
              nestedMetadata = nestedInput.metadata;
              return {
                status: 200,
                headers: {},
                body: {
                  id: 'resp_stop_followup_metadata_blackbox',
                  object: 'response',
                  status: 'completed',
                  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
                }
              };
            }
          });
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
          metadata: {
            responsesContext: { previous_response_id: 'resp_legacy' },
            responses_context: { previous_response_id: 'resp_legacy_snake' },
            extraFields: { store: true },
            responseFormat: { type: 'json_object' },
            __rt: {
              serverToolFollowup: true,
              responsesContext: { previous_response_id: 'resp_rt_legacy' },
              extraFields: { store: true }
            }
          }
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_stop_followup_metadata_blackbox');
      expect(nestedMetadata).toBeDefined();
      expect(nestedMetadata).not.toHaveProperty('responsesContext');
      expect(nestedMetadata).not.toHaveProperty('responses_context');
      expect(nestedMetadata).not.toHaveProperty('extraFields');
      expect(nestedMetadata).not.toHaveProperty('responseFormat');
      expect(nestedMetadata?.__rt).not.toHaveProperty('responsesContext');
      expect(nestedMetadata?.__rt).not.toHaveProperty('extraFields');
    } finally {
      await closeServer(server);
    }
  });
});

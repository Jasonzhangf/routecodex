import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('responses-response-bridge request-context resolution', () => {
  it('requires requestContext.context.toolsRaw as the explicit client projection input', async () => {
    const { normalizeResponsesClientPayloadForHttp } = await import(
      '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
    );

    await expect(
      normalizeResponsesClientPayloadForHttp({
        entryEndpoint: '/v1/responses',
        metadata: {},
        payload: {
          id: 'resp_bridge_tools_raw_contract',
          object: 'response',
          status: 'completed',
          output: [],
        },
        requestContext: {
          payload: {
            model: 'gpt-5.4',
            tools: [{ type: 'function', function: { name: 'exec_command' } }],
          },
          context: {
            clientToolsRaw: [{ type: 'function', function: { name: 'apply_patch' } }],
          },
        },
      })
    ).rejects.toThrow('Responses client projection requires requestContext.context.toolsRaw');
  });

  it('does not keep request-context salvage helpers in the response bridge surface', () => {
    const responseBridge = readFileSync(
      join(root, 'src/modules/llmswitch/bridge/responses-response-bridge.ts'),
      'utf8'
    );
    const sseBridge = readFileSync(
      join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'),
      'utf8'
    );
    const bridgeIndex = readFileSync(join(root, 'src/modules/llmswitch/bridge/index.ts'), 'utf8');

    for (const forbidden of [
      'resolveResponsesRequestContextForHttp',
      'shouldDispatchResponsesSseToClientForHttp',
    ]) {
      expect(responseBridge).not.toContain(forbidden);
      expect(sseBridge).not.toContain(forbidden);
      expect(bridgeIndex).not.toContain(forbidden);
    }

    expect(responseBridge).not.toContain('buildClientSseKeepaliveFrameForHttp');
    expect(responseBridge).not.toContain('contextClientToolsRaw');
    expect(responseBridge).not.toContain('payloadTools');
    expect(responseBridge).not.toContain('requestContext?.payload?.tools');
    expect(bridgeIndex).not.toContain('resolveResponsesRequestContextForHttp');
    expect(bridgeIndex).not.toContain('shouldDispatchResponsesSseToClientForHttp');
    expect(sseBridge).toContain('buildClientSseKeepaliveFrameForHttp');
  });
});

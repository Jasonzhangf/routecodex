import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('responses-response-bridge request-context resolution', () => {
  it('keeps metadata session id as the request log color identity when usage has only a log key', async () => {
    const { buildResponsesRequestLogContextForHttp } = await import(
      '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts'
    );
    const { resolveSessionLogColorKey } = await import('../../../../src/utils/session-log-color.ts');

    const context = buildResponsesRequestLogContextForHttp({
      metadata: {
        sessionId: 'visible-session-color',
        conversationId: 'visible-conversation-color',
        logSessionColorKey: 'metadata-log-key'
      },
      usageLogInfo: {
        logSessionColorKey: 'usage-route-color-key'
      }
    });

    expect(context.sessionId).toBe('visible-session-color');
    expect(context.session_id).toBe('visible-session-color');
    expect(context.conversationId).toBe('visible-conversation-color');
    expect(context.conversation_id).toBe('visible-conversation-color');
    expect(resolveSessionLogColorKey(context)).toBe(resolveSessionLogColorKey({ sessionId: 'visible-session-color' }));
    expect(resolveSessionLogColorKey(context)).not.toBe(resolveSessionLogColorKey({ logSessionColorKey: 'usage-route-color-key' }));
  });

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
    expect(existsSync(join(root, 'src/modules/llmswitch/bridge/index.ts'))).toBe(false);

    for (const forbidden of [
      'resolveResponsesRequestContextForHttp',
      'shouldDispatchResponsesSseToClientForHttp',
    ]) {
      expect(responseBridge).not.toContain(forbidden);
      expect(sseBridge).not.toContain(forbidden);
    }

    expect(responseBridge).not.toContain('buildClientSseKeepaliveFrameForHttp');
    expect(responseBridge).not.toContain('contextClientToolsRaw');
    expect(responseBridge).not.toContain('payloadTools');
    expect(responseBridge).not.toContain('requestContext?.payload?.tools');
    expect(sseBridge).toContain('buildClientSseKeepaliveFrameForHttp');
  });
});

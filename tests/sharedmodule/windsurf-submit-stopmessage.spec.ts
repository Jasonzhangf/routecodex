import { describe, expect, it } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';

describe('Windsurf submit continuation stopMessage isolation', () => {
  it('RED: responses submit_tool_outputs continuation must not trigger stop_message_auto client inject flow', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl_windsurf_submit_final',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '/Users/fanzhang/Documents/github/routecodex'
            }
          }
        ]
      },
      adapterContext: {
        requestId: 'req_windsurf_submit_stopmessage_red',
        providerProtocol: 'openai-responses',
        providerFamily: 'windsurf',
        __rt: {
          clientProtocol: 'openai-responses',
          providerFamily: 'windsurf'
        },
        responsesResume: {
          previousRequestId: 'req_windsurf_submit_root',
          restoredFromResponseId: 'resp_windsurf_submit_root',
          toolOutputsDetailed: [
            { callId: 'native:run_command:3', outputText: '/Users/fanzhang/Documents/github/routecodex\n' }
          ]
        }
      } as any,
      requestId: 'req_windsurf_submit_stopmessage_red',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientInjectDispatch: async () => {
        throw new Error('clientInjectDispatch must not be called for submit continuation final answer');
      }
    } as any);

    expect(result.mode).toBe('passthrough');
    expect((result as any).execution).toBeUndefined();
  });

  it('skips default stopMessage when entering through a port with stopMessage.enabled=false', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl_windsurf_port_stopmessage_disabled',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'RCC_SMOKE_OK' }
          }
        ]
      },
      adapterContext: {
        requestId: 'req_windsurf_port_stopmessage_disabled',
        providerProtocol: 'openai-responses',
        providerFamily: 'windsurf',
        stopMessageEnabled: false,
        routecodexPortStopMessageEnabled: false,
        __rt: {
          clientProtocol: 'openai-responses',
          providerFamily: 'windsurf',
          stopMessagePortEnabled: false
        }
      } as any,
      requestId: 'req_windsurf_port_stopmessage_disabled',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientInjectDispatch: async () => {
        throw new Error('clientInjectDispatch must not be called when port disables stopMessage');
      }
    } as any);

    expect(result.mode).toBe('passthrough');
    expect((result as any).execution).toBeUndefined();
  });

});

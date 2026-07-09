import { describe, expect, it } from '@jest/globals';

import { runHubPipelineLibWithNative } from './helpers/hub-pipeline-orchestration-direct-native.js';
import { NativeHubPipelineTestWrapper as HubPipeline } from '../helpers/native-hub-pipeline-test-wrapper.js';
import { executeRequestStagePipelineDirectNative as executeRequestStagePipeline } from './helpers/request-stage-direct-native.js';
import { buildRequestMetadata } from '../../src/server/runtime/http-server/executor-metadata.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function virtualRouterConfigForPreselectedRoute(route: {
  target: {
    providerKey: string;
    providerType?: string;
    providerId?: string;
    runtimeKey?: string;
    modelId?: string;
    outboundProfile?: string;
  };
}) {
  const target = route.target;
  return {
    providers: {
      [target.providerKey]: {
        providerKey: target.providerKey,
        providerType: target.providerType ?? 'openai',
        providerId: target.providerId,
        runtimeKey: target.runtimeKey ?? target.providerId ?? target.providerKey.split('.').slice(0, -1).join('.'),
        modelId: target.modelId ?? 'gpt-5.5',
        outboundProfile: target.outboundProfile ?? 'openai-responses',
        endpoint: `mock://${target.providerKey}`,
        auth: { type: 'apikey', apiKey: 'test-key' },
      },
    },
    routing: {
      default: [{
        id: 'default-priority',
        mode: 'priority',
        targets: [target.providerKey],
      }],
    },
  };
}

describe('hub pipeline Rust responses provider payload regression', () => {
  it('projects providerPayload and selected target from native engine handle output', async () => {
    const pipeline = new HubPipeline({
      virtualRouter: {
        providers: {
          'snapshot.key1.gpt-5.5': {
            providerKey: 'snapshot.key1.gpt-5.5',
            providerType: 'openai',
            runtimeKey: 'snapshot.key1',
            modelId: 'gpt-5.5',
            outboundProfile: 'openai-responses',
            endpoint: 'mock://snapshot',
            auth: { type: 'apikey', apiKey: 'snapshot-key' }
          }
        },
        routing: {
          default: [{
            id: 'default-priority',
            mode: 'priority',
            targets: ['snapshot.key1.gpt-5.5']
          }]
        }
      }
    });

    try {
      const result = await pipeline.execute({
        id: 'req_native_handle_executor_contract',
        endpoint: '/v1/responses',
        payload: {
          model: 'gpt-5.5',
          input: 'route from native handle'
        },
        metadata: {
          entryEndpoint: '/v1/responses'
        },
        metadataCenterSnapshot: {
          requestTruth: {
            requestId: 'req_native_handle_executor_contract',
            sessionId: 'native-handle-contract-session'
          },
          runtimeControl: {
            preselectedRoute: {
              target: {
                providerKey: 'snapshot.key1.gpt-5.5',
                providerType: 'openai',
                runtimeKey: 'snapshot.key1',
                modelId: 'gpt-5.5',
                outboundProfile: 'openai-responses'
              },
              decision: {
                routeName: 'thinking/gateway-priority-5555-priority-thinking'
              },
              diagnostics: { source: 'test' }
            }
          }
        }
      });

      expect(result.providerPayload).toMatchObject({
        model: 'gpt-5.5'
      });
      expect(result.target).toMatchObject({
        providerKey: 'snapshot.key1.gpt-5.5',
        outboundProfile: 'openai-responses'
      });
      expect(result.routingDecision).toMatchObject({
        routeName: 'thinking/gateway-priority-5555-priority-thinking'
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('keeps /v1/responses tool requests as Responses wire payload for openai-responses providers', () => {
    const preselectedRoute = {
      target: {
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        providerId: 'minimonth',
        modelId: 'MiniMax-M2.7',
        outboundProfile: 'openai-responses'
      },
      decision: { routeName: 'tools/gateway-priority-5555-weighted-tools' },
      diagnostics: {}
    };
    const result = runHubPipelineLibWithNative({
      config: { virtualRouter: virtualRouterConfigForPreselectedRoute(preselectedRoute) },
      request: {
        requestId: 'req_responses_tools_provider_payload',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: true,
        processMode: 'chat',
        direction: 'request',
        stage: '',
        payload: {
          model: 'gpt-5.5',
          stream: true,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'read files with a tool' }]
            }
          ],
          tools: [
            {
              type: 'function',
              name: 'exec_command',
              description: 'run a shell command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          ]
        },
        metadata: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          runtime_control: {
            preselectedRoute
          }
        }
      }
    });

    if (result.success !== true) {
      // eslint-disable-next-line no-console
      console.error('responses provider payload baseline failure', JSON.stringify(result, null, 2));
    }
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.payload).toMatchObject({
      model: 'MiniMax-M2.7'
    });
    expect(typeof result.payload?.stream).toBe('boolean');
    expect(Array.isArray(result.payload?.input)).toBe(true);
    expect(result.payload).not.toHaveProperty('messages');
    expect(result.payload?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'exec_command' })
    ]));
  });

  it('uses metadataCenterSnapshot preselectedRoute for bootstrapped request routing without runtime_control residue', () => {
    const preselectedRoute = {
      target: {
        providerKey: 'snapshot.key1.gpt-5.5',
        providerId: 'snapshot',
        modelId: 'gpt-5.5',
        outboundProfile: 'openai-responses'
      },
      decision: { routeName: 'thinking/gateway-priority-5555-priority-thinking' },
      diagnostics: { source: 'metadataCenterSnapshot' }
    };
    const result = runHubPipelineLibWithNative({
      config: { virtualRouter: virtualRouterConfigForPreselectedRoute(preselectedRoute) },
      request: {
        requestId: 'req_responses_snapshot_preselected_route',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: true,
        processMode: 'chat',
        direction: 'request',
        stage: '',
        payload: {
          model: 'gpt-5.5',
          stream: true,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'route from snapshot only' }]
            }
          ]
        },
        metadata: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses'
        },
        metadataCenterSnapshot: {
          runtimeControl: {
            preselectedRoute
          }
        }
      }
    });

    if (result.success !== true) {
      // eslint-disable-next-line no-console
      console.error('snapshot preselectedRoute request routing failure', JSON.stringify(result, null, 2));
    }
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.metadata).toMatchObject({
      target: expect.objectContaining({
        providerKey: 'snapshot.key1.gpt-5.5'
      }),
      routingDecision: expect.objectContaining({
        routeName: 'thinking/gateway-priority-5555-priority-thinking'
      })
    });
    expect(result.payload).toMatchObject({
      model: 'gpt-5.5'
    });
  });

  it('RED: keeps stopless schema feedback and guidance in final provider payload for /v1/responses', () => {
    const preselectedRoute = {
      target: {
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        providerId: 'minimonth',
        modelId: 'MiniMax-M2.7',
        outboundProfile: 'openai-responses'
      },
      decision: { routeName: 'thinking/gateway-priority-5555-weighted-thinking' },
      diagnostics: {}
    };
    const result = runHubPipelineLibWithNative({
      config: { virtualRouter: virtualRouterConfigForPreselectedRoute(preselectedRoute) },
      request: {
        requestId: 'req_responses_stopless_provider_payload',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: false,
        processMode: 'chat',
        direction: 'request',
        stage: '',
        payload: {
          model: 'gpt-5.5',
          stream: false,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行原任务' }]
            },
            {
              type: 'function_call',
              call_id: 'call_servertool_cli_stop_1',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: "routecodex hook run reasoningStop --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"schemaFeedback\":{\"missingFields\":[\"stopreason\",\"reason\"],\"reasonCode\":\"stop_schema_missing\"},\"triggerHint\":\"no_schema\"}' --repeat-count '1' --max-repeats '3'"
              })
            },
            {
              type: 'function_call_output',
              call_id: 'call_servertool_cli_stop_1',
              output: JSON.stringify({
                ok: true,
                toolName: 'stop_message_auto',
                flowId: 'stop_message_flow',
                repeatCount: 2,
                maxRepeats: 3,
                continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
                schemaFeedback: {
                  reasonCode: 'stop_schema_missing',
                  missingFields: ['stopreason', 'reason']
                },
                schemaGuidance: {
                  requiredFields: ['stopreason', 'reason', 'next_step'],
                  stopreasonValues: {
                    finished: 0,
                    blocked: 1,
                    continueNeeded: 2
                  },
                  triggerHint: 'no_schema'
                }
              })
            }
          ],
          tools: [
            {
              type: 'function',
              name: 'exec_command',
              description: 'run a shell command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          ]
        },
        metadata: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          clientInjectReady: true,
          runtime_control: {
            preselectedRoute
          }
        }
      }
    });

    if (result.success !== true) {
      // eslint-disable-next-line no-console
      console.error('responses stopless provider payload failure', JSON.stringify(result, null, 2));
    }
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const payloadText = JSON.stringify(result.payload ?? {});
    expect(payloadText).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
    expect(payloadText).toContain('上一轮执行结果');
    expect(payloadText).toContain('repeatCount=2/3');
    expect(payloadText).toContain('reasonCode=stop_schema_missing');
    expect(payloadText).toContain('missingFields=stopreason, reason');
    expect(payloadText).toContain('如果任务已经完成');
  });

  it('materializes stopless instructions into final provider payload from real request metadata entrypoint', async () => {
    const metadata = buildRequestMetadata({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req_responses_stopless_real_entry_provider_payload',
      headers: {},
      query: {},
      body: {
        model: 'mimo-v2.5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'read files <**stopless:on**>' }]
          }
        ],
        stream: false,
        metadata: {
          sessionId: 'sess_responses_stopless_real_entry_provider_payload'
        }
      },
      metadata: {}
    } as any);
    expect(MetadataCenter.read(metadata)?.readRuntimeControl()).toMatchObject({
      stopMessageEnabled: true
    });
    expect(MetadataCenter.read(metadata)?.readRequestTruth()).toMatchObject({
      sessionId: 'sess_responses_stopless_real_entry_provider_payload'
    });
    MetadataCenter.read(metadata)?.writeRuntimeControl(
      'preselectedRoute',
      {
        target: {
          providerKey: 'mimo.key2.mimo-v2.5',
          providerType: 'anthropic',
          runtimeKey: 'mimo.key2',
          modelId: 'mimo-v2.5',
          outboundProfile: 'anthropic-messages'
        },
        decision: { routeName: 'tools' },
        diagnostics: {}
      },
      {
        module: 'tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts',
        symbol: 'materializes stopless instructions into final provider payload from real request metadata entrypoint',
        stage: 'test'
      }
    );

    const result = await executeRequestStagePipeline({
      normalized: {
        id: 'req_responses_stopless_real_entry_provider_payload',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        payload: {
          model: 'mimo-v2.5',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'read files <**stopless:on**>' }]
            }
          ],
          stream: false,
          metadata: {
            sessionId: 'sess_responses_stopless_real_entry_provider_payload'
          }
        },
        metadata,
        processMode: 'chat',
        direction: 'request',
        stage: 'inbound',
        stream: false
      } as any,
      routerEngine: {
        route: () => {
          throw new Error('route should not be called when preselectedRoute is present');
        }
      } as any,
      config: {
        virtualRouter: virtualRouterConfigForPreselectedRoute({
          target: {
            providerKey: 'mimo.key2.mimo-v2.5',
            providerType: 'anthropic',
            runtimeKey: 'mimo.key2',
            modelId: 'mimo-v2.5',
            outboundProfile: 'anthropic-messages'
          }
        })
      } as any,
      runtimeRouterRequired: false,
    });

    const payloadText = JSON.stringify(result.providerPayload ?? {});
    expect(payloadText).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
  });

});

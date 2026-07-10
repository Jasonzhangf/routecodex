import { describe, expect, it } from '@jest/globals';

import { normalizeReqInboundShellLikeToolCallsWithNative } from './helpers/req-inbound-direct-native.js';
import {
  applyReqProcessToolGovernanceDirectNative,
  type NativeReqProcessToolGovernanceInput,
  type NativeReqProcessToolGovernanceOutput
} from './helpers/req-process-direct-native.ts';

function buildBaseRequest(userContent = 'hello'): Record<string, unknown> {
  return {
    model: 'glm-4.7',
    messages: [
      { role: 'system', content: 'act as system' },
      { role: 'user', content: userContent }
    ],
    tools: [],
    parameters: { stream: true },
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function runGovernance(overrides?: {
  request?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  hasActiveStopMessageForContinueExecution?: boolean;
}): NativeReqProcessToolGovernanceOutput {
  const input: NativeReqProcessToolGovernanceInput = {
    request: (overrides?.request ?? buildBaseRequest()) as Record<string, unknown>,
    rawPayload: {},
    metadata: {
      originalEndpoint: '/v1/chat/completions',
      ...(overrides?.metadata ?? {})
    },
    entryEndpoint: '/v1/chat/completions',
    requestId: 'req-process-servertool-bundle-contract',
    hasActiveStopMessageForContinueExecution:
      overrides?.hasActiveStopMessageForContinueExecution ?? false,
  };
  return applyReqProcessToolGovernanceDirectNative(input);
}

function readToolNames(result: NativeReqProcessToolGovernanceOutput): string[] {
  const tools = Array.isArray(result.processedRequest.tools)
    ? (result.processedRequest.tools as Array<Record<string, unknown>>)
    : [];
  return tools
    .map((tool) => {
      const fn = tool.function;
      if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
        const name = (fn as Record<string, unknown>).name;
        return typeof name === 'string' ? name : '';
      }
      const direct = tool.name;
      return typeof direct === 'string' ? direct : '';
    })
    .filter((name): name is string => Boolean(name));
}

describe('req_process servertool bundle contract', () => {
  it('injects canonical web_search tool when semantics.providerExtras.webSearch.force=true', () => {
    const request = buildBaseRequest('hello');
    request.semantics = {
      providerExtras: {
        webSearch: { force: true }
      }
    };

    const result = runGovernance({
      request,
      metadata: {
        __rt: {
          webSearch: {
            injectPolicy: 'selective',
            engines: [
              {
                id: 'engine-1',
                providerKey: 'tabglm.glm-4.7'
              }
            ]
          }
        }
      }
    });

    expect(readToolNames(result)).toContain('web_search');
  });

  it('keeps canonical web_search injection for non-deepseek servertool search engines', () => {
    const result = runGovernance({
      request: buildBaseRequest('请联网搜索 RouteCodex 最新版本'),
      metadata: {
        __rt: {
          webSearch: {
            injectPolicy: 'selective',
            engines: [
              {
                id: 'glm:web_search',
                providerKey: 'glm',
                default: true
              }
            ]
          }
        }
      }
    });

    expect(readToolNames(result)).toContain('web_search');
  });

  it('keeps continue_execution hidden and does not inject deleted review tool', () => {
    const result = runGovernance({
      request: buildBaseRequest('继续处理并自查当前实现')
    });

    const toolNames = readToolNames(result);
    expect(toolNames).not.toContain('continue_execution');
    expect(toolNames).not.toContain('review');
  });

  it('skips review/web_search/clock injection when client inject is not ready', () => {
    const request = buildBaseRequest('请联网搜索 RouteCodex 最新版本');
    request.semantics = {
      providerExtras: {
        webSearch: { force: true }
      }
    };

    const result = runGovernance({
      request,
      metadata: {
        clientInjectReady: false,
        clientInjectReason: 'tmux_session_missing',
        __rt: {
          clock: { enabled: true },
          webSearch: {
            injectPolicy: 'always',
            engines: [
              {
                id: 'glm:web_search',
                providerKey: 'glm',
                default: true
              }
            ]
          }
        }
      }
    });

    const toolNames = readToolNames(result);
    expect(toolNames).not.toContain('review');
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).not.toContain('clock');
  });

  it('RED: stopless submit_tool_outputs normalization must preserve current tool result count and schema feedback in model-visible request text', () => {
    const payload: Record<string, unknown> = {
      model: 'gpt-5.5',
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
            cmd: "routecodex hook run reasoningStop --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"schemaFeedback\":{\"missingFields\":[\"next_step\"],\"reasonCode\":\"stop_schema_next_step_missing\"},\"triggerHint\":\"invalid_schema\"}' --repeat-count '1' --max-repeats '3'"
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
            continuationPrompt: '继续；按上一轮反馈修正。',
            schemaFeedback: {
              reasonCode: 'stop_schema_next_step_missing',
              missingFields: ['next_step']
            },
            schemaGuidance: {
              requiredFields: ['stopreason', 'current_goal', 'next_step'],
              stopreasonValues: {
                finished: 0,
                blocked: 1,
                continueNeeded: 2
              },
              triggerHint: 'invalid_schema'
            }
          })
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' }
              }
            }
          }
        }
      ]
    };

    normalizeReqInboundShellLikeToolCallsWithNative(payload);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('上一轮执行结果');
    expect(serialized).toContain('repeatCount=2/3');
    expect(serialized).toContain('reasonCode=stop_schema_next_step_missing');
    expect(serialized).toContain('missingFields=next_step');
    expect(serialized).toContain('继续；按上一轮反馈修正。');
    expect(serialized).toContain('继续；按上一轮反馈补齐 next_step');
    expect(serialized).toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
    expect(serialized).not.toContain('如果任务已经完成');
    expect(serialized).toContain('按上一轮反馈补齐这些字段');
  });

  it('keeps standalone req-process governance from owning relay stopless instruction injection', () => {
    const result = applyReqProcessToolGovernanceDirectNative({
      request: {
        model: 'gpt-5.5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '请直接回复一句“阶段完成”，然后结束。<**stopless:on**>' }]
          }
        ],
        stream: false
      },
      rawPayload: {},
      metadata: {
        entryEndpoint: '/v1/responses',
        clientInjectReady: false,
        clientInjectReason: 'tmux_session_missing',
        stopMessageEnabled: true
      },
      metadataCenterSnapshot: {
        runtimeControl: {
          stopless: {
            active: true,
            flowId: 'stop_message_flow',
            repeatCount: 1,
            maxRepeats: 3,
            triggerHint: 'no_schema',
            schemaFeedback: {
              reasonCode: 'stop_schema_missing',
              missingFields: ['stopreason', 'reason']
            }
          }
        }
      },
      entryEndpoint: '/v1/responses',
      requestId: 'req-process-stopless-relay-no-tmux',
      hasActiveStopMessageForContinueExecution: false
    });

    expect(Array.isArray(result.processedRequest.input)).toBe(true);
    const serialized = JSON.stringify(result.processedRequest.input);
    expect(serialized).toContain('请直接回复一句“阶段完成”');
    expect(serialized).not.toContain('stopreason 取值：0=finished，1=blocked，2=continue_needed');
    expect(serialized).not.toContain('reasoningStop');
    expect(result.processedRequest.instructions).toBeUndefined();
  });
});

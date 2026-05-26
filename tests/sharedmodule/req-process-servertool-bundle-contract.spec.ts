import { describe, expect, it } from '@jest/globals';

import { applyReqProcessToolGovernanceWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';

type NativeGovernanceInput = Parameters<typeof applyReqProcessToolGovernanceWithNative>[0];

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
}): ReturnType<typeof applyReqProcessToolGovernanceWithNative> {
  const input: NativeGovernanceInput = {
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
  return applyReqProcessToolGovernanceWithNative(input);
}

function readToolNames(result: ReturnType<typeof applyReqProcessToolGovernanceWithNative>): string[] {
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

  it('keeps continue_execution hidden but still injects review when stopMessage is not active', () => {
    const result = runGovernance({
      request: buildBaseRequest('继续处理并自查当前实现')
    });

    const toolNames = readToolNames(result);
    expect(toolNames).not.toContain('continue_execution');
    expect(toolNames).toContain('review');
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
});

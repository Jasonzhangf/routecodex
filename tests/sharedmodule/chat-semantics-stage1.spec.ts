import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { chatEnvelopeToStandardized, standardizedToChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { runHubPipelineLibWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

const adapterContext: AdapterContext = {
  requestId: 'req-semantics',
  entryEndpoint: '/v1/chat/completions',
  providerProtocol: 'openai-chat'
};

function hasUserDirective(messages: StandardizedRequest['messages'], marker: string): boolean {
  return messages.some((message) => {
    if (message?.role !== 'user') {
      return false;
    }
    if (typeof message.content === 'string') {
      return message.content.includes(marker);
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((part) => {
      if (!part || typeof part !== 'object') {
        return false;
      }
      return typeof (part as Record<string, unknown>).text === 'string'
        && String((part as Record<string, unknown>).text).includes(marker);
    });
  });
}

function buildSemantics(): NonNullable<ChatEnvelope['semantics']> {
  return {
    session: { previousResponseId: 'resp-123' },
    system: { textBlocks: ['sys-0'] },
    responses: { include: ['messages'] },
    anthropic: { systemBlocks: [{ type: 'text', text: 'anthropic' }] },
    gemini: { safetySettings: [{ category: 'HARM_CATEGORY_DEROGATORY', threshold: 'BLOCK_NONE' }] },
    providerExtras: { passthrough: { foo: 'bar' } }
  };
}

function buildChatEnvelope(): ChatEnvelope {
  return {
    messages: [
      { role: 'system', content: 'act as system' },
      { role: 'user', content: 'hello' }
    ],
    parameters: { model: 'glm-4.7' },
    metadata: {
      context: adapterContext
    },
    semantics: buildSemantics()
  };
}

describe('Chat semantics stage 1 bridge', () => {
  const previousUserDir = process.env.ROUTECODEX_USER_DIR;
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-chat-semantics-stage1-'));

  beforeAll(() => {
    process.env.ROUTECODEX_USER_DIR = tmpUserDir;
  });

  afterAll(() => {
    if (previousUserDir === undefined) {
      delete process.env.ROUTECODEX_USER_DIR;
    } else {
      process.env.ROUTECODEX_USER_DIR = previousUserDir;
    }
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    saveRoutingInstructionStateSync('session:session-stopmessage-mode-only', null);
  });

  it('preserves semantics through chat↔standardized bridge with isolated clones', () => {
    const chat = buildChatEnvelope();
    const originalSemantics = JSON.parse(JSON.stringify(chat.semantics));
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-bridge'
    });

    expect(standardized.semantics).toEqual(originalSemantics);

    // mutate original chat semantics and ensure standardized copy is isolated
    (chat.semantics?.system?.textBlocks as unknown[] | undefined)?.push('mutated');
    expect(standardized.semantics).toEqual(originalSemantics);

    const restored = standardizedToChatEnvelope(standardized, { adapterContext });
    expect(restored.semantics).toEqual(originalSemantics);

    // mutate restored semantics and ensure standardized copy stays intact
    if (restored.semantics?.responses && Array.isArray((restored.semantics.responses as any).include)) {
      ((restored.semantics.responses as any).include as string[]).push('mutated');
    }
    expect(standardized.semantics).toEqual(originalSemantics);
  });

  it('retains semantics field on shallow StandardizedRequest copies', () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-clone'
    });

    const cloned: typeof standardized = {
      ...standardized,
      metadata: {
        ...standardized.metadata,
        toolChoice: 'auto'
      }
    };

    expect(cloned.semantics).toEqual(standardized.semantics);
  });

  async function runProcessWithRequest(
    request: StandardizedRequest,
    metadataOverrides?: Record<string, unknown>
  ) {
    const result = runHubPipelineLibWithNative({
      config: { virtualRouter: {} },
      request: {
        requestId: 'req-sem-process',
        endpoint: '/v1/chat/completions',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        payload: request as unknown as Record<string, unknown>,
        metadata: {
          providerProtocol: 'openai-chat',
          ...(metadataOverrides ?? {}),
          __routecodexPreselectedRoute: {
            target: { providerKey: 'test.key1.gpt-test', modelId: 'gpt-test', outboundProfile: 'openai-chat' },
            decision: { routeName: 'test/preselected' },
            diagnostics: {},
          },
        },
        stream: false,
        processMode: 'chat',
        direction: 'request',
        stage: 'inbound',
      },
    });
    if (result.success !== true) {
      throw new Error(result.error?.message ?? 'Rust HubPipeline request pipeline failed');
    }
    return { processedRequest: result.payload as unknown as StandardizedRequest };
  }

  it('does not leak semantics into provider wire payload', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-process'
    });
    const result = await runProcessWithRequest(standardized);
    expect(result.processedRequest?.semantics).toBeUndefined();
    expect(result.processedRequest?.metadata).toBeUndefined();
  });

  it('forces web_search injection when semantics providerExtras.webSearch.force=true', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-force-web'
    });
    standardized.semantics = {
      ...(standardized.semantics ?? {}),
      providerExtras: {
        ...(standardized.semantics?.providerExtras ?? {}),
        webSearch: { force: true }
      }
    };
    const result = await runProcessWithRequest(standardized, {
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
    });
    const hasWebSearchTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'web_search'
    );
    expect(hasWebSearchTool).toBe(true);
  });

  it('skips web_search injection when semantics providerExtras.webSearch.disable=true even if config present', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-disable-web'
    });
    standardized.semantics = {
      ...(standardized.semantics ?? {}),
      providerExtras: {
        ...(standardized.semantics?.providerExtras ?? {}),
        webSearch: { disable: true }
      }
    };
    const result = await runProcessWithRequest(standardized, {
      __rt: {
        webSearch: {
          injectPolicy: 'always',
          engines: [
            {
              id: 'engine-1',
              providerKey: 'tabglm.glm-4.7'
            }
          ]
        }
      }
    });
    const hasWebSearchTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'web_search'
    );
    expect(hasWebSearchTool).toBe(false);
  });

  it('keeps web_search tool in provider wire when search intent remains servertool-governed', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-deepseek-native'
    });
    standardized.messages = [
      standardized.messages[0],
      {
        role: 'user',
        content: '请上网搜索今天 RouteCodex 的更新'
      }
    ];

    const result = await runProcessWithRequest(standardized, {
      __rt: {
        webSearch: {
          injectPolicy: 'selective',
          engines: [
            {
              id: 'deepseek:web_search',
              providerKey: 'provider-a.model-a-search',
              default: true
            },
            {
              id: 'glm:web_search',
              providerKey: 'glm'
            }
          ]
        }
      }
    });
    const hasWebSearchTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'web_search'
    );
    expect(hasWebSearchTool).toBe(true);
  });

  it('keeps servertool web_search injection for non-deepseek search engines', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-glm-search'
    });
    standardized.messages = [
      standardized.messages[0],
      {
        role: 'user',
        content: '请联网搜索 RouteCodex 最新版本'
      }
    ];

    const result = await runProcessWithRequest(standardized, {
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
    });
    const hasWebSearchTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'web_search'
    );
    expect(hasWebSearchTool).toBe(true);
  });

  it('does not inject continue_execution tool when stopMessage is not active', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-continue-default'
    });

    const result = await runProcessWithRequest(standardized);
    const hasContinueTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'continue_execution'
    );
    expect(hasContinueTool).toBe(false);
    const hasClockTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'clock'
    );
    expect(hasClockTool).toBe(false);

    const messages = result.processedRequest?.messages ?? [];
    expect(messages.some((message) => message.role === 'user')).toBe(true);
  });

  it('skips continue_execution injection when stopMessage is mode-only active', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-continue-stop-active'
    });

    saveRoutingInstructionStateSync('session:session-stopmessage-mode-only', {
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageStageMode: 'on',
      stopMessageMaxRepeats: 10
    });

    const result = await runProcessWithRequest(standardized, {
      sessionId: 'session-stopmessage-mode-only',
      __rt: {
        stopMessageState: {
          stopMessageStageMode: 'on',
          stopMessageMaxRepeats: 10
        }
      }
    });

    const hasContinueTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'continue_execution'
    );
    expect(hasContinueTool).toBe(false);

    expect(hasUserDirective(result.processedRequest?.messages ?? [], '[routecodex:continue_execution_injection]')).toBe(false);
  });

  it('skips continue_execution and clock injection when client inject is not ready', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-continue-client-inject-unready'
    });

    const result = await runProcessWithRequest(standardized, {
      clientInjectReady: false,
      clientInjectReason: 'tmux_session_missing'
    });

    const hasContinueTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'continue_execution'
    );
    const hasClockTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'clock'
    );
    const hasReviewTool = (result.processedRequest?.tools ?? []).some(
      (tool) => tool.function?.name === 'review'
    );
    expect(hasContinueTool).toBe(false);
    expect(hasClockTool).toBe(false);
    expect(hasReviewTool).toBe(false);

    expect(hasUserDirective(result.processedRequest?.messages ?? [], '[routecodex:continue_execution_injection]')).toBe(false);
  });

});

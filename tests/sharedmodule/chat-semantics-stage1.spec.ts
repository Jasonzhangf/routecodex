import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { chatEnvelopeToStandardized, standardizedToChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

const mockRunChatRequestToolFilters = jest.fn(async (payload: any) => payload);
const mockGovernRequest = jest.fn((request: any) => ({
  request,
  summary: { applied: false }
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.js', () => ({
  runChatRequestToolFilters: mockRunChatRequestToolFilters
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/index.js', () => ({
  ToolGovernanceEngine: class {
    governRequest(request: any) {
      return mockGovernRequest(request);
    }
  },
  ToolGovernanceError: class extends Error {}
}));

const { runHubChatProcess } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process.js');

const adapterContext: AdapterContext = {
  requestId: 'req-semantics',
  entryEndpoint: '/v1/chat/completions',
  providerProtocol: 'openai-chat'
};

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
  beforeEach(() => {
    mockRunChatRequestToolFilters.mockClear();
    mockGovernRequest.mockClear();
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
    return runHubChatProcess({
      request,
      requestId: 'req-sem-process',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {
        providerProtocol: 'openai-chat',
        ...(metadataOverrides ?? {})
      }
    });
  }

  it('keeps semantics attached after chat-process execution', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-sem-process'
    });
    const expectedSemantics = JSON.parse(JSON.stringify(standardized.semantics));
    const result = await runProcessWithRequest(standardized);
    expect(result.processedRequest?.semantics).toEqual(expectedSemantics);
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

  it('injects continue_execution tool and directive when stopMessage is not active', async () => {
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
    expect(hasContinueTool).toBe(true);

    const userMessages = (result.processedRequest?.messages ?? []).filter((message) => message.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
    expect(content).toContain('[routecodex:continue_execution_directive]');
  });

  it('suppresses continue_execution injection when mode-only stopMessage state is active', async () => {
    const chat = buildChatEnvelope();
    const standardized = chatEnvelopeToStandardized(chat, {
      adapterContext,
      endpoint: '/v1/chat/completions',
      requestId: 'req-continue-stop-active'
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

    const userMessages = (result.processedRequest?.messages ?? []).filter((message) => message.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
    expect(content).not.toContain('[routecodex:continue_execution_directive]');
  });

});

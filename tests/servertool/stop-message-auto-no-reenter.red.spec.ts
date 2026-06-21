import { describe, expect, it, jest } from '@jest/globals';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function buildStopChatResponse(): JsonObject {
  return {
    id: 'chatcmpl-stopless-no-reenter',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'need more evidence' },
        finish_reason: 'stop'
      }
    ]
  } as JsonObject;
}

function buildAdapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const adapterContext = {
    requestId: overrides.requestId ?? `req-no-reenter-${unique}`,
    entryEndpoint: overrides.entryEndpoint ?? '/v1/chat/completions',
    providerProtocol: overrides.providerProtocol ?? 'openai-chat',
    sessionId: overrides.sessionId ?? `session-no-reenter-${unique}`,
    capturedChatRequest: overrides.capturedChatRequest ?? {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'diagnose this' }]
    }
  } as any;
  MetadataCenter.attach(adapterContext);
  return adapterContext;
}

describe('stopless must not reenter via append_user_text', () => {
  it('never returns a followup plan with append_user_text injection', async () => {
    const reenterPipeline = jest.fn(async () => {
      throw new Error('reenterPipeline must not be invoked by stop_message_auto');
    });
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse(),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).not.toHaveBeenCalled();
    const visible = JSON.stringify(result.chat);
    expect(visible).not.toContain('append_user_text');
    expect(visible).not.toContain(':stop_followup');
    expect(visible).not.toContain('requestIdSuffix');
  });
});

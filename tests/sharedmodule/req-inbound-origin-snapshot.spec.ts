import { describe, expect, test } from '@jest/globals';

import { runReqInboundStage3ContextCaptureOrchestration } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/context-capture-orchestration.js';
import { loadOriginSnapshot } from '../../sharedmodule/llmswitch-core/src/servertool/origin-request-store.js';

describe('req inbound origin snapshot', () => {
  test('saves the original inbound request for servertool followup clone', async () => {
    const rawRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit sample' }],
      tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
      parameters: { temperature: 0.3 }
    } as any;
    const adapterContext = {
      requestId: 'req-inbound-origin-snapshot',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 'origin-snapshot-session'
    } as any;

    await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest,
      adapterContext,
      captureContext: () => ({ stage: 'test' })
    });

    const snapshot = loadOriginSnapshot('session:origin-snapshot-session') as any;
    expect(snapshot).toMatchObject({
      requestId: 'req-inbound-origin-snapshot',
      sessionScope: 'session:origin-snapshot-session',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit sample' }],
      tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
      parameters: { temperature: 0.3 },
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });
    expect(snapshot.capturedChatRequest).toEqual(rawRequest);
  });
});

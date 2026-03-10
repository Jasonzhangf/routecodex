import { runInboundPipeline, type InboundPlan } from '../../src/conversion/hub/pipelines/inbound.js';
import { runOutboundPipeline, type OutboundPlan } from '../../src/conversion/hub/pipelines/outbound.js';
import type { AdapterContext, ChatEnvelope } from '../../src/conversion/hub/types/chat-envelope.js';
import type { FormatEnvelope } from '../../src/conversion/hub/types/format-envelope.js';
import type { StageRecorder } from '../../src/conversion/hub/format-adapters/index.js';

class MemoryStageRecorder implements StageRecorder {
  public readonly stages: Array<{ stage: string; payload: object }> = [];
  record(stage: string, payload: object): void {
    this.stages.push({ stage, payload });
  }
}

const context: AdapterContext = {
  requestId: 'req_test',
  entryEndpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages'
};

describe('hub pipelines skeleton', () => {
  test('inbound pipeline records stages and produces ChatEnvelope', async () => {
    const recorder = new MemoryStageRecorder();
    const rawRequest = { body: { text: 'hello' } };
    const formatEnvelope: FormatEnvelope = {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: rawRequest
    };
    const chatEnvelope: ChatEnvelope = {
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { context, missingFields: [{ path: 'instructions', reason: 'absent' }] }
    };

    const inboundPlan: InboundPlan = {
      protocol: 'openai-chat',
      stages: ['format_parse', 'semantic_map_to_chat'],
      formatAdapter: {
        parseRequest: async () => formatEnvelope
      },
      semanticMapper: {
        toChat: async () => chatEnvelope
      }
    };

    const result = await runInboundPipeline({
      rawRequest,
      context,
      plan: inboundPlan,
      stageRecorder: recorder
    });

    expect(result).toEqual(chatEnvelope);
    expect(recorder.stages.map(s => s.stage)).toEqual(['format_parse', 'semantic_map_to_chat']);
    expect((result.metadata.missingFields || [])[0]?.path).toBe('instructions');
  });

  test('outbound pipeline mirrors order and returns protocol payload', async () => {
    const recorder = new MemoryStageRecorder();
    const chatEnvelope: ChatEnvelope = {
      messages: [{ role: 'assistant', content: 'hi' }],
      metadata: { context }
    };
    const formatEnvelope: FormatEnvelope = {
      protocol: 'anthropic-messages',
      direction: 'response',
      payload: { body: { text: 'hi' } }
    };
    const protocolPayload = { body: { text: 'hi' }, headers: {} };

    const outboundPlan: OutboundPlan = {
      protocol: 'anthropic-messages',
      stages: ['semantic_map_from_chat', 'format_build'],
      semanticMapper: {
        fromChat: async () => formatEnvelope
      },
      formatAdapter: {
        buildResponse: async () => protocolPayload
      }
    };

    const result = await runOutboundPipeline({
      chat: chatEnvelope,
      context,
      plan: outboundPlan,
      stageRecorder: recorder
    });

    expect(result).toEqual(protocolPayload);
    expect(recorder.stages.map(s => s.stage)).toEqual(['semantic_map_from_chat', 'format_build']);
  });

  test('inbound passthrough short-circuits', async () => {
    const recorder = new MemoryStageRecorder();
    const envelope: ChatEnvelope = {
      messages: [{ role: 'user', content: 'direct' }],
      metadata: { context }
    };
    const plan: InboundPlan = {
      protocol: 'openai-chat',
      stages: [],
      passthrough: { mode: 'chat', factory: async raw => raw as ChatEnvelope }
    };
    const result = await runInboundPipeline({ rawRequest: envelope, context, plan, stageRecorder: recorder });
    expect(result).toBe(envelope);
    expect(recorder.stages.map(s => s.stage)).toEqual(['inbound_passthrough']);
  });

  test('outbound passthrough short-circuits', async () => {
    const recorder = new MemoryStageRecorder();
    const envelope: ChatEnvelope = {
      messages: [{ role: 'assistant', content: 'done' }],
      metadata: { context }
    };
    const plan: OutboundPlan = {
      protocol: 'openai-chat',
      stages: [],
      passthrough: { mode: 'protocol', factory: async (chatEnv) => ({ passthrough: chatEnv.messages.length }) }
    };
    const result = await runOutboundPipeline({ chat: envelope, context, plan, stageRecorder: recorder });
    expect(result).toEqual({ passthrough: 1 });
    expect(recorder.stages.map(s => s.stage)).toEqual(['outbound_passthrough']);
  });
});

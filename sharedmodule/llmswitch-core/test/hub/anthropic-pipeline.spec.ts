import { runInboundPipeline, type InboundPlan } from '../../src/conversion/hub/pipelines/inbound.js';
import { runOutboundPipeline, type OutboundPlan } from '../../src/conversion/hub/pipelines/outbound.js';
import { AnthropicFormatAdapter } from '../../src/conversion/hub/format-adapters/anthropic-format-adapter.js';
import { AnthropicSemanticMapper } from '../../src/conversion/hub/semantic-mappers/anthropic-mapper.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../../src/conversion/hub/format-adapters/index.js';

class MemoryRecorder implements StageRecorder {
  stages: Array<{ stage: string; payload: object }> = [];
  record(stage: string, payload: object): void {
    this.stages.push({ stage, payload });
  }
}

const ctx: AdapterContext = {
  requestId: 'req_anth_1',
  entryEndpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages',
  providerId: 'glm-anthropic',
  routeId: 'default'
};

const anthropicRequest = {
  model: 'claude-3-sonnet',
  system: [{ type: 'text', text: 'You are a CLI assistant.' }],
  metadata: { variant: 'cli' },
  custom_flag: true,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'List files' }]
    }
  ]
};

describe('Anthropic hub pipeline', () => {
  const formatAdapter = new AnthropicFormatAdapter();
  const semanticMapper = new AnthropicSemanticMapper();
  const inboundPlan: InboundPlan = {
    protocol: 'anthropic-messages',
    stages: ['format_parse', 'semantic_map_to_chat'],
    formatAdapter,
    semanticMapper
  };
  const outboundPlan: OutboundPlan = {
    protocol: 'anthropic-messages',
    stages: ['semantic_map_from_chat', 'format_build'],
    formatAdapter,
    semanticMapper
  };

  test('converts anthropic request to chat envelope and back', async () => {
    const recorder = new MemoryRecorder();
    const inbound = await runInboundPipeline({
      rawRequest: anthropicRequest,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });

    expect(inbound.messages[0].role).toBe('system');
    expect(inbound.messages[1].role).toBe('user');
    expect(inbound.parameters?.model).toBe('claude-3-sonnet');
    expect(inbound.metadata.systemInstructions).toEqual(['You are a CLI assistant.']);
    expect((inbound.metadata.providerMetadata as any).variant).toBe('cli');
    expect((inbound.metadata.extraFields as any).custom_flag).toBe(true);
    expect(recorder.stages.map(s => s.stage)).toEqual(['format_parse', 'semantic_map_to_chat']);

    const outboundPayload = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });

    expect(outboundPayload.model).toBe('claude-3-sonnet');
      expect(outboundPayload.system?.[0]?.text).toContain('You are a CLI assistant');
      expect(outboundPayload.metadata?.variant).toBe('cli');
      expect(outboundPayload.custom_flag).toBe(true);
    });

  test('captures tool results as tool outputs', async () => {
    const recorder = new MemoryRecorder();
    const requestWithTool = {
      model: 'claude-3-sonnet',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
        }
      ]
    };
    const inbound = await runInboundPipeline({
      rawRequest: requestWithTool,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    expect(inbound.toolOutputs?.[0]?.tool_call_id).toBe('toolu_1');
    const outbound = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    expect(outbound.messages?.length).toBeGreaterThan(0);
  });

  test('normalizes tool definitions to canonical names', async () => {
    const recorder = new MemoryRecorder();
    const requestWithTools = {
      model: 'claude-3-sonnet',
      tools: [
        {
          name: 'Bash',
          description: 'Run shell commands',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' }
            }
          }
        },
        {
          name: 'Task',
          input_schema: {
            type: 'object',
            properties: {}
          }
        }
      ],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'ls' } }]
        }
      ]
    };
    const inbound = await runInboundPipeline({
      rawRequest: requestWithTools,
      context: ctx,
      plan: inboundPlan,
      stageRecorder: recorder
    });
    expect(inbound.tools?.map((tool) => tool.function.name)).toEqual(['shell_command', 'task']);
    const outboundPayload = await runOutboundPipeline({
      chat: inbound,
      context: ctx,
      plan: outboundPlan,
      stageRecorder: recorder
    });
    const outboundTools = Array.isArray(outboundPayload.tools) ? outboundPayload.tools : [];
    expect(outboundTools.map((tool: any) => tool.name)).toEqual(['Bash', 'Task']);
  });

  test('defaults ark-coding-plan outbound requests to high thinking', async () => {
    const recorder = new MemoryRecorder();
    const inbound = await runInboundPipeline({
      rawRequest: anthropicRequest,
      context: {
        ...ctx,
        providerId: 'ark-coding-plan',
        providerKey: 'ark-coding-plan.kimi-k2.5'
      } as AdapterContext,
      plan: inboundPlan,
      stageRecorder: recorder
    });

    const outboundPayload = await runOutboundPipeline({
      chat: inbound,
      context: {
        ...ctx,
        providerId: 'ark-coding-plan',
        providerKey: 'ark-coding-plan.kimi-k2.5'
      } as AdapterContext,
      plan: outboundPlan,
      stageRecorder: recorder
    });

    expect(outboundPayload.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  test('preserves explicit reasoning disable for ark-coding-plan', async () => {
    const recorder = new MemoryRecorder();
    const inbound = await runInboundPipeline({
      rawRequest: anthropicRequest,
      context: {
        ...ctx,
        providerId: 'ark-coding-plan',
        providerKey: 'ark-coding-plan.doubao-seed-2.0-code'
      } as AdapterContext,
      plan: inboundPlan,
      stageRecorder: recorder
    });

    inbound.parameters = {
      ...(inbound.parameters ?? {}),
      reasoning: false
    };

    const outboundPayload = await runOutboundPipeline({
      chat: inbound,
      context: {
        ...ctx,
        providerId: 'ark-coding-plan',
        providerKey: 'ark-coding-plan.doubao-seed-2.0-code'
      } as AdapterContext,
      plan: outboundPlan,
      stageRecorder: recorder
    });

    expect(outboundPayload.thinking).toEqual({ type: 'disabled' });
  });
});

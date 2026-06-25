import { describe, expect, it } from '@jest/globals';

import { buildMetadataCenterRustSnapshot } from '../../src/server/runtime/http-server/metadata-center/dualwrite-api.ts';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { writeStoplessRuntimeControl } from '../../src/server/runtime/http-server/metadata-center/request-truth-readers.ts';
import { writeStoplessRuntimeControlToBoundMetadataCenter } from '../../sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts';
import { normalizeStoplessTriggerHintForMetadata } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';

describe('stopless metadata center helper', () => {
  it('writes stopless runtime control into MetadataCenter as the request-local control truth', () => {
    const metadata: Record<string, unknown> = {};

    writeStoplessRuntimeControl({
      metadata,
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        active: true
      },
      writer: {
        module: 'tests/servertool/stopless-metadata-center.spec.ts',
        symbol: 'writes stopless runtime control into MetadataCenter as the request-local control truth',
        stage: 'test'
      }
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        continuationPrompt: '继续做下一步；先把手头能确认的结果拿回来。',
        active: true
      })
    );
    expect(buildMetadataCenterRustSnapshot(metadata).runtimeControl?.stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3
      })
    );
    expect(center?.readRuntimeControl().stopless).not.toHaveProperty('sessionId');
  });

  it('writes through the sharedmodule metadata side-channel when a MetadataCenter is already bound', () => {
    const metadata: Record<string, unknown> = {};
    MetadataCenter.attach(metadata);

    writeStoplessRuntimeControlToBoundMetadataCenter({
      metadata,
      value: {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行',
        active: true
      },
      writer: {
        module: 'tests/servertool/stopless-metadata-center.spec.ts',
        symbol: 'writes through the sharedmodule metadata side-channel when a MetadataCenter is already bound',
        stage: 'test'
      },
      reason: 'test-side-channel'
    });

    const center = MetadataCenter.read(metadata);
    expect(center?.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        continuationPrompt: '继续执行',
        active: true
      })
    );
    expect(buildMetadataCenterRustSnapshot(metadata).runtimeControl?.stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3
      })
    );
    expect(center?.readRuntimeControl().stopless).not.toHaveProperty('sessionId');
  });

  it('fails fast when a required stopless runtime control write has no MetadataCenter binding', () => {
    const metadata: Record<string, unknown> = {};

    expect(() =>
      writeStoplessRuntimeControlToBoundMetadataCenter({
        metadata,
        value: {
          flowId: 'stop_message_flow',
          repeatCount: 1,
          maxRepeats: 3,
          continuationPrompt: '继续执行',
          active: true
        },
        writer: {
          module: 'tests/servertool/stopless-metadata-center.spec.ts',
          symbol: 'fails fast when a required stopless runtime control write has no MetadataCenter binding',
          stage: 'test'
        },
        reason: 'test-required-side-channel',
        required: true
      })
    ).toThrow(/requires a bound MetadataCenter/);
  });

  it('preserves stopless MetadataCenter binding when adapter root lacks the symbol but metadata bag already owns it', async () => {
    const metadata: Record<string, unknown> = {
      __rt: {
        stopMessageState: {
          stopMessageText: '继续推进当前任务。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1
        }
      }
    };
    const center = MetadataCenter.attach(metadata);

    const adapterContext: Record<string, unknown> = {
      requestId: 'req-stopless-rootless-center',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-rootless-center',
      metadata,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    };

    await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-stopless-rootless-center',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段结束'
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: adapterContext as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopless-rootless-center',
      providerProtocol: 'openai-responses'
    });

    expect(center.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        active: true
      })
    );
    expect(center.readRuntimeControl().stopless).not.toHaveProperty('sessionId');
  });

  it('inherits stopless MetadataCenter binding from adapter root when metadata bag is created during finalize', async () => {
    const adapterContext: Record<string, unknown> = {
      requestId: 'req-stopless-root-center',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-root-center',
      __rt: {
        stopMessageState: {
          stopMessageText: '继续推进当前任务。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1
        }
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    };
    const center = MetadataCenter.attach(adapterContext);

    await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-stopless-root-center',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段结束'
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: adapterContext as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopless-root-center',
      providerProtocol: 'openai-responses'
    });

    expect(adapterContext.metadata).toEqual(expect.any(Object));
    expect(center.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        active: true
      })
    );
    expect(center.readRuntimeControl().stopless).not.toHaveProperty('sessionId');
    expect(MetadataCenter.read(adapterContext.metadata as Record<string, unknown>)).toBe(center);
  });

  it('persists next visible repeatCount from existing stop state when no current CLI output is present', async () => {
    const adapterContext: Record<string, unknown> = {
      requestId: 'req-stopless-repeatcount-persist',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-repeatcount-persist',
      __rt: {
        stopMessageState: {
          stopMessageText: '继续推进当前任务。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1,
          stopMessageStageMode: 'on'
        }
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    };
    const center = MetadataCenter.attach(adapterContext);

    const result = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-stopless-repeatcount-persist',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段结束'
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: adapterContext as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopless-repeatcount-persist',
      providerProtocol: 'openai-responses'
    });

    expect(center.readRuntimeControl().stopless).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        active: true
      })
    );
    expect((result.execution?.context as any)?.serverToolLoopState).toEqual(
      expect.objectContaining({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3
      })
    );
  });

  it('persists stop-message compare context into MetadataCenter after projection finalize', async () => {
    const adapterContext: Record<string, unknown> = {
      requestId: 'req-stopless-compare-context-persist',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-compare-context-persist',
      __rt: {
        stopMessageState: {
          stopMessageText: '请补齐 stop schema 后继续。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1,
          stopMessageStageMode: 'on'
        }
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    };
    const center = MetadataCenter.attach(adapterContext);

    const result = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-stopless-compare-context-persist',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段结束'
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: adapterContext as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopless-compare-context-persist',
      providerProtocol: 'openai-responses'
    });

    expect(center.readRuntimeControl().stopMessageCompareContext).toEqual(
      expect.objectContaining({
        decision: 'trigger',
        reason: expect.any(String),
        used: 1,
        observationStableCount: expect.any(Number)
      })
    );
    expect((result.execution?.context as any)?.stopSchemaFeedback).toBeDefined();
  });

  it('normalizes stop schema reason codes into MetadataCenter triggerHint tokens', () => {
    expect(normalizeStoplessTriggerHintForMetadata('stop_schema_budget_exhausted')).toBe('budget_exhausted');
    expect(normalizeStoplessTriggerHintForMetadata('stop_schema_finished')).toBe('schema_pass');
    expect(normalizeStoplessTriggerHintForMetadata('stop_schema_next_step_missing')).toBe('invalid_schema');
    expect(normalizeStoplessTriggerHintForMetadata('stop_schema_missing')).toBe('no_schema');
  });
});

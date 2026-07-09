import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  buildMetadataCenterTransportSnapshot,
  readMetadataCenterSlot,
  writeMetadataCenterSlot
} from '../../../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';
import {
  finalizeRequestExecutorAttemptMetadata,
  prepareRequestExecutorAttemptState
} from '../../../../../src/server/runtime/http-server/executor/request-executor-attempt-state.js';

const ROOT = process.cwd();
const ATTEMPT_STATE_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/request-executor-attempt-state.ts'
);

function sliceBetween(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  if (!endMarker) {
    return source.slice(start);
  }
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('request-executor attempt-state contract', () => {
  it('moves retry provider pin into MetadataCenter runtime_control at runtime', () => {
    const initialMetadata: Record<string, unknown> = {
      __routecodexRetryProviderKey: 'legacy.flat.should.be.deleted',
      excludedProviderKeys: ['first.provider'],
    };
    const input = {
      requestId: 'req-attempt-1',
      body: { model: 'gpt-5.5', input: [] },
    } as never;

    const result = prepareRequestExecutorAttemptState({
      input,
      providerRequestId: 'req-attempt-2',
      retryPayloadSeed: { mode: 'none' },
      attempt: 2,
      initialMetadata,
      excludedProviderKeys: new Set(['first.provider']),
      retryProviderKey: 'retry.provider.gpt-5.5',
      inboundClientHeaders: undefined,
      clientRequestId: 'client-req-1',
      throwIfClientAbortSignalAborted: () => {},
    });

    expect(result.metadataForAttempt).not.toHaveProperty('__routecodexRetryProviderKey');
    expect(result.metadataForAttempt).not.toHaveProperty('excludedProviderKeys');
    expect(MetadataCenter.read(result.metadataForAttempt)?.readRuntimeControl().retryProviderKey)
      .toBe('retry.provider.gpt-5.5');
  });

  it('promotes responsesResume providerKey from MetadataCenter continuation truth into runtime_control retry pin', () => {
    const initialMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(initialMetadata);
    center.writeContinuationContext(
      'responsesResume',
      {
        providerKey: 'primary.key1.gpt-test',
        restoredFromResponseId: 'resp_prev_1',
      },
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'promotes responsesResume providerKey from MetadataCenter continuation truth into runtime_control retry pin',
        stage: 'test_setup'
      }
    );
    const input = {
      requestId: 'req-attempt-1',
      body: { model: 'gpt-test', input: [] },
    } as never;

    const result = prepareRequestExecutorAttemptState({
      input,
      providerRequestId: 'req-attempt-2',
      retryPayloadSeed: { mode: 'none' },
      attempt: 1,
      initialMetadata,
      excludedProviderKeys: new Set<string>(),
      inboundClientHeaders: undefined,
      clientRequestId: 'client-req-1',
      throwIfClientAbortSignalAborted: () => {},
    });

    expect(MetadataCenter.read(result.metadataForAttempt)?.readRuntimeControl().retryProviderKey)
      .toBe('primary.key1.gpt-test');
  });

  it('does not promote relay responsesResume providerKey into retry pin or clear excluded providers', () => {
    const initialMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(initialMetadata);
    center.writeContinuationContext(
      'responsesResume',
      {
        providerKey: 'primary.key1.gpt-test',
        continuationOwner: 'relay',
        restoredFromResponseId: 'resp_prev_1',
      },
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'does not promote relay responsesResume providerKey into retry pin or clear excluded providers',
        stage: 'test_setup'
      }
    );
    const input = {
      requestId: 'req-attempt-relay-1',
      body: { model: 'gpt-test', input: [] },
    } as never;

    const result = prepareRequestExecutorAttemptState({
      input,
      providerRequestId: 'req-attempt-relay-2',
      retryPayloadSeed: { mode: 'none' },
      attempt: 2,
      initialMetadata,
      excludedProviderKeys: new Set<string>(['primary.key1.gpt-test']),
      inboundClientHeaders: undefined,
      clientRequestId: 'client-req-relay-1',
      throwIfClientAbortSignalAborted: () => {},
    });

    expect(MetadataCenter.read(result.metadataForAttempt)?.readRuntimeControl().retryProviderKey)
      .toBeUndefined();
    expect(result.metadataForAttempt.excludedProviderKeys).toEqual(['primary.key1.gpt-test']);
  });

  it('preserves resumed relay session scope from MetadataCenter request truth into attempt metadata', () => {
    const initialMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(initialMetadata);
    center.writeRequestTruth(
      'sessionId',
      'sess-stopless-live-1',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'preserves resumed relay session scope from MetadataCenter request truth into attempt metadata',
        stage: 'test_setup'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'conv-stopless-live-1',
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'preserves resumed relay session scope from MetadataCenter request truth into attempt metadata',
        stage: 'test_setup'
      }
    );
    const input = {
      requestId: 'req-attempt-1',
      body: { model: 'gpt-test', input: [] },
    } as never;

    const result = prepareRequestExecutorAttemptState({
      input,
      providerRequestId: 'req-attempt-2',
      retryPayloadSeed: { mode: 'none' },
      attempt: 1,
      initialMetadata,
      excludedProviderKeys: new Set<string>(),
      inboundClientHeaders: undefined,
      clientRequestId: 'client-req-1',
      throwIfClientAbortSignalAborted: () => {},
    });

    expect(MetadataCenter.read(result.metadataForAttempt)?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-stopless-live-1',
      conversationId: 'conv-stopless-live-1'
    });
  });

  it('writes retry provider pin to MetadataCenter runtime_control instead of flat metadata', () => {
    const source = fs.readFileSync(ATTEMPT_STATE_PATH, 'utf8');
    const prepareBlock = sliceBetween(
      source,
      `export function ${'prepareRequestExecutorAttemptState'}`,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );
    const finalizeBlock = sliceBetween(
      source,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );

    expect(prepareBlock).toContain('writeRuntimeControlSlot(');
    expect(prepareBlock).toContain("'retryProviderKey'");
    expect(prepareBlock).not.toContain('metadataForAttempt.__routecodexRetryProviderKey =');
    expect(prepareBlock).toContain("delete metadataForAttempt.__routecodexRetryProviderKey;");
    expect(finalizeBlock).not.toContain('__routecodexRetryProviderKey');
    expect(source).not.toContain('__routecodexPreselectedRoute');
  });

  it('fails fast when pipeline result returns a second runtime carrier', () => {
    const attemptMetadata: Record<string, unknown> = {};
    const pipelineMetadata: Record<string, unknown> = {};
    MetadataCenter.attach(attemptMetadata).writeRuntimeControl(
      'stopMessageEnabled',
      true,
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'fails fast when pipeline result returns a second MetadataCenter',
        stage: 'test_setup_request'
      }
    );
    MetadataCenter.attach(pipelineMetadata).writeRuntimeControl(
      'stopMessageEnabled',
      false,
      {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'fails fast when pipeline result returns a second MetadataCenter',
        stage: 'test_setup_pipeline'
      }
    );

    expect(() =>
      finalizeRequestExecutorAttemptMetadata({
        requestId: 'req-second-center',
        metadataForAttempt: attemptMetadata,
        pipelineResult: {
          providerPayload: {},
          target: {
            providerKey: 'provider.test',
            providerType: 'openai',
            outboundProfile: 'default',
          },
          processMode: 'chat',
          metadata: pipelineMetadata,
        },
        clientHeadersForAttempt: undefined,
        clientRequestId: 'client-second-center',
      })
    ).toThrow(
      'request-executor attempt metadata violated single-center contract: pipeline result returned a second runtime carrier'
    );
  });

  it('applies Rust pipeline metadataCenterSnapshot onto the bound MetadataCenter without creating a second center', () => {
    const attemptMetadata: Record<string, unknown> = {};
    writeMetadataCenterSlot({
      target: attemptMetadata,
      family: 'request_truth',
      key: 'requestId',
      value: 'req-stopless-pipeline-writeback',
      writer: {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'applies Rust pipeline metadataCenterSnapshot onto the bound MetadataCenter without creating a second center',
        stage: 'test_setup'
      }
    });
    writeMetadataCenterSlot({
      target: attemptMetadata,
      family: 'request_truth',
      key: 'sessionId',
      value: 'sess-stopless-pipeline-writeback',
      writer: {
        module: 'tests/server/runtime/http-server/executor/request-executor-attempt-state.contract.spec.ts',
        symbol: 'applies Rust pipeline metadataCenterSnapshot onto the bound MetadataCenter without creating a second center',
        stage: 'test_setup'
      }
    });
    const pipelineMetadata = {
      metadataCenterSnapshot: {
        runtimeControl: {
          stopless: {
            active: true,
            flowId: 'stop_message_flow',
            sessionId: 'sess-stopless-pipeline-writeback',
            repeatCount: 1,
            maxRepeats: 3,
            triggerHint: 'invalid_schema',
            continuationPrompt: '运行下一步',
            schemaFeedback: {
              reasonCode: 'stop_schema_next_step_missing',
              missingFields: ['next_step']
            }
          }
        }
      }
    };

    const result = finalizeRequestExecutorAttemptMetadata({
      requestId: 'req-stopless-pipeline-writeback',
      metadataForAttempt: attemptMetadata,
      pipelineResult: {
        providerPayload: {},
        target: {
          providerKey: 'provider.test',
          providerType: 'openai',
          outboundProfile: 'default',
        },
        processMode: 'chat',
        metadata: pipelineMetadata,
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-stopless-pipeline-writeback',
    });

    expect(readMetadataCenterSlot({
      source: result.mergedMetadata,
      family: 'runtime_control',
      key: 'stopless',
      expectedScope: {
        requestId: 'req-stopless-pipeline-writeback',
        sessionId: 'sess-stopless-pipeline-writeback'
      }
    })).toEqual(expect.objectContaining({
      repeatCount: 1,
      maxRepeats: 3,
      continuationPrompt: '运行下一步'
    }));
    expect(buildMetadataCenterTransportSnapshot(result.mergedMetadata)?.runtimeControl)
      .toEqual(expect.objectContaining({
        stopless: expect.objectContaining({
          repeatCount: 1,
          maxRepeats: 3,
          continuationPrompt: '运行下一步'
        })
      }));
  });

  it('does not reintroduce second-center merge logic into finalizeRequestExecutorAttemptMetadata', () => {
    const source = fs.readFileSync(ATTEMPT_STATE_PATH, 'utf8');
    const finalizeBlock = sliceBetween(
      source,
      `export function ${'finalizeRequestExecutorAttemptMetadata'}`
    );

    expect(finalizeBlock).toContain(
      'request-executor attempt metadata violated single-center contract: pipeline result returned a second runtime carrier'
    );
    expect(finalizeBlock).not.toContain('pipelineMetadataCenter.snapshot().runtimeControl');
    expect(finalizeBlock).not.toContain('merged from pipeline result metadata center');
    expect(finalizeBlock).not.toContain('mergedCenter?.writeRuntimeControl(');
    expect(finalizeBlock).not.toContain('mergedMetadata.__routecodexRetryProviderKey');
    expect(finalizeBlock).not.toContain('mergedMetadata.__routecodexPreselectedRoute');
  });
});

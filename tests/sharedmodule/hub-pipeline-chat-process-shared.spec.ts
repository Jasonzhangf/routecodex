import { describe, expect, it, jest } from '@jest/globals';

const resolveActiveProcessModeWithNative = jest.fn();
const buildPassthroughAuditWithNative = jest.fn();
const stripHistoricalImageAttachments = jest.fn();
const stripHistoricalVisualToolOutputs = jest.fn();
const peekHubStageTopSummary = jest.fn();
const ensureRuntimeMetadata = jest.fn((metadata: unknown) => {
  const record = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  if (!record.__rt || typeof record.__rt !== 'object') {
    record.__rt = {};
  }
  return record.__rt as Record<string, unknown>;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    resolveActiveProcessModeWithNative,
    buildPassthroughAuditWithNative,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-media.js',
  () => ({
    stripHistoricalImageAttachments,
    stripHistoricalVisualToolOutputs,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js',
  () => ({
    peekHubStageTopSummary,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    ensureRuntimeMetadata,
  }),
);

const {
  sanitizeStandardizedRequestMessages,
  resolveActiveProcessModeAndAudit,
  attachHubStageTopSummary,
} = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-shared.js');

describe('hub pipeline chat process shared blocks', () => {
  it('sanitizes messages by applying image-strip then visual-tool-output-strip', () => {
    stripHistoricalImageAttachments.mockReturnValueOnce([{ role: 'user', content: 'img-stripped' }]);
    stripHistoricalVisualToolOutputs.mockReturnValueOnce([{ role: 'user', content: 'visual-stripped' }]);
    const standardizedRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'raw' }],
    } as any;

    const sanitized = sanitizeStandardizedRequestMessages(standardizedRequest);

    expect(stripHistoricalImageAttachments).toHaveBeenCalledWith(standardizedRequest.messages);
    expect(stripHistoricalVisualToolOutputs).toHaveBeenCalledWith([{ role: 'user', content: 'img-stripped' }]);
    expect(sanitized.messages).toEqual([{ role: 'user', content: 'visual-stripped' }]);
  });

  it('resolves passthrough mode and emits passthrough audit', () => {
    resolveActiveProcessModeWithNative.mockReturnValueOnce('passthrough');
    buildPassthroughAuditWithNative.mockReturnValueOnce({ reason: 'passthrough_detected' });
    const normalized = { processMode: 'chat', providerProtocol: 'openai-chat' } as any;

    const result = resolveActiveProcessModeAndAudit({
      normalized,
      requestMessages: [{ role: 'user', content: 'hi' }] as any,
      rawPayload: { messages: [] },
    });

    expect(normalized.processMode).toBe('passthrough');
    expect(result.activeProcessMode).toBe('passthrough');
    expect(result.passthroughAudit).toEqual({ reason: 'passthrough_detected' });
    expect(buildPassthroughAuditWithNative).toHaveBeenCalledWith({ messages: [] }, 'openai-chat');
  });

  it('attaches hubStageTop into runtime metadata without dropping existing runtime fields', () => {
    peekHubStageTopSummary.mockReturnValueOnce([
      { stage: 'req_inbound.stage2_semantic_map', totalMs: 12 },
    ]);
    const metadata = {
      __rt: {
        existingFlag: true,
        existingCounter: 7,
      },
    } as Record<string, unknown>;

    attachHubStageTopSummary({
      requestId: 'req_top_summary',
      metadata,
    });

    const rt = (metadata.__rt ?? {}) as Record<string, unknown>;
    expect(rt.existingFlag).toBe(true);
    expect(rt.existingCounter).toBe(7);
    expect(Array.isArray(rt.hubStageTop)).toBe(true);
    expect((rt.hubStageTop as Array<Record<string, unknown>>)[0]?.stage).toBe('req_inbound.stage2_semantic_map');
  });
});


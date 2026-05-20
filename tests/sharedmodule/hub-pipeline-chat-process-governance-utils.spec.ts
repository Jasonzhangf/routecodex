import { describe, expect, it, jest } from '@jest/globals';

const mergeClockReservationIntoMetadataWithNative = jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => ({
  ...metadata,
  clockReservationApplied: true,
}));
const annotatePassthroughGovernanceSkipWithNative = jest.fn((audit: Record<string, unknown>) => ({
  ...audit,
  skipped: true,
}));
const buildPassthroughGovernanceSkippedNodeWithNative = jest.fn(() => ({ stage: 'req_process_skipped' }));
const buildToolGovernanceNodeResultWithNative = jest.fn((value: unknown) => value);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    mergeClockReservationIntoMetadataWithNative,
    annotatePassthroughGovernanceSkipWithNative,
    buildPassthroughGovernanceSkippedNodeWithNative,
    buildToolGovernanceNodeResultWithNative,
  }),
);

const { propagateClockReservationToMetadata, annotatePassthroughAuditSkipped } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-governance-utils.js'
);

describe('hub pipeline chat-process governance utils', () => {
  it('merges clock reservation metadata in place', () => {
    const metadata: Record<string, unknown> = { existing: true };

    propagateClockReservationToMetadata(
      { processed: true } as any,
      metadata,
    );

    expect(mergeClockReservationIntoMetadataWithNative).toHaveBeenCalledWith({
      processedRequest: { processed: true },
      metadata,
    });
    expect(metadata).toEqual({
      existing: true,
      clockReservationApplied: true,
    });
  });

  it('annotates passthrough audit in place', () => {
    const audit: Record<string, unknown> = { mode: 'passthrough' };

    annotatePassthroughAuditSkipped(audit);

    expect(annotatePassthroughGovernanceSkipWithNative).toHaveBeenCalledWith(audit);
    expect(audit).toEqual({
      mode: 'passthrough',
      skipped: true,
    });
  });
});

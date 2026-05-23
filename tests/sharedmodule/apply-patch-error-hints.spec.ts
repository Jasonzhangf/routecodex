import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockAugmentApplyPatchErrorContentWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js',
  () => ({
    augmentApplyPatchErrorContentWithNative: mockAugmentApplyPatchErrorContentWithNative,
    mapOpenaiChatToChatWithNative: jest.fn(),
    mapOpenaiChatFromChatWithNative: jest.fn()
  })
);

describe('apply_patch error hints', () => {
  beforeEach(() => {
    jest.resetModules();
    mockAugmentApplyPatchErrorContentWithNative.mockReset();
  });

  it('chat semantic mapper no longer owns apply_patch-specific error hinting', async () => {
    mockAugmentApplyPatchErrorContentWithNative.mockImplementation((content: string) => content);
    const { maybeAugmentApplyPatchErrorContent } = await import(
      '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper.js'
    );
    const content =
      "apply_patch verification failed: invalid hunk at line 2, '--- a/src/server/index.ts' is not a valid hunk header.";
    const augmented = maybeAugmentApplyPatchErrorContent(content, 'apply_patch');
    expect(augmented).toBe(content);
  });

  it('does not inject mixed-syntax guidance text at chat mapper layer anymore', async () => {
    const content =
      "apply_patch verification failed: invalid hunk at line 2, '--- a/src/server/index.ts' is not a valid hunk header.";
    mockAugmentApplyPatchErrorContentWithNative.mockImplementation(() => `${content}\n[APPLY_PATCH_MIXED_SYNTAX]`);
    const { maybeAugmentApplyPatchErrorContent } = await import(
      '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper.js'
    );
    const augmented = maybeAugmentApplyPatchErrorContent(content, 'apply_patch');
    expect(augmented).toBe(content);
  });
});

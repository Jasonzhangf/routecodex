import { maybeAugmentApplyPatchErrorContent } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper.js';

describe('apply_patch error hints', () => {
  it('adds a mixed-syntax hint for Begin Patch payloads that still include GNU diff headers', () => {
    const content =
      "apply_patch verification failed: invalid hunk at line 2, '--- a/src/server/index.ts' is not a valid hunk header.";
    const augmented = maybeAugmentApplyPatchErrorContent(content, 'apply_patch');
    expect(augmented).toContain('块内不要再写 `--- a/...` / `+++ b/...`');
    expect(augmented).toContain('二选一');
  });

  it('adds a context-mismatch hint for guessed GNU line-number hunks', () => {
    const content =
      "apply_patch verification failed: Failed to find context '-50,6 +50,8 @@' in src/server/index.ts";
    const augmented = maybeAugmentApplyPatchErrorContent(content, 'apply_patch');
    expect(augmented).toContain('更小且唯一的上下文');
    expect(augmented).toContain('不要依赖猜测出来的 `@@ -x,y +x,y @@` 行号范围');
  });
});

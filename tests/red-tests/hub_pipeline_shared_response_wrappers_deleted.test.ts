import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Hub Pipeline shared response wrapper deletion boundary', () => {
  it('keeps zero-consumer output content wrapper file deleted', () => {
    const native = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts');
    const rust = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_output_content_normalizer.rs');
    const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');

    expect(() => read('sharedmodule/llmswitch-core/src/conversion/shared/output-content-normalizer.ts')).toThrow();
    expect(native).not.toMatch(/\bextractOutputSegmentsWithNative\b/);
    expect(native).not.toMatch(/\bnormalizeContentPartWithNative\b/);
    expect(rust).not.toMatch(/\bextract_output_segments_json\b/);
    expect(rust).not.toMatch(/\bnormalize_output_content_part_json\b/);
    expect(requiredExports).not.toContain('extractOutputSegmentsJson');
    expect(requiredExports).not.toContain('normalizeOutputContentPartJson');
  });

  it('keeps zero-consumer response reasoning wrapper file deleted', () => {
    expect(() => read('sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.ts')).toThrow();
  });

  it('keeps zero-consumer single-tool mapping wrappers deleted', () => {
    const nativeBarrel = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts');
    const rustLib = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs');
    const rustMapping = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_mapping.rs');
    const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');

    expect(() => read('sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.ts')).toThrow();
    expect(() => read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tool-definitions.ts')).toThrow();
    expect(nativeBarrel).not.toContain('bridgeToolToChatDefinitionWithNative');
    expect(nativeBarrel).not.toContain('chatToolToBridgeDefinitionWithNative');
    expect(rustLib).not.toMatch(/\bbridge_tool_to_chat_definition_json\b/);
    expect(rustLib).not.toMatch(/\bchat_tool_to_bridge_definition_json\b/);
    expect(rustMapping).not.toMatch(/\bbridge_tool_to_chat_definition_json\b/);
    expect(rustMapping).not.toMatch(/\bchat_tool_to_bridge_definition_json\b/);
    expect(requiredExports).not.toContain('bridgeToolToChatDefinitionJson');
    expect(requiredExports).not.toContain('chatToolToBridgeDefinitionJson');
  });

  it('keeps zero-consumer responses tool utility wrappers deleted', () => {
    const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');

    expect(() => read('sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts')).toThrow();
    expect(() => read('sharedmodule/llmswitch-core/scripts/tests/coverage-responses-tool-utils.mjs')).toThrow();
    expect(existsSync(join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(requiredExports).toContain('createToolCallIdTransformerJson');
    expect(requiredExports).not.toContain('normalizeResponsesToolCallIdsWithNative');
    expect(requiredExports).not.toContain('resolveToolCallIdStyleWithNative');
  });
});

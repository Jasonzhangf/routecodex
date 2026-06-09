import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Hub Pipeline shared response wrapper deletion boundary', () => {
  it('keeps zero-consumer output content wrappers deleted', () => {
    const source = read('sharedmodule/llmswitch-core/src/conversion/shared/output-content-normalizer.ts');
    const native = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts');
    const rust = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_output_content_normalizer.rs');
    const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');

    expect(source).toContain('normalizeMessageContentPartsWithNative');
    expect(source).not.toMatch(/export\s+function\s+extractOutputSegments\b/);
    expect(source).not.toMatch(/export\s+function\s+normalizeContentPart\b/);
    expect(source).not.toMatch(/export\s+interface\s+OutputContentExtractionResult\b/);
    expect(native).not.toMatch(/\bextractOutputSegmentsWithNative\b/);
    expect(native).not.toMatch(/\bnormalizeContentPartWithNative\b/);
    expect(rust).not.toMatch(/\bextract_output_segments_json\b/);
    expect(rust).not.toMatch(/\bnormalize_output_content_part_json\b/);
    expect(requiredExports).not.toContain('extractOutputSegmentsJson');
    expect(requiredExports).not.toContain('normalizeOutputContentPartJson');
  });

  it('keeps zero-consumer response reasoning wrapper deleted', () => {
    const source = read('sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.ts');

    expect(source).toContain('normalizeMessageReasoningToolsWithNative');
    expect(source).not.toMatch(/export\s+function\s+normalizeChatResponseReasoningTools\b/);
    expect(source).not.toMatch(/export\s+interface\s+ReasoningNormalizationResult\b/);
    expect(source).not.toContain('normalizeChatResponseReasoningToolsWithNative');
  });

  it('keeps zero-consumer single-tool mapping wrappers deleted', () => {
    const source = read('sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.ts');
    const nativeToolDefs = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tool-definitions.ts');
    const nativeBarrel = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts');
    const rustLib = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs');
    const rustMapping = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_mapping.rs');
    const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts');

    expect(source).toContain('mapBridgeToolsToChatWithNative');
    expect(source).toContain('mapChatToolsToBridgeWithNative');
    expect(source).not.toMatch(/export\s+function\s+bridgeToolToChatDefinition\b/);
    expect(source).not.toMatch(/export\s+function\s+chatToolToBridgeDefinition\b/);
    expect(source).not.toMatch(/export\s+function\s+stringifyArgs\b/);
    expect(source).not.toMatch(/export\s+interface\s+ToolCallFunction\b/);
    expect(source).not.toMatch(/export\s+interface\s+ToolCallItem\b/);
    expect(nativeToolDefs).not.toContain('bridgeToolToChatDefinitionWithNative');
    expect(nativeToolDefs).not.toContain('chatToolToBridgeDefinitionWithNative');
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
    const source = read('sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts');
    const coverage = read('sharedmodule/llmswitch-core/scripts/tests/coverage-responses-tool-utils.mjs');

    expect(source).toContain('createToolCallIdTransformerWithNative');
    expect(source).not.toMatch(/export\s+function\s+normalizeResponsesToolCallIds\b/);
    expect(source).not.toMatch(/export\s+function\s+resolveToolCallIdStyle\b/);
    expect(source).not.toContain('normalizeResponsesToolCallIdsWithNative');
    expect(source).not.toContain('resolveToolCallIdStyleWithNative');
    expect(coverage).not.toMatch(/\bnormalizeResponsesToolCallIds\b/);
    expect(coverage).not.toMatch(/\bresolveToolCallIdStyle\b/);
  });
});

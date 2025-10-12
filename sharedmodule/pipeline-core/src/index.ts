// Phase-1 shim exports: re-export core pipeline APIs from current codebase
// Note: These are temporary relative re-exports to enable incremental extraction.
// In later phases, the implementations will live inside this package.

// Interfaces and shared pipeline contracts
export * from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces';

// Core manager and assembler
export { default as PipelineManager } from '../../../../src/modules/pipeline/core/pipeline-manager';
export { default as PipelineAssembler } from '../../../../src/modules/pipeline/config/pipeline-assembler';

// LLMSwitch conversion utilities (public, stable surface for routers)
export { AnthropicOpenAIConverter } from '../../../../src/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai';


# Gemini CLI Protocol Mapping Implementation

## Overview
Implemented proper protocol mapping for Gemini CLI responses to OpenAI-compatible format, ensuring tool calls, thinking/reasoning, and other metadata are preserved and correctly transformed.

## Problem
Previously, `GeminiSseNormalizer` would silently drop any SSE events that didn't match the expected format:
- Tool calls (`functionCall`, `functionResponse`) were discarded
- Thinking/reasoning content was lost
- Code execution events were ignored
- Stream would terminate prematurely (showing only 8 events instead of complete response)

## Solution
Rewrote `emitCandidateParts` method in `src/providers/core/runtime/gemini-cli-http-provider.ts` to map all Gemini part types to OpenAI/Chat-compatible semantics:

### Mapping Rules

| Gemini Part Type | Target Format | Description |
|-----------------|---------------|-------------|
| `text` | `type: 'text', content: string` | Regular text content → delta text |
| `functionCall` | `type: 'tool_call', tool_call: {...}` | Tool invocation → OpenAI `tool_calls` |
| `functionResponse` | `type: 'tool_response', tool_response: {...}` | Tool result → tool message |
| `thought` | `type: 'reasoning', reasoning_content: string` | Thinking process → reasoning content (o1-style) |
| `executableCode` | `type: 'code', code_content: {...}` | Code to execute → code_interpreter |
| `codeExecutionResult` | `type: 'code_result', code_result: {...}` | Execution output → code output |
| Unknown types | `type: 'metadata', metadata: {...}` | Preserve in metadata for outbound processing |

### Implementation Details

1. **Tool Calls**: Maps `functionCall` to OpenAI `tool_calls` format with generated call IDs
2. **Reasoning**: Maps `thought` to `reasoning_content` for models with thinking capability
3. **Code Execution**: Preserves code and execution results for code_interpreter tools
4. **Metadata Preservation**: Unknown part types are wrapped in metadata for downstream processing

### Outbound Processing
The response outbound layer (in `llmswitch-core`) will:
- Transform these typed events to target protocol format (OpenAI/Anthropic/etc)
- Drop metadata fields not supported by target protocol
- Preserve chat-compatible fields in final response

## Benefits
- ✅ Complete streaming responses (no premature termination)
- ✅ Tool calls work correctly with Gemini providers
- ✅ Thinking/reasoning preserved for Advanced Reasoning models
- ✅ Extensible to future Gemini part types
- ✅ No data loss - all events properly mapped or logged

## Testing
After restarting the server with v0.89.371+:
- Tool call requests should show complete responses
- Thinking models should stream reasoning content
- No more "8 events then stop" issues
- Logs will show any unmapped part types (for debugging)

## Version
- Fixed in: v0.89.371
- Files modified: `src/providers/core/runtime/gemini-cli-http-provider.ts`

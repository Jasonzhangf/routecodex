# Gemini SSE Stream Processing Issue - Root Cause & Solution

## Current Status
- ✅ `GeminiSseNormalizer` correctly sends 15 events with raw `part` objects
- ❌ Only 8 events reach the client (7 events dropped)

## Architecture Flow
```
Gemini CLI (upstream)
  ↓ SSE stream
GeminiCLIHttpProvider.GeminiSseNormalizer
  ↓ parse SSE → emit `gemini.data` events with raw `part`
llmswitch-core: GeminiSseToJsonConverter  
  ↓ collect parts → build GeminiResponse
llmswitch-core: Response transformation layer
  ↓ Gemini parts → Responses/OpenAI format
Client (receives final SSE)
```

## Root Cause
**Gemini parts with `functionCall`, `thought`, `executableCode` are未被正确转换为 Responses 格式**

`GeminiSseToJsonConverter` 正确收集所有 parts（包括 tool calls），但后续转换层（可能在 `codecs/gemini-openai-codec.ts` 或 Responses 转换器中）不认识这些 part 类型，导致它们被过滤掉。

## Files Need Investigation
1. `/sharedmodule/llmswitch-core/src/codecs/gemini-openai-codec.ts`  
   - Gemini → OpenAI 格式转换
   - 需要添加 `functionCall` → `tool_calls` 映射
   - 需要添加 `thought` → `reasoning_content` 映射

2. `/sharedmodule/llmswitch-core/src/sse/json-to-sse/gemini-json-to-sse-converter.ts`
   - 如果是逆向流程（JSON → SSE），也需要处理这些类型

3. 参考实现：  
   - `~/Documents/github/gcli2api` (user 提到的参考项目，目前无法访问)
   - 需要 user 提供关键的转换逻辑

## Next Steps
1. 查看 `gemini-openai-codec.ts` 的 part 转换逻辑
2. 添加对以下 Gemini part 类型的支持：
   - `functionCall` →  OpenAI `tool_calls`
   - `functionResponse` → tool result
   - `thought` → `reasoning_content` (extended thinking)
   - `executableCode` → code_interpreter
   - `codeExecutionResult` → execution output

3. 或者，user 提供 gcli2api 的实现参考

## Current State
- v0.89.376 deployed
- Provider layer correctly sends raw parts
- Waiting for llmswitch-core response inbound layer fixes

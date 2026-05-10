# DeepSeek-Web Provider 对齐 ds2api 工具调用能力

## 索引概要
- L1-L10 `scope`: 对齐目标与范围
- L12-L45 `ds2api-architecture`: ds2api 工具调用完整链路
- L47-L90 `rcc-current-state`: RCC 当前实现对比
- L92-L130 `gap-analysis`: 差距分析
- L132-L160 `fix-plan`: 修复计划

## 对齐目标
参考 `../ds2api`（Go 实现）的 DeepSeek Web 工具调用链路，补齐 RCC `deepseek-web` provider 的完整工具调用能力。

## ds2api 架构（参考实现）

### 请求链路
```
OpenAI Chat/Responses API
  → promptcompat.NormalizeOpenAIChatRequest()
    → injectToolPrompt(): 注入 tool schema 到 system message
    → StandardRequest.CompletionPayload(): 构建 DeepSeek payload
      → model_type (from config.GetModelType)
      → ref_file_ids (from file upload)
      → thinking_enabled / search_enabled
  → completionruntime.StartCompletion()
    → CreateSession() + GetPow()
    → CallCompletion()
```

### 响应链路
```
DeepSeek SSE → sse.CollectStream()
  → assistantturn.BuildTurnFromCollected()
    → shared.DetectAssistantToolCalls(): 文本中检测工具调用
    → toolcall.NormalizeParsedToolCallsForSchemas(): 规范化
  → openaifmt.BuildChatCompletionWithToolCalls(): 输出 OpenAI 格式
```

### 文件上传链路
```
inline file (data URL) → decodeOpenAIInlineFileBlock()
  → UploadFile() [with model_type header]
  → waitForUploadedFile() [poll fetch_files until ready]
  → ref_file_ids → completion payload
```

### 关键设计模式
1. **工具引导注入** (`injectToolPrompt`): 工具 schema 以文本方式注入 system message，不依赖上游 native function calling
2. **工具调用收割** (`DetectAssistantToolCalls` + `toolstream`): 从 assistant 文本中解析 `<tool_call>` XML 标签
3. **文件上传 ready 等待** (`waitForUploadedFile`): poll `fetch_files` API 直到 status 为 ready/processed
4. **model_type 路由**: `config.GetModelType(modelID)` 返回 vision/search/default，决定上传 headers

## RCC 当前实现（deepseek-web provider）

### 已实现
| 能力 | 文件 | 状态 |
|---|---|---|
| 工具引导注入 | Rust `req_process_stage1_tool_governance` | ✅ 完成 |
| 工具调用收割 | Rust `resp_process_stage1_tool_governance` + heredoc | ✅ 完成 |
| 文件上传 (context file) | TS `deepseek-file-upload.ts` | ✅ 完成 |
| inline 文件上传 + fetch ready | TS `deepseek-file-upload.ts` | ✅ 完成（本轮新增）|
| model_type header | TS `readDeepSeekModelType` + Rust `resolve_model_type` | ✅ 完成 |
| PoW / Session 管理 | TS `deepseek-session-pow.ts` | ✅ 完成 |

### 路由能力（本轮修复）
| 能力 | 真源 | 状态 |
|---|---|---|
| `web_search_preview` 工具声明识别 | Rust `detect_web_search_tool_declared` | ✅ 已修 |
| `web_search` 路由候选前置 | Rust `build_route_queue` | ✅ 已修 |
| `web_search` pool filter | Rust `selection.rs` web_search_route_requested | ✅ 已修 |
| capability 传播到 aliases | Rust `normalize_model_capabilities` | ✅ 已修 |

### 差距分析
1. **fetch_files ready 状态判断**: RCC 只检查 `code===0`，ds2api 用 `isReadyUploadFileStatus()` 检查具体 status 值（processed/ready/done/available/success/completed/finished）。**风险**: DeepSeek 可能返回 code=0 但 status 仍为 processing。
2. **upload purpose**: ds2api 会传 `purpose` 字段，RCC 不传。**风险**: DeepSeek 可能依赖 purpose 做分类。
3. **retry 逻辑**: ds2api upload 有 maxAttempts=3，RCC upload 无 retry。
4. **hash dedupe**: ds2api inline upload 有 SHA256 dedupe 缓存，RCC 无。
5. **tool_choice policy**: ds2api 有 ToolChoiceRequired/Forced/None 模���，RCC 只做 auto。

### 唯一性判断
- 路由层的真源在 Rust `router-hotpath-napi`，本轮已修 4 个点
- provider runtime 的真源在 TS `deepseek-file-upload.ts`，本轮已修 fetch ready
- 剩余差距（purpose/retry/dedupe）是非阻塞的增强，不影响当前 smoke 验证


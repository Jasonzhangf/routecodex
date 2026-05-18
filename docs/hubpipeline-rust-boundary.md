# HubPipeline Rust 边界文档

## 索引概要
- L1-L7 `purpose`：本文档用途。
- L9-L18 `classification`：process/ 目录逐文件分类。
- L20-L23 `runtime-infra`：runtime 基础设施文件（非 pipeline 语义）。
- L25-L27 `rust-truth`：Rust 真源路径索引。

## 用途
记录 `src/conversion/hub/process/` 与 `src/conversion/hub/pipeline/` 下每个 TS 文件的语义归属判定。
按 `AGENTS.md` 规则 18（HubPipeline 强制 Rust 规则）：
- **Rust 真源**：核心语义在 Rust，TS 仅薄壳或编排。
- **编排薄壳**：TS 仅编排调度，必须至少一层调用 native。
- **Runtime 基础设施**：依赖 Node.js runtime（fs/daemon/state），不属于 pipeline 语义，不应强迁 Rust。
- **违规**：存在 payload 语义变换且不调用 native 的 TS 文件，发现即迁。

## process/ 目录逐文件分类

### Rust 真源（核心语义在 Rust，TS 已收缩为薄壳）
| 文件 | 性质 | Rust 真源 |
|---|---|---|
| `chat-process-request-sanitizer.ts` | 消息过滤（空 assistant / 模板 / mirror / tool_call id 归一）→ Rust | `shared_response_compat.rs` |

### 编排薄壳（TS 仅调度 + native 调用，无 payload 语义重写）
| 文件 | native 调用 | 性质 |
|---|---|---|
| `chat-process-clock-reminders.ts` | `resolveClockReminderFlowPlanWithNative` | 编排：调度 clock reminder 注入 |
| `chat-process-clock-reminder-orchestration.ts` | `buildGuardedClockScheduleItemWithNative` 等 7 处 | 编排：clock 任务调度与 reservation |
| `chat-process-clock-directives.ts` | `stripClockClearDirectiveText` 等 4 处 | 编排：directive 提取与清理 |
| `chat-process-clock-reminder-finalize.ts` | `buildClockReminderMessages` 等 | 编排：reminder 消息构建 |
| `chat-process-clock-reminder-messages.ts` | `buildClockMarkerScheduleMessages` | 编排：clock marker 消息生成 |
| `chat-process-clock-reminder-time-tag.ts` | `resolveClockReminderTimeTagLine` | 编排：time tag 行解析 |
| `chat-process-clock-tools.ts` | `isClientInjectReady` + native | 编排：clock 工具注入决策 |
| `chat-process-clock-tool-schemas.ts` | `buildClockToolAppendOperations` 等 | 编排：clock 工具 schema 构建 |
| `chat-process-web-search.ts` | `planChatWebSearchOperationsWithNative` | 编排：web search 工具注入决策 |
| `chat-process-web-search-intent.ts` | `extractWebSearchSemantics` | 编排：web search 意图解析 |
| `chat-process-web-search-tool-schema.ts` | native | 编排：web search schema 构建 |
| `chat-process-review.ts` | `buildReviewOperationsWithNative` | 编排：review 操作注入 |
| `chat-process-servertool-orchestration.ts` | `planServertoolFollowupRuntimeWithNative` 等 | 编排：servertool 编排 |
| `chat-process-governance-orchestration.ts` | `applyReqProcessToolGovernanceWithNative` | 编排：tool governance 调用 |
| `chat-process-governance-finalize.ts` | `finalizeGovernedRequestWithNative` | 薄壳：governance 后归一化 |
| `chat-process-node-result.ts` | — | 纯构造：无 payload 语义 |
| `chat-process-media.ts` | `analyzeChatProcessMedia` 等 | 薄壳：media 分析结果透传 |
| `client-inject-readiness.ts` | `resolveClientInjectReadyWithNative` | 薄壳：client inject 就绪判断 |

### Runtime 基础设施（依赖 Node.js runtime，不属于 pipeline 语义）
| 文件 | 性质 | 不可迁 Rust 原因 |
|---|---|---|
| `chat-process-heartbeat-directives.ts` | daemon 启停、文件系统写入 | `node:fs` daemon 操作，NAPI 无法替代 |
| `chat-process-session-usage.ts` | 会话 usage 快照持久化、token 估算 | 依赖 `loadRoutingInstructionStateSync` Node.js store |
| `chat-process-clock-directive-parser.ts` | clock schedule directive 解析 | 依赖 `VirtualRouterClockConfig` 类型，调度逻辑在 servertool 层 |
| `chat-process-generic-marker-strip.ts` | routing marker 保留判断 | 薄决策包装器（18 行），无 payload 语义；Rust 无对应能力时可保留 |

## Rust 真源路径索引
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_response_compat.rs` → 消息过滤（空 assistant / 模板 / mirror / tool_call id 归一）
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs` → req_process 工具治理主入口
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs` → resp_process 工具治理主入口
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_clock_reminder_semantics.rs` → clock reminder 核心语义
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-clock-*.ts` → clock native 薄壳（engine-selection 下全部 100% 薄壳）

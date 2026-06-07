# HubPipeline Rust 边界文档

## 索引概要
- L1-L7 `purpose`：本文档用途。
- L9-L18 `classification`：process/ 目录逐文件分类。
- L20-L23 `runtime-infra`：runtime 基础设施文件（非 pipeline 语义）。
- L25-L27 `rust-truth`：Rust 真源路径索引。

## 用途
记录 `src/conversion/hub/process/` 与 `src/conversion/hub/pipeline/` 下仍保留 TS 文件的语义归属判定。
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
| `chat-process-node-result.ts` | — | 纯构造：无 payload 语义 |
| `chat-process-media.ts` | `analyzeChatProcessMedia` 等 | 薄壳：media 分析结果透传 |

### Runtime 基础设施（依赖 Node.js runtime，不属于 pipeline 语义）
| 文件 | 性质 | 不可迁 Rust 原因 |
|---|---|---|
| `chat-process-session-usage.ts` | 会话 usage 快照持久化、token 估算 | 依赖 `loadRoutingInstructionStateSync` Node.js store |
| `chat-process-generic-marker-strip.ts` | routing marker 保留判断 | 薄决策包装器（18 行），无 payload 语义；Rust 无对应能力时可保留 |

## Rust 真源路径索引
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/` → Hub Pipeline Rust lib 化总控入口骨架（`HubPipelineEngine`、typed contract、effect plan、diagnostics）；当前已接入 NAPI `executeHubPipelineJson`，但 TS 主链尚未切到该总入口。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_response_compat.rs` → 消息过滤（空 assistant / 模板 / mirror / tool_call id 归一）
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs` → req_process 工具治理主入口
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs` → resp_process 工具治理主入口

## 已删除 TS residue

- 2026-06-07 Phase 0：`chat-process-governance-finalize.ts`、`chat-process-web-search.ts`、`chat-process-web-search-intent.ts`、`chat-process-web-search-tool-schema.ts`、`client-inject-readiness.ts`、`hub-pipeline-mutable-record-utils.ts`、`target-utils.ts`、`chat-response-utils.ts`、`provider-response-observation.ts` 均为 0 live consumer 的旧 TS native wrapper / helper，已物理删除并由 residue audit 锁住不得复活。
- 2026-06-07 Phase 0：`hub-stage-timing-measure-blocks.ts` 及同名 generated JS/DTS/map 已删除；`hub-stage-timing.ts` 是 timing measure 唯一 TS owner。

# Hub Pipeline & Servertool Rust vs TS Code Split Audit

Audit date: 2026-06-XX
Auditor: Reasonix Code

## 现状总览

| 区域 | TS 文件 | Rust 文件 | Rust 占比 |
|---|---|---|---|
| Hub pipeline stages | ~81 | ~30 (blocks + pipeline.rs) | ~37% |
| Servertool orchestration | ~30 | 2 (servertool_skeleton, chat_servertool_orchestration) | ~7% |
| Virtual router | ~30 | ~40 | ~57% |
| Provider compat (req_outbound_stage3) | ~20 | ~25 | ~55% |
| Resp process tool governance | ~5 | ~20 | ~80% |
| Shared utils / codecs | ~50 | ~30 | ~37% |
| **整体** | **~500** | **~150** | **~30%** |

## Hub Pipeline 还剩下的纯 TS 大块

| 块 | 文件 | 行数 | 性质 |
|---|---|---|---|
| 主编排壳 | `hub-pipeline.ts` | 196 | stage 调度 + 异常处理 |
| stage 执行器 | `*-execute-request-stage*.ts` | ~200 | 类似 main() 的编排 |
| provider payload 编排 | `*-provider-payload-*blocks.ts` (10 files) | ~450 | 策略应用/观测逻辑 |
| inbound 编排 | `*-inbound-*blocks.ts` (5 files) | ~350 | inbound 编排壳 |
| heavy input 快速路径 | `hub-pipeline-heavy-input-fastpath.ts` | 122 | 大输入处理 |
| max_tokens 策略 | `hub-pipeline-max-tokens-policy.ts` | 83 | token 策略 |
| stage timing | `hub-stage-timing*.ts` (8 files) | ~300 | 打点计时 |
| 快照 recorder | `hub-pipeline-snapshot-recorder-blocks.ts` | 36 | 快照写入 |

**小计：~1700 行编排壳逻辑。**

## Servertool——最缺失的大块（几乎所有逻辑仍是纯 TS）

| 块 | 文件 | 行数 | 说明 |
|---|---|---|---|
| stop_message_auto handler | `stop-message-auto.ts` | 697 | **全 TS**——状态机、默认逻辑、provider pin |
| stop_message_counter | `stop-message-counter.ts` | 93 | 预算计数器 |
| followup_mainline | `backend-route-mainline-block.ts` | 470 | **全 TS**——followup 重入编排中枢 |
| followup_runtime | `backend-route-runtime-block.ts` | 265 | 全 TS——运行时状态 |
| stopless_goal_state | `stopless-goal-state.ts` | 381 | **全 TS**——goal 状态机（仅 rcc_fence.rs 做 directive 解析） |
| web_search handler | `web-search.ts` | ~350 | 全 TS |
| vision handler | `vision.ts` | ~400 | 全 TS |
| engine.ts | `engine.ts` | ~200 | 编排壳 |

**Servertool ~2500 行纯 TS。**

## Rust 侧已存在的相关模块

| Rust 模块 | 功能 | 与 TS 重叠 |
|---|---|---|
| `rcc_fence.rs` | stopless directive 解析（start/pause/resume/stop/done） | 覆盖 stopless-goal-state 的 directive 层 |
| `servertool_skeleton_config.rs` | servertool 骨架配置（autoHook 队列, flow policy） | 覆盖 skeleton-config.ts |
| `router_metadata_input.rs` | 路由 metadata 构建（含 __shadowCompareForcedProviderKey） | 覆盖 followup 的 metadata 组装 |
| `chat_servertool_orchestration.rs` | servertool 编排的 Rust 入口 | 覆盖 engine.ts 的部分编排 |
| `responses_resume.rs` | responses resume/continuation 语义 | 覆盖 route-aware-responses-continuation 部分 |
| `stop_message_state_codec.rs` | stopMessage state 序列化 | 覆盖 routing-state codec |
| `stop_message_actions.rs` | stopMessage action 处理 | 部分覆盖 stop-message-auto |

## 剩余 Rust 化优先级

| 优先级 | 块 | 行数 | 理由 |
|---|---|---|---|
| **P0** | `stop-message-auto.ts` | 697 | 维护痛点最高，每次 stopless 变更都在改这里 |
| **P0** | `backend-route-mainline-block.ts` | 470 | followup 重入编排中枢 |
| P1 | `hub-pipeline.ts` + stage 编排 | ~400 | 编排壳，逻辑稳定 |
| P1 | `stopless-goal-state.ts` | 381 | 已有 rcc_fence.rs 底层 |
| P2 | web_search / vision handlers | ~750 | 按调用频率排序 |
| P2 | stage timing / snapshot | ~350 | ROI 低 |

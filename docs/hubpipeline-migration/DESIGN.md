# HubPipeline TS→Rust 迁移设计文档

## 索引概要
- L1-L5 `status`：当前状态
- L7-L18 `phase-0`：TS 遗留清理（审计结论）
- L20-L55 `phase-1`：HubPipeline Rust 重构
- L57-L65 `verification`：验收标准
- L67-L72 `decisions`：Jason 待决策

## 状态
| 阶段 | 状态 | 依赖 |
|------|------|------|
| Phase 0: TS 遗留清理 | 待 Jason 决策 | - |
| Phase 1: HubPipeline Rust 重构 | PENDING | Phase 0 完成 |

---

## Phase 0: TS 遗留清理（审计结论）

### P1-1: applyGoalLedgersToValidatedProjection 无条件清零 ✅ 需修复
| 项目 | 内容 |
|------|------|
| **位置** | `src/server/runtime/http-server/executor/provider-response-converter.ts:361-372` |
| **现状** | 无条件清零三个 counters |
| **调用场景** | 仅 `status='active'` 时调用（valid transition） |
| **语义** | 语义正确 = "valid tool call 成功后清零" ✅ |
| **问题** | 代码结构未体现语义边界：switch 内混在一起，无条件清零 |
| **修复** | 重构调用边界：只在 valid transition 路径调用清零函数 |

### P1-2: consecutiveNoProgress ✅ 保持现状
| 项目 | 内容 |
|------|------|
| **TS 侧** | `stopless-goal-guard.ts:71-104` 有完整逻辑，**活跃使用** |
| **Rust 侧** | `rcc_fence.rs` 保留字段传递，无独立 action，**预留设计** |
| **结论** | 无需修改 |

### P1-3: fixApplyPatchToolCallsWithNative ✅ 无需操作
| 项目 | 内容 |
|------|------|
| **结论** | 已正确 export，dist 引用正常 |

### P1-4: readStoplessGoalState ✅ 禁止删除
| 项目 | 内容 |
|------|------|
| **调用方** | `stopless-goal-state.ts`、`stopless-goal-guard.ts` |
| **结论** | 活跃使用，非死代码 |

---

## Phase 1: HubPipeline Rust 重构

### 1.1 范围边界
| 模块 | 当前 | 目标 |
|------|------|------|
| `src/conversion/pipeline/` (TS) | Pipeline v2 | 迁移至 Rust，TS 仅 thin wrapper |
| `rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs` | 已存在 | 扩展为统一入口 |
| `rust-core/crates/router-hotpath-napi/src/hub_req_inbound*.rs` | 部分 | 补充缺失阶段 |
| `rust-core/crates/router-hotpath-napi/src/hub_resp_outbound*.rs` | 部分 | 补充缺失阶段 |

### 1.2 迁移优先级
1. **P0 核心热路径**：格式解析 → Canonical 构建 → 协议转换 → 出站序列化
2. **P1 治理层**：tool governance、semantics lift、passthrough audit
3. **P2 增强功能**：clock/reminder/web_search 语义

### 1.3 执行阶段
```
Phase 1-1: 审计与基线
  - 扫描 TS 实现，列出所有 codec/hook/schema
  - 扫描现有 Rust hub_pipeline.rs
  - 建立语义等价测试套件
  - 识别 gap

Phase 1-2: 核心 Rust 实现
  - 统一 PipelineContext 结构体
  - 实现 ProtocolConversionPipeline trait
  - 迁移 OpenAI/Anthropic/Gemini/Responses codec

Phase 1-3: Hook 与治理迁移
  - ProtocolPipelineHooks → Rust struct + NAPI 导出
  - tool_governance / passthrough / semantic_lift

Phase 1-4: 元数据与 Schema
  - meta/meta-bag.ts → Rust
  - schema/canonical-chat-request.ts → Rust struct

Phase 1-5: NAPI 粘合
  - lib.rs 导出新函数
  - 最小 TS wrapper
  - 移除 TS 业务逻辑

Phase 1-6: 集成验证
  - E2E 测试
  - 语义等价回归测试
  - 性能基准测试
```

---

## 验收标准

### Phase 0 验收
| 门 | 条件 |
|----|------|
| P0-1 | P1-1 已修复：代码结构反映"valid transition 时清零"语义 |
| P0-2 | P1-2/P1-3/P1-4 保持现状，无需操作 |

### Phase 1 验收
| 门 | 条件 |
|----|------|
| P1-1 | TS 功能代码物理移除，仅 thin wrapper |
| P1-2 | 语义等价测试 100% |
| P1-3 | 性能 ≤ TS 基准 80% |
| P1-4 | 无 fallback/降级代码 |
| P1-5 | ARCHITECTURE.md 已更新 |

---

## 待 Jason 决策
| # | 决策项 | 选项 |
|---|--------|------|
| D1 | P1-1 修复确认 | ① 确认语义 = "valid transition 后清零"，按此修复；② 其他语义 |

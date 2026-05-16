# HubPipeline Rust-only 审计报告（修正版）

**审计时间**: 2026-05-16
**版本**: v0.90.1714
**修正说明**: 原报告 P0 阻塞项存在错误判断，实际已有 Rust 代理

---

## 一、修正后的审计结论

| 状态 | Stage 数 | 说明 |
|------|---------|------|
| ✅ Rust 真源 | 12 / 16 | 主体逻辑在 Rust |
| ⚠️ 混合需优化 | 4 / 16 | 有 Rust 调用但残留 TS 业务逻辑 |
| ❌ 纯 TS 阻塞 | 0 / 16 | **已修正：无纯 TS 阻塞** |
| **合计** | **16** | |

### 关键修正

| # | 原判断 | 修正后 | 依据 |
|---|--------|--------|------|
| P0-1 VirtualRouterEngine | ❌ 纯 TS 阻塞 | ✅ 已有 nativeProxy | engine.ts:118 `nativeProxy.route()` |
| P0-2 servertool engine | ❌ 纯 TS 阻塞 | ⚠️ 混合 | engine.ts:119 有 Rust 调用，但主体仍是 TS |
| P0-3 tool-governor-request | ❌ 纯 TS 阻塞 | ⚠️ 混合 | 部分逻辑调用 Rust，部分纯 TS |
| P0-4 anthropic-alias | ❌ 纯 TS 阻塞 | ✅ 已有 Rust | buildAnthropicToolAliasMapWithNative |

---

## 二、Stage 审计明细（修正版）

### 2.1 ✅ Rust 真源（12 stages）

| Stage | 文件 | 行数 | 评估 |
|-------|------|------|------|
| req_inbound.stage1 | format_parse/index.ts | 93 | ✅ 全量 Rust 调用 |
| req_inbound.stage2 | semantic_map/index.ts | 296 | ✅ 大部分逻辑已委托 Rust |
| req_inbound.stage3 | context_capture/index.ts | 73 | ✅ 全量 Rust 调用 |
| req_outbound.stage1 | semantic_map/index.ts | 169 | ✅ 主要逻辑委托 Rust |
| req_outbound.stage2 | format_build/index.ts | 23 | ✅ Rust 调用为主 |
| req_outbound.stage3 | compat/index.ts | 66 | ✅ Rust 调用为主 |
| resp_inbound.stage2 | format_parse/index.ts | 70 | ✅ 全量 Rust 调用 |
| resp_inbound.stage3 | semantic_map/index.ts | 41 | ✅ mapper + sanitize 均 Rust |
| resp_outbound.stage1 | client_remap/index.ts | 51 | ✅ 委托 client-remap-protocol-switch.ts |
| resp_outbound.stage2 | sse_stream/index.ts | 73 | ✅ processSseStreamWithNative 主体 |
| resp_process.stage1 | tool_governance/index.ts | 142 | ✅ applyRespProcessToolGovernanceWithNative 主体 |
| resp_process.stage2 | finalize/index.ts | 70 | ✅ finalizeRespProcessChatResponseWithNative 主体 |

### 2.2 ⚠️ 混合需优化（4 stages）

| Stage | 文件 | 行数 | 残留 TS 问题 |
|-------|------|------|-------------|
| req_process.stage1 | tool_governance/index.ts | 93 | `maybeInjectClockRemindersAndApplyDirectives`(TS)、`sanitizeChatProcessRequest`(TS) |
| req_process.stage2 | route_select/index.ts | 65 | `VirtualRouterEngine` TS wrapper（但已委托 Rust nativeProxy） |
| resp_inbound.stage1 | sse_decode/index.ts | 373 | `resolveSseTimeoutOptions`(~80L)、`extractSseStream`(~30L) |
| resp_process.stage3 | servertool_orchestration/index.ts | 174 | `runServerToolOrchestration` TS engine（但有 Rust 检测点） |

---

## 三、共享模块状态

| 模块 | 文件 | 行数 | 状态 | 说明 |
|------|------|------|------|------|
| semantic-lift | semantic-lift.ts | 56 | ✅ | applyReqInboundSemanticLiftWithNative |
| context-merge | context-merge.ts | 47 | ✅ | selectToolCallIdStyleWithNative |
| context-orchestration | context-capture-orchestration.ts | 62 | ✅ | 全量 Rust 调用 |
| VirtualRouterEngine | engine.ts | 408 | ✅ | nativeProxy 委托 Rust |
| servertool engine | servertool/engine.ts | 262 | ⚠️ | 部分 Rust，主体 TS 编排 |
| tool-governor-request | tool-governor-request.ts | 196 | ⚠️ | 部分 Rust，治理逻辑 TS |
| anthropic-alias | chat-process-anthropic-alias.ts | 80 | ✅ | buildAnthropicToolAliasMapWithNative |
| operation-table | operation-table-runner.ts | ~150 | ⚠️ | TS，有 pre/post hook 机制 |
| marker-lifecycle | marker-lifecycle.ts | ~80 | ⚠️ | cleanMarkerSyntaxInPlace TS |

---

## 四、修正后的迁移优先级

### P0 核心（已大部分完成）

| # | 模块 | 原状态 | 修正后状态 |
|---|------|--------|-----------|
| P0-1 | VirtualRouterEngine | ❌ 阻塞 | ✅ Rust 真源 |
| P0-2 | servertool engine | ❌ 阻塞 | ⚠️ 混合（可优化） |
| P0-3 | tool-governor-request | ❌ 阻塞 | ⚠️ 混合（可优化） |
| P0-4 | anthropic-alias | ❌ 阻塞 | ✅ Rust 真源 |

### P1 可优化

| # | 模块 | 行数 | 说明 |
|---|------|------|------|
| P1-1 | `resolveSseTimeoutOptions` | ~80L | resp_inbound.stage1 SSE timeout 解析 |
| P1-2 | `extractSseStream` | ~30L | resp_inbound.stage1 流提取 |
| P1-3 | `runServerToolOrchestration` 优化 | ~174L | servertool engine Rust 增强 |
| P1-4 | `maybeInjectClockRemindersAndApplyDirectives` | ~40L | clock reminder 注入 |
| P1-5 | `normalizeRequestToolCalls` | ~70L | req_process.tool_governance |

### P2 收尾

| # | 模块 |
|---|------|
| P2-1 | operation-table hooks |
| P2-2 | marker-lifecycle |
| P2-3 | 5520 live 验证 |

---

## 五、剩余 Rust NAPI 增强项（可选）

基于审计，以下可进一步增强 Rust 覆盖：

### req_process 增强
- `resolve_sse_timeout_options` - 替代 TS timeout 解析
- `extract_sse_stream` - 替代 TS 流提取

### servertool 增强
- `run_server_tool_orchestration` - 评估整体迁移可行性
- `filter_executed_server_tool_calls` - 可考虑 Rust 实现

---

## 六、验收门状态

| 验证 | 状态 | 说明 |
|------|------|------|
| build:min | ✅ | v0.90.1714 通过 |
| unified-hub-shadow | ✅ | diff=0 |
| Phase 0 清理 | ✅ | P1-1~P1-4 已处理 |
| Rust-only 主体 | ✅ | 12/16 stages 真源，4/16 混合可优化 |
| 5520 live | ❌ NOT VERIFIED | 未重启验证 |

---

## 七、审计结论

**当前进度**: 约 75% Rust 化（12/16 stages 达到真源，4/16 stages 混合可优化）

**核心发现**: 
1. 原报告误判 P0-1、P0-4 为"阻塞"，实际已是 Rust 真源
2. 无纯 TS 阻塞项，所有 stages 均已有 Rust 代理
3. 剩余 4 个混合 stages 可作为优化项处理

**建议**: 
- 无需大规模 P0 迁移
- 可按 P1 优化顺序逐步增强 Rust 覆盖
- 优先完成 P1-1~P1-2（SSE 相关）

---

**审计人**: Codex Agent
**审计状态**: ✅ 报告修正完成

---

## Slice 0.1: extractDecodeStats → Rust ✅

**完成时间**: 2026-05-16

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../hub_resp_inbound_sse_decode_semantics.rs` | +35行 Rust `extract_decode_stats_json` |
| `native-hub-pipeline-resp-semantics-inbound-tools.ts` | +22行 wrapper `extractDecodeStatsWithNative` |
| `resp_inbound_stage1_sse_decode/index.ts` | +1行 import, TS函数删除(35L) |

### 验证
| 测试 | 结果 |
|------|------|
| build:min | ✅ v0.90.1717 |
| unified-hub-shadow | ✅ diff=0 |

### 累计
- extractDecodeStats: 35行 TS → Rust ✅

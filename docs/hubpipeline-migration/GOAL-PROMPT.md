/goal HubPipeline TS→Rust Phase 1 深化迁移

## 目标
Phase 1 按 slice 逐个推进，详见 `docs/hubpipeline-migration/DESIGN.md`

**Phase 0 ✅**：P0-1 ~ P0-4 全部完成
**Phase 1 Slice 2 ✅**：`client-remap-protocol-switch.ts`（524→106 行，-80%）
**Phase 1 Slice 3.1 ✅**：`shouldNormalizeReasoningPayload` → Rust predicate
**Phase 1 Slice 3.2 ✅**：`buildSlimResponsesContext` → Rust（wrapper + 调用点）

## 当前进展（2026-05-15）
| Slice | 文件 | 状态 |
|-------|------|------|
| Slice 1 | `resolveProtocolToken` | ✅ 完成 |
| Slice 2 | `client-remap-protocol-switch.ts` | ✅ 完成（418 行迁移） |
| Slice 3.1 | `shouldNormalizeReasoningPayload` | ✅ 完成 |
| Slice 3.2 | `buildSlimResponsesContext` | ✅ 完成（Rust wrapper + 调用点替换） |
| Slice 3.3 | `normalizeReqInboundReasoningPayload` responses fast-path | ⏳ 待启动 |

## 设计文档
- 主设计：`docs/hubpipeline-migration/DESIGN.md`
- 入口路由：`docs/agent-routing/10-runtime-ssot-routing.md`

## 执行规范
- **单一真源**：Rust 是唯一真源；TS 仅 thin wrapper
- **禁止 fallback**：不允许双路径 / 降级 / 静默降级
- **物理删除**：每 slice 完成后物理删除对应 TS 功能代码
- **same-shape replay**：Rust vs TS 输出 diff=0 才可继续

## 验收
- `build:min` ✅
- `unified-hub-shadow` diff=0
- 文档同步更新 DESIGN.md
- 未做 live 的部分必须标注**未验证**

## 下一步
Slice 3.3：`normalizeReqInboundReasoningPayload` responses fast-path 迁 Rust（`normalizeLatestResponsesReasoningTarget` ~100 行）

# R5 HubPipeline Single-TS-Shell 收口计划

## 目标
将 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**` 收敛为“单 TS 壳 + Rust 语义真源”。

## 目标形态
- 保留：`hub-pipeline.ts`（或 `hub-pipeline-shell.ts`）作为唯一业务入口壳。
- TS 壳职责仅：
  1) 入参整形/类型断言
  2) 单次调用 Rust NAPI 总入口
  3) 出参/错误透传
- 删除所有 TS 语义 blocks / orchestration 逻辑文件（物理删除）。

## 分批删除顺序（execute-entry 主干优先）

### Batch E1（当前继续执行）
- `hub-pipeline-execute-chat-process-entry.ts`
- `hub-pipeline-execute-chat-process-entry-setup.ts`
- `hub-pipeline-execute-chat-process-entry-orchestration-blocks.ts`
- 目标：仅保留最薄装配；所有判定转 native。

### Batch E2
- `hub-pipeline-chat-process-entry-blocks.ts`
- `hub-pipeline-chat-process-request-utils.ts`
- `hub-pipeline-governance-blocks.ts`
- 目标：聊天流程 gate/passthrough/governance 全量 native。

### Batch E3
- `hub-pipeline-route-and-outbound*.ts`
- `hub-pipeline-provider-payload-*.ts`
- `hub-pipeline-normalize-request*.ts`
- 目标：route/outbound/payload policy 语义归 Rust。

### Batch E4（最终收口）
- `hub-pipeline-*.ts` 仅留单壳入口和必要 type/index。
- 清理残留重复导出与无用 glue。

## 每批强制验证
1. `npm run build:min`
2. Hub 定向测试（7 suites）
3. `node scripts/ci/hub-deterministic-audit.mjs`
4. `node scripts/ci/llmswitch-rustification-audit.mjs --json`

## 完成定义
- HubPipeline TS 不再包含语义判定实现。
- 仅单壳入口 + 必要类型胶水。
- 四门验证持续全绿。

# client-request snapshot debug closeout plan

## 目标与验收标准

目标：修复 `client-request` snapshot 在大 payload 下退化为 meta-only 的错误实现，且全部实现收口到 `src/debug/snapshot/*` 真源，不新增壳层、不在 SSE/handler/request-executor/provider/runtime 层补语义。

验收标准：
- `client-request` 小 payload 继续写完整 `url + headers + body/bodyText`。
- `client-request` 大 payload 不再写出 meta-only 假成功文件。
- 若 payload 过大，行为必须由 `debug` 模块唯一决定并显式表达，不能靠别层补壳。
- `provider-request/provider-response` 现有 full-preserve 语义不回归。
- 5555 live 新样本中，`client-request.json` 要么完整，要么显式失败/摘要；不能再只有 `meta`。

## 范围与边界

In scope：
- `src/debug/snapshot/provider-writer.ts`
- `src/debug/snapshot/writer.ts`
- `src/utils/snapshot-payload-guard.ts` 或其 debug 模块归属迁移点
- 对应 focused tests / live snapshot verification

Out of scope：
- SSE 传输逻辑
- Hub/chat process/stopless/servertool 语义
- provider request/outbound 语义
- 通过 handler/request-executor/provider runtime 补第二套 snapshot 逻辑

## 现状与根因

已证实根因：
1. `writeClientSnapshot()` 先对完整 payload 调 `coerceSnapshotPayloadForWrite('client-request', ...)`。
2. `client-request` 超过默认 256KB 时返回 `undefined`。
3. `writeClientSnapshot()` 仍把 `undefined` 传给 `writeUnifiedSnapshot()`。
4. `writeUnifiedSnapshot()` 在 `rawPayload` 缺失时重新 `buildSnapshotPayload(input)`，此时只剩 `scope/stage/entryEndpoint/entryPort`，最终落盘为 meta-only。

这属于 debug 模块内部错误实现，不是 SSE、不是 provider、不是 live history 缺失。

## 设计原则

1. 唯一 owner：`client-request` snapshot shape 只允许 `src/debug/snapshot/*` 决定。
2. 不建壳：禁止 meta-only 假成功；禁止在别层生成替代文件形态。
3. no fallback：guard 命中后不能静默降级成另一种“看起来成功”的 payload。
4. 纯观测：debug 模块只能修复 snapshot 观测语义，不得回流正常请求/响应链。
5. 保持相邻职责：payload guard 决定“可写/不可写/如何显式表达”，writer 只负责写，不再二次猜测。

## 技术方案

### 方案 A：显式 fail-closed，不写 `client-request.json`

做法：
- `writeClientSnapshot()` 在 guard 返回 `undefined` 时直接走显式分支：
  - 要么写专用 debug artifact，例如 `client-request-oversize.json` / `errorsample`；
  - 要么直接不写主文件并输出明确非阻塞日志。
- `writeUnifiedSnapshot()` 不再接受“主 payload 已被 guard 吃掉后重建 meta-only 正文”的路径。

优点：
- 最符合“不能建壳、不能假成功”。
- 责任清晰，debug 真源统一。

风险：
- 现有依赖默认存在 `client-request.json` 的排查脚本可能需要适配。

### 方案 B：debug 模块内显式摘要文件

做法：
- guard 命中时，由 debug 模块构造明确的 oversize 摘要结构，包含：
  - `kind: client_request_oversize`
  - `stage/scope/entryEndpoint/entryPort`
  - `droppedBecause: payload_max_bytes_exceeded`
  - `estimatedBytes/maxBytes`
  - 非语义摘要：如 `model`、`input_len/messages_len`、`tools_len`
- 文件仍由 debug writer 写入，但不是 meta-only 壳，而是显式 oversize 观测结果。

优点：
- 保留可观测性。
- 不伪装成完整 request snapshot。

风险：
- 必须严格限制摘要字段，不能重新发明业务语义恢复路径。

### 推荐落地

优先方案 B。

原因：
- Jason 明确要求不建壳；meta-only 假成功必须删除。
- 纯“不写文件”会损失排障面。
- 由 `debug` 模块显式产出 oversize 观测结果，既不补业务壳，也不把责任散到别层。

## 文件清单

- [src/debug/snapshot/provider-writer.ts](/Users/fanzhang/Documents/github/routecodex/src/debug/snapshot/provider-writer.ts)
- [src/debug/snapshot/writer.ts](/Users/fanzhang/Documents/github/routecodex/src/debug/snapshot/writer.ts)
- [src/utils/snapshot-payload-guard.ts](/Users/fanzhang/Documents/github/routecodex/src/utils/snapshot-payload-guard.ts)
- [docs/goals/debug-unified-surface-goal.md](/Users/fanzhang/Documents/github/routecodex/docs/goals/debug-unified-surface-goal.md)
- [docs/architecture/snapshot-stage-contract.md](/Users/fanzhang/Documents/github/routecodex/docs/architecture/snapshot-stage-contract.md)

## 实施步骤

1. 补红测：
   - 大 `client-request` payload 当前写出 meta-only，先红。
   - 小 `client-request` payload 继续完整写盘，防止误伤。
2. 在 `debug` 模块内定义唯一 oversize 行为：
   - 推荐新增 `coerceSnapshotPayloadForWriteDetailed()` 或等价 debug-only decision result。
   - 返回值必须能区分 `keep_full` / `oversize_explicit`，不能只用 `undefined`。
3. 修改 `writeClientSnapshot()`：
   - 不再把 guard 吃掉后的 `undefined` 继续传给 `writeUnifiedSnapshot()`。
   - 由这里显式传递完整 payload 或显式 oversize artifact。
4. 修改 `writeUnifiedSnapshot()`：
   - 禁止把 `rawPayload/data` 缺失的 `client-request` 重建成 meta-only 正文。
   - 若被错误调用到空 payload，应 fail-fast 或直接不写。
5. 补 focused tests。
6. 跑 5555 live 样本复验。

## 测试计划

单测 / focused：
- `tests/debug/...` 新增：
  - `RED: client-request oversize must not collapse into meta-only snapshot`
  - `client-request small payload still writes full body`
  - `provider-request oversize policy unchanged`

架构 / gate：
- 如已有 snapshot contract / owner gate，补 contract 说明与必要断言。

live：
- 用全局安装版重放 5555 `/v1/responses` 大历史样本。
- 检查 `~/.rcc/codex-samples/openai-responses/ports/5555/req_*/client-request.json`
  - 不得再是纯 meta-only。

## 风险与规避

风险：
- 旧脚本假设 `client-request.json` 一定是完整 request body。
- 改动若触碰 provider-request preserve-full 逻辑，可能误伤其他 snapshot。

规避：
- 小 payload / 大 payload / provider-request 三类测试分开锁。
- 只改 `client-request` 的 debug owner 路径，不改 request mainline。

## 完成定义（DoD）

- 根因实现被物理移除，仓库中不再存在“guard 吃掉后重建 meta-only”的错误路径。
- `client-request` oversize 行为只由 debug 模块定义。
- focused tests 通过。
- 5555 live 新样本验证通过。
- 文档同步：本计划 + 必要 contract 文档更新。

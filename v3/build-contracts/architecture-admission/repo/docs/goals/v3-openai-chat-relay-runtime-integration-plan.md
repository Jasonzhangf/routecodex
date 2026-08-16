# V3 OpenAI Chat Relay Runtime Integration Plan

## 1. 目标与验收标准

将已完成的 OpenAI Chat codec characterization 接入唯一 Hub v1 Relay 主线，形成
`/v1/chat/completions -> Hub Req01-Req09 -> Provider -> Hub Resp01-Resp06 -> client`
的 controlled-runtime JSON/SSE 闭环。

验收标准：

- OpenAI Chat 入口只进入既有 Hub v1 固定节点，不新增第二 Runtime kernel。
- request/messages/tools/tool_calls/tool results 语义等价保留。
- JSON 与 SSE 均通过 controlled upstream replay；首帧不等待 terminal。
- provider error 进入唯一 Error01-06，不投成成功响应。
- characterization codec 保持纯协议 owner；Runtime 只编排相邻 typed node。

## 2. 范围与边界

In scope：

- OpenAI Chat Relay Runtime typed wiring。
- Server-owned controlled driver、JSON/SSE/error/isolation blackbox。
- feature/resource/mainline/verification map、manifest、wiki、source/red gates。

Out of scope：

- Responses Direct、Responses WebSocket、Anthropic Relay/local continuation。
- live config、install、restart、5555/5520 runtime 变更。
- servertool/stopless、provider-specific Hub 分支、TS 功能代码。

## 3. 设计原则

- Rust-only、单 Hub v1 lifecycle、相邻节点转换。
- OpenAI Chat codec 是协议转换真源；Hub/VR 不写 provider 特例。
- SSE 使用共享增量 transport framing，禁止完整流 materialize。
- metadata/debug/error 只走 side channel，禁止进入 provider/client payload。
- fail-fast、无 fallback、无 history/tool repair。

## 4. 技术方案与文件清单

主要 owner：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/`：新增 OpenAI Chat runtime orchestration 文件；
  不修改 Responses Direct kernel。
- `v3/crates/routecodex-v3-server/`：只增加 controlled entry/driver 与黑盒测试。
- `v3/crates/routecodex-v3-runtime/tests/`：JSON/SSE/error/isolation integration。
- `scripts/architecture/`、`scripts/tests/`：source verifier 与 mutation fixtures。
- `docs/architecture/v3-*.yml`、manifest、wiki：新增独立 feature/resource/edge。

协议 payload 通过 typed wrapper move/borrow；禁止 JSON round-trip、complete payload deep clone、
Debug snapshot truth 或 Server 重建 codec。

## 5. 风险与规避

- 与 Anthropic Relay 共享 Hub v1：只新增 OpenAI Chat 专属 runtime 文件和注册边，禁止改
  Anthropic runtime 业务实现。
- SSE 边界漂移：controlled upstream 分块发送 delta/terminal，首帧 timing gate 锁增量。
- tool identity 被修补：正反测试锁多 tool call、matching result、orphan/duplicate fail-fast。
- map 共享文件冲突：只追加本 feature 段；提交前刷新协作 view 和 HEAD。

## 6. 测试计划

- 红测：Runtime wiring/entry/trace symbols 缺失。
- JSON：messages/tools/tool_calls/results/usage/finish_reason 等价。
- SSE：split chunks、tool delta、terminal、DONE；首帧先于 terminal。
- Error：provider protocol/error/malformed event 进入 Error01-06。
- Isolation：metadata/debug/resource/continuation control 不泄漏。
- Gate：focused、mutation、module/Rust-only/fmt/clippy/full V3 workspace、architecture review/browser。

## 7. 实施步骤

1. 刷新协作协议并 claim `feature_id:v3.openai_chat_relay_runtime_integration`。
2. 查 maps/mainline/verification/wiki 和 characterization source。
3. 先建 test design、red integration、controlled upstream。
4. 接相邻 Hub v1 typed node；Server 只调用 Runtime owner。
5. 绿化 JSON/SSE/error/isolation，补 source/mutation gates。
6. 同步 maps/manifest/wiki，跑全栈与 architecture review。
7. 定向 stage/commit；evidence 写入本 run。

## 8. 完成定义

- OpenAI Chat controlled Runtime JSON/SSE/error 闭环真实执行。
- 单 Hub v1 主线、无第二 owner/fallback/materialization。
- maps/wiki/manifest/gates queryable 且全绿。
- 不宣称 live/provider 兼容或生产部署。

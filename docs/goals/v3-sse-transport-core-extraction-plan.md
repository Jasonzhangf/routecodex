# V3 SSE Transport Core Extraction Plan

## 1. 目标与验收标准

从 V2 已验证的 SSE 行为中抽取唯一 Rust SSE Transport Core，向 V2 薄壳和 V3 Pipeline 提供同一套增量解析、结构化 frame、编码写出、backpressure、abort、timeout、closeout 与资源释放能力。

验收标准：

- SSE Transport 只处理字节、frame 与 HTTP streaming lifecycle，不解释业务 event。
- V2 真实 JSON/SSE 样本在抽取前后语义与 payload 等价。
- V2 handler 和 V3 Server/Pipeline 只通过公开 transport contract 调用，不保留第二套 framing/parser/writer。
- 非法流、半帧、超限、断流、disconnect、timeout 显式失败；不补 terminal、`[DONE]` 或成功响应。

## 2. 范围与边界

In scope：

- 新建共享 Rust SSE transport crate，优先位于 `sharedmodule/llmswitch-core/rust-core/crates/sse-transport-core/`；若 workspace 约束证明该位置不可用，先在设计文档记录唯一共享 owner 后再落点。
- 定义 `RawChunk -> DecodedFrame -> ValidatedFrameStream -> EncodedChunk` 相邻类型链与唯一 builder/parser。
- 增量 decoder/encoder、未知 event/扩展字段等价保留、多行 data、comment、id、retry、CRLF/LF、UTF-8 chunk 边界。
- backpressure、flush、keepalive comment、abort、timeout、limits、closeout、typed transport error。
- V2/V3 最薄 adapter 与正反 characterization/blackbox gates。

Out of scope：

- Responses/Anthropic/Gemini event 语义、JSON data 业务解析。
- continuation、required_action、tool/reasoning、servertool、stopless、retry/routing/provider policy。
- provider/client error 业务投影、terminal repair、synthetic event、fallback。
- `~/.rcc`、live 5555、global install、release 或服务重启。

Claim：`feature_id:sse.transport_core_shared`

## 3. 设计原则

- 数据面原样保留；传输层默认不把 `data:` 强制转为 JSON。
- Pipeline 类型只许相邻转换；禁止 handler/codec 绕过 transport contract。
- 业务 terminal 与 transport EOF 分离；`[DONE]` 只是可传输 data，不是成功判定。
- borrow/move-first；禁止为了解析、Debug 或比较 materialize/clone 完整长流。
- 单一 owner、无 fallback、错误显式、正反测试成对。

## 4. 技术方案与文件清单

先查并同步：

- `docs/architecture/resource-map.yml` 或 V3 resource registry
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/mainline-call-graph.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `.agents/skills/rcc-dev-skills/references/25-protocol-sse-continuation-boundary.md`

候选实现：

- `sharedmodule/llmswitch-core/rust-core/crates/sse-transport-core/`
- V2 transport-only adapter/handler 文件，以 function map 实际 owner 为准
- `v3/crates/routecodex-v3-server/` 或独立 V3 adapter，只允许薄调用
- Rust focused tests、V2 characterization tests、V3 controlled-stream blackbox
- 对应 maps、wiki、manifest、test design、architecture gates

公开核心类型必须按项目拓扑命名并封闭字段构造；codec 只能消费结构化 frame stream，transport 不依赖任何 provider/Hub business crate。

## 5. 风险与规避

- 风险：把 `response.completed`、`[DONE]`、required_action 混入 transport。规避：source gate 禁止业务 event allowlist 和 continuation/tool symbols。
- 风险：完整 SSE materialize 导致内存放大。规避：任�� chunk split/长流/byte budget 测试与 clone/materialize source gate。
- 风险：V2/V3 各留一套 parser。规避：owner uniqueness gate 和死实现物理删除；删前查依赖、删后跑真实旧样本。
- 风险：抽取改变 payload。规避：先固化 V2 原始 byte/frame characterization，再做实现。

## 6. 测试计划

- 红测先行：证明当前 parser/writer owner 分散或缺少共享 contract。
- 正向：JSON data、多行 data、comment、id/retry、CRLF/LF、UTF-8 任意切割、unknown event、长流、backpressure、正常 close。
- 反向：半帧 EOF、非法 UTF-8、超大 line/frame/buffer、disconnect、timeout、writer/upstream failure、不得合成 terminal/`[DONE]`。
- 模块黑盒：V2 与 V3 adapter 通过相同 transport core；不存在第二套 framing。
- 项目黑盒：真实 V2 旧 SSE 样本重放；受控 V3 SSE upstream 重放。未授权不得动 live 5555。
- 必跑 Rust workspace、fmt、clippy、architecture/resource/function/mainline gates、diff check。

## 7. 实施步骤

1. 按 MemoryPalace -> resource map -> function map -> mainline -> verification map -> source 顺序定位 V2 真实 owner。
2. 写测试设计并固化当前 V2 正反样本与 failing owner-uniqueness gate。
3. 定义共享类型链和 typed error，先完成纯 decoder/encoder tests。
4. 接入 V2 薄 adapter，重放旧样本。
5. 接入 V3 薄 adapter，运行 controlled-upstream blackbox。
6. 物理删除确认无引用的重复 transport 实现，同步 maps/wiki/manifest/gates。
7. architecture review：确认无业务语义、fallback、第二 owner、完整流 materialize。

## 8. 完成定义

- 唯一共享 Rust SSE Transport Core 被 V2/V3 调用。
- 所有正反测试、真实旧样本和 controlled replay 通过。
- V2/V3 薄壳无重复 framing/parser/writer；业务 SSE 语义仍归协议/Pipeline owner。
- 没有 live 5555、配置、安装、重启变更；如需 live 验证必须另获 Jason 授权。

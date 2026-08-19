# V4 请求链插件任务计划

## 目标

完成 V4 请求链全部大节点插件，并按 Cordis 架构拆成小插件。请求链目标形态：

```text
V4ServerReqInbound01ClientRaw
  -> V4ServerSseIn02FrameBoundary
  -> V4HubReqInbound03Normalized
  -> V4HubReqChatProcess04Governed
  -> VR route/select（独立插件：entry model admission + provider model replacement）
  -> V4HubReqOutbound05ProviderSemantic
  -> V4ProviderReqCompat06Compat
  -> V4ProviderSseOut07WireBoundary
  -> provider transport
```

Direct 和 Relay 两条请求路径都要有：Direct 保持入口协议直连；Relay 先归一化到 Chat/Responses 规范，再经相邻 outbound/compat 转成目标 provider wire。

## 当前真源与缺口

- 请求链工作树 `v4/playground/v4-independent-runtime-admission-20260818T031744Z-Macstudio-38512-26190` 已有 Node 02-04 插件与 Node 05-07 插件，并有 runtime/standard-plugins 定向测试证据；尚未合并为 main 真源。
- 当前真实 Responses JSON/SSE 由 runtime-bin 的 admission handler 直接调 `route_request` + wire build + provider transport，不是经过 SkeletonRuntime 插件链完成。
- 入口模型和出口模型是两件事：VR 插件负责 entry model admission 与 provider model replacement；server input / SSE in / Responses inbound 不检查 model。
- 当前插件库偏 keyless/mock，真实 provider transport 已在 provider crate，但插件链与真实 transport 的接线需要收口。

## 任务列表

### M1：合并请求链 source worktree

1. 从当前 main HEAD 建立 clean worktree。
2. 合并请求链 Node 02-04 与 Node 05-07 两个 worktree 的源码、map、gate、contract。
3. 核对 standard plugin descriptors 数量从源码派生，禁止硬编码魔法数。
4. 合并后先跑定向测试与红测，证明基线绿。

### M2：Node 01/02：Server Input + SSE In

1. `V4ServerReqInbound01ClientRaw`：只做 HTTP frame/body capture、request identity；不做协议/模型判定。
2. `V4ServerSseIn02FrameBoundary`：只做 SSE frame -> JSON；不做 model 检查、不做路由。
3. malformed frame、非 object payload、多个 data 字段 fail-fast。

### M3：Node 03：Responses Inbound

1. `V4HubReqInbound03Normalized`：只做 Responses 入口协议 normalize，保留原始语义。
2. 不检查 model、不做 continuation restore、不做工具治理。
3. 控制/error/debug/snapshot/metadata 不进入 normal payload；发现泄漏 fail-fast。

### M4：Node 04：Request ChatProcess

1. `V4HubReqChatProcess04Governed`：请求侧工具治理与 continuation restore 唯一入口。
2. 不做协议转换、不做 VR 路由、不做 provider model replacement。
3. 拆小插件：tool governance、continuation restore、scope restore；每个小插件有独立 descriptor/handle/测试。

### M5：VR 路由插件（独立节点语义）

1. VR 插件只消费 typed route facts，输出 `SelectedTarget`；不修改 provider/client payload 除 model target 外。
2. 插件拆小：entry model admission、candidate filter、target selection、model replacement。
3. entry model 与 provider wire model 分离；`/v1/models` 展示 entry alias，出站 `model` 用 target wire model。
4. 禁止把 port 或 provider 名硬编码进路由插件。

### M6：Node 05-07：Outbound / Compat / Wire

1. `V4HubReqOutbound05ProviderSemantic`：normal payload -> provider semantic envelope。
2. `V4ProviderReqCompat06Compat`：provider semantic -> target protocol wire；Responses direct 与 Relay 各走相邻转换。
3. `V4ProviderSseOut07WireBoundary`：wire JSON -> SSE frame boundary；transport/auth 归 provider runtime，不进插件。
4. Direct 保持 Responses 同协议；Relay 按 Chat/Responses 规范归一化后转 Anthropic/OpenAI Chat/Gemini 等目标协议时，只做静态、已登记映射；无映射 fail-fast。
5. provider 差异只允许在 provider runtime/compat owner 内，禁止写进 Hub Pipeline。

### M7：真实 Provider 接线

1. 用真实 provider（fable、minimax M3 等现有 `~/.rcc/provider` 配置）跑通 JSON/SSE，不新增 mock。
2. auth handle 支持 inline key / token file / secret file；空 secret fail-fast。
3. `SkeletonRuntime` 执行请求插件链，再调用真实 transport；删除 admission handler 旁路。
4. 增加 live replay：`/v1/responses` JSON、SSE、错误响应；保存同入口样本。

### M8：Direct / Relay 请求链回归

1. Direct：Responses entry -> Responses provider，same-protocol direct；不降级为 Chat。
2. Relay：Responses/Chat/Messages entry -> normalize -> ChatProcess -> outbound compat -> target provider wire。
3. 每个小插件补正反测试：正确相邻转换通过；跨节点 shortcut、模型替换越界、控制入 payload、未注册 compat 映射 fail-fast。
4. 同步 function/mainline/verification/resource maps，注册 plugin descriptor 与 owner。

## 验证矩阵

| 类别 | 最小验证 |
|---|---|
| 插件层 | `cargo test -p routecodex-v4-standard-plugins --locked`；`node scripts/architecture/verify-v4-standard-plugins.mjs --red-self-test` |
| Runtime | `cargo test -p routecodex-v4-runtime --test l2_runtime --locked` |
| Cordis | `cargo test -p routecodex-v4-cordis-bridge --locked`；真实 Cordis NodeContainer 黑盒 |
| 架构 | resource/function/mainline/verification maps、node-graph、isolation、red suites |
| Live | V4 独立端口真实 Responses JSON/SSE；Direct/Relay 各一条；旧样本/同入口复测 |
| Review | DSH review（opencode-go/deepseek-v4-flash）语义 PASS |

## 完成定义（DoD）

- Node 01-07 请求链插件全部存在且按节点绑定准确 node_id/role_id/position。
- Server input 不检查 model；VR 插件负责 entry admission 和 provider model replacement。
- Direct 与 Relay 请求路径均有真实插件链，provider transport 真实可跑。
- 无旁路 admission handler、无 mock 冒充真实、无控制面入 payload、无硬编码端口。
- map/gate/CI 同步；DSH 无 P0/P1。

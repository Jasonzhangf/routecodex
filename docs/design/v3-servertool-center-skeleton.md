# V3 ServertoolCenter Skeleton（统一 MetadataCenter）

## Scope

本契约定义 RouteCodex V3 流水线中的 ServertoolCenter：所有 server tool（stopless、web_search、servertool CLI）的
统一 MetadataCenter 骨架、固定 hook 挂载点、状态机与配置方案。实现顺序自上而下：本设计 -> function/mainline map
-> 测试锁定 -> 实现。

## 架构原则（Jason 2026-08-07，真源）

1. **数据面零逻辑**：direct 与 relay 的所有数据面（SSE 流、payload、handler、outbound/inbound codec）不做任何
   控制逻辑操作。SSE 只是 transport（纯 framing/backpressure/closeout）。
2. **控制逻辑只活在 MetadataCenter**：server tool 的解析、状态管理、状态机整体推进全部在 ServertoolCenter。
3. **servertool 不是例外**：它与其他控制语义一样，逻辑在 MetadataCenter；数据面只透传投影结果。
4. **stopless 与客户端交互 = noop 调用**：客户端看到统一的 noop（无参数、空返回），文本内容来自剥离的
   模型文字/思考（不丢失响应内容）。
5. **MetadataCenter 三段式**：先管理"当前工具是哪一个"（工具识别），再状态判断，再操作。
6. **隔离键**：session ID + 端口（port）+ routing_group + conversation（工具维度独立）。
7. **其他节点的逻辑判断只是 hook**：没有独立完整生命周期，只执行 MetadataCenter 状态机决策。

## 骨架（ServertoolCenter 节点）

```text
请求链:
V3HubReqContinuation03Classified
  -> V3HubReqChatProcess04Governed            (Req04 治理入口)
  -> [ServertoolReq01ToolIdentified]          (工具识别: stopless/web_search/CLI)
  -> [ServertoolReq02StateLoaded]             (MetadataCenter load: session/port 隔离)
  -> [ServertoolReq03HookApplied]             (固定 hook: 注入 guidance/noop 消费/状态推进)
  -> V3HubReqExecution05Planned

响应链:
V3ProviderRespInbound01Raw
  -> V3HubRespChatProcess03Governed           (Resp03 治理入口)
  -> [ServertoolResp01ToolInspected]          (工具识别: reasoningStop/web_search/CLI 调用)
  -> [ServertoolResp02StateTransitioned]      (MetadataCenter transition: 状态机推进)
  -> [ServertoolResp03Projected]              (固定 hook: 投影 noop/剥离/文本保留)
  -> V3HubRespContinuation04Committed

direct 对齐:
direct 请求/响应在 same-protocol direct 路径使用同一 ServertoolCenter（同一工具识别/状态机/hook 注册表），
不新增数据面路径；direct stopless 默认关闭，开启时只走 ServertoolCenter 逻辑。
```

## 三段式（ServertoolCenter 统一流程）

1. **工具识别（identify_tool）**：从数据面观察（只读）识别当前工具是哪一个：
   - `stopless`：请求侧 `routecodex hook run reasoningStop` CLI pair / 响应侧 `reasoningStop` function_call
   - `web_search`：`web_search` / `web_search_preview` 工具声明与调用
   - `servertool_cli`：已注册 servertool 的 CLI 投影调用
2. **状态判断（load + state machine）**：按 `V3ServerToolCenterKey`（tool_name + scope_key：
   entry/endpoint/port/routing_group/session/conversation）load 实例，按工具状态机判定迁移：
   - stopless：Idle -> ProviderTurnInFlight -> RespStopObserved -> CliNoopProjected -> CliNoopObserved ->
     ContinuationGuidancePrepared -> ProviderTurnInFlight（或 TerminalCompleted/TerminalBlocked/GuardTerminal）
   - web_search：Mode B（metadata_center_local_search）的请求/响应状态机
   - servertool_cli：CLI 投影生命周期
3. **操作（transition + hook 投影）**：执行状态迁移（原子，fail-fast 防串台），再执行固定 hook 投影：
   - stopless 续杯：finish_reason -> tool_calls + noop（无参数）+ 文本；客户端返回空结果 -> 下一轮续杯
   - stopless Terminal：剥离工具调用 + finish_reason=stop + 文本/证据保留
   - guard 终止：回滚为剥离的纯文本 stop 响应

## hook 注册与固定挂载点

- **hook 只能从固定节点调用**：Req04 请求治理（V3HubReqChatProcess04Governed）与 Resp03 响应治理
  （V3HubRespChatProcess03Governed）。禁止在 SSE、handler、inbound/outbound codec、store transport、
  provider runtime 调用或补偿。
- **hook 注册表**：ServertoolCenter 维护 `工具 -> hook 执行器` 注册（register_hook），pipeline 节点通过
  Center 分发；hook 无独立生命周期，只执行状态机决策的投影。
- **禁止**：hook 在非固定节点散落调用；数据面自行解析/改写控制语义；控制状态进入 provider/client payload。

## 配置方案（config 驱动）

- 每个 server 声明 ServertoolCenter 启用与工具注册：
  - `stopless_center`（已有）：stopless 工具启用
  - `responses_direct_stopless_center`（已有，默认关闭）：direct stopless 启用
  - web_search：`web_search_execution_mode`（已有：metadata_center_local_search 等）+ `web_search_backend`
  - servertool CLI：已注册 servertool 的声明（hook 绑定）
- 配置编译为 manifest 后，ServertoolCenter 按 manifest 注册工具与 hook（配置驱动注册，不在运行时动态发现）。

## direct/relay 对齐

- relay：Req04/Resp03 治理节点挂载 ServertoolCenter hooks（现状收敛为注册表调用）。
- direct：same-protocol direct 的对应治理点使用同一 ServertoolCenter（工具识别/状态机/hook 注册表），
  不复制逻辑；direct stopless 默认关闭。
- 数据面（SSE/JSON 透传）不因 direct/relay 差异做任何控制处理。

## 完成标准

1. ServertoolCenter 节点在 mainline-call-map 显式声明（工具识别/状态/投影 step）。
2. hook 只在 Req04/Resp03 固定挂载点调用（红测锁定静态约束）。
3. 三段式（识别 -> 判断 -> 操作）在 ServertoolCenter 统一实现；状态机整体管理在 Center。
4. 数据面无控制逻辑（SSE 透传；payload 不重建控制状态）。
5. stopless 续杯/Terminal/guard 行为与本文档一致（测试锁定）。
6. direct 与 relay 共用同一 ServertoolCenter。

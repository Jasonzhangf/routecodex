# 22 Servertool Hook Skeleton Workflow

## 触发
- servertool / stopless / reasoning_stop / hook run / CLI projection / followup / reenter / tool injection / schema validation 开发或 debug。
- 用户要求“全流程 Rust / 0 TS 业务语义 / hook 骨架 / 黑盒闭环”。

## 核心结论
- 业务执行生命周期仍是 client-visible CLI：`routecodex hook run <toolName> --input-json <json>`。
- hook 不替代 CLI；hook 只治理请求/响应处理流程。
- 标准骨架真源：`docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md`。
- 机器真源：`docs/architecture/mainline-call-map.yml` 的 `servertool.hook_skeleton.mainline`。
- owner/verification map 只在 Rust owner symbols 与 tests 存在后登记 `hub.servertool_hook_skeleton`；当前不得伪造 canonical builders。
- 实施顺序、debug 切段、删 TS 前置条件见 `references/23-servertool-hook-dev-debug-flow.md`。
- 归一化节点不做任何业务逻辑。inbound normalization 允许做“入口/上游协议 -> Hub chat process 语义”的相邻协议映射与 shape/字段类型校验；outbound normalization 允许做“Hub chat process 语义 -> provider/客户端入口协议”的相邻协议映射与投影。工具 identity 配对/唯一性/orphan 判定、工具治理和任何 hook 的逻辑 payload 处理都不能出现在归一化阶段。servertool/stopless hook 只能出现在 Chat Process 请求侧和响应侧。
- provider compat 节点只承载标准 provider 协议与 provider-family 实现差异之间的微调。`ProviderReqCompat` / `ProviderRespCompat` 禁止重做协议映射、工具治理、route/model 选择、fallback/silent repair；只有真实 runtime owner 存在时才可把 manifest 边从 `binding_pending` 提升为 `anchored`。
- stopless 是 servertool hook skeleton 上的第一个内置 hook，不是独立新骨架。响应侧拦截必须发生在 Chat Process 响应治理后、continuation save 前；请求侧拦截必须发生在 Chat Process 请求入口的 context/continuation restore 后、请求治理完成前。

## 标准流程
1. 先查 owner/map/wiki
- `rg -n 'servertool.hook_skeleton.mainline|servertool-hook-skeleton-mainline-source' docs/architecture`
- 当前 mainline 若是 `binding pending`，不得宣称实现完成。

2. 画当前路径
- 响应端：`HubRespChatProcess03Governed -> ServertoolRespHook01Intercepted -> ... -> ServertoolRespHook06ProjectionFinalized -> HubRespContinuation04Committed -> HubRespOutbound04ClientSemantic`
- CLI：`ServertoolRespHook03HookResponseInjected -> routecodex hook run ... -> ordinary tool result`
- 请求端：`HubReqChatProcess context/continuation restore -> ServertoolReqHook01ResultParsed -> ... -> ServertoolReqHook04RequestFinalized -> HubReqChatProcess governed request`
- 对称边界：响应端必须在 continuation save 前完成 hook 投影；请求端必须在 continuation restore 后消费同一轮普通 tool result，并把 stopless CLI result 转成私有控制证据 / 普通 user prompt。两边必须围绕 Chat Process save/restore 边界配对，不能在不可变区插入语义。

3. 先补红 gate / 红测
- red gate 必须先证明当前 TS 活语义仍存在或当前 hook skeleton 未实现。
- 禁止先迁实现再补测试。

4. 单元测试必须闭合完整可能性
- normal response
- abnormal/error response
- empty schema / no_schema
- invalid schema
- malformed hook args
- valid terminal schema
- non-terminal / still-running
- already-terminal
- malformed CLI stdout
- required hook missing
- optional hook skipped no-op
- multi-hook ordering / effect merge

5. 黑盒必须覆盖必经之路
- client in -> provider out -> provider in -> response hook intercept/schema -> client exec_command -> client tool result -> request result parse/rewrite/tool inject -> provider out。
- backend-route/followup 还必须覆盖 reenter/clientInject/providerInvoke effect 执行后回到 normal client projection。
- direct/provider-direct negative 必须证明 hooks 不激活。

6. 替换顺序
- 先 Rust hook skeleton/scheduler。
- 再响应端 intercept/schema/inject/finalize。
- 再请求端 result parse/text rewrite/tool inject/finalize。
- 再 followup/reenter effect plan。
- 最后删 TS 业务语义，保留 IO shell。

## Required/Optional 规则
- 每个 hook 必须声明 required/optional。
- required 缺失、失败、输出非法必须 fail-fast。
- optional 未启用必须产出 no-op event。
- optional 不得 fallback 到另一条业务路径。
- 多 hook 排序：`priority -> order -> id`。
- duplicate hook id fail-fast。

## 禁止
- 把 hook 当成 CLI 替代方案。
- stopless CLI 改回 server-side followup/reenter。
- 把 hook 误当成 Responses continuation store/restore owner；hook 只消费当前请求的 tool result / response event，不负责 `responses_resume` 或 `responses-conversation-store` 的恢复判定。
- 把工具治理、stopless/servertool hook、schema 判定、tool result 解析/改写、payload 逻辑处理放进请求进入归一、响应进入归一、请求输出归一、响应输出归一、SSE、handler 或 provider runtime。
- TS 注册/排序/选择业务 hook。
- TS 解析 schema、重判 terminal/retry/backoff、构造 followup payload。
- 只跑单元测试就宣称上线闭环。

## 必跑验证
- `cargo test -p servertool-core`
- `cargo test -p router-hotpath-napi servertool --lib`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- 新增/相关 servertool hook blackbox Jest
- 可上线前必须跑旧样本或 live replay；不能 replay 时明确缺口。

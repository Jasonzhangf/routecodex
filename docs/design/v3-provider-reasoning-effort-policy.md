# Provider 可配置的思考强度

状态：独立设计 review 已 PASS，typed 配置链与候选实现已接通。候选验证由本任务回执记录；安装、live 验收与集成由父任务负责。

## 目标

允许每个 provider 通过 provider-directory TOML 声明一个可选的最终思考强度。
显式配置存在时，它以 provider 配置为准，覆盖客户端请求和既有 compat mappings
在 provider wire 上已经形成的 effort。配置省略时，完整保留当前客户端、协议投影
和 compat 行为。

示例：

```toml
[provider.v3]
reasoning_effort = "medium"
```

`medium` 只是配置示例和测试值。产品代码读取通用 typed enum 值，禁止写入
MTPLX、provider id、模型 id 或固定 `medium` 的分支。

## 配置合同

- 字段名固定为 `reasoning_effort`，使用 snake_case。
- `V2ProviderV3Config` 当前使用 `#[serde(rename_all = "camelCase")]`。
  新字段必须显式声明 `#[serde(default, rename = "reasoning_effort")]`，
  不得依赖 Rust 字段名或 camelCase 自动命名。只接受 exact
  `reasoning_effort`；不添加 `reasoningEffort` alias。
- 值类型是 `Option<V3ReasoningEffort>`，enum 使用
  `#[serde(rename_all = "snake_case")]`，只接受 `low`、`medium`、`high`、
  `xhigh`。非法值在 provider-directory TOML 解析时失败。
- 该字段只属于 provider 配置。它不是 model thinking 元数据，不改变
  `supports_thinking`、`thinking`、`enable_thinking`、sampler、`max_tokens`、
  cache、client、health 或 error contract。
- 只有 `openai_chat` 和 `responses` provider 支持该字段。`anthropic` 或
  `gemini` provider 显式配置该字段时，Config 编译必须返回 typed
  `V3ConfigError::Validation`，并且不得发布 `V3Config05ManifestPublished`。

## typed 传递链

字段沿唯一配置链传递，不在 wire payload、metadata、日志或隐式上下文重建：

1. `V2ProviderV3Config.reasoning_effort: Option<V3ReasoningEffort>` 从 exact
   `provider.v3.reasoning_effort` 解析。
2. `compile_provider_directory` 把值复制到
   `V3ProviderAuthoringConfig.reasoning_effort`。
3. `compile_providers` 校验协议并把值复制到
   `V3ProviderManifest.reasoning_effort`。
4. `V3TargetInterpreter` 在展开 provider 候选时把值复制到
   `V3TargetCandidate.reasoning_effort`。该值随 Target10 已选 provider
   目标传递。
5. `ProviderReqCompat06ProviderCompat` 是唯一 wire 覆盖 owner。它在标准协议
   投影和既有 compat mappings 之后读取 `selected.reasoning_effort`，只覆盖
   provider wire 的 effort 字段。

唯一 owner：

- Config typed 定义与编译：`routecodex-v3-config`。
- 已选目标承载：`routecodex-v3-target::V3TargetCandidate`。
- provider wire 覆盖：`apply_v3_provider_req_compat_to_provider_payload`
  所在的 `ProviderReqCompat06ProviderCompat`。

## wire 行为

`ProviderReqCompat06ProviderCompat` 只在配置值存在时执行覆盖。覆盖发生在
`run_req_outbound_stage3_compat` 之后，因此 provider 配置拥有最终值。没有配置时
不新增写入、不删除字段、不改变既有 compat 结果。

覆盖规则：

| provider wire | 最终 effort 位置 |
| --- | --- |
| OpenAI Chat | `reasoning_effort` |
| Responses | `reasoning.effort` |

配置协议以外的 Anthropic 和 Gemini 已在 Config 编译时失败，因此不会进入该 owner。
覆盖只改 effort 值；同一 payload 的其他字段保持原值。配置值不写入客户端响应、
metadata、错误 payload 或控制日志。

Responses 的 `reasoning` 缺失或为 null 时，创建可承载 effort 的对象；已是对象时
只覆盖 effort，保留其他成员。非 null 的非对象值属于 opaque business data，
不能在保留原值的同时表示 `reasoning.effort`。配置覆盖在此处返回现有 typed
`V3ProviderCompatError`，分类为 `RequestPayloadInvalid`，由既有 Error 链处理；
不 panic，不替换原始值，也不向客户端发送错误。省略配置时，此类原值照常透传。

## DAG、终止与清理边界

项目图产物：

`docs/architecture/dags/v3.provider_request_policy_injection.graph.json`

图的语义审阅面：

`docs/architecture/dags/v3.provider_request_policy_injection.md`

图描述已发布 manifest 之后的单个 runtime 请求对象流：

```text
路由目标
-> Target09 展开候选并携带 provider policy
-> Target10 选定具体 provider 目标
-> ProviderReqCompat06 补齐输出上限并覆盖显式思考强度
-> provider wire 请求
```

唯一入口是 `路由目标`。唯一出口是
`已应用 provider 请求策略的 provider wire 请求`。

配置编译是图入口之前的同步前置依赖，不是同一对象流的第二个入口：

- exact TOML 解析失败或非法 enum 返回 `V3ConfigError::Parse`。
- unsupported protocol 返回 `V3ConfigError::Validation`。
- 两种失败都在 `V3Config05ManifestPublished` 之前终止。没有 listener、进程、
  文件句柄或异步任务由本 feature 创建，因此取消和运行时清理不适用于配置失败路径。
- 请求进入 runtime 后，既有 Error 链继续拥有 provider 请求失败、重试和耗尽；
  本 feature 不增加 client error 响应，也不改变 no-client-error contract。

测试 listener 和外部 provider fixture 不属于产品图节点。它们由测试自身拥有。
测试必须在断言后关闭 server handle，并验证独占 fixture listener 不再接受连接。
该清理终点只回收本任务创建的 listener，不触碰 4444、7777 或其他进程。

## 黑盒验收

使用真实公开 consumer，不使用内部函数 mock：

- 测试从独占 provider-directory TOML 通过 `V3UserConfigStore` 加载并编译。
- 使用 `spawn_v3_server_aggregate` 建立隔离 HTTP listener。
- 客户端通过公开 HTTP entry 发送 Chat 和 Responses 请求。
- 外部 provider fixture 捕获实际 wire 请求。
- Direct 和 Relay 都覆盖。

必须断言：

- 配置 `medium` 时，客户端发送 `xhigh`，provider wire effort 为 `medium`。
- 配置 `medium` 时，客户端不发送 effort，provider wire effort 为 `medium`。
- 未配置 effort 时，客户端 `xhigh` 保持 `xhigh`。
- 配置 `low` 时，provider wire effort 为 `low`。
- 同一请求的其他字段保持不变。
- 同一 manifest 中未配置 effort 的其他 provider 不受影响。
- 无效 enum 和 unsupported protocol 编译失败，且不发布 manifest。
- 失败路径遵守项目 no-client-error contract；测试不期待 client `502`。
- Responses 覆盖遇到 boolean、string、number、array reasoning 时，transport
  及时结束且没有 client error；原始 request 和 typed Error 链保留在诊断样本。
  同一 listener 的后续独立请求成功；省略配置可透传 opaque 值，null 可承载覆盖。
- 测试结束后 listener 和 fixture 资源已清理。

定向测试和公开 consumer E2E 通过后，运行受影响的 architecture gates 和完整
candidate build。作者证据必须绑定 candidate commit SHA。安装、live MTPLX
验收、merge 和 runtime 交付由父任务负责；本任务不安装 binary，不重启 RCC，
不修改 4444/7777 配置，也不向 8100 发送推理请求。

# Direct Semantic Classification

## Goal

把 same-protocol direct 的模型名、thinking effort、响应模型投影提升为一个通用分类流程。配置定义类别，Virtual Router 解析类别，Rust request/response projector 执行类别，Host 只执行 IO。

## Non-goals

- 不改变 direct/relay eligibility。
- 不改变 provider health、quota、retry、default floor。
- 不把 provider-specific 逻辑放进 Hub Pipeline 或 Virtual Router。
- 不让 forwarder、MetadataCenter、HTTP handler 成为 policy owner。
- 不改变现有 provider transport/auth/runtime 协议职责。

## Authoring Contract

唯一公开配置：

```toml
[provider.models."<modelId>".direct]
semantics = "routing"
```

允许值：

- `routing`：默认。使用路由 canonical model/thinking，并在响应恢复 client-visible model。
- `passthrough`：必须显式。request model/thinking 与 provider response model/thinking 都保持数据面原样。

禁止多个独立布尔开关，例如：

```toml
modelPassthrough = true
thinkingPassthrough = true
restoreResponseModel = false
```

原因：独立布尔会产生无效组合、双路径和持续补丁分支。

## Canonical Types

```rust
enum DirectSemanticClass {
    Routing,
    Passthrough,
}

enum DirectSemanticSource {
    ClientRequest,
    RoutingPolicy,
    ProviderModelConfig,
    ProviderResponse,
}

enum DirectFieldProjection {
    Preserve,
    Set(Value),
    RestoreOriginal,
}

struct ConfigDirect01AuthoringPolicy {
    semantics: Option<String>,
}

struct ConfigDirect02ValidatedPolicy {
    semantic_class: DirectSemanticClass,
}

struct VrDirect03ResolvedSemantics {
    semantic_class: DirectSemanticClass,
    selected_provider_key: String,
    selected_runtime_key: String,
    configured_model_id: String,
    request_model: Option<String>,
    route_thinking: Option<String>,
    request_thinking: Option<String>,
}

struct DirectReq04ProjectionPlan {
    model: DirectFieldProjection,
    thinking: DirectFieldProjection,
}

struct DirectResp05ProjectionPlan {
    model: DirectFieldProjection,
    thinking: DirectFieldProjection,
}
```

`DirectSemanticSource` 只用于诊断 provenance，不进入 provider/client payload。

## Lifecycle

```text
provider model authoring config
  -> ConfigDirect01AuthoringPolicy
  -> ConfigDirect02ValidatedPolicy
  -> provider profile/runtime manifest
  -> forwarder/VR selects real provider target
  -> RoutePoolTier.thinking -> SelectionResult.route_thinking -> target.routeThinking
  -> VrDirect03ResolvedSemantics
  -> DirectReq04ProjectionPlan
  -> provider wire
  -> raw provider response
  -> DirectResp05ProjectionPlan
  -> client frame
```

## Node Responsibilities

### ConfigDirect01AuthoringPolicy

- 读取 provider model 下的显式 `direct.semantics`。
- 不读取 route pool、port、forwarder runtime state。

### ConfigDirect02ValidatedPolicy

- 缺失值编译成 `routing`。
- `routing` / `passthrough` 编译成闭合枚举。
- 未知值、数组、对象、空字符串显式失败。
- 输出 deterministic manifest；runtime 不重新解析 TOML。
- 只写 `config.provider_profile_projection`；此阶段尚未创建 request-scoped `direct.semantic_policy`。

### VrDirect03ResolvedSemantics

- 只在 VR/forwarder 已解析 real provider target 后运行。
- 绑定 selected provider/runtime/configured model 与 semantic class。
- 只从 VR selected target 的 `routeThinking` 读取 route thinking；不得从 `routeParams` 派生。
- 收集 client/route/provider provenance，供 projector 使用。
- 是 `direct.semantic_policy` 的唯一 writer；validated config 只是输入，不与 request-scoped resolved contract 共用资源 owner。
- 不改 request/response payload。

### DirectReq04ProjectionPlan

`routing`：

- model：`Set(configured canonical modelId)`。
- thinking：`Set(route thinking)`；协议字段映射由 projector 合同统一完成。
- 保存 client-visible original model 作为同一 plan 的 response projection input。

`passthrough`：

- model：`Preserve`。
- thinking：`Preserve`。
- provider model default、route thinking 不覆盖 client direct 数据面。

### DirectResp05ProjectionPlan

`routing`：

- JSON/SSE 已识别 model 字段：`RestoreOriginal`。
- thinking response：保持现有协议数据，不做 provider-specific修补。

`passthrough`：

- model：`Preserve`。
- thinking：`Preserve`。

Request 与 response 必须消费同一个 `VrDirect03ResolvedSemantics`。response 所需的 original client model 已绑定在该 resolved contract 内，不依赖 request projector 的执行结果。禁止 response 从 `originalClientModel`、`payloadChanged`、response shape 猜分类。

## Forwarder Boundary

Forwarder 只做：

```text
logical protocol/model target -> real provider target
```

Forwarder 不声明、不覆盖、不缓存 direct semantic policy。real target 选定后，VR 从 compiled provider/model profile 解析 policy。

Route thinking 不属于 forwarder policy，也不属于 `routeParams` 派生字段。它的唯一 runtime 链路是：

```text
RoutePoolTier.thinking
  -> SelectionResult.route_thinking
  -> target.routeThinking
  -> VrDirect03ResolvedSemantics.route_thinking
```

任何把 top-level `thinking` 塞进 `routeParams` 的测试都不是有效证据。

## Control/Data Boundary

`direct.semantic_policy`：

- 是 request-scoped control contract。
- 可被 VR、request projector、response projector、diagnostic observer 读取。
- 不得写入 provider body、provider SDK options、client JSON/SSE、continuation state。
- 不得从 MetadataCenter 恢复或跨请求复用。

## Ownership

- Config compile owner：`config.user_config_materialization` / `config.provider_profile_materialization`。
- Classification owner：`hub.direct_semantic_classification`，Rust target。
- Request/response projection owner：现有 `hub.direct_route_model_hooks` 后续升级为 classifier consumer。
- Host：只执行 native plan、stream IO、MetadataCenter observation IO。

## Runtime Binding

- `ConfigDirect01AuthoringPolicy -> ConfigDirect02ValidatedPolicy`：
  `provider_bootstrap::normalize_model_direct_semantic -> direct_semantic_classification::validate_config_direct_02`。
- `ConfigDirect02ValidatedPolicy -> VrDirect03ResolvedSemantics`：
  `resolve_direct_semantic_classification_json -> resolve_direct_semantic_classification`。
- `VrDirect03ResolvedSemantics -> DirectReq04ProjectionPlan`：
  `direct_route_model_hooks::plan_request_hooks -> build_direct_req_04_projection_plan`。
- `VrDirect03ResolvedSemantics -> DirectResp05ProjectionPlan`：
  `direct_route_response_action::plan_direct_route_response_action -> build_direct_resp_05_projection_plan`。

四条边均由 Rust 类型与 builder 实现；Host 只调用 native plan 和执行 stream/IO action。

## Migration Order

1. 设计、resource/function/mainline/test map 锁定。
2. Config red tests + Rust validated policy types。
3. Manifest/provider profile projection。
4. VR real-target classification red tests + resolver。
5. Request projection red tests + planner。
6. Response JSON/SSE projection red tests + planner。
7. Host 收缩，物理删除旧本地推断。
8. Architecture gates、native/base build、global install、managed restart、same-entry live replay。

禁止先在 `router-direct-pipeline.ts` 加条件，再回补 config/VR owner。

# Direct Semantic Classification Test Design

## Lifecycle

`ConfigDirect01AuthoringPolicy -> ConfigDirect02ValidatedPolicy -> VrDirect03ResolvedSemantics -> DirectReq04ProjectionPlan / DirectResp05ProjectionPlan`.

同一个 request-scoped resolved contract 同时驱动 request 和 response。forwarder 先解析 real target，semantic classification 后执行。

Route thinking 的唯一输入链路是 `RoutePoolTier.thinking -> SelectionResult.route_thinking -> target.routeThinking -> VrDirect03ResolvedSemantics.route_thinking`。测试必须使用真实 authoring shape 的 top-level route tier `thinking` 字段；把 `thinking` 塞入 `routeParams` 只会证明错误输入，不能作为 runtime 证据。

## Whitebox

正向：

- 缺失 `direct.semantics` 编译为 `routing`。
- 显式 `routing` 编译为 `DirectSemanticClass::Routing`。
- 显式 `passthrough` 编译为 `DirectSemanticClass::Passthrough`。
- `routing` request plan 设置 canonical model 和 route thinking。
- `routing` response plan恢复 original client model。
- `passthrough` request/response model 与 thinking 都返回 `Preserve`。

反向：

- 未知字符串、空字符串、数组、对象配置 fail-fast。
- 独立 model/thinking/response 布尔配置字段被 schema/gate 拒绝。
- response planner 缺失 resolved contract 时 fail-fast。
- request/response semantic class 不一致时 fail-fast。
- projector 不读取 provider config、route config、MetadataCenter。
- response projector 不依赖 request projector 输出或 payload mutation 结果。

## Module Blackbox

Config：

- provider model policy进入 deterministic runtime manifest。
- config compile 只生成 provider profile projection，不提前创建 request-scoped `direct.semantic_policy`。
- alias 与 canonical model 解析不改变 policy identity。
- 旧配置输出与当前 runtime manifest 等价，新增字段默认 `routing`。

Virtual Router：

- direct + real target：输出 resolved contract。
- 只有 `VrDirect03ResolvedSemantics` 可以创建 request-scoped `direct.semantic_policy`。
- relay/non-direct：不创建 direct semantic policy。
- forwarder 命中：按最终 real provider/model policy分类。
- HTTP server 从 VR target 构造 router-direct input 时必须传递 `target.directSemantic`；该层不得解释 routing/passthrough。
- HTTP server 从 VR target 构造 router-direct input 时必须传递独立的 `target.routeThinking`；resolver/projector 不得从 `routeParams` 回读 thinking。
- 两个 forwarder target policy 不同：选择哪个 real target就使用哪个 policy，不串台。
- provider/model policy 缺失：确定性 `routing`，不从 route/client推断。

Projector：

- `routing` JSON 与 SSE model restore 对齐。
- `passthrough` JSON 与 SSE 保持上游响应。
- malformed SSE 保持 transport 等价。
- 未修改 payload 时保持 object identity。

## Project Blackbox

- 旧 provider 配置 + direct 请求：final provider request 与当前行为相同。
- 显式 passthrough：final provider request 的 model/thinking 等于 client request。
- 显式 passthrough：client response 的 model/thinking 等于 provider response。
- routing：client alias、provider canonical model、response restore 三段证据完整。
- relay 请求不受 direct semantic policy 影响。
- provider retry/reroute 后按新 real target 重新解析 policy；禁止沿用旧 provider policy。
- HTTP same-entry 黑盒必须证明默认 routing、显式 passthrough、forwarder real target 和 retry 后新 target policy 四类接线都经过真实 server -> VR -> router-direct 路径。

## Positive/Negative Risk Locks

正向锁：

- 默认兼容。
- 显式 passthrough。
- forwarder real-target policy。
- JSON/SSE parity。
- retry 后 policy 更新。

反向锁：

- 非 direct 污染。
- MetadataCenter 第二真源。
- response 模式猜测。
- provider-specific 分支。
- forwarder policy owner。
- silent fallback。
- invalid config组合。

## Required Gates

设计阶段：

- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `npm run verify:direct-semantic-classification-design`

实现阶段：

- focused Rust config/classifier/projector tests
- provider config materialization blackbox
- router-direct focused Jest
- request dry-run final provider request fixtures
- response JSON/SSE dry-run fixtures
- direct semantic residue/red gate
- native hotpath build
- base build
- global install + managed restart
- same-entry routing/passthrough/forwarder/retry live replay

## Runtime Evidence

- config compiler 已生成 deterministic `directSemantic` provider profile/target runtime 字段。
- VR selection 已把 top-level route tier `thinking` 投影为 `SelectionResult.route_thinking`，再输出到 selected target 的 `routeThinking`。
- `VrDirect03ResolvedSemantics` 在 real target eligibility 完成后由 native resolver 创建。
- HTTP server 已把 VR real target 的 `routeThinking` 与 `directSemantic` 投影进 router-direct input；缺 `routeThinking` 会让 routing request thinking 保持 client 值而不是 route 值。
- request/response projector 已消费同一个 typed resolved contract。
- `dsc-01..dsc-04` 已绑定真实 Rust caller/callee，不再 `binding pending`。
- source closeout、native/base build、global install、managed aggregate restart 与 same-entry routing/passthrough/retry live replay 均已有证据。Passthrough live evidence came from a bounded temporary config probe and is not an online rollout.

## Managed-Live Evidence

- Temporary config probe: Jason 授权后，在受控验证窗口内向 `~/.rcc/provider/cc/config.v2.toml` 临时加入 `[provider.models."gpt-5.5".direct] semantics = "passthrough"`；`routecodex config validate` 通过。该授权只用于验证，不代表上线。
- Runtime identity: global `routecodex`、global `rcc`、`~/.rcc/install/current/package.json` 与 4444/5520/5555/10000 `/health.version` 均为 `0.90.3932`；一次 `routecodex restart --port 5555` 完成 aggregate restart。
- Request passthrough: `direct-passthrough-dryrun-20260713T055340` 命中 `cc.key1.gpt-5.5`，provider-request 保留 client `model=client-visible-passthrough-model` 与 `reasoning.effort=low`，没有采用 `tools` route 的 `xhigh`。
- JSON response passthrough: `direct-passthrough-json-20260713T055404` 的 provider/client response 均为 `model=gpt-5.5-anyint`、effort `low`，返回 `PASSTHROUGH_JSON_OK`。
- SSE response passthrough: `direct-passthrough-sse-20260713T055458` 的 provider/client frames 在移除 client transport `: keepalive` 前缀后字节相等；model、effort、事件序列、`PASSTHROUGH_SSE_OK` 与 `[DONE]` 一致。
- Retry reclassification: `direct-passthrough-reroute-20260713T055707` 首轮 `cc` passthrough 原样发送无效 client model并收到 403；ErrorErr reroute 到 routing `asxs.crsa.gpt-5.5` 后，raw provider response 使用 canonical `gpt-5.5-2026-04-23` 与 route `xhigh`，client response 恢复 original client model。这证明新 real target 会重新解析 policy，不沿用旧 passthrough class。
- Isolation: dry-run、JSON、SSE、provider-error 与 retry provider/client artifacts 均无 `direct.semantic_policy`、`directSemantic`、`MetadataCenter` 或 projector contract 泄漏。
- Withdrawal proof: 临时 direct block 已从真实 provider config 删除；再次 `routecodex config validate`、aggregate restart 和四端口 health/version 检查通过。最终 provider-request dry-run `direct-routing-after-config-withdrawal-*` 返回 canonical `model=gpt-5.5` 与 route `reasoningEffort=xhigh`，证明当前运行态仍是默认 routing。

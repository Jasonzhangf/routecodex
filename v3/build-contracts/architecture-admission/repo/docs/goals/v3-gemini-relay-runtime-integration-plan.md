# V3 Gemini Relay Runtime Integration Plan

## 1. 目标与验收标准

目标：把当前只完成 codec characterization 的 Gemini `/v1beta/models/:model/generateContent` 入口，推进为受控 V3 Relay Runtime 闭环：Server endpoint -> entry protocol binding -> Hub v1 Relay -> provider wire -> Hub response projection。

验收标准：

- Gemini endpoint 不再落到隐式 foundation pending；若仍未接线，必须是显式 typed pending。
- JSON、SSE、provider error、side-channel isolation 均通过受控 Runtime/Server loopback。
- Gemini provider 差异只在 Gemini codec/provider runtime owner 内处理；Hub/VR/Server 不写 provider-specific 分支。
- 不声明 live/provider/global 可用，除非后续另获授权并完成真实 provider replay。

## 2. 范围与边界

In scope：

- 新 feature：`v3.gemini_relay_runtime_integration`。
- Gemini entry binding 从 `pending_not_implemented` 进入 controlled runtime implementation。
- 复用已验证的 `v3.protocol_gemini_codec_characterization` codec 链。
- 补齐 function map、mainline call map、verification map、manifest/wiki/review gate。
- 受控 JSON/SSE/error/isolation loopback tests。

Out of scope：

- V2、P6、`~/.rcc`、live 5555、global install/restart、real credential/provider replay。
- Responses Direct、Anthropic Relay、OpenAI Chat Relay、inbound WebSocket。
- Hub/VR/Server provider-specific branch、fallback、history repair、SSE materialize、第二 Runtime lifecycle。

## 3. 设计原则

- Server 只消费 entry protocol binding registry，不维护 raw path 协议表。
- Hub v1 Relay 保持固定节点拓扑；Gemini 协议差异在相邻 codec/provider runtime 边界解决。
- metadata/resource/debug/error carrier 不得进入 provider/client normal payload。
- 错误必须进入 Error01-06；不允许把 provider error 包成成功。
- 先红后绿：先证明 Gemini endpoint 仍 pending/unwired，再实现唯一 owner。

## 4. 技术方案与文件清单

必须先查：

- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml`
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- `docs/goals/v3-gemini-codec-characterization-plan.md`
- `docs/goals/v3-entry-protocol-endpoint-binding-parallel-goals-plan.md`

候选实现面：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs`
- 新 Gemini Relay Runtime owner 文件，以 map 锁定为准
- `v3/crates/routecodex-v3-server/src` 只做 endpoint binding consumer
- `v3/crates/routecodex-v3-runtime/tests/*gemini*`
- `scripts/architecture/verify-v3-gemini-relay-runtime-integration.mjs`
- `scripts/tests/v3-gemini-relay-runtime-integration-red-fixtures.mjs`
- V3 architecture maps/wiki/manifest

## 5. 风险与规避

- 风险：把 Gemini 特例写进 Hub/VR/Server。规避：source gate 禁止 provider-specific Hub/Server 分支。
- 风险：endpoint 从 pending 变成隐式 fallback。规避：Server test 锁 explicit implementation owner。
- 风险：SSE 通过完整 materialization 伪装成功。规避：incremental stream tests + materialization source gate。
- 风险：错误提前投影客户端。规避：Error01-06 provider error replay。

## 6. 测试计划

- 红测：当前 Gemini endpoint 为 explicit `pending_not_implemented` / runtime unwired。
- JSON 正向：受控 provider 返回 Gemini JSON，client projection 等价。
- SSE 正向：Gemini SSE 分块/多 candidate/event 增量投影，不 materialize。
- 错误反向：provider 4xx/5xx/malformed SSE 进入 Error01-06。
- 隔离反向：metadata/resource/debug/error carrier 不进 provider/client payload。
- 架构门禁：V3 module boundaries、Rust-only、resource map、architecture docs、cargo fmt/clippy/workspace、diff check。

## 7. 实施步骤

1. 刷新 `.agent-collab`，claim `feature_id:v3.gemini_relay_runtime_integration`。
2. 用 map/mainline/verification/wiki 锁唯一 owner；查不到先补 contract。
3. 写红测证明当前 endpoint pending/unwired。
4. 接入 Gemini Relay Runtime JSON 路径。
5. 接入 Gemini SSE 增量路径。
6. 接入 provider error 与 isolation gates。
7. 同步 maps/manifest/wiki/review gate。
8. 跑 required gates 并做 architecture review。

## 8. 完成定义

- 受控 Gemini JSON/SSE/error/isolation 通过唯一 Hub v1 Relay mainline。
- Gemini endpoint 状态从 explicit pending 变为 controlled runtime implemented。
- 所有 docs/maps/gates/evidence 完整。
- 不声明 live/provider/global production 可用。

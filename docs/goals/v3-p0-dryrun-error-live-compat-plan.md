# V3 P0 Dry-run, Error Policy, and Live Compat Plan

## 1. 目标与验收标准

目标：对 RouteCodex V3 的 P0 parity items 2/3/4 做审计、红测、实现与 live 闭环：统一跨入口 provider-request dry-run；让 direct 与 relay 的 provider 错误都进入同一 Error01-06 分类/处理链；用当前多 provider 5555 profile 重建 live compatibility matrix。

验收标准：

- `/v1/responses`、`/v1/messages`、direct/relay 已启用入口的 provider-request dry-run 都执行到 provider wire build 后、network send 前终止，并证明 `provider_network_send=false`。
- dry-run 不写 provider health、failure count、cooldown、retry/backoff、continuation、session truth，不触发 provider network send。
- direct 与 relay 的 provider/runtime 执行错误都进入统一错误中心；direct 只做 request/response passthrough，不做 error passthrough。
- provider 错误在所有可选项耗尽前不得投影给客户端；优先 switch provider 继续流水线。
- 单 provider 连续错误计数、5 秒阻塞、3 次后 15 分钟冷却、default 最后 provider 不移出且第 3 次后返回客户端的状态机被正反测试锁住。
- 当前 5555 多 provider profile 的 live compatibility matrix 与真实 config/profile/evidence 一致；controlled/source/live/profile-disabled/provider-quota-blocked/runtime-defect 状态明确。

## 2. 范围与边界

In scope：

- Item 2：provider-request dry-run 生命周期、terminal owner、跨入口一致性。
- Item 4：Error01-06、provider failure policy、direct/relay unified execution decision、backoff/cooldown/default-floor。
- Item 3：基于当前 V3 5555 多 provider profile 的 live compatibility matrix、manifest/wiki/map/verifier 更新。
- 正反红测、controlled tests、global install/restart、live 5555 replay、样本和日志证据。

Out of scope：

- 把 5555 改回 MiniMax-only；当前多 provider 配置是目标输入，不是漂移。
- WebSocket full closeout、remote continuation full closeout、servertool/stopless V2 black-box full closeout、P6 deletion。
- 为绕过 provider quota/credential 问题修改真实用户 key 或删 provider。
- 在 Hub/VR/compat/server/SSE 中发明 fallback 或 provider-specific 修补。

## 3. 设计原则

- 纯 Rust 语义真源；TS 只允许薄壳/IO/现有 CLI 包装。
- dry-run 是 transport-send 前的唯一 terminal effect，不是 endpoint-local hack。
- direct 与 relay 可有不同 payload/response执行 owner，但错误政策必须统一。
- 错误中心只消费 typed source/classification/router policy truth；禁止调用点本地判断是否返回客户端。
- default pool 配置层永远非空；最后 default provider 不被物理移出；当前请求 attempt budget 耗尽后才允许 Error06 投影。
- 5 秒 backoff 是当前合同；旧 `1s -> 2s -> 3s` 文档语义必须标 stale 并更新。
- controlled evidence 不得冒充 live evidence；profile-disabled 不得冒充 runtime failure。

## 4. 技术方案与文件清单

优先查阅：

- `docs/agent-routing/05-foundation-contract.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `docs/error-handling-v2.md`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/manifests/v3.live_provider_compat.parity.yml`
- `docs/architecture/wiki/v3-live-provider-compat-parity.md`
- `docs/goals/v3-live-provider-compat-parity-closeout-plan.md`

Likely implementation owners to locate before editing：

- V3 server entry/dry-run parsing: `v3/crates/routecodex-v3-server/`
- V3 runtime hub pipeline: `v3/crates/routecodex-v3-runtime/src/hub_v1/`
- Provider transport/runtime crates: `v3/crates/routecodex-v3-provider-*`
- Error chain: `v3/crates/routecodex-v3-error/`
- Config/VR/default pool truth: `v3/crates/routecodex-v3-config/` and runtime route-selection owners
- Architecture gates/verifiers: `scripts/architecture/`, `scripts/tests/`, `docs/architecture/*`

Do not edit before owner lock：

- Do not patch endpoint handlers to special-case `/v1/messages` dry-run.
- Do not reintroduce provider health persistence as cooldown truth.
- Do not implement retry/backoff in direct executor, provider runtime, HTTP mapper, SSE handler, or compat.
- Do not change current multi-provider config to hide failures.

## 5. 错误状态机合同

Provider/runtime execution error flow：

```text
provider/direct/relay error
  -> Error01 SourceRaised
  -> Error02 Classified
  -> Error03 ProviderLocalAction
  -> Error04 RouterPolicyApplied
  -> Error05 ExecutionDecision
  -> retry/switch/cooldown/final project
  -> Error06 only when mayProject=true
```

Provider policy：

- 第 1 次连续错误：记录 provider count=1，优先切其他候选继续流水线，不返回客户端。
- 同一 provider 再次被选中前：如果 count>0，真实异步等待 5 秒。
- 第 2 次连续错误：记录 count=2，继续找其他候选；再次选中前仍等待 5 秒。
- 第 3 次连续错误：如果不是 default 最后 provider，从当前可选路由池排除，冷却 15 分钟；15 分钟后进入 probe。
- probe 成功：清零并恢复 Healthy。
- probe 失败：重新冷却 15 分钟。
- 如果要移出的是 default 最后 provider：不移出；第 1/2 次失败后各等待 5 秒重试；第 3 次失败后当前请求耗尽，返回客户端。
- provider 成功清零连续错误计数。
- dry-run、client input error、endpoint_not_enabled、path_not_found、client_disconnect 不处罚 provider。

终止条件必须表达当前请求 attempt budget，而不能只看 `defaultPoolAvailable`：

```text
optionalEligibleCandidates == 0
AND (
  defaultEligibleCandidates == 0
  OR lastDefaultAttemptBudgetExhausted == true
)
```

同时配置层必须保持：

```text
defaultConfiguredProviders >= 1
```

## 6. 测试计划

Item 2 dry-run tests：

- Responses Relay provider-request dry-run: wire built, no network send, no state mutation。
- Anthropic Messages provider-request dry-run: wire built, no network send, no state mutation。
- Direct provider-request dry-run: passthrough wire captured, no network send, no state mutation。
- Dry-run provider wire build error: explicit build error, no provider health mutation。
- Non-dry-run paired case: provider network send occurs normally。

Item 4 error-policy positive tests：

- Provider A fails, provider B succeeds, client sees only final success。
- Same provider reselected after failure waits at least 5 seconds。
- Third consecutive failure on non-final-default enters 15 minute cooldown and is excluded。
- Cooldown expiry allows probe; probe success restores provider。
- Last default provider failure attempts 1 and 2 wait 5 seconds; attempt 3 projects final error。
- Direct and relay produce the same Error03/04/05 decision for equivalent provider errors。

Item 4 error-policy negative tests：

- Success clears consecutive failure count。
- Client input error does not switch provider。
- Client disconnect is health-neutral。
- Dry-run does not count/backoff/cooldown。
- Provider A failures do not affect provider B。
- Optional provider first failure cannot project to client while alternatives remain。
- Direct cannot bypass Error01-06。
- Last default provider is never physically removed。
- Third failure before budget exhaustion cannot project early; after budget exhaustion cannot loop forever。

Item 3 live matrix tests：

- Current 5555 profile config snapshot and `/health` evidence。
- `/v1/responses` JSON/SSE success/error cases across selected providers where available。
- `/v1/messages` JSON/SSE dry-run and live cases; quota-blocked cases explicitly classified。
- Multi-provider switch/cooldown/default-floor controlled evidence plus targeted live evidence where safe。
- Manifest verifier rejects stale endpoint_not_enabled when current profile enables the endpoint。
- Manifest distinguishes live_verified, source_controlled, profile_disabled, provider_quota_blocked, runtime_defect。

## 7. 实施步骤

1. 刷新 `.agent-collab`，claim `feature_id:v3.p0_dryrun_error_live_compat` 或 split claims for item2/item4/item3。
2. Re-read maps/mainline/source and lock owners for dry-run terminal and Error01-06 execution decision。
3. Update docs/maps/test design for the latest Jason error-policy contract, marking stale old backoff wording as superseded。
4. Add failing/red tests for `/v1/messages` dry-run network-send bug。
5. Add failing/red tests for direct provider error bypass, early projection, missing 5s wait, missing 15m cooldown, and last-default attempt budget。
6. Implement only in unique owners; keep Hub/VR/compat/server/SSE boundaries intact。
7. Run focused tests, architecture gates, Rust-only gates, fmt/clippy/build。
8. Global install current V3, restart the aggregate 5555 once using the approved V3 lifecycle path, verify `/health` and process identity。
9. Live replay current 5555 dry-run, multi-provider error/switch/default-floor samples, and update manifest/wiki/evidence。
10. Record durable lessons in `note.md`, `MEMORY.md`, and local skill only if reusable workflow changed。

## 8. 完成定义

- Item 2: all enabled entries support provider-request dry-run without provider network send or state mutation。
- Item 4: direct/relay share the same provider error policy; errors do not reach clients before candidate/budget exhaustion; 5s backoff, 3-failure 15m cooldown, and last-default 3-failure terminal behavior are locked by positive and negative tests。
- Item 3: live compatibility matrix reflects the current multi-provider 5555 profile and no stale blocker remains。
- Source, architecture, install/restart, live sample, and log evidence are all recorded; repo is clean and changes are committed。

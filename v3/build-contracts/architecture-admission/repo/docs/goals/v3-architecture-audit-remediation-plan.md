# V3 架构审计违规修复计划

## 1. 目标与验收标准

目标：修复 V3 架构审计发现的 P0 边界违规，确保 SSE/Server 只承担 transport/client-frame 责任，Inbound/Outbound/Provider/Error 各回唯一 owner，Provider 错误不再被包装成伪 `client_response.error.type=provider_error` 中间真相，并让 `verify:v3-architecture-ci` 成为真实 CI/build/install/release gate。

验收标准：
- Server/SSE 不构造、不分类、不伪造 `V3Error01..06`；post-commit SSE client projection 只来自 `routecodex-v3-error` 的 typed helper。
- SSE body/stream transport error fail-fast/propagate，不再 fabricated `event:error` 或 fabricated Error06 terminal。
- Provider/local hook/provider response failure 使用 typed error policy fields，不再把 provider error 伪装成 `client_response.error.type=provider_error` 作为中间 truth。
- Responses inbound canonicalization 失败必须返回 Err/显式失败，不得 silent continue 进入 Chat Process。
- `verify:v3-architecture-ci` 挂入 npm script、test workflow、coverage workflow、release workflow、`build:v3-cli`、`build:min`、`install-v3-cli`，红则阻断。
- P0 相关 gate 绿；若剩余红项是 fingerprint lock drift 或破坏性删除/迁移，必须标为 Jason 授权阻塞，不得自行改锁。
- Runtime 变更完成后必须 build/install/restart/live replay，再跑 codex review，review PASS 后才能声明闭环。

## 2. 范围与边界

In scope：
- `v3/crates/routecodex-v3-server/src/lib.rs` 的 SSE transport/server closeout 边界。
- `v3/crates/routecodex-v3-error/src/lib.rs` 的 Error06 client projection owner。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` 的 provider failure typed policy carrier。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs` 的 inbound canonicalization fail-fast。
- `scripts/architecture/verify-v3-architecture-ci.mjs`、`package.json`、CI/release workflow、install script 的 gate 接线。
- V3 architecture maps/verification maps/resource maps 的最小 anchor 修复。
- V2 provider action gate manifest 的 machine sync 修复（只修 gate 要求的 active/status/caller/callee/downstream/admission ownership，不改运行语义）。

Out of scope：
- 不刷新 architecture fingerprint lock，除非 Jason 明确授权。
- 不做旧链物理删除、迁移、发布或全局 runtime 破坏性动作，除非 Jason 明确授权。
- 不新增 fallback、降级、双路径补偿。
- 不把 provider-specific shape 修补写进 Hub Pipeline/Virtual Router/Server/SSE。

## 3. 设计原则

- Transport-only：SSE/Server 只做 frame/HTTP transport/projection，不拥有 provider/runtime/error policy 语义。
- Adjacent-only：Inbound/ChatProcess/Outbound/Provider/Error 只做相邻节点转换，禁止跨节点 shortcut。
- Typed error chain：provider/runtime/direct/executor 错误必须进入 typed Error chain；禁止用 client response shape 承载内部中间真相。
- Fail-fast normalization：协议字段归一化失败必须显式失败，不得静默丢字段或继续进入下游。
- Machine gate first：文档/map/manifest 声称的 owner/edge/status 必须由 gate 验证；未接 CI/build/install 的 gate 不能称门禁。
- No lock drift self-heal：fingerprint drift 是授权事件，不是普通 patch 项。

## 4. 技术方案与文件清单

### 4.1 已完成/已进入当前 diff 的修复面
- `v3/crates/routecodex-v3-error/src/lib.rs`：新增/承接 post-commit SSE source -> Error06 projection helper，Error projection owner 下沉到 error crate。
- `v3/crates/routecodex-v3-server/src/lib.rs`：移除 Error builder/classifier/action 语义；SSE body Err 传播，不伪造 provider terminal/error event；删除 dead failed terminal variant。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`：provider failure carrier 改为 typed policy fields，移除 `client_response.error.type=provider_error` 中间 truth。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs`：新增 Result builder，Responses canonicalization 失败显式 Err；旧 builder fail-fast。
- `package.json` / `.github/workflows/test.yml` / `.github/workflows/release.yml` / `scripts/install-v3-cli.mjs` / `scripts/architecture/verify-v3-architecture-ci.mjs`：接入 V3 architecture CI umbrella。
- `docs/architecture/v3-mainline-call-map.yml` / `v3-function-map.yml` / `v3-verification-map.yml` / `v3-resource-operation-map.yml`：追加最小 V3 provider action gate anchors。

### 4.2 下一步必须修的 blocker
- `docs/architecture/manifests/error.provider_action_gate.mainline.yml`：同步 V2 provider action gate manifest 与 verifier/source map：
  - `status: active`。
  - 8 条 `error-provider-action-gate-01..08` edge 补齐并同步 `caller_symbol`、`caller_file`、`callee_symbol`、`callee_file`。
  - `downstream_projection.lifecycle_id = error.mainline`。
  - `downstream_projection.step_id = err-05`。
  - `downstream_projection.provider_action_gate_witness = none`。
  - `admission_ownership.wall_clock_expiry_forbidden = true`。
  - `admission_ownership.abandon_increments_failure_count = false`。
  - `admission_ownership.max_admissions_per_generation = 1`。
  - 确保没有 `admission_lease`。

## 5. 风险与规避

- 风险：manifest/map 修复误改大块 YAML 格式，制造无关 diff。规避：只做最小 patch；不得 YAML stringify 全文件。
- 风险：SSE transport 为了兼容客户端又补一套语义 terminal。规避：只传播 body/stream transport error；语义 error projection 只经 error crate typed helper。
- 风险：Provider error 为了通过响应测试被包装到 client response shape。规避：runtime 中间态只保留 typed policy fields；client shape 只在 Error06/client projection owner 生成。
- 风险：`verify:v3-architecture-ci` 被接线后暴露历史 file-size/fingerprint 债务。规避：区分本次 P0 边界修复与授权型 debt；不得自行刷新 fingerprint。
- 风险：并行 worker dirty diff。规避：只改本计划列出的文件；保留无关 dirty/untracked；提交前定向 stage。

## 6. 测试计划

### 6.1 Red/green 定向测试
- Direct SSE abrupt/body closeout：证明不伪造 Error06。
- Relay SSE body/stream closeout：证明不伪造 `event:error`。
- Provider response failure classifier：证明 provider error 与 local hook error 分离，且无 `client_response.error.type=provider_error` 中间 truth。
- Malformed Responses inbound canonicalization：证明失败不进入 Chat Process。
- Provider action gate red fixtures：证明 map/manifest/wiki/required tests drift 会红。

### 6.2 架构 gate
- `npm run verify:v3-module-boundaries`
- `npm run verify:sse-architecture-boundary`
- `npm run verify:sse-transport-core-shared`
- `npm run verify:error-pipeline-contract`
- `npm run verify:provider-response-errorerr-bypass-closeout`
- `npm run verify:v3-normalization-payload-logic-boundary`
- `npm run verify:v3-provider-action-gate`
- `npm run verify:v3-architecture-ci`
- `npm run verify:architecture-review-surface-light`
- `npm run verify:v3-architecture-docs`
- `git diff --check`

### 6.3 Runtime closeout gate
- Build：按项目当前 required build stack 跑 V3 CLI/build。
- Install：全局安装/`install:v3` 使用同一 gate 入口。
- Restart/live：`routecodex restart --port <locator-port>`，同一 listener PID 集合只重启一次；验证全部成员端口 `/health`。
- Live replay：使用 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/` 旧错误样本或同入口真实样本重放，确认源码改动在运行版本生效。
- Review：完成 build/install/restart/live 后运行 codex review；无 PASS 不交付。

## 7. 实施步骤

1. 刷新 `.agent-collab` 视图，确认无 kill switch；记录当前 run/evidence，避让同语义 active claim。
2. 修 `error.provider_action_gate.mainline.yml` 的 V2 manifest drift，保持最小 YAML patch。
3. 跑 `npm run verify:v3-provider-action-gate`，若仍红，按 verifier 输出继续修 manifest/map 的 machine 字段，不改 runtime 语义。
4. 重跑已绿 focused tests，确认 SSE/provider-error/inbound fail-fast 未回归。
5. 跑 P0 架构 gate stack；把失败归类为本次必须修、历史 debt、或 Jason 授权阻塞。
6. 跑 `verify:v3-architecture-ci`，证明 umbrella 已真实阻断；若只剩 file-size/fingerprint，记录为非本次授权项。
7. 跑 build/install/restart/live replay；必须使用全局安装版本和真实样本，不用 repo-local 启动替代。
8. 跑 codex review；若 FAIL，修复后重跑受影响验证、build/install/live、review。
9. 更新 `note.md`、`MEMORY.md`，必要时更新 local skill；`mempalace mine --wing routecodex` 后搜索新短语验证可检索。
10. 定向 stage/commit 仅本次文件；最终回报改动、验证、剩余风险、下一步。

## 8. 完成定义（DoD）

- P0 SSE/Error/Inbound/Outbound/Provider ownership 违规已通过 source + red/green tests + architecture gates 证明修复。
- `verify:v3-architecture-ci` 已是真实 CI/build/install/release gate；红会阻断，不是文档声明。
- Provider action gate V2/V3 manifest/map/wiki/test binding 绿。
- 未刷新 fingerprint lock；若 fingerprint/file-size 仍红，已明确列为 Jason 授权/历史 debt，不混入“已闭环”。
- 全局安装运行版本与源码 diff 一致，旧样本 live replay 通过。
- codex review 最终 PASS。

## 9. 2026-07-31 继续执行补充计划

### 9.1 当前已验证进展
- `npm run verify:v3-provider-action-gate` 已通过，V2 provider action gate manifest active/status/caller/callee/downstream/admission ownership 已同步。
- SSE transport focused tests 已通过：direct abrupt close 不伪造 Error06，relay SSE body abrupt 不伪造 `event:error`。
- Provider response failure focused test 已通过：provider/local hook error 不再经 `client_response.error.type=provider_error` 中间 truth。
- ReqInbound focused test 已通过：Responses inbound canonicalization fail-fast，原始 surface 由后续 owner 处理，不在 ReqInbound 合成语义。
- `npm run test:v3-protocol-conversion-field-parity` 曾绿；后续 umbrella 暴露 provider-action recovery lane mismatch 回归。
- P0 架构 gate 已绿过：module boundaries、provider action gate、SSE architecture/shared、error pipeline、provider-response-errorerr bypass、normalization boundary。

### 9.2 当前唯一必须先修的源码 blocker
- `npm run verify:architecture-review-surface-light` 内嵌 `test:v3-protocol-conversion-field-parity` 当前失败：`ProviderHealth("provider action recovery ticket references a lane that is absent")`。
- 失败样例：`responses_relay_anthropic_cyber_refusal_sse_is_retryable_provider_failure`。
- 根因假设必须用源码验证：provider action failure 记录、recovery ticket、Error05 recovery wait 使用的 scoped gate key 不一致，导致 wait 阶段找不到记录 failure 的 lane。
- 目标修法：统一 `V3ProviderActionGateKey` / `V3ProviderActionProviderScope` / `V3ProviderActionRecoveryTicket` / `V3Error05RecoveryAdmissionWitness` 的 lane 真源；记录 failure、生成 recovery ticket、等待 recovery witness 必须消费同一个 scoped key。
- 禁止修法：不得删除 session/routing/provider identity 以绕过 mismatch；不得 fallback 到新 lane；不得把 recovery miss 包成成功或 client error；不得把逻辑搬到 SSE/Server/Error06 projection。

### 9.3 目标文件与检查顺序
1. 先读 `.agent-collab/PROTOCOL.md`、当前 run/claim/kill switch，保护并行 worker diff。
2. 检查 target diff 后再改：
   - `v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs`
   - `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
3. 定位以下 symbol 的输入/输出 key：
   - `V3ProviderActionGateKey`
   - `V3ProviderActionProviderScope`
   - `V3ProviderActionRecoveryTicket`
   - `wait_for_recovery_witness`
   - `record_failure`
   - `record_provider_action_failure`
   - `request_local_recovery`
   - `wait_for_error05_recovery`
   - `run_v3_relay_provider_failure_policy`
4. 补最小白盒/集成断言：同一 provider failure 的 record ticket key 与 wait witness key 完全一致；缺 lane 必须是真错误，不能静默补 lane。
5. 只改唯一 owner：provider action gate / provider failure runtime policy；Server/SSE/Hub payload/outbound 不参与 recovery lane 修复。

### 9.4 修复后验证顺序
1. `npm run test:v3-protocol-conversion-field-parity`
2. `npm run verify:architecture-review-surface-light`
3. P0 gate 回归：
   - `npm run verify:v3-module-boundaries`
   - `npm run verify:v3-provider-action-gate`
   - `npm run verify:sse-architecture-boundary`
   - `npm run verify:sse-transport-core-shared`
   - `npm run verify:error-pipeline-contract`
   - `npm run verify:provider-response-errorerr-bypass-closeout`
   - `npm run verify:v3-normalization-payload-logic-boundary`
4. `npm run verify:v3-architecture-docs`：若只剩 fingerprint lock drift，列为 Jason 授权阻塞，不刷新 lock。
5. `npm run verify:v3-architecture-ci`：若只剩 `verify:v3-file-size` 历史 debt，列为授权/拆分后续，不 ratchet/whitelist。
6. `git diff --check`
7. 若源码 gate 达到可交付状态，再执行 build/install/restart/live replay；最后 codex review PASS。

### 9.5 完成/阻塞判定
- 完成：provider-action recovery lane mismatch 修复；architecture-review-surface-light 与 protocol parity 绿；P0 gates 绿；build/install/restart/live replay 有证据；codex review PASS。
- 授权阻塞：fingerprint lock refresh、file-size 分解/ratchet、删除/迁移/发布类破坏动作。
- 不可声明完成：只靠源码阅读、静态 grep、单测局部绿、未安装运行、未 live replay、未 review PASS。

## 10. 2026-07-31 handoff 后继续修复计划

### 10.1 当前目标
- 继续收口 V3 架构审计违规：SSE/Server transport-only、Inbound/Outbound/Provider/Error 各守唯一 owner、provider error 走 typed Error chain、protocol fields 归一化 fail-fast、`verify:v3-architecture-ci` 真实接入 CI/build/install gate。
- 当前阶段不声明完成；只在 source gates、build/install/restart/live replay、codex review PASS 后闭环。

### 10.2 当前已知证据状态（来自 handoff，继续执行者必须复跑确认）
- 已知 passing：`cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-virtual-router -- --nocapture`、`routecodex-v3-target`、`routecodex-v3-provider-responses`、`routecodex-v3-lifecycle`。
- 已知 passing：`cargo +stable check --manifest-path v3/Cargo.toml -p routecodex-v3-runtime`、`cargo +stable check --manifest-path v3/Cargo.toml -p routecodex-v3-server`。
- 需复跑确认：`cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib -- --nocapture`、`cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib -- --nocapture`、`npm run verify:v3-file-size`。

### 10.3 当前必须先处理的 blocker
- `verify:v3-file-size` 仍需收口：
  - `v3/crates/routecodex-v3-config/src/validate.rs`
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs`
  - `v3/crates/routecodex-v3-runtime/src/kernel.rs`
- `verify:v3-architecture-docs` 存在 fingerprint lock drift；未经 Jason 明确授权不得刷新 lock：
  - `chain:v3.servertool_hook_skeleton_lifecycle`
  - `chain:v3.debug_error_foundation.mainline`
- runtime/server lib tests 必须在 provider failure session scope wiring 后复跑，不能沿用旧 PASS。

### 10.4 修复顺序
1. 刷新 `.agent-collab`：读 `.agent-collab/PROTOCOL.md`、`KILL_SWITCH`、当前 run、claims、events/evidence；继续使用当前 run evidence 文件追加证据。
2. 复跑 runtime/server lib tests 与 file-size gate，先确认最新红项，不基于旧日志改代码。
3. 修 file-size 只做 cut/move，不 copy/duplicate，不 ratchet/whitelist；优先移动 inline tests 或私有 helper 到同 owner 子模块，保持 public API 与语义不变。
4. 若 runtime test 失败：回唯一 owner 修复，不改 SSE/Server/Error06 投影来掩盖 provider/runtime 错误。
5. file-size 绿后跑 P0 architecture/source gates；`verify:v3-architecture-docs` 若只剩 fingerprint drift，记录授权阻塞，不自刷。
6. source gates 绿后执行 `npm run install:v3`，再按项目 live 规则做聚合 restart、全成员 health、旧样本/同入口 live replay。
7. live 证据齐后再跑 codex review；review FAIL 则修复并重新执行受影响 gates + install/restart/live + review。
8. 最后更新 `note.md`、`MEMORY.md`、必要 local skill；`mempalace mine --wing routecodex memory` 后搜索新 marker 证明可检索。

### 10.5 禁止事项
- 禁止 broad kill、`git checkout/reset`、清理他人 dirty/untracked。
- 禁止刷新 fingerprint lock，除非 Jason 明确授权。
- 禁止为了 file-size gate 增加 ratchet、白名单、死代码、重复 helper 或 shadow module。
- 禁止把 provider error 包成 `client_response.error.type=provider_error` 作为中间 truth。
- 禁止在 SSE/Server/RespOutbound 承载 provider policy、tool governance、continuation save/restore、Error01..06 builder/classifier 语义。

### 10.6 DoD
- runtime/server focused tests 与 file-size gate 绿。
- `verify:v3-architecture-ci`、`verify:architecture-review-surface-light`、`test:v3-protocol-conversion-field-parity` 绿；若 docs fingerprint drift 未授权刷新，明确列为阻塞而非完成。
- 全局安装版本与源码一致；聚合 restart、全部成员 health、旧样本/同入口 live replay 有证据。
- codex review 明确 PASS；无 PASS 不交付。

## 11. 2026-07-31 closeout 修复计划（当前授权边界版）

### 11.1 当前状态
- V3 架构审计主修复已经进入 source-gate closeout：SSE/Server 不承载 Error01..06/Provider policy 语义，Provider error 进入 typed Error chain，Inbound canonicalization fail-fast，protocol conversion/field parity 已回归。
- `verify:v3-file-size` 已通过；本轮 file-size 修复只做 cut/move 拆分，不新增 ratchet/whitelist，不复制语义。
- 当前 `verify:v3-architecture-ci` 与 `verify:v3-architecture-docs` 的已知 blocker 只剩 `verify:v3-mainline-caller-flow` fingerprint lock drift。
- fingerprint lock refresh 是授权动作；未获 Jason 明确授权前不得刷新 lock，也不得继续把该状态说成闭环完成。

### 11.2 当前剩余 blocker
- `chain:v3.servertool_hook_skeleton_lifecycle`
  - current: `sha256:e47bae6a4f5f8530cc2005a6ccfed3d24f1d3719c11ad0061912e17b6bb4003f`
  - lock: `sha256:7e820a4b9abf338c874911d7b599c10c79803079b186ca4dfb3b437b30a100e4`
- `chain:v3.debug_error_foundation.mainline`
  - current: `sha256:5e3f4fc296d20586517136147dce146569f94b34616ef5d49fff01c01b4bf011`
  - lock: `sha256:c29480973dbd035b5799ff5098cae9e7853c5ccfb39eaad8ab5848de9e330896`

### 11.3 修复策略
1. 先固定当前边界，不再扩大源码范围：只处理 fingerprint 授权、source gate 复跑、install/restart/live/review closeout。
2. 若 Jason 授权刷新 fingerprint：只刷新上述两个已审计 chain lock，不刷新其他 lock，不改运行语义。
3. 刷新后立刻复跑 caller-flow/doc/CI gate，证明 lock 与 map/rendered review surface 同步。
4. source gates 全绿后才进入 `npm run install:v3`、聚合 `routecodex restart --port <locator-port>`、全成员 `/health`、旧样本/同入口 live replay。
5. live 证据齐后运行 codex review；review PASS 才允许最终交付。review 后若改任何代码/测试/build/runtime 配置，旧 PASS 失效，必须重新验证和 review。

### 11.4 必跑验证顺序
1. 若授权刷新 lock：`npm run verify:v3-mainline-caller-flow`
2. `npm run verify:v3-architecture-docs`
3. `npm run verify:v3-architecture-ci`
4. `npm run verify:architecture-review-surface-light`
5. `git diff --check`
6. `npm run install:v3`
7. 聚合 restart + 全成员 `/health`
8. 旧错误样本或同入口真实样本 live replay
9. codex review，要求明确语义 PASS

### 11.5 禁止事项
- 禁止未授权刷新 fingerprint lock。
- 禁止用 ratchet/whitelist/fallback 绕过 source gate。
- 禁止把 Provider error 包进 `client_response.error.type=provider_error` 当中间 truth。
- 禁止在 SSE/Server/RespOutbound 承载 provider policy、tool governance、continuation save/restore、Error01..06 builder/classifier。
- 禁止 repo-local start 替代全局安装版本 live 验证。
- 禁止 broad kill、`git checkout/reset`、清理无关 dirty/untracked。

### 11.6 DoD
- 上述两个 fingerprint lock 要么经 Jason 授权刷新并通过 docs/CI gate，要么明确作为授权阻塞，不宣称完成。
- `verify:v3-architecture-ci`、`verify:v3-architecture-docs`、`verify:architecture-review-surface-light`、`git diff --check` 有最新 PASS 证据。
- 全局安装版本与源码 diff 一致；聚合 restart、全部成员 health、旧样本/同入口 live replay 有证据。
- codex review 明确 PASS。
- `note.md`、`MEMORY.md`、local skill/mempalace 完成必要沉淀。

## 12. 2026-07-31 closeout 修复计划（当前实测版）

### 12.1 当前实测状态
- 本轮重新验证 `.agent-collab/KILL_SWITCH` 不存在，继续使用 run `.agent-collab/runs/20260731T034910Z-Macstudio.local-72114-v3-arch-cont`。
- `npm run verify:v3-architecture-docs` 当前失败点已收敛到 `verify:v3-mainline-caller-flow` fingerprint lock drift：
  - `chain:v3.responses_direct.required_mainline`: current `sha256:c4640c59c879afb9d39249c9d4c0ea5c999022a701a9f65b79e061fbb4293018`, lock `sha256:9c8e7f1e93a0ba4b1ffffc68bad3af881fe5216b822ee45c9a260a5b461f1b56`。
  - `chain:v3.debug_error_foundation.mainline`: current `sha256:c29480973dbd035b5799ff5098cae9e7853c5ccfb39eaad8ab5848de9e330896`, lock `sha256:7c61139166bb06245658f7cc62cf366690ad8159adc6b1e900893a7ecdf90107`。
- `npm run verify:v3-architecture-ci` 当前通过前 14/25 个 subgate，失败点同样是 `verify:v3-mainline-caller-flow` fingerprint lock drift。
- 因 fingerprint refresh 属授权动作，未获 Jason 明确授权前不得刷新 lock；也不得绕过 `install:v3` preflight 做手动安装或 live 结论。

### 12.2 修复顺序
1. 先审计两条 fingerprint drift 的 map/rendered surface/source anchor，确认 drift 只来自已验证的 mainline map/文件拆分同步，不含未审计语义变更。
2. 若审计发现 stale source anchor 或 symbol 仍不真实，先最小修 `docs/architecture/v3-mainline-call-map.yml` / renderer 输出并重跑 doc gates；不得刷新 lock 掩盖 source/map 不一致。
3. 若只剩上述两条 fingerprint drift，向 Jason 请求明确授权刷新这两个 chain lock；未授权则停在 source-gate 授权阻塞。
4. 授权后只刷新这两个 chain lock，不扩散刷新其它 fingerprint，不改 runtime 语义。
5. 复跑 `npm run render:v3-mainline-caller-flow`、`npm run render:architecture-wiki-html`、`npm run verify:v3-mainline-caller-flow`、`npm run verify:v3-architecture-docs`、`npm run verify:v3-architecture-ci`、`npm run verify:architecture-review-surface-light`、`git diff --check`。
6. source gates 全绿后再跑 `npm run install:v3`，随后只用聚合入口 `routecodex restart --port <locator-port>`，验证全部成员端口 `/health`。
7. 用 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/` 旧错误样本或同入口真实样本 live replay，证明安装运行版本与源码修复一致。
8. live 证据齐后运行 codex review；review 后若改代码/测试/build/runtime 配置，重跑受影响验证、install/restart/live/review。
9. 最后更新 `note.md`、`MEMORY.md`、必要 local skill，并执行 `mempalace mine --wing routecodex memory` + `mempalace search --wing routecodex <marker>`。

### 12.3 禁止事项
- 禁止 broad kill、`git checkout/reset`、覆盖无关 dirty/untracked。
- 禁止未授权刷新 fingerprint lock。
- 禁止绕过 `npm run install:v3` 的 `verify:v3-architecture-ci` preflight。
- 禁止把 SSE/Server/RespOutbound 作为 provider policy、Error01..06 builder/classifier、continuation save/restore、tool governance 的 owner。
- 禁止把 provider error 包装成 `client_response.error.type=provider_error` 作为中间 truth。

### 12.4 DoD
- 两条 fingerprint drift 已审计并在授权后刷新，或明确作为 Jason 授权阻塞上报。
- `verify:v3-architecture-docs`、`verify:v3-architecture-ci`、`verify:architecture-review-surface-light` 全绿。
- `install:v3`、聚合 restart、全成员 health、旧样本/同入口 live replay 有证据。
- codex review 明确 PASS；无 PASS 不交付。

### 12.5 当前 source-anchor 审计补充
- `v3.responses_direct.required_mainline` 的 drift 来自真实 source split：`plan_v3_responses_protocol_execution_with_provider_health` 已不在 `kernel.rs`，现位于 `kernel/direct_protocol_plan.rs`；回退 map 会重新制造 stale source anchor。
- `v3.debug_error_foundation.mainline` 的 drift 来自错误链 owner 收口与 source split：Error02-05 分类/策略在 `V3ErrorHandlingCenter::decide_provider`，Error06 投影在 `V3ErrorHandlingCenter::handle`，旧 `build_pending_projection` 不再是 Error02-06 相邻 builder owner；旧 `build_v3_error_04_target_exhaustion_decision_from_v3_error_03` 与 `V3ProviderHealthStore::apply_error_action` 已不存在。
- 当前 P0 gate 栈已复跑通过：module boundaries、provider action gate、SSE boundary/shared、error pipeline、provider-response bypass、normalization payload boundary、architecture review surface、`git diff --check`。
- 因此剩余动作不是继续改 SSE/Server/Error owner，而是对两条已审计 chain lock 做 Jason 授权刷新；未授权不得执行。


### 12.6 install:v3 preflight 复验证据
- `2026-07-31T06:41:29Z` 正式运行 `npm run install:v3`，未绕过脚本。
- `scripts/install-v3-cli.mjs` 先执行 `verify:v3-architecture-ci`；该 preflight 通过 14/25 个 subgate 后，在 `verify:v3-mainline-caller-flow` 因同两条 audited fingerprint drift 失败。
- 结果：install 入口按设计阻断，未执行全局安装；后续 restart/live replay/codex review 仍必须等 fingerprint 授权刷新和 CI gate 全绿后再做。

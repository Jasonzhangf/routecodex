# Goal: Rust 化 RouteCodex Hub Pipeline 剩余 TS 语义层

**Created**: 2026-07-03
**Owner**: RouteCodex Agent
**Status**: active
**Token Budget**: 50,000

---

## Objective

Rust 化 RouteCodex Hub Pipeline 剩余 TypeScript 语义层，确保所有 payload 语义变换严格在 Rust 完成，满足架构门禁：

- 非相邻转换禁止（HubReq* ↔ HubResp* 不得跨节点 shortcut）
- Metadata 与 payload 分流（MetadataCenter 仅承载控制语义，不得混入 client response body）
- 无 fallback/降级（所有 error chain 必须走 ErrorErr02→ErrorErr06，禁止 TS 层重写 retry/cooldown）
- Metadata 闭环隔离（/v1/responses continuation 隔离键：entry protocol + continuationOwner + session/conversation(+port/group)）

---

## Success Criteria

| 维度 | 指标 | 阈值 |
|------|------|------|
| 全链路复测 | 失败样本 1:1 复测（Red→Green）| 0 fallback |
| 架构门禁 | pnpm verify:hardcode | PASS |
| | pnpm verify:architecture-deny-nonadjacent | PASS |
| | npm run verify:mainline-call-map | PASS |
| 性能基线 | P99 Latency vs Baseline | ≤ 5% regress |
| | TP99 Latency vs Baseline | ≤ 5% regress |
| 稳定性 | Error chain success rate | ≥ 99.5% |
| 文档 | MEMORY.md 追加 | 完成节 2026-07-03 |

---

## Rust 化优先级

### P0（必须 Rust，当前有大量 TS 语义）

| 模块 | 文件（TS） | 目标 Crate | feature_id | 主线边 |
|------|-----------|-----------|-----------|--------|
| servertool/orchestration | servertool/engine-orchestration-shell.ts (255行) | native-servertool-core-semantics.rs | servertool.followup_orchestration | servertool.* |
| | servertool/auto-hook-caller.ts (165行) | 同上 | servertool.auto_hook | |
| | servertool/dispatch-preparation-shell.ts (33行) | 同上 | servertool.dispatch_prep | |
| | servertool/orchestration-blocks.ts (13行) | 同上 | servertool.orchestration | |
| | servertool/run-server-side-tool-engine-shell.ts (60行) | 同上 | servertool.engine_run | |
| shared/anthropic-message-utils | conversion/shared/anthropic-message-utils.ts (343行) | native-shared-conversion-anthropic.rs（新） | conversion.shared.anthropic | conversion/type.anthropic |
| | conversion/shared/anthropic-message-utils-tool-schema.ts (272行) | 同上 | | |
| | conversion/shared/anthropic-message-utils-core.ts (247行) | 同上 | | |
| responses-conversation-store | conversion/shared/responses-conversation-store.ts (1185行) | native-responses-conversation-store.rs（新） | conversion.responses.store | conversion/responses.* |
| | conversion/shared/responses-conversation-store-native.ts (171行) | 同上 | | |
| req_process tool_governance | native-chat-process-governance-semantics.ts (~600行) | req_process_stage1_tool_governance_blocks.rs（拆分） | hub.req_chatprocess.tool_governance | HubReqChatProcess03Governed |
| resp_process tool_governance | 同上（resp 侧） | resp_process_stage1_tool_governance_blocks.rs（拆分） | hub.resp_chatprocess.tool_governance | HubRespChatProcess03Governed |

### P1（应 Rust，可后置）

| 模块 | 文件（TS） | 目标 Crate | feature_id |
|------|-----------|-----------|-----------|
| responses-openai-bridge/utils | conversion/responses/responses-openai-bridge/utils.ts (243行) | native-hub-pipeline-req-inbound-semantics-responses.rs | conversion.responses.bridge.utils |
| bridge-actions + policies | conversion/bridge-actions.ts (100行), bridge-policies.ts (30行) | native-hub-bridge-action-semantics.rs | conversion.bridge.actions |
| snapshot-utils | conversion/snapshot-utils.ts (466行) | native-snapshot-hooks.rs | servertool.snapshot_stage.* |
| compat/engine | conversion/hub/pipeline/compat/compat-engine.ts (72行) | native-compat-action-semantics.rs | responses.*compat |

### P2（保持 TS thin shell，确保 future owner 可用）

- servertool/metadata-center-carrier.ts（thin wrapper，语义已 native）
- servertool/progress-log-block.ts（log only）
- servertool/extract-tool-calls-shell.ts（thin wrapper）
- SSE converters（thin shell，Rust 已健全）
- chat-process-session-usage.ts（已 native）

---

## 架构硬护栏

1. 无 fallback：error chain 严格走 ErrorErr02→ErrorErr06，禁止 TS 层重写 retry/cooldown fallback。验证：grep -rE 'fallback|degraded|soft_retry' src/ 在 TS 层必须为 0 命中。
2. Metadata 分流：MetadataCenter 仅承载控制语义（routeHint、entryEndpoint、stream intent、stopless、servertool、error、scope），不得进入 providerPayload 或 client response body。
3. 非相邻转换禁止：HubReq* ↔ HubResp* 不得跨节点 shortcut；禁止 req_outbound 直接读取 resp_inbound。
4. Pipeline 类型拓扑锁：阶段序号固定（ReqInbound→ReqChatProcess→ReqOutbound→RespInbound→RespChatProcess→RespOutbound），新增节点必须先更新 docs/design/pipeline-type-topology-and-module-boundaries.md。

---

## Execution Stages

### Stage A：Function Map + Mainline Call Map + Verification Map 补全

目标：为每个 P0 模块锁 owner、allowed/forbidden paths、主线 caller/callee、最小验证栈。

Actions：
1. 读 docs/agent-routing/05-foundation-contract.md
2. 查 docs/architecture/function-map.yml，搜每个 feature_id：
   - servertool.followup_orchestration
   - conversion.shared.anthropic
   - conversion.responses.store
   - hub.req_chatprocess.tool_governance
   - hub.resp_chatprocess.tool_governance
3. 若为空，补 entry：
   ```yaml
   feature_id: servertool.followup_orchestration
   owner: sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_orchestration.rs
   allowed_paths:
     - native-servertool-core-semantics.ts（薄壳）
   forbidden_paths:
     - servertool/*.ts（语义层）
     - 直接读写 payload.metadata 做控制
   required_gates:
     - unit: servertool_orchestration_test.rs
     - integration: hub_pipeline_servertool_integration.test.ts
     - e2e: servertool_followup_e2e.test.ts
   ```
4. 查 docs/architecture/mainline-call-map.yml，补主线边。
5. 查 docs/architecture/verification-map.yml，补最小验证栈。
6. 更新 docs/architecture/wiki/mainline-call-graph.md（同步节点 ID）。

Output：
- git diff docs/architecture/function-map.yml（补全所有 P0 feature_id）
- git diff docs/architecture/mainline-call-map.yml
- git diff docs/architecture/verification-map.yml
- CI：npm run verify:function-map-owner-uniqueness PASS

Abort：若 map 补全后仍有歧义（同一 owner 多个路径），先解决 owner 歧义再继续。

---

### Stage B：Red Test（现 TS 语义下的最小 failure）

目标：为每个 P0 模块写最小失败样本，确认当前 TS 实现的行为真源。

Actions：

1. servertool/orchestration：
   - 写 tests/server/servertool/orchestration_skip_red.test.ts：验证当前 TS 在 tool call 为空时错误跳过 servertool injection
   - 写 tests/server/servertool/stopless_timeout_red.test.ts：验证 TS 层 timeout 逻辑错误导致 stopMessage 延迟

2. anthropic-message-utils：
   - 写 tests/conversion/anthropic/anthropic_tool_schema_red.test.ts：验证 TS 层 buildAnthropicToolAliasMap 对 apply_patch 类型 tool 缺失 parameters 时未归一化到 {"type":"object"}
   - 写 tests/conversion/anthropic/anthropic_thinking_merge_red.test.ts：验证 TS 层多 block thinking 内容合并错误

3. responses-conversation-store：
   - 写 tests/conversion/responses/continuation_scope_isolation_red.test.ts：验证 TS 层仅靠 sessionId 命中 continuation（应同时校验 entry protocol + continuationOwner + conversation scope）
   - 写 tests/conversion/responses/ttl_eviction_red.test.ts：验证 TS 层 TTL 过期后仍被错误复用

4. req/resp_process_tool_governance：
   - 写 tests/hub_pipeline/tool_governance/req_text_tool_harvest_red.test.ts：验证 TS 层文本工具 harvest 错误导致 tool_calls 重复
   - 写 tests/hub_pipeline/tool_governance/resp_patch_reverse_red.test.ts：验证 TS 层 apply_patch 逆向转换错误

5. 对每个红测跑 pnpm test 确认 red，记录 flamegraph 到 /tmp/flame_STAGENAME.json。

Output：
- 每个 P0 模块一个 failing test fixture：tests/fixtures/red_STAGENAME_YYYYMMDD.jsonl
- git diff tests/（红测 + fixture）
- CI：pnpm test -- --grep "STAGENAME" | grep "FAIL" 确认所有 red test 失败

Abort：若红测在当前 TS 下通过，说明行为已正确或测试设计错误，停止并修正测试。

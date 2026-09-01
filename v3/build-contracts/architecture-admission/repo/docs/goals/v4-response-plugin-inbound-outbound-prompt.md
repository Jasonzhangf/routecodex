/goal
目标：完成 V4HubRespInbound02Parsed / V4HubRespOutbound04ClientSemantic / V4ServerSseOut05FrameBoundary / V4ServerRespOutbound06ClientFrame 四个插件的 typed handle；让 provider_raw -> parsed_response -> client_semantic -> client_frame 这条相邻转换符合 V3 规格。

说明：本任务不需要再写新的提示词，直接按实现文档执行。Worker A data-plane 与 Worker B continuation control-plane 已就位；你是 inbound/outbound 集成工作 worker，要在自己的 clean worktree 中重新核验并落实附件中的所有约束。

实现文档（不要重写）：
docs/goals/v4-response-plugin-inbound-outbound-plan.md

执行规范：
1. 申请 feature_id:v4.response_plugin_inbound_outbound claim → 新建 clean worktree playground/v4-response-plugin-inbound-outbound-<UTC>-<host>-<pid>-<rand>，分支 codex/v4-response-plugin-inbound-outbound，base 4813ae09ffbdd8763396b661a70faaea3356ecd7。
2. 只改 v4/crates/routecodex-v4-standard-plugins/src/response_inbound.rs、response_outbound.rs、lib.rs（最小接线），新增 tests/l2_response_inbound_outbound.rs。禁止碰 runtime / cordis-bridge / server / provider / plugin-contract / plugin-plan / plugin-catalog。
3. 不实现、不修改 V4HubRespChatProcess03Governed 内部治理、tool harvest、continuation commit/release；只与 ChatProcess owner 走相邻边。
4. SSE 只在两端 frame boundary 处理；中间节点不携带 transport 状态。
5. 控制面（error_chain / metadata_center / route_facts / target_selection / stopless_state / payload_cycle / scope_session）一律走 typed control side-channel，禁止进入 v4.response.normal_payload 或 client wire；违反必须 fail-fast。
6. 禁止 fallback、silent strip、payload cleanup、handler/SSE/outbound/provider 特例补偿。
7. 同步 v4/.appsdk/maps/{function-map.json,mainline-call-map.json,verification-map.json}、v4/docs/architecture/v4-resource-operation-map.yml、v4/scripts/architecture/verify-v4-standard-plugins.mjs（NODE_PERMISSIONS 行 + descriptor 数 21 → 23）、contracts/active-link/frozen-consumer-registry.json（source deps: routecodex-v4-cordis-bridge / -node-container / -standard-plugins）。
8. 任何 JSON drift（例如把 "ExecCtx::write_control_resource" 这类字面塞进 function_map.json 的数组）必须就地修正；function-map/maps 里 entry_symbols 必须是字符串数组。
9. 完成前必须写 .agent-collab/runs/<run_id>/{actor.json,heartbeat.json,events.jsonl,evidence.jsonl}；handoff 放 .agent-collab/handoff/，注明与 feature_id:v4.response_chain_split_into_two_workers 的合并顺序。

验证：
- cargo test -p routecodex-v4-standard-plugins --locked（含新 l2_response_inbound_outbound.rs）；
- cargo test -p routecodex-v4-cordis-bridge --locked --test l2_bridge；
- node v4/scripts/architecture/verify-v4-standard-plugins.mjs [--red-self-test]、verify-v4-semantic-parity、verify-v4-plane-isolation、verify-v4-skeleton-topology、verify-v4-capability-isolation、verify-v4-execution-binding、verify-v4-resource-binding、verify-v4-relay-continuation、verify-v4-responses-direct-compat、verify-v4-node-graph；
- git diff --check --<changed files>；模块边界自检：cordis-bridge / runtime / server / provider 不允许改动；
- 至少 3 个正向 + 5 个反向 L2（malformed input / 非 object / 控制面泄漏 / 非相邻 selector / 未声明 resource 读写）。

完成标准：
- descriptor/catalog/plan compile + 21→23 descriptor 注册；
- protocol_decode / client_semantic_projection / frame_build 均有真实 typed handle；
- inbound/outbound 与 ChatProcess owner 无交叉；
- git diff --check 通过；所有 gate PASS；evidence.jsonl 完整；
- 不再写新的 prompt / plan，回报 worktree、改动文件、验证结果、剩余集成事项。

Canonical prompt 已落盘：docs/goals/v4-response-plugin-inbound-outbound-prompt.md

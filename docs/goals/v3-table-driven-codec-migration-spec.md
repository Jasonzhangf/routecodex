# V3 表驱动 Codec 迁移规格（阶段 3）

Design family: `v3-skeleton-and-table-driven-codec-20260808-r1`
Claim: `feature_id:v3-skeleton-and-table-driven-codec`（run `20260808T021953Z-Macstudio-31041-skeleton-table-codec`）
状态：**表数据已落地（7 张表 + 执行器 + 11 单测绿）；M1-M5 codec 迁移已完成并验证（行为零变化）；M6-M7 待做；部分 codec 文件仍在 active claim 下，已按用户授权 low-risk 迁移 + .agent-collab handoff 执行。**

## 1. 已落地基础设施

- 表目录：`v3/crates/routecodex-v3-runtime/tables/`（JSON 数据，schema 在 `tables/schema/protocol_tables.schema.json`）
- 加载器/校验器/执行器：`src/protocol_tables.rs`（`pub mod protocol_tables`）
  - `V3TableKind`：FinishReason / Role / PartType / Field / ToolChoice / Usage / RequestField
  - `V3TableDirection`：Inbound（协议->hub 归一化）/ Outbound（hub->协议 投影）
  - `map_value(kind, protocol, value, direction)` / `map_field(protocol, field, direction)`
  - `register_transform(name, fn)` / `run_transform(name, value)` / `validate_table_transforms()`
  - 加载即校验：JSON 合法、kind 合法、protocols 去重、**inbound 唯一性**（同一协议值只能对应一个 hub；outbound 折叠合法）
- 表清单（7）：
  | 表 | kind | 内容 | 数据来源 |
  |---|---|---|---|
  | finish_reason_map | value | finish_reason/stop_reason 双向 | anthropic_relay_runtime_codec.rs:305-322、openai_chat_codec.rs:217-226/467-474 |
  | role_map | value | role 双向（anthropic 无 developer） | responses_to_anthropic.rs:57-100、request_outbound_format.rs:184/992-1021 |
  | part_type_map | value | content part type 双向（带方向） | anthropic_codec.rs:823-835、responses_openai_codec.rs:628-700 |
  | field_map | bidi_field | 字段互逆对 | request_outbound_format.rs:1224-1228、responses_openai_codec.rs:981-985 |
  | tool_choice_map | value | tool_choice 类型双向（含 function/tool/custom 折叠） | responses_to_anthropic.rs:997-1047、anthropic_codec_tool_projection.rs:23-33 |
  | usage_map | value | usage 同名映射（首批） | responses_to_anthropic.rs:1049-1076 |
  | request_field_map | field_whitelist | 出站顶层字段白名单（4 协议） | allowed_top_level_outbound_fields |

## 2. codec 迁移步骤（claim 释放后按序执行，每步行为一致性测试）

### M1 finish_reason 查表化 ✅ 完成
- 源：`anthropic_relay_runtime_codec.rs:312-321`（match）、`openai_chat_codec.rs:220-225/468-472`、`servertool_hooks.rs:681-693`、`resp_chat_process_03_governed.rs:416-427`（四键归一化）
- 改法：match 表 → `protocol_tables::map_value(V3TableKind::FinishReason, protocol, value, dir)`；四键归一化循环收共享 helper
- 占用 claim：anthropic_thinking_normalization / 4444_chat_sse

### M2 互逆字段对查表化 ✅ 完成
- 源：`request_outbound_format.rs:1224-1228`、`responses_openai_codec.rs:981-985`
- 改法：`map_field(protocol, field, dir)` 替代两处手写
- 占用 claim：5520_outbound / responses_chat_malformed / responses_client_metadata_long_value

### M3 role + part_type 查表化 ✅ 完成（request_outbound_format 部分；anthropic 分发逻辑豁免）
- 源：`responses_to_anthropic.rs`（role 折叠）、`request_outbound_format.rs:992-1021`、`anthropic_codec.rs:1297-1332`
- 改法：`map_value(Role/PartType, ...)`；anthropic developer 折叠注册 `fold_developer_to_system` transform
- 占用 claim：anthropic_thinking_normalization / 5520_outbound

### M4 tool_choice 查表化 ✅ 完成
- 源：`anthropic_codec_tool_projection.rs:23-33`、`responses_to_anthropic.rs:997-1047`
- 改法：type 名查 `tool_choice_map`；对象变换（name/disable_parallel_tool_use）注册 transform
- 占用 claim：5520_outbound / anthropic 系列

### M5 顶层字段表化 ✅ 完成（schema 已扩展 field_whitelist_map；request_field_map.json 四协议白名单）
- 源：`request_outbound_format.rs` responses 37 字段拷贝数组（L82-119）+ 白名单（L842-983 三份）+ chat 重写（L1339-1404）
- 改法：新建 `request_field_map.json`（whitelists per protocol + renames 对）；schema 加 `field_whitelist_map` kind；加载器/执行器扩展
- 占用 claim：5520_outbound / 5520_malformed / deepseek_max_reasoning / structured_output_strict / protocol_structured_output / review_direct_payload / responses_client_metadata

### M6 SSE 事件生成表化 ⏳ 延后（依赖阶段 4 骨架收敛）
- 源：`anthropic_relay_runtime_codec.rs:105-256`（text/thinking/tool_use 四分支 start/delta/stop 脚手架约 120 行）
- 改法：新建 `sse_event_template_map.json`（content 类型 → start block 模板/delta 类型/delta 字段）；表驱动生成
- 状态：**延后到阶段 4（relay 统一骨架）一并做**——SSE unfold 循环收敛（3 套 → 1 套）是骨架工作，模板表单独落地无收益且与骨架耦合。
- 占用 claim：anthropic_thinking_normalization / anthropic_malformed_function_arguments

### M7 resp_inbound_02 分派 ⏳ 延后（协议少 + context 依赖）
- 源：`resp_inbound_02_normalized.rs`（单协议 if）
- 改法：`resp_protocol_dispatch.json`（protocol → codec 入口），骨架按表分派
- 状态：**延后**。当前仅 anthropic 一个转换协议，且其投影需要 `chat_request` context（超出纯数据表能力，需先扩展 transform 注册表签名支持 context）；待协议增多或 transform context 扩展后落地。
- 占用 claim：responses_chat_malformed（req_inbound_02_normalized.rs 在其 allowed_paths）

## 3. 锁死防回退（每迁移完成后的红测）

1. 新增协议映射必须出现在 JSON 表（禁止手写新映射）——红测扫描 codec 文件中的 `"type": "..."` 字符串映射对，与表内容比对；
2. 互逆映射必须成对同表——`validate_table_transforms()` 已覆盖 transform；互逆成对由 schema 校验；
3. 主循环/骨架禁止协议字段名——架构 gate 扫描（阶段 6）。

## 4. 待扩展表（后续批次）

- `sse_event_template_map.json`（M6，随阶段 4 落地）
- `resp_protocol_dispatch.json`（M7，待 transform context 扩展或协议增多）
- gemini 协议列补全（当前 7 张表以 responses/openai_chat/anthropic 为主）
- usage_map 的 cached/read 双语义字段（inbound 歧义，需 transform 兜底）

## 5. 阶段 4 进度（relay 骨架收敛）

里程碑 1（完成）：`relay_runtime_shared.rs` 共享辅助模块 + gemini/anthropic/openai_chat 三协议迁移。
- 共享：`server_routing_group`（返回 `&str`）、`provider_target`（`expected_provider_type` 参数化：gemini 传 `Some("gemini")`、其余 `None`）、`error_output`（返回 `(V3Error06ClientProjected, Vec<&'static str>)`）、`handle_provider_failure`、`V3RelayProviderFailure`（错误 body 形状协议差异用 `error_type_fn`/`error_message_fn` 函数指针字段 + `extract_error_*_style` 提取函数）。
- 协议本地（保留）：`provider_http_failure` / `provider_request_failure` / `provider_runtime_failure`（body 形状协议 wire 差异）、`provider_failure_output` / `error_output` 壳（组装协议 Output）。
- 错误形状：gemini `error.code`（code-style）、anthropic/openai_chat `error.type`（type-style）。
- 验证：gemini 20+42、anthropic 72+6+5+1+2、openai_chat 6+23（2 个既有并行中间态失败除外）、lib 335 全绿。

里程碑 2（待做）：`V3RelayProtocolCodec` trait + `execute_v3_relay_runtime_core` 统一主循环（抽 VR loop / 错误循环 / SSE 循环）。

**responses 延后**：`responses_relay_runtime.rs` 的失败处理是增强版（`V3ResponsesRelayProviderRetryState` 聚合状态 + observability 事件收集 + `V3ResponsesRelayProviderFailure` 含 `policy_error_type`/`policy_error_message`/`observability` 字段 + 混合错误形状提取），与共享 `V3RelayProviderFailure` 结构不兼容；且该文件被多个 active claim 修改中。迁移需先统一 failure 结构（大改动），延后到里程碑 2 之后单独处理。

## 6. continuation 不可变区审计（Jason 规则：save 与 restore 之间只能语义归一）

规则：**continuation 响应保存（Resp04 save）与下一轮请求恢复上下文（req04 restore）之间，不能有任何逻辑处理，只能做语义等价归一化 / 投影 / 传输 / scope 校验 / 释放**。禁止：history/tool 修补、tool_call/tool_output 重排、stopless/servertool guidance 注入、required_action 推断、response repair、request rebuild、payload cleanup。

逐环节审计结论（2026-08-08，全部 PASS）：

| 环节 | 位置 | 判定 |
|---|---|---|
| **save（Resp04）** | `commit_or_release_responses_local_continuation`（responses_relay_runtime.rs:2330 JSON / :2601 SSE）→ `commit_or_release_v3_relay_local_continuation_at_resp04`（resp_continuation_04_committed.rs:481） | 唯一保存点 |
| save 之后 health/observability | `record_provider_success_in_failure_scope` / `stream_observation.*` / observability 组装（:2606-2667） | 仅 side-channel 记录，不改 payload |
| save 之后 client body | `project_v3_responses_relay_client_body`（:2671） | 语义等价投影 |
| **resp05** | `build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04`（resp_outbound_05_client_semantic.rs:19）identity；`..._with_client_payload`（:35）受控相邻投影，文档契约"禁止绕过 03 治理/04 commit" | 仅投影 |
| **resp06 / server 输出** | `trace.push("V3ServerRespOutbound06ClientFrame")` + client_body 传输（:3343-3351） | 仅传输 |
| **req_inbound_01/02** | server raw 接收 + 归一化；红测 `responses_continuation_locator_does_not_enter_chat_canonical_payload`（req_inbound_02_normalized.rs:252-279，断言"continuation control locator 不得作为 Chat payload 跨越 ReqInbound02"） | 仅接收/归一化 + 防泄漏 fail-fast |
| **req03** | `classify_continuation`（所有权分类）+ req03 构建（relay_request.rs:448-450） | 分类/归一 |
| **restore 点** | `restore_local_context_at_req04`（relay_request.rs:455） | 唯一恢复点 |
| restore 之后 | `merge_v3_relay_restored_local_context_at_req04` + servertool 注入 + tool outputs 治理（relay_request.rs:459-519） | 均在 req04 内（恢复点之后），属 req_chatprocess 正常职责 |

边界说明：`infer_v3_runtime_finish_reason(action, status)`（:2660 附近）用 continuation action 推断 finish_reason 仅用于 **observability 元数据**（side-channel），不写入 client payload，不违反不可变区。SSE 的 `stream_observation` 是 observability 载体（非 continuation store），save 后从快照投影 client 事件帧属语义等价投影。

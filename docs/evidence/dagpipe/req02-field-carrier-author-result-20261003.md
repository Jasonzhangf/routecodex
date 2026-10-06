# REQ02 field carrier result

## 结论

本 worker 已完成 `operation_runner/operators` 字段库的直接 canonical root carrier 修复：生成的 Chat 根 carrier 为既有 `messages` 与 `routecodex_chat_extension`，根扩展写入、读取、opaque records、tool declaration/history pairing 和 inverse/opaque path 引用由同一字段库产出。

本 worker 只修改以下文件：

- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`
- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_records.rs`
- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_gemini.rs`
- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library_tests.rs`

`mod.rs` 的六模块注册由本树既有工作引入，本 worker 未编辑。未编辑配置 manifest、其它 worker 文件、产品 caller 或其它 worktree；未添加 `container_transform_id` fallback，也未按 protocol/path 推导 transform。未 commit、merge、push、install 或 restart。

## Carrier 行为

- 生成 carrier 根键：`routecodex_chat_extension`。
- 原始客户端 `extension` 和原始客户端 `routecodex_chat_extension` 都按原路径记录 opaque 值；生成 carrier 不从客户端同名字段复制或改名。
- opaque record 的 `path`、inverse `opaque_record_references[].path` 和 provenance destination 使用实际 carrier 路径 / `chat.routecodex_chat_extension...`，没有事后 rename adapter。
- 工具声明内部的嵌套 `extension` 保持原值，不批量替换；工具身份从请求声明 / 历史条目读取，不按 model 猜测，不解析 arguments/input。
- `opaque_records` 仍直接从 `canonical_request.routecodex_chat_extension.chat_extension_opaque_record` 读取，字段类型仍保持 `ClientRequestNormalization` 的三个公开输出字段。

## 测试

命令：

```text
cd /Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture
```

修改前基线：`21 passed; 11 failed`，失败均为 profile 方向绑定缺失（`request.messages` / `request.contents` 的 `no dispatch operator`）。

修改后实际结果：`23 passed; 10 failed`。通过项包含本 worker 新增/改写的：

- `canonical_root_carrier_uses_routecodex_chat_extension_and_preserves_conflicts`
- `responses_tool_identities_preserve_namespace_custom_and_complete_strings`
- `responses_instructions_and_token_limit_use_chat_destinations`（新增 provenance destination 断言）

仍失败的 10 项全部是配置 worker 依赖，不修改本 worker carrier 代码变绿：

- Gemini（7 项）：`request.contents` 无 `dispatch operator`。失败名为
  `gemini_preserves_unknown_fields_inside_recognized_content_parts`、
  `gemini_top_level_containers_dispatch_by_direction_binding`、
  `gemini_tool_container_siblings_are_preserved`、
  `gemini_non_array_parts_are_preserved_opaque`、
  `gemini_inline_data_with_unrepresentable_values_stays_opaque`、
  `gemini_hosted_tools_do_not_become_fabricated_functions`。
- Anthropic（3 项）：`request.messages` 无 `dispatch operator`。失败名为
  `anthropic_tools_keep_arguments_opaque_and_identity_typed`、
  `anthropic_message_blocks_preserve_unmapped_siblings`、
  `anthropic_recognized_tool_choice_preserves_unknown_siblings_in_inverse_context`。
- OpenAI Chat（1 项）：`openai_chat_preserves_unknown_fields_and_tool_payloads`，同样因
  `request.messages` 无 `dispatch operator`。

因此本 worker 的 carrier / 原始关联测试已通过；配置 profile 红测保留，未用 protocol/path 推导或 fallback 变绿。

## 配置依赖首次偏离

只读核对 `/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002/docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml`：

- 候选仍使用 `chat.extension.responses_request.include`（本树 manifest 同一 path 仍是 `request.include` 的方向 binding destination），而字段库现在实际输出 `chat.routecodex_chat_extension.responses_request.include`。
- 候选 manifest 中没有 `request.contents`、OpenAI `request.messages` 或 Anthropic `request.messages` 的 `direction_bindings.client_request_to_chat` transform_id；运行时因此在这些容器 row 上报 `profile row ... has no dispatch operator`，这是当前 10 项失败的首个可观察偏离。

本 worker 没有修改配置或猜测新流程；该绑定/输出差异需要配置 worker 按 R2 合同提供显式 profile 后重新验证。

## 剩余状态

- 未验证/未交付：REQ02 接线、产品 caller、配置 manifest、安装/restart/replay、review、commit/merge/push。
- 本 worker 输出仅供父编排合并与配置依赖收敛；不宣称 REQ02 完成。

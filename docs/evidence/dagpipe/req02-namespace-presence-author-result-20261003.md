# REQ02 namespace presence 最小纠正结果

## 结论

窄任务完成：字段记录构造不再把未声明 `namespace` 写成 JSON `null`；显式 `null` 和字符串 namespace 保持原有 presence。公开外部 consumer 的 absent/null/string 与四协议 absent 用例已从真实红转为绿。

本结果只证明公开 capture + normalize + typed resource 边界；没有执行 HTTP/WS、provider 调用或实际工具执行，不构成 runtime、节点或 REQ02 集成交付。

## 首次偏差与根因

- 首次偏差位置：`push_tool_declaration` 和 `record_history_pairing` 的 `json!` 记录构造把 `Option::None` 序列化为 `null`。
- 后续观察：typed parser 使用 `object.get("namespace").cloned()`，因此把该 `null` 保留为 `Some(Value::Null)`。
- 纠正边界：缺少值时不插入 `namespace` 键；值是显式 `null` 时仍插入 `null`。没有增加 parser 补偿、fallback、filter-null、工具参数解析或语义拒绝。

## 变更

- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs`：仅修改 `push_tool_declaration` 的记录构造。
- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_records.rs`：仅修改 `record_history_pairing` 的记录构造。
- `v3/crates/routecodex-v3-server/tests/req02_namespace_presence.rs`：新增公开外部 consumer 回归测试。

## 红绿证据

真实红：

- 命令：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_namespace_presence -- --nocapture`
- 日志：`.execution/req02_namespace_presence.before.log`
- 结果：真实 exit `101`，`0 passed; 2 failed`；首断言实际为 `Some(Null)`、期望 `None`。
- 同一缺陷的父公开 consumer 红：`.execution/req02_public_normalization.before.log`，真实 exit `101`，`1 passed; 4 failed`。

真实绿：

- 命令：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_namespace_presence -- --nocapture`
- 日志：`.execution/req02_namespace_presence.after.log`
- 结果：真实 exit `0`，`2 passed; 0 failed`。
- 覆盖：Responses 的 declaration/history 在 absent/null/string 下分别为 `None`、`Some(Null)`、`Some(String)`；同时验证原声明 opaque 值与 history arguments 精确保留；四协议 absent declaration 均为 `None`。

## 原公开用例与开发测试

- 原五公开用例：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture`
  - 日志：`.execution/req02_public_normalization.after.log`
  - 结果：真实 exit `0`，`5 passed; 0 failed`。
- 开发测试：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`
  - 日志：`.execution/routecodex-v3-runtime.operation_runner.after.log`
  - 结果：真实 exit `0`，`51 passed; 0 failed; 1085 filtered out`。
- `git diff --check`：真实 exit `0`。

## 精确哈希

```text
97d5e74c80cdec339b736cac0e781c307943e248e9afc863bccc024d6bfd5f6f  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs
f04e3e311bbf0b0a767a6f72212b404b70db6c91c9d0672ddb0db65a65e68fef  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_records.rs
eef031f5447c4193460e1283b84a775d9dd3fc3d4bfacac45ecf00db2fd7fbbc  v3/crates/routecodex-v3-server/tests/req02_namespace_presence.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
```

## 边界

- 只修改用户指定的三处源码/测试，并写本结果文档；未改 typed 资源、profile、graph、maps、注册表或其他产品/测试。
- 没有 commit、merge、push、install、restart。
- 没有 HTTP/WS 或真实工具执行证据，不宣称 runtime 或节点交付。

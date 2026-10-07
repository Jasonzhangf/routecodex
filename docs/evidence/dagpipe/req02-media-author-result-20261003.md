# REQ02 media operator recovery result

## 结论

本 worker 已完成 Media recovery 范围内的实现核对与行为验证。当前树保留的在途实现已经由 `field_operator_gemini.rs` 唯一处理 Gemini `inlineData`：

- `inlineData.data` 字符串精确输出到 `chat.messages[].content[].media.inline_data`。
- `inlineData.mimeType` 字符串精确输出到 `chat.messages[].content[].media.mime_type`；缺失时不合成 MIME。
- 非字符串 `data`/`mimeType`、未知兄弟字段和完整 `inlineData` 容器进入 opaque carrier，不裁剪、不 decode、不猜 MIME。
- provenance 指向实际 canonical media 目的位置，不再把 `inlineData` 拼成 `image_url.url` data URI。
- 当前轮最后 `contents` 条目中的图片值与文本按原顺序进入 canonical messages；本 recovery pass 新增该显式回归。

本 worker 只修改了：

- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library_tests.rs`
- 本结果文档

本 worker 没有修改 `mod.rs`、manifest/matrix、resource/runner、Server/kernel 或其他 tree。生产 media owner 文件是在途候选已有内容，本 pass 只完成复核、补充当前轮用例和真实验证，不声称已接公开 caller。

## 原红与当前修复

父合同记录的输入基线是 `33 passed; 4 failed`，首次实现是 `36 passed; 1 failed`。本树早先 field-carrier 回执还保留了更早的原始配置红错：

```text
profile row `request.contents` has no dispatch operator
profile row `request.messages` has no dispatch operator
```

当前组合树已具备显式方向 binding，进入本 recovery pass 后首次完整运行即为 `37 passed; 0 failed`。未发现剩余 media 生产偏差；此前未独立重验的 unknown inline sibling 用例也已实际通过。随后新增当前轮图片回归，最终完整套件为 `38 passed; 0 failed`。

## 验证

工作目录固定为：

```text
/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002
```

新增用例单独执行：

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner::operators::field_operator_library_tests::gemini_current_turn_inline_image_keeps_exact_canonical_media_value -- --nocapture
```

结果：`1 passed; 0 failed`，exit `0`。

完整 operation_runner 套件：

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture
```

结果：`38 passed; 0 failed; 0 ignored; 1085 filtered out`，exit `0`。

`git diff --check`：exit `0`。

附加 `rustfmt --edition 2021 --check` 未作为本任务 gate；该未跟踪测试文件包含既有格式差异，本次没有批量格式化，以避免扩大其他 owner 的修改面。

## 输入与产物哈希

基线 HEAD：

```text
3a72ad81320b1c435b08c0d99343c7c22efa5197
```

SHA256：

```text
8709c3cc6b09fc1247d24c7d5eb85a67def77f86397bcc11cf32ade822696a98  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_gemini.rs
78ac0e793a7ad3907944bc94feb832306c92a0af1fe5725c2705d1c381241b7d  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs
e05a43e9943292b68c37528402773ac77bd12e0d0380bae8801b959b4250758b  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_profiles.rs
0363b2a31a771e83d5c0ae428d10efc61463dbdc9ca4028b47b1420ea7dc62db  v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library_tests.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
```

## 未完成与交接

- 本结果只证明字段库/operation_runner 开发行为；公开 REQ02 runner、真实 Server provider-bound image、工具回环和终端响应黑盒仍由父候选验收。
- 未 commit、merge、push、install 或 restart。
- 未创建独立临时日志；本结果与工作树属于父编排的资源回收范围。

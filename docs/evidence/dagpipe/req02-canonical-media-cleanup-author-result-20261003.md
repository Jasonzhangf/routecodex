# REQ02 canonical media 历史图片修复结果

## 状态

`SLICE_COMPLETE`

限定结论：本切片在公开 operation runner / Req04 consumer 入口完成行为红绿闭合。
未 commit、merge、push、install、restart，未动 4444。
该结果不声称完整 HTTP/WS 或真实 provider/工具回环 PASS。

## 范围与 owner

- 任务合同：`docs/goals/req02-canonical-media-cleanup-worker-20261003.md`
- 工作目录：`/Volumes/Intel/playground/routecodex/req02-canonical-media-cleanup-20261003`
- feature：`v3.history_image_cleanup`
- 唯一 owner：`v3/crates/routecodex-v3-runtime/src/hub_v1/history_image_cleanup.rs`
- Inbound / canonical normalization、operation runner、Req04 caller 均未修改。

## 修改

1. `history_image_cleanup.rs`
   - 将 chat / responses 图片 part 判定收敛到共享 `is_v3_embedded_image_carrier`。
   - 新增仅针对真实 canonical 表示的识别：
     - `type=media` 且 `media.mime_type` 为 `image/*`，载体为真实非空
       `media.inline_data` 或 `media.file_uri`。
     - `type=file` 且 `file.mime_type` 为 `image/*`，载体为真实非空
       `file.file_url`。
   - 复用既有固定 `[Image]` 替换和历史轮选择。
   - 不因仅有 MIME、无类型未知 media、音频/视频 media 而清理。
   - 不解析工具参数判断工具身份，不新增协议/model 分支、拒绝或 fallback。
2. 新增 `v3/crates/routecodex-v3-server/tests/req02_canonical_media_images.rs`
   - 从公开 operation runner 真实入口进入，经 canonical Inbound 和 Req04 consumer。
   - 覆盖历史 inline/file 图片、当前轮图片、音频/视频/缺省 MIME 保留、
     canonical media 仅 MIME 保留、完整 tool calls 与 tool output 保留。
3. `history_image_cleanup.rs` 定向单测
   - 覆盖 canonical media/file 图片与过宽匹配负向保留。

## 原始红

命令：

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable \
  -p routecodex-v3-server --test req02_chat_history_images -- --nocapture
```

结果：`exit 101`

失败点：`v3/crates/routecodex-v3-server/tests/req02_chat_history_images.rs:325`

```text
assertion `left != right` failed: gemini history image must be replaced by Chat Process
left: Array [..., Object {"media": Object {"inline_data": String("aGVsbG8="),
      "mime_type": String("image/png")}, "type": String("media")}]
right: Array [..., Object {"media": Object {"inline_data": String("aGVsbG8="),
       "mime_type": String("image/png")}, "type": String("media")}]
```

原始日志：`docs/goals/req02-canonical-media-cleanup-red.log`

该失败是行为红，不是编译红。

## 绿与回执

命令：

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable \
  -p routecodex-v3-server --test req02_chat_history_images -- --nocapture
```

结果：`1 passed; 0 failed`，`exit 0`
日志：`docs/goals/req02-canonical-media-cleanup-green.log`

命令：

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable \
  -p routecodex-v3-server --test req02_canonical_media_images -- --nocapture
```

结果：`1 passed; 0 failed`，`exit 0`
日志：`docs/goals/req02-canonical-media-cleanup-canonical.log`

命令：

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable \
  -p routecodex-v3-runtime --lib history_image -- --nocapture
```

结果：`20 passed; 0 failed; 1121 filtered out`，`exit 0`
日志：`docs/goals/req02-canonical-media-cleanup-runtime.log`

命令：

```sh
git diff --check
```

结果：`exit 0`

## 精确哈希

```text
40f88ee4cc0ad28355a430a3e7c055df827fbfbcfade220633151dca07fc2afc  v3/crates/routecodex-v3-runtime/src/hub_v1/history_image_cleanup.rs
b865a09c37e074ac87fe41d6e7edaa945ba6809f22d380ee6b1f406cede58c03  v3/crates/routecodex-v3-server/tests/req02_canonical_media_images.rs
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
d4e6365c265793468fde1f17409e87aa84e9597fd78fbbdfef5cad290386ec8f  docs/architecture/dagpipe/v3.operation_runner.request.graph.json
```

后两项是共享候选的只读 profile/graph 哈希，本次未修改。

## 未覆盖与下一步

- 未运行完整 HTTP/WS E2E、runtime 安装/重启或真实 provider/工具回环。
- 未 commit、merge、push。
- 下一步由主目标编排者合并独立工作结果；合并前需重新绑定候选与验证证据。

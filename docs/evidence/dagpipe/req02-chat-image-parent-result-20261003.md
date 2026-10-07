# REQ02 canonical consumer 与历史图片：父候选验收

状态：公开consumer切片与父开发回归PASS，整节点INCOMPLETE。REQ02生产caller未替换，无安装/restart、实现架构review、merge/push或两模型实际工具回合回执。

## 输入和唯一owner

- 父工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002`。
- 父HEAD：`75b1927f50d66863c4506fbecf265830dfac85d8`，加本任务未提交候选；完整输入由下列hash记录绑定，不把HEAD当完整候选版本。
- 已组合main：`75cab8267de2e6058d557f440d1f0f1c0854252a`。最新fetch为`688f7a1c6a15ecf45dfee12cc430148ae3c03898`，尚未组合；本证据不证明最新main上的全部行为。
- canonical薄consumer与Req04唯一清理调用输入：`.execution/chat-image-parent-imported-inputs.sha256`，与image作者源码cmp一致。
- helper与新增公开test/profile：`.execution/canonical-media-parent-inputs.sha256`。
- helper唯一owner：`hub_v1/history_image_cleanup.rs`；两处重复图片part识别收敛到既有共享谓词。只支持当前已发出的`media.inline_data`和`file.file_url`图片载体，不引入无契约的`media.file_uri`分支。
- 原Inbound保持无损，canonical consumer直接消费SDK结果；历史清理由Req04一次调用，当前轮图片、音视频、未知MIME及原完整工具调用/结果保留。

## 父实际执行回执

所有命令在父工作树执行，输出分别重定向到独立日志；退出码来自实际执行handle，未用后续成功命令替代。

| 阶段 | 命令 | 实际退出 | 结果 | 日志 |
| --- | --- | ---: | --- | --- |
| 组合consumer后的行为红 | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images -- --nocapture` | 101 | 0 passed / 1 failed，Gemini历史media图片原样保留 | `.execution/chat-image-parent-before-media.log` |
| 组合helper后的公开行为 | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images --test req02_canonical_media_images -- --nocapture` | 0 | 两个test target各1 passed / 0 failed | `.execution/canonical-media-parent-public.log` |
| helper开发回归 | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib history_image -- --nocapture` | 0 | 19 passed / 0 failed | `.execution/canonical-media-parent-history.log` |
| 父runtime全库开发回归 | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib -- --nocapture` | 0 | 1135 passed / 0 failed / 1 ignored | `.execution/canonical-media-parent-runtime-lib.log` |
| diff格式 | `git diff --check` | 0 | PASS | CLI回执 |

日志hash见`.execution/canonical-media-parent-logs.sha256`。忽略用例保留原状态，未作为验收证据；本次未改变测试断言使失败消失。helper作者的新增白盒test未导入父，作者20项与父既有19项结果分别报告。

## 后续

真实请求资源/guard搬运与成功attempt响应consumer仍需收取、审计和组合。REQ06外部owner的公共projection helper尚未交付当前typed接口。候选必须组合最新main，并取得真实HTTP/WS、JSON/SSE、Direct/Relay、成功/失败/取消/断连和gpt-5.5/5.6的exec、apply_patch、MCP实际执行/结果回传/follow-up证据，之后才共享runtime安装/restart、独立实现架构review与集成。

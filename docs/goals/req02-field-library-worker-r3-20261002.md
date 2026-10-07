# REQ02 字段算子实施 R3

独占工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002`，base `3a72ad813`。你不是独自工作，不覆盖他人文件。Desktop child 不执行 Collab；不要审计 worktree 列表、身份、安装、main 或其他节点。

执行边界：每个command显式workdir为上面的绝对工作树，或命令先cd该树；每个apply_patch使用该树绝对路径。首次pwd必须等于该树，当前默认cwd不可靠，不能在cutover树读写产品代码。任务合同在另一棵树，仅此一个文档允许跨树读取。

任务：先完成可编译且通过公开归一化边界测试的 REQ02 字段算子库。参考不可变 commit `768a9565c` 的七个 `field_operator_*` 文件，逐文件核实后 apply_patch 引入；保留主链 REQ01。当前只实现既有已声明 `client_request_to_chat` profile 合同，不修改 graph/profile，不写其他节点、不接生产 caller。不要因尚未完成的 caller 设计而停止本切片。

允许写入：`operation_runner/operators/field_operator_{library,profiles,helpers,records,gemini,library_tests}.rs`，`operation_runner/operators/mod.rs` 的这些模块注册，本工作树 `docs/goals/req02-field-library-result-20261002.md`。禁止 normalize 算子、context store、operation_runner/mod.rs、hub/server/kernel、graph/maps；父编排负责它们。若发现 profile/合同问题，在结果中记录，不悄悄改变配置。

完成 iff：四种协议经同一 field traversal/registered field operators 归一，输出 canonical data 和 inverse/history associations。完整保留 exec 字符串、apply_patch freeform、MCP参数/结果、未知嵌套值、当前轮图片；工具类型/namespace由请求声明决定，不按模型名猜，不在 Inbound 做 provider-safe 改名。逆向资源只保存映射关联，不能夹带控制真相。不得增加猜测修复/拒绝/静默strip；透传可表达意义。

测试：先运行针对原始请求工具/未知字段保留的 failing test，再实现，执行 `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`、修改文件 rustfmt 和 `git diff --check`。命令结果精确写入结果文档，包含文件/API/通过数/失败与剩余接线边。归一化测试不证明 provider 最终保留；不宣称节点已交付。不 commit/merge/push/install/restart。不要重复全库探索；立即写允许范围的实现。

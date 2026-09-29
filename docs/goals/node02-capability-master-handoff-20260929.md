# RouteCodex Node02 能力候选交接（2026-09-29）

## 当前证据

- 独立 worktree：`/Volumes/Intel/playground/routecodex/dagpipe-node02-capability-20260929`；分支 `codex/dagpipe-node02-capability-20260929`；HEAD `4844c4df3aabceff680932033a35e0ccb4697abc`。核对时 `origin/main` 为 `775e8af23791d7d9a7e58fa2928d19f1948622b9`，交接后须重新 fetch。
- 未提交文件：`docs/architecture/v3-mainline-call-map.yml`、`v3/crates/routecodex-v3-runtime/src/operation_runner/mod.rs`、未跟踪的 `v3/crates/routecodex-v3-runtime/src/operation_runner/capability_tests.rs`。本交接文件也未提交。保留全部内容，先检查再改；不得清理、覆盖或在主仓开发。
- 现有设计：`docs/design/v3-node02-typed-resource-injection.md`。Astra 对最初能力候选给出 FAIL。Node02 产品归一化尚未接线；候选未提交、未 review PASS、未 merge/push、未安装/重启 4444。

## 必须处理的错误

1. **能力证明的三个架构缺口。** `capability_tests.rs` 的 finalizer 由测试手动调用，未由真实失败、SDK 取消和客户端断连统一触发；协议由测试构造的 `IngressContract` 提供，未经过真实 HTTP/Responses WebSocket endpoint owner；资源适配仍须证明 graph declarations、V3 resource map、静态 Operator access contract 与受限句柄共同约束访问，尤其 RawEntry 原子发布和 AlreadyCanonical 只读。见上述设计文档及 Astra FAIL；测试绿不能替代这些执行边。
2. **新增伪证据须消融。** 当前 `capability_tests.rs:419` 的测试自建 TCP listener，却称为“real endpoint”；它没有调用 RouteCodex Server endpoint。`:466` 的测试把手动 `finalize`、私有 `is_cancelled` 轮询和自建 TCP 连接当作取消/断连终点。`:324` 的 `finalize` 仍忽略 outcome。删除这两项伪测试和失效辅助代码，再按实际 owner 建立真实 consumer；不能只修到编译通过后沿用其结论。
3. **候选当前编译失败。** 命令 `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime capability_ --lib --no-default-features` 返回 101，剩四处错误：`:421`、`:490` 对异步 `tokio::net::TcpListener::bind` 直接 `.expect`；`:485` 调用 DAGPipe SDK 私有 `Cancellation::is_cancelled`；`:104` 资源 map 借用数据逃逸（E0521）。这些是当前候选错误，修复时应先移除伪测试，再重新观察剩余编译错误。
4. **GCM worker 编辑失败。** 三个 `codex exec --profile gcm` worker 已停止。第一位在大 patch 失败后用 shell heredoc 重写未跟踪测试文件，造成 Rust 字符串转义损坏；第二位反复提交无效 patch 和错误路径；第三位未完成清理即停止。当前测试文件不能作为原先 4/4 能力证明的延续。只用逐文件、可核对的 `apply_patch`；每次改动后核对 diff 和定向编译。不要在此基础上直接接线或送 review。
5. **Master 通信路由故障。** 本 Desktop 任务没有可用的原生 Codex TUI `send_message_to_thread` 工具。`collab context` 返回 `DAEMON_UNAVAILABLE`；`collab master status` 返回 `TMUX_ENDPOINT_MISSING`；`collab status --all` 无法连接 socket。`~/.collab/log.txt` 的最新启动记录为 `RECOVERY_RECONCILE_REQUIRED`，host pane route 缺失或与 project pane route 不一致。未向 TUI master 成功送达任何消息；不得把本文件存在当成通知回执。不要手改 routes、复制 token、启动第二 daemon 或用 tmux 输入伪造消息。

## 可直接交给 RouteCodex Codex TUI master 的提示词

```text
/goal
目标：接管 RouteCodex Node02 typed-resource 能力候选，先修复候选中的伪测试和编译错误，再完成真实 DAGPipe SDK consumer 的三条能力边；修复本项目 Collab/Codex TUI 通信路由后给出实际送达回执。完成能力验证和独立 Astra review PASS 前，不接线 Node02 产品归一化，也不 merge、安装或重启 4444。

范围与约束：工作树 /Volumes/Intel/playground/routecodex/dagpipe-node02-capability-20260929，当前 HEAD 4844c4df3aabceff680932033a35e0ccb4697abc。先核对 live worker、worktree dirty 内容和最新 origin/main，保留现有改动。唯一 writer 负责 operation_runner 的能力 consumer；Server endpoint 或 Runtime 生命周期所需跨 crate 边先按 V3 map 锁定 owner，再给独占 writer。禁止在主仓或默认 playground 开发；禁止 JSON payload 承载 control、猜测协议、自造 TCP endpoint 冒充真实入口、手动 finalize 冒充失败/取消/断连、无条件 fallback、吞错或双实现。4444 只可按官方命令 restart，不可 stop/kill。

依据：docs/goals/node02-capability-master-handoff-20260929.md 和 docs/design/v3-node02-typed-resource-injection.md。先移除 capability_tests.rs:419 与 :466 的伪测试及失效辅助代码；当前聚焦 cargo test 有 4 个编译错误（:421、:485、:490、:104），以实际修复后的新错误集为准。重新证明：真实 HTTP/Responses WebSocket endpoint 提供 typed ingress 且与 body 形状无关；graph + V3 map + 静态 access contract 限制 Operator 对同一 request-scoped MetadataCenter 的句柄，RawEntry 原子发布、AlreadyCanonical 只读；真实失败、SDK cancellation 和 consumer disconnect 通过唯一 Runtime finalizer 释放 slots。保留业务 Value 原样，失败显式进入正确边界。对工具/参数只做身份与配对验证，不解析或截断工具参数。

验收：提供 red/green 原始命令和结果、真实 pinned DAGPipe compile/run、HTTP 与 WebSocket 实际 endpoint consumer、成功/失败/取消/断连终点、两请求隔离、禁止访问负例、focused cargo tests、server cargo check、适用 architecture gates、精确候选 SHA/树；独立 Astra 对该候选 PASS 后才推进下一阶段。对 Collab 路由给出修复前错误、修复后的 context/master 身份和真实 send/recipient 回执；送达、读取和执行分层报告。未证明的层标 INCOMPLETE。直接执行，不再生成另一层提示词。
```

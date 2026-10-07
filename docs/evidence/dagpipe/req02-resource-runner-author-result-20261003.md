# REQ02 Resource Runner Correction Result

## 结论

Resource recovery 子任务完成作者实现与定向验证，本树不 commit / merge / push / install / restart。结果供父编排候选组合和后续 consumer / Server 黑盒验收。

工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`

## 输入与哈希

```text
mod.rs                                         2694d90f655083996d2f72fb3c30546f66c2c9d17d247c502e7a10a85fab1686
request_context_store.rs                        bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35
operators/mod.rs                                2db08a43dc9d3ba12ff333a8278fdbec04fba6f5c24057a23d9d5d413fe8f47b
operators/normalize_request_losslessly.rs       13bb8145e021a1c0a906cf1c6ae5f02ed94c0c88a509db16e4764f8f2b63a9dd
docs/architecture/dagpipe/v3.operation_runner.request.graph.json d4e6365c265793468fde1f17409e87aa84e9597fd78fbbdfef5cad290386ec8f
docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml 88cac07bbaf56f99a6abc58f0ecc3580a20190d56299649ab6c4a15fe77bf98a
```

field/profile/maps/graph 只读，未修改。

## 修复内容

- 释放 owner 收敛为单次 lock：`release_request_scope` 在锁内先清 `successful_attempt` / `failed_attempts`，再清 `original_pair`，然后标终态；poison 通过锁结果保留显式错误，清理仍执行，并恢复锁 poison。
- `V3RequestFinalizerGuard::finalize()` 返回真实 `Result<(), String>`；Drop 消费该结果，失败时显式 `eprintln` 记录，不 panic、不吞错、不假成功。
- `publish_original_pair` 不再静默复用旧 pair；同 scope 已发布 pair 后再来 `RawEntry` 返回内部生命周期错误，重入必须走 `AlreadyCanonical`。
- 公开 normalize runner 用 `same_scope()`（`Arc::ptr_eq`）校验 handle 与 invocation 指向同一 scope，不再只比较 `request_id`。
- `AttemptContext` 发布时校验 `attempt_id` / projection / declarations 的 attempt、provider protocol、provider model 一致。
- `ToolMappingReference` 增加实际发出的 `emitted_kind`、`emitted_name`、`emitted_namespace`，并用 `declaration_record_id` 关联原声明；不存业务 schema、参数、结果。
- normalize slice 保持单节点 `normalize_request_losslessly`，输入 `client-json`、输出 `canonical-request`；`AlreadyCanonical` 与 `RawEntry` 都通过真实 SDK compile / Runtime 执行。

## 验证证据

REQ02 精确 filter（exit 0，13 passed）：

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner::req02_resource_runner_tests -- --nocapture
test result: ok. 13 passed; 0 failed
```

覆盖：raw entry 归一和 pair 发布、AlreadyCanonical 复用不重捕获不替换 pair、RawEntry 禁止重发布、same-scope 而非仅 request id、clone 不 finalize、终态 attempt->request 顺序、poison 显式错误与清理、Drop 不 panic、attempt 身份一致性、失败 attempt 不可读作成功。

原合同全 operation_runner filter（exit 101，34 passed / 11 failed）：

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture
test result: FAILED. 34 passed; 11 failed
```

失败均在 `field_operator_library_tests`，根因是 profile 行 `request.messages` / `request.contents` 没有 dispatch operator；该 profile 属 readonly 范围，本任务未改 field / profile，按合同如实报告，不作为 runner PASS。父树 `resources-r1.jsonl` 已留有旧 exit101 红证据；本次 `operation_runner` 的完整失败也独立记录于此。

`git diff --check`：exit 0。

允许文件 `rustfmt --edition 2021 --check`：exit 0。

## Consumer 待接边

公开消费面已从 `operation_runner/mod.rs` 导出：`V3RequestContextHandle`、`RequestInvocationContext`、`RequestNormalizationEntry`、`RequestOriginKind`、`RequestScopedContextPair`、`AttemptContext`、`AttemptProjectionContext`、`AttemptDeclarationMap`、`ProjectionPath`、`ToolMappingReference`、`V3RequestFinalizerGuard` 等。Server / kernel / response projection 尚未在本树接入，父验收仍负责公开 Server 黑盒；profile dispatch 缺口由对应 field/profile owner 接续。

## 资源归属

本轮仅修改本任务允许的四份 source 文件和本结果文档；未创建临时目录或进程，无需要回收的额外资源。

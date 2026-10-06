# REQ02 Runtime请求身份及实际资源搬运

独占树：/Volumes/Intel/playground/routecodex/req02-identity-plumbing-20261003。fresh origin/main=75cab8267，父提供已审REQ02算子/typed资源作为只读依赖。你不是独自工作，另worker独占req_inbound_02_normalized.rs及req_chat_process_04_governed.rs；不可修改它们。全新codex exec --profile gcm，无resume/fork/父transcript，不使用Collab或内置subagent。

依据父树docs/design/v3-req02-cutover-consumer-contract.md及R2设计PASS，读取既有图/资源边即可，不重复全库审计。目标是把现有V3RequestContextHandle和唯一非Clone guard搬进真实Runtime请求生命周期，不能仅增加类型、accessor或未消费sidecar。REQ06公共投影helper仍是外部依赖，本任务不改标准投影，不提前替换Direct native payload为canonical。

允许：execution_control.rs（唯一factory及opaque handle/guard搬运）、kernel.rs/direct_execution_control.rs/v3_direct_core.rs/nodes.rs中真实请求身份及同scope传递；server metadata_center.rs/endpoint_handlers.rs/websocket.rs/executors.rs/responses_direct_server_outcome.rs的opaque搬运；hub_v1/{relay_runtime_core.rs,responses_relay_runtime_inner.rs,anthropic_relay_runtime.rs}只限factory参数、同control传递和终态guard搬运，不改协议投影/治理/归一化；新增server/tests/req02_request_scope_lifecycle.rs及本树结果/笔记。必要Runtime输出struct的最小guard字段改动先落盘具体路径和原因给父，不擅自扩大。共享maps/graph、operation_runner依赖、REQ06、req_inbound_02/req_chat_process_04、Provider及SSE协议投影只读。

实现合同：复用当前budget构造，在有真实requestId/entryProtocol且首次planning前由Runtime factory创建同一request-local handle；V3RequestExecutionControl持有该handle，getter request_context()返回同scope引用。原无请求身份factory改为显式requestId/entryProtocol的唯一factory并迁移可达调用，不合成生产ID、不由payload猜控制、不留无身份fallback。Server只搬运factory返回的opaque资源；metadata plan不能成为所有请求唯一创建点。Direct-to-Relay/Relay-to-Direct沿既有handoff搬运同control，不再创建新pair。guard只take一次；成功JSON、SSE EOF/Drop、error、取消/future drop、HTTP/WS断连到同Runtime释放终点，先attempt后request；普通handle clone不finalize，不用每clone的Drop。真实输出/stream搬运唯一guard，未安装候选不得影响4444。

不在本任务改inbound normalization的payload流程，父在projection依赖齐备后统一接REQ02 SDK并删除旧分支；不要为了编译以default context/dummy IDs/Option兜底复活旧链。遇到边界缺口，落盘首个确切caller、必需接口与最小拟改，继续不依赖缺口的实现，不反复读同一源码。

测试：公开consumer覆盖真实request identity与独立invocation identity、两请求隔离、同scope handoff、guard唯一取得、普通clone存活不提前释放、成功JSON/错误/stream EOF及Drop/取消终态释放。先记录现有行为缺口，编译红与行为红分开，不能称旧baseline为新回归。分别执行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_request_scope_lifecycle -- --nocapture，以及-p routecodex-v3-runtime --lib execution_control -- --nocapture和-p routecodex-v3-runtime --lib operation_runner -- --nocapture，单独日志/实际退出码。新增完整HTTP/WS入口用例可作为集成patch交父；公开测试不能冒称共享runtime或工具执行验收。

完成iff：真实factory/caller同scope接入且guard从实际输出终态释放、公开回归和受影响开发测试exit0、范围内旧无身份调用已迁移、逐文件diff和源/test/profile hashes及原始退出回执落盘docs/goals/req02-identity-plumbing-result-20261003.md。无commit/merge/push/install/restart，结果落盘退出。不能闭合某终点时明确INCOMPLETE和具体可集成产物，不增加fallback。

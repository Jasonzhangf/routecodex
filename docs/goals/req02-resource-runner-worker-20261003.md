# REQ02 typed资源与可执行runner

开始条件：父编排确认`req02-consumer-design-20261003-r1`或其修订已有独立设计PASS后才启动。工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`，base3a72ad813。你不是独自工作，其他worker负责field库、配置gate、Server/consumer；不得覆盖或回滚别人修改。每command显式本workdir，apply_patch绝对路径。Desktop child不进入Collab，禁止resume。

读唯一实施合同 `/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002/docs/design/v3-req02-cutover-consumer-contract.md`，无需重复全链审计。字段库作为父编排提供的依赖留在同树，只读不修改field_operator_*.rs。

独占允许写：`v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs`、该目录mod.rs、operators/normalize_request_losslessly.rs、operators/mod.rs（只增注册/reexport）、本树docs/goals/req02-resource-runner-result-20261003.md。禁止execution_control、Server、其他hub/kernel、REQ03—09、配置/profile及外部REQ06文件。

直接实现合同中的typed固定slots、RequestInvocationContext、RawEntry/AlreadyCanonical、original pair原子发布、successful attempt访问、唯一非Clone finalizer guard。控制记录使用typed结构，raw业务值不存slot；不建全局HashMap、第二MetadataCenter或payload控制标记。guard不因handle clone的Drop释放；成功/错误/取消/drop先attempt再request。真实requestId由调用方显式传入，graph invocationId独立，attemptId独立。REQ02 Operator注册name/version与主graph一致，只消费client-json，不capture；从主graph确定性派生single-node slice，准确保留schema/effects，通过pipeline_runtime::compile/Runtime::run执行，不直接调用Operator作为公开入口。RawEntry运行字段库并成对发布原始inverse/history；retry/followup显式AlreadyCanonical，保持Value及原pair不重新归一。

先写本范围红测再实现：真实request与invocation身份分离、公开runner真实执行、首次原pair发布、retry/followup不覆盖、两请求隔离、handle clone不finalize、guard success/error/drop/cancel终态释放顺序、成功attempt不读失败attempt。测试从公开边界贯穿，不使用假Operator成功替代真实field库。配置缺口导致field测试失败可记录依赖，但资源/runner不能靠协议fallback绕过；你不负责安装或接生产caller。

验证：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`；`git diff --check`。报告实际测试数量/失败与原错、修改文件、公共接口、SHA/tree和结果文档。完成iff：注册REQ02及公开SDK slice实际运行，typed原pair与释放consumer测试通过，明确待entry接线；不以类型定义/accessor算完成。不commit/merge/push/install/restart。

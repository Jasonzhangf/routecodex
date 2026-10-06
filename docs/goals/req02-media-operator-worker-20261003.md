# REQ02 Gemini canonical media 算子实施

启动条件：原field-carrier child终态、实际carrier代码和测试回执收取；父编排提供最新显式profile只读输入。复用本任务独占 `/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002` 的在途代码，全新 `codex exec --profile gcm`，不resume/fork旧session。你不是独自工作，其他worker负责gate、资源和入口；不覆盖或回滚别人的文件。

补充设计 `req02-profile-structure-media-design-20261003-r3` 已独立PASS。合同在父树 `docs/evidence/dagpipe/req02-profile-design-reviewed-20261003.md`；按该规范直接写媒体操作，不重新规划整个流水线。

允许：`operation_runner/operators/field_operator_gemini.rs`、`field_operator_library.rs`、`field_operator_profiles.rs`、`field_operator_library_tests.rs`（完整绝对目录由本worktree派生），本树 `docs/goals/req02-media-operator-result-20261003.md`。禁止mod.rs、resource/runner、manifest/matrix、hub/Server/kernel、外部REQ06 helper及运行环境。每命令显式本workdir，apply_patch绝对路径。

实现两个已声明media变换：inlineData.data → canonical messages[].content[].media.inline_data；mimeType → media.mime_type。保留精确值与存在性，provenance引用实际输出；不再在Inbound构造image_url data URI，不默认猜mime，不裁剪/decode原值；未知类型/未知兄弟字段opaque保留。只能按显式注册transform选择，不加入protocol/path/model推导fallback。carrier沿既有routecodex_chat_extension直接产出，完整保留工具自由文本/命令/MCP配对。

先新增实际失败用例再实现转绿：有效inline data+mime、缺mime、未知/非字符串值、inlineData兄弟字段、当前轮图片值。测试断言canonical media实际值及presence与opaque保留，不只断言manifest/provenance。保留所有既有field测试，不能删失败或把新功能改为总是opaque来过关。

验证分别取得原始退出码：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`；`git diff --check`。父提供显式profile后原容器配置缺口应被真实绑定消除；若仍失败，定位具体绑定/算子首次偏差并报告，不补猜测代码。每个测试结果绑定当前tree/profile哈希。

完成 iff：实际媒体输出符合规范，新增媒体成功/未知/缺字段用例通过，既有工具/carrier测试无回归，结果文档说明真实修改和剩余依赖。字段单测只是作者开发证据；公开runner/真实Server provider-bound image与终端响应黑盒由父候选继续验收，未取得前不宣称媒体或REQ02交付。不得commit/merge/push/install/restart。

# REQ02 field carrier与原始关联

独立设计`req02-consumer-design-20261003-r2`已PASS。独占工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002`，base3a72ad813，已引入六模块，已有32项测试21PASS/11FAIL。违规container_transform_id fallback已由父编排移除，对不可变参考profile文件diff为零，不得加回。你不是独自工作，资源runner、profile、gate由其它worker做；不改其文件。

只改本树operation_runner/operators/field_operator_{library,records,gemini,helpers,profiles,library_tests}.rs及本树docs/goals/req02-field-carrier-result-20261003.md。禁止mod.rs、REQ02 Operator/context、产品caller、其它节点、配置manifest、其他worktree。所有command显式本workdir，apply_patch绝对路径；Desktop child不Collab、不resume。

直接实现已审合同的唯一canonical root carrier：既有`messages`与`routecodex_chat_extension`。根扩展写入、读取、opaque records与inverse/provenance destination/path引用必须从字段库直接一致产出，不增事后rename adapter。注意工具声明内部的`extension`与客户端未知名为`extension`的业务字段不是根carrier，不能批量替换或删除；逐文件apply_patch。保留客户端与carrier同名冲突的原始值和逆向关联、unknown嵌套值、完整tool arguments/input/output/free-text；工具身份只能来自原请求声明/历史条目，不按model猜测，不解析工具参数。

为carrier一致性、已知/未知字段冲突、原请求namespace+function/custom+call_id及exec/apply_patch/MCP完整字符串保留补红绿测试。字段类型保持资源worker依赖的ClientRequestNormalization三个输出字段，不改变其公共shape。

配置worker将补显式请求transform，当前field树未组合其profile，因此OpenAI/Anthropic/Gemini原有11项配置红测允许仍失败；不得用protocol/path推导或fallback把它们变绿。本次carrier/引用测试必须通过，配置依赖单独报告。你可以只读 `/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002/docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml` 的实际候选配置核对映射，但不复制未审配置或编辑它。若该配置声明destination与handler实际输出不同，结果文件精确列出该绑定/输出首次偏离，不能擅自修改矩阵或猜新流程。

执行 `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture` 与 `git diff --check`，保留实际测试输出、数量和失败；落盘修改路径、验证、候选tree和剩余依赖。完成iff是直接canonical carrier与原始工具/opaque引用一致，定向新测试通过；不声称REQ02接线，不commit/merge/push/install/restart。

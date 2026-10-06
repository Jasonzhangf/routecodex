# REQ02 公开consumer黑盒测试实施

工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-blackbox-20261002`。你不是独自工作；三worker负责resource/media/gate，不能写其文件或回滚他人产物。全新GCM，不resume/fork，无父transcript。每command显式本workdir，apply_patch绝对路径。

唯一允许写：`v3/crates/routecodex-v3-server/tests/req02_public_normalization.rs`及本树`docs/goals/req02-public-consumer-result-20261003.md`。公共API只读参考resource树`v3/crates/routecodex-v3-runtime/src/operation_runner/{mod.rs,request_context_store.rs}`。真实field行为只读参考operators树field测试与父树已审consumer R2/media R3合同。禁止产品模块、注册表/profile/maps、其他测试、其他tree、运行时和全局配置。

测试对象：从外部crate调用公开`execute_v3_operation_runner_request_capture_client_json`，随后公开`execute_v3_operation_runner_request_normalize_losslessly`，以实际输入/输出和公开typed资源行为验收；不用内部normalizer、私有state、源码字符串或mock。成功结果是canonical真实值及对应原pair，不是测试命名/覆盖率。此harness证明SDK公开边界，不冒称真实HTTP/WS或生产工具回合。

至少用例：
1. Responses namespace function/custom声明、完整exec JSON字符串、多行apply_patch自由文本、MCP JSON参数和对应call_id/output历史，canonical和typed声明/history保持原义；unknown顶层/嵌套字段与client同名extension冲突无损。
2. Chat messages/tool_calls/tool result、tools function schema与unknown字段完整保持，输出不截断命令或参数。
3. Anthropic tool_use/tool_result的input JSON/result及id配对、cache_control与unknown兄弟字段无损。
4. Gemini inline_data/mime_type真实canonical值与presence，缺mime不猜，未知类型与兄弟字段opaque保留，当前轮图片值完整；Gemini functionCall/functionResponse声明/历史引用保持。
5. 同handle AlreadyCanonical retry/followup原canonical不重复处理，原pair保持；两request不同声明不串扰，handle clone不提前finalize，唯一guard终态后公开资源不可访问。精确内部非法origin组合失败不被包装成功。

输入要同时含业务内容和需要断言的非Chat/未知内容。assert通过公开API返回的业务数据或typed引用，不因参数业务值列举/解析来判断工具身份。field协议profile配置缺失或产物接口不足，报告精确失败，不能为测试加fallback/改产品或跳过。

目前本树只有main基线，父会在资源/media产物收取后提供只读候选依赖。先落盘有意义的完整测试并运行一次`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture`取得真实退出；缺公共API时记录dependency red，不冒称验证完成、不反复等待/重查。不修改依赖。`git diff --check`单独退出。

测试准备完成iff：真实公开consumer测试源落盘、命令原始回执与依赖红错保存、结果文档给出父组合后重跑命令；行为验收完成iff：父提供精确候选依赖后所有用例实际PASS且候选tree/profile/hash绑定。不可混淆两层。不commit/merge/push/install/restart。完成窄任务后退出，父接收并继续最终黑盒。

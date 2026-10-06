# REQ02 成功attempt逆向资源的真实响应consumer

目标：实现已审consumer R2合同中的ResponseProjectionView::from_successful_attempt，并令既有公开响应codec实际消费原始工具声明和成功attempt映射，证明function/custom、namespace/name与调用内容反向恢复；只类型/accessor不是完成。

独占树/branch：/Volumes/Intel/playground/routecodex/req02-successful-response-view-20261003，codex/req02-successful-response-view-20261003，fresh origin/main。你不是独自工作，其他worker负责execution_control/Runtime factory/Relay控制搬运、Inbound与图片helper；不能覆盖他人修改。全新codex exec --profile gcm；无resume/fork/父transcript/Collab。

依据父已审docs/design/v3-req02-cutover-consumer-contract.md：资源唯一定义为operation_runner/request_context_store.rs，原始pair一次发布，响应消费成功attempt的AttemptDeclarationMap，失败attempt不能成为映射源。标准投影producer由REQ06外部owner负责，本任务不修改producer或其独占文件。公共类型和profile由父提供只读依赖，编译测试使用实际公共公开边界。

允许写入：operation_runner/request_context_store.rs中仅新增成功view及必要typed读取；operation_runner/mod.rs中最小export；hub_v1/anthropic_codec/projection_context.rs中新增由typed view构造既有响应projection context的入口，不重建工具映射于governed payload；新增server/tests/req02_successful_response_view.rs；任务结果与笔记。如必要一个独立operation_runner/response_projection_view.rs允许，复用已有类型，不增第二store或registry。其余源码、maps/profile/graph、Runtime实际caller、Server、REQ06及Provider只读。

固定操作：读取request原pair与指定successful attempt→通过declaration_record_id关联实际emitted identity与原始ToolDeclarationReference→构造既有codec需要的typed inverse context→调用既有公开JSON/SSE响应projector。原请求kind/name/namespace从原声明取；provider身份只从实际attempt取；禁止按模型名/名称分隔符猜原kind或namespace，不遍历schema/参数来识别工具。保留ID、custom自由文本、exec字符串、MCP参数完整；没有映射的未触及响应按原合同透传，不添加业务拒绝、fallback或成功包装。控制资源不承载业务metadata、reasoning字段、schema、工具参数或结果。新API不得复制完整请求以兼容旧factory。已有metadata/reasoning业务投影仍归原codec，说明最小集成方式，不能为了方便静默丢失。

设计边界：这是R2已准入的必要consumer/helper，不迁移整条响应图。先读既有公开codec的精确签名和实际形状，选同一个已存在JSON及SSE projector贯穿公开消费，不新写第二响应重写器。若某公共类型不能无猜测关联，落盘具体缺字段/确切first divergence及最小拟改，不扩充虚构映射规则。真实Runtime success调用接线由父在REQ06 producer依赖齐备后完成，不修改另worker正在写的responses_relay_runtime_inner.rs。

测试条件：先公开test复现API缺失/旧请求推导不能反映成功attempt，编译红与行为红分开。运行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_view -- --nocapture；案例覆盖两请求同provider名字不同原kind/namespace隔离、同请求失败attempt后成功attempt重编码、原namespace缺省/null/string、function及custom自由文本、完整exec/MCP JSON、call_id不变、JSON及SSE实际输出。再runtime --lib operation_runner -- --nocapture、--lib anthropic_codec -- --nocapture，独立日志/退出码；git diff --check exit0。不能以私有状态断言、200或只生成工具调用称完整工具回合，父仍有HTTP/WS与两模型真实工具验收。

完成iff：typed view与既有公开响应codec确实消费成功attempt并反向恢复原语义，上述公开回归和受影响开发测试exit0，源码/测试/profile哈希与红绿原始退出码写入docs/goals/req02-successful-response-view-result-20261003.md，然后退出。保留旧factory仅用于未迁移caller时明确列出，父接线后必须消融，不能声称本任务完成整节点。无commit/merge/push/install/restart，不动4444。

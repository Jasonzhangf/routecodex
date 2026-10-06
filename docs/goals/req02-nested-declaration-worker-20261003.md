# REQ02 namespace 子工具关联缺口

独占fresh main75cab8267工作树 /Volumes/Intel/playground/routecodex/req02-nested-declarations-20261003。你不是独自工作；namespace presence任务已给出通过产物，另一worker仅负责公开测试，禁止覆盖其他人。父提供组合候选：absence/null区别已修、原公开5PASS、新presence2PASS、operation_runner51PASS。源与profile依赖只读，除下面明确写范围。

已证实的红：父公开req02_tool_shapes测试3PASS/1FAIL，exit101，失败为missing typed declaration for request.tools[0].tools[0]。真实输入来自Codex标准Responses namespace声明：type=namespace、name=functions或mcp__demo__、tools内function/custom；同名工具在不同namespace可有不同schema。唯一首次偏差process_openai_like_tool只记录外层namespace容器，不记录子声明，history已有namespace但inverse无法找到对应原声明。

所有前置设计/owner来自父树docs/design/v3-req02-cutover-consumer-contract.md及field-profile-admission.md，R2/R3设计receipt已PASS，复用不要重审整个库。原错误日志仅父树.execution/tool-shapes-parent-r1.log，状态仅父docs/goals/dagpipe-req02-cutover-notes-20261002.md；禁止搜索整个playground、其他JSON日志或推测是否别人已写你的任务。直接读本树library的process_tools/process_openai_like_tool/push_tool_declaration与提供的公开测试后执行。

唯一可写：v3/crates/routecodex-v3-runtime/src/operation_runner/operators/field_operator_library.rs中现有tool_declaration_transform处理点及必要私有helper；新v3/crates/routecodex-v3-server/tests/req02_nested_declarations.rs；本树docs/goals/req02-nested-declarations-result-20261003.md。不写records（presence修复只读）、profiles、maps、graph、注册表或原测试；不改其他节点/真实caller/响应，不安装重启或提交。

修复目标：现有注册的tool_declaration_transform算子一次遍历声明容器，保持原始业务工具列表完全等价；保留外层记录，给真实function/custom子声明建立typed原身份+准确source_path+原始opaque记录引用。子声明namespace依标准容器name关联，不凭模型/工具名猜，不解析参数schema内容来判断工具身份；schema、free-text、未知sibling及provider payload均不得进入typed资源。不引入新的协议分支、第二归一化、跨节点shortcut或独立扫描流。未声明、显式null、显式namespace值必须区分；未知声明按现有opaque契约保留，不新增业务拒绝或猜测修复。无需新增配置抽象；若必须改变注册合同先报告具体缺口，不擅自放宽gate。

测试：先单独运行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture，真实3PASS/1FAIL为红。新公开测试覆盖两容器同名不同schema/function/custom、完整参数与自由文本/结果配对、unknown siblings和明确namespace presence。修改后分别运行该测试、--test req02_nested_declarations、--test req02_namespace_presence、--test req02_public_normalization；再同wrapper -p routecodex-v3-runtime --lib operation_runner -- --nocapture。每命令单独redirect日志，检查真实exit，不tail管道不后续命令掩盖。

完成iff：缺口最小修正、公开行为红绿、所有受影响公开用例实际通过、开发测试结果、精确library/test/profile哈希和结果文件。失败立即保留原错/首次偏差，不能改已有断言或扩范围。只证明SDK公开行为，不称HTTP/WS或工具实际执行完成。结果落盘后退出，不重复audit或等待，不commit/merge/push/install/restart。父验收与后续caller接线独立完成。

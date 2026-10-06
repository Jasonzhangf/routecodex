# REQ02 算子切片实施合同

你独占 `/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002`，从main `3a72ad813`建立。你不是独自工作，不得改其他worktree、旧候选、main或其他节点。任务只实现REQ02，父编排负责下游契约适配、真实caller、review与交付。

用户明确要求：Desktop独立child不执行Collab规则。本任务是独立codex exec child，只通过stdout/本任务结果文档回父编排。禁止collab context/注册/身份恢复/发送消息/访问canonical main来取身份，禁止等待master。产品能力或schema差异直接先写允许的结果文档，不为辅助协作改路线，不研究playground资源列表。

先读本工作树AGENTS、现有request graph/profile/lifecycle中normalize_request_losslessly的合同。复用旧候选commit `768a9565c` 的REQ02算子、字段算子库与request_context_store的有效实现；它们不是接线验收。已记录设计准入来源为design-only SHA `48b9b03f025aa497ad88138103d38a970f3628b2`，旧候选commit `93ee5c29b` 的任务文档记录其design-only PASS。这仅允许复用相同合同，新的schema或owner变更先落盘交父编排review，不自称PASS。

唯一允许写入：本工作树 `v3/crates/routecodex-v3-runtime/src/operation_runner/` 中REQ02所需的字段算子、normalize算子、request上下文、注册与测试，以及本工作树 `docs/goals/req02-operator-result-20261002.md`。禁止REQ03—09/响应/错误算子、hub/kernel/server代码、graph/profile设计变更。确需设计差异先报父编排，不绕过。

具体工作：

1. 逐文件核对后用apply_patch携入唯一REQ02实现，不整批cherry-pick旧分支，不用脚本语义替换。保留本工作树main已有REQ01；REQ02入口直接消费已捕获的client-json，不再运行第二个capture，不复制整段request图的registry。
2. Runtime按现有项目graph导出capture后的REQ02单节点切片，注册normalize_request_losslessly@1与其必需资源，以显式typed origin、payload form、project/request identity运行。不能靠messages字段猜already-canonical，不能为测试改接口协议。
3. 统一字段walker只使用manifest的operator@version、typed params、destination/transform_id；未知原始数据完整保留，inverse资源只承载关联，工具参数和结果不做业务解析。只实现已声明REQ02，工具/provider标准投影归REQ06。
4. 提供明确可供父编排接线的公开typed入口/结果：canonical data以及request-scoped inverse/history context；原始请求关联在同一次request identity内稳定，retry/internal-followup不能覆盖。不要把控制字段塞进payload，不加全局request-map或新MetadataCenter副本。
5. 范围内重复注册/切片构造收敛唯一入口；错误返回OperationRunnerError到既有Error owner，不success-wrap。finalizer按已声明release边界提供接口和测试，但没有真实终端接线不得宣称资源闭环。
6. 写最小consumer测试覆盖四种entry protocol、namespace/function/custom声明与历史调用/结果、完整字符串参数、嵌套未知字段/图片当前轮保留、typed reentry/pair保护及释放。仅证明归一化边界，不能声称unknown字段已到provider；下游验收由父编排负责。
7. 执行 `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`、目标rustfmt及git diff --check。记录确切通过/失败数与输入版本，首次失败先修本范围，不改断言、不skip。

完成iff：REQ02可执行算子及typed公共consumer在本工作树编译运行、定向测试通过，源码不包含后续节点、实现与当前profile合同匹配，并落盘文件列表、具体API、测试命令结果、仍缺的真实caller/下游适配/终端/E2E。不commit、不merge、不push、不安装、不重启。只返回可集成diff和证据；不能用未接线实现声称节点交付完成。

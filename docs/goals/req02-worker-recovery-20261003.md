# REQ02 在途产物恢复合同

父编排已核对旧执行句柄均missing、OS进程命令无三个本任务worktree的child，原JSON日志无完成回执。已有源码保留。三个新任务均全新GCM，不resume/fork，不传父transcript。你不是独自工作，其他owner并发；不得覆盖、回滚或编辑他人范围。使用下列分工对应原合同，禁止重审全仓库。

## Resource recovery

工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`。
先读父树`docs/goals/req02-resource-runner-correction-20261003.md`和当前resource代码。
允许写：`v3/crates/routecodex-v3-runtime/src/operation_runner/{mod.rs,request_context_store.rs,operators/mod.rs,operators/normalize_request_losslessly.rs}`和本树`docs/goals/req02-resource-runner-correction-result-20261003.md`。field/profile/maps/graph只读；Server/kernel/其他节点/其他tree禁止。

已证实首次偏差：`release_request_scope`先清request及terminated，后attempt；二次lock在poison上panic。8PASS只断言终态不可访问，未证实先attempt后request和poison恢复。修唯一释放owner：单次lock；持锁先清successful/failed attempt，再清original pair，然后标终态；poison需要保留显式可观察错误且清理仍执行，Drop不panic、不吞错、不假成功。复用现有错误可观测方式或最小typed终态错误，不建第二日志/状态框架。explicit finalize可返回真实Result，Drop消费并显式记录；同步实际调用点和测试。补poison红测与顺序辅助断言，公开handle终态黑盒仍必须通过。

还需：禁止不同RawEntry再次发布后把新canonical与旧pair拼接；同请求scope仅一次RawEntry，重入通过AlreadyCanonical，属于内部生命周期错误不是业务校验。核对公开函数两个handle真正指向同一scope而不是只比较requestId。attempt identity字段须相互一致；不要扩大为业务schema校验。AttemptDeclarationMap应可引用实际发出的工具名称/类型与原声明关联，业务schema/参数/结果不塞control资源；若接口不足明确报告具体缺口。

测试分别执行并取得真实退出：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner::req02_resource_runner_tests -- --nocapture`；全operation_runner命令按原合同单独执行，已有配置FAIL如实报告；`git diff --check`。禁止管道tail遮蔽exit，不将8PASS当整体验收。完成iff：修复已证实顺序/poison问题、SDK单节点/reentry保持、真实开发测试通过，结果落盘含输入hash/真实退出及consumer待接边。

## Media recovery

工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002`。
先读父树`docs/goals/req02-media-operator-worker-20261003.md`。允许写其原四field文件及结果文档，profile等依赖只读。
已有红测33PASS/4FAIL，首次实现36PASS/1FAIL；最新文件已补unknown inlineData siblings但未独立重验。直接检查当前产物、定位剩余实际偏差并转绿，不重复规划，不删除失败测试，不把新增media总转opaque。保留精确canonical值/presence、未知字段及工具完整文本。验证原合同完整operation_runner命令和diff-check，各自真实退出码，禁止打印后丢弃test退出。完成iff：新增media实际输出及原工具/carrier全部开发测试PASS，结果文档落盘含原红错/输入hash/结果；公开Server黑盒仍由父验收。

## Structural gate recovery

工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-config-gate-20261003`。
先读父树`docs/goals/req02-structural-gate-worker-20261003.md`。允许仅两脚本和本树结果文档。现有差异主要是旧optional/方向实现，结构binding即使consumers为空仍需统一验证；不用继续查git历史或find其他tree。
直接新增结构binding红fixture，再改唯一verifier。精确inventory、registered operator/version、direction、typed参数、destination/shape/semantics/transform与ordinary consumer合同都保留。negative helper及mutation循环必须assert非零退出+匹配诊断。分别运行`npm run verify:v3-operation-runner-dagpipe`、`npm run test:v3-operation-runner-red-fixtures`、`git diff --check`并保存真实exit0。完成iff：正负公开CLI用例通过且结果文档含hash/原错/退出，不能弱化gate或修改profile造绿。

## 所有worker共同交付

每命令显式自己的workdir，apply_patch绝对路径。不得commit/merge/push/install/restart；本子任务不是REQ02生产交付。实现和作者验证完成即写结果文档并退出，不持续重复未变检查。临时日志放自己的任务目录，结果说明资源归属，父收原始回执后统一保留/回收。

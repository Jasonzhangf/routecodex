# REQ02 结构 binding 编译准入实施

启动条件：原 config-gate R1 child 已终态且其实际diff/原始测试回执已收取。父编排提供已审profile草稿和唯一matrix依赖。复用本任务独占 `/Volumes/Intel/playground/routecodex/dagpipe-req02-config-gate-20261003` 的在途改动；不恢复旧session，必须全新 `codex exec --profile gcm`。你不是独自工作，字段和资源由其他worker负责，不覆盖或回滚其文件。

准入：consumer R2已审optional(string)/逐方向合同；补充设计 `req02-profile-structure-media-design-20261003-r3` 已独立PASS。精确合同及回执在父树 `docs/evidence/dagpipe/req02-profile-design-reviewed-20261003.md` 与 `req02-profile-design-review-receipt-20261003.md`。无需重新全链审计。

只写 `v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs`、`v3/scripts/tests/v3-operation-runner-red-fixtures.mjs`、本树 `docs/goals/req02-structural-gate-result-20261003.md`。profile/matrix/maps是父编排提供的只读输入；不得写Rust、active config、Server、全局Skill或其他worktree。每命令明确本workdir，apply_patch绝对路径。

实现：在唯一verifier统一检查所有显式direction_bindings，包括structure_only+parent_owned且consumers为空的行。结构算子组装容器，不新增叶子consumer；正常行仍需本方向consumer或union scalar consumer匹配。绑定自己的operator@version/direction/typed参数必须有效，source必须属于同协议唯一inventory的精确字段，destination/shape/semantics/transform必须满足声明；禁止prefix匹配、未知path例外、假consumer或弱化既有mandatory checks。保留原R2 optional及未迁移方向row参数合同。只修compile规则，不新增业务请求校验。

先新增失败fixture，再实现转绿。可重复公开CLI黑盒：`npm run verify:v3-operation-runner-dagpipe` 必须exit0；`npm run test:v3-operation-runner-red-fixtures` 必须exit0且valid-candidate/结构合法绑定通过，缺参数/未知算子/错方向/虚构source/重复owner/opaque参数普通消费等负例均以非零退出及对应诊断失败。新增结构非法binding不可因consumers为空跳过。现有新expectVerifierFailure helper与mutation循环仅匹配诊断文字，需同时断言实际status非零；不能exit0但打印错误词也判负例成功。两条命令分别取得真实exit_code，不能用后续命令遮蔽。`git diff --check` 单独exit0。

完成 iff：组合profile+inventory+唯一verifier的上述CLI行为全部通过，原P1消失，新增正反用例确实运行，保存完整命令/输入hash/结果/原错与修改文件。不是REQ02 runtime交付；不commit/merge/push/install/restart，不claim实际工具或Server验收。

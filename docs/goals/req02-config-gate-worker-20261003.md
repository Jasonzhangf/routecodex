# REQ02 配置compile gate单一合同

开始条件：增量consumer/gate设计独立PASS后由父编排启动。独占工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-config-gate-20261003`，base3a72ad813。你不是独自工作，不覆盖别人修改，每command显式本workdir、patch用绝对路径。Desktop child不执行Collab，不resume。

只读合同 `/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002/docs/design/v3-req02-cutover-consumer-contract.md` 的“请求方向配置与compile gate的同一合同”。已知checkTypedParams把optional(string)当必填；direction_bindings循环用外层profile套所有方向。不要重新全仓库定位。

唯一允许写：`v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs`、`v3/scripts/tests/v3-operation-runner-red-fixtures.mjs`、本树docs/goals/req02-config-gate-result-20261003.md。不修改profile/schema、Rust、架构map、其它gates或外部REQ06。

先红后绿实现：optional(string)缺省合法，有值严格非空string；required参数仍必需。每个显式direction binding只由其自身operator@version+direction的typed profile验证；不要求未迁移方向新增binding，未覆盖方向用其现有row参数按该方向profile验证；direction_bindings仅作为配置容器不作为operator参数传入。保留raw inventory授权、consumer绑定一致性、唯一owner、未知operator/direction和必需字段全部门禁。不以整层skip、删fixture、放宽所有类型或重写测试期望换绿。

fixtures必须覆盖：optional缺省PASS、合法string PASS、number/object/empty/blank FAIL、required缺失FAIL、仅请求方向binding且其它方向仍合法PASS、两方向各自schema验证PASS、错direction/operator/source/必需字段FAIL。保留所有已有负例。先跑变更fixture得到原实现红证据，修唯一verifier后重跑 `npm run verify:v3-operation-runner-dagpipe`、`npm run test:v3-operation-runner-red-fixtures`、`git diff --check`，记录实际结果和证据位置。完成iff为新旧fixture全部通过且保留原schema边界；不commit/merge/push/install/restart。

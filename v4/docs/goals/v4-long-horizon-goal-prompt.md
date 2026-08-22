/goal
目标：V4 长线完整落地——从当前 foundation（资源 49/49 anchored、Relay/
Continuation 垂直切片、base-node/edge/control/error 已冻结、13 模块注册）推进到
V4 runtime 可运行、行为等价 V3、可逐步接管的完整目标态：三链 node-graph 机器
锁、Cordis NodeContainer + 插件框架、标准插件库、Config Compiler 完整化与冻结、
Admin API + WebUI 可视化，全部资源/函数/主链/验证门禁同步且 DSH review PASS。

说明：本任务是长线分阶段目标，不是单 slice。每个 Phase 独立验收、独立提交、
独立 DSH review；只有前一 Phase 语义 PASS 后才进入下一 Phase。本提示词不需要
再写新的提示词，各 Phase 按下方实现文档执行；执行中发现范围/owner/边界偏差时
先写 plan 偏差记录，不静默改冻结基线。

实现文档（按 Phase 引用）：
- Phase 0：v4/docs/goals/v4-resource-anchor-complete-plan.md（收口当前 slice）
- Phase 1：v4/docs/architecture/v4-standard-nodes-and-node-graph.md +
  v4/contracts/node-graph.contract.json + v4/contracts/skeleton-plan.contract.json
- Phase 2/4/5：v4/docs/architecture/v4-cordis-node-plugin-architecture.md +
  v4/docs/goals/v4-cordis-plugin-framework-and-webui-plan.md
- Phase 3：v4/docs/goals/v4-config-compiler-plan.md
- Phase 6：v4/docs/architecture/v4-pipeline-abstraction-model.md +
  v4/docs/goals/v4-foundation-framework-plan.md（Phase 2-4 迁移准则）

执行规范（全局硬护栏，任何 Phase 生效）：
- P0 禁止脚本批量语义替换：逐文件读取核实上下文后用 apply_patch hunk，禁
  Python/Node/Perl/sed/awk/shell loop/正则批量替换；formatter/canonical
  generator 只生成其声明的机械产物。
- 控制/诊断/错误语义只走 typed carrier / MetadataCenter / Error 链，绝不进
  provider/client 正常 payload；payload 不得重建控制状态；禁 fallback、禁
  silent strip、禁请求侧 cleanup、禁 handler/SSE/outbound 补偿。
- 冻结 crate（base-node/edge/control/error active artifact）零修改；确需扩展先
  报 Jason 批准 re-freeze，或按实现证据迁移 owner 并记录偏差。
- 新模块走 active-link（build-consumer/test-consumer），禁 frozen 源码 path
  dep；Rust 真源优先，TS 只留薄壳/桥接/IO/诊断。
- 先红后绿：每个不变量先落负类红测确认红，再改唯一真源转绿；绿化后跑旧样本/
  同入口复测，禁止口头验证。
- 只动 v4/ + verify 脚本 + package.json + CI + note/MEMORY；不裹 V3 dirty
  worktree；commit 显式列路径。
- 每次改动后重跑受影响验证与全局安装/重启/在线验证，再 DSH review；DSH 固定
  opencode-go/deepseek-v4-flash，语义 PASS（无 P0/P1、无“修复后再审”）才交付。

Phase 0 —— 收口当前资源锚定 slice（已基本完成，剩生命周期与门禁接线）
目标：49/49 anchored 双源一致已绿；修复 appsdk verify/admission
（ARTIFACT_MODULE_SET_MISMATCH），注册 v4_debug/router/provider/server_l2_regression
四个 gate，verify:v4-foundation 10 -> 14 gates、verify:v4-foundation-red、
CI `v4-build` job（macos-14）经 V4 canonical `verify:ci` 覆盖 test-consumer 步骤，active-link frozen-consumer
registry 登记新 crate，全量验证矩阵绿后提交并 DSH PASS。
验证：resource gate 12/12 红自测 -> 各 crate L2 -> cargo workspace ->
test-consumer（全部模块）-> verify:v4-foundation -> verify:v4-foundation-red ->
appsdk verify v4 / appsdk verify --admission v4 -> gen/verify-index ->
DSH review PASS。
完成标准：appsdk 生命周期全绿；verification-map/package.json/CI 与 module
registry 一致；本 Phase 提交后 HEAD 可复现全绿；DSH 无 P0/P1 语义 PASS。

Phase 1 —— Node-graph 三链机器锁完整化
目标：node-graph.contract.json 从 design 收敛为 active：request/response/config
三链全部节点注册（request 7 / response 6 / config 5）+ registered_nodes 覆盖
全部已 anchored 资源 owner_node + 侧链（control/diagnostic/error）节点 +
skeleton-plan checkpoints 与 node-graph 三链编号一致；新增红测锁
“未注册节点引用资源 owner_node 必红”“checkpoint 与 chain 编号漂移必红”
“registered_nodes 漏覆盖已 anchored owner_node 必红”。
验证：先落红测 -> 修改 node-graph/registered_nodes/skeleton-plan ->
verify:v4-resource-binding + verify:v4-skeleton-topology + 新红测全绿 ->
verify:v4-foundation -> DSH review PASS。
完成标准：node-graph status=active；49/49 owner_node 全部命中机器目录；三链
编号、checkpoint、registered_nodes 三方一致有红测锁定；DSH 无 P0/P1。

Phase 2 —— Cordis NodeContainer + 插件框架落地
目标：按 cordis 架构实现 routecodex-v4-node-container / plugin-contract /
plugin-catalog / plugin-plan / plugin-manager / cordis-host / cordis-bridge /
skeleton-runtime（新模块），NodeContainer 由实际 Cordis Context/Fiber/Effect
承载，Rust 只执行编译出的 typed plan；NodePlugin 统一 operator/hook/control/
debug/snapshot/validator/observer 生命周期；顺序/依赖/选择组/资源权限机器可验证。
验证：node-plugin/node-container/plugin-catalog/plugin-management 合同
contract_bound -> Rust + Cordis host 实现 -> 每模块 L2 正反成对 + 红测
（tie/cycle/未注册算子/越权资源/候选失败不改 active/已发布失败不自动回滚）->
test-consumer -> verify:v4-foundation（新 gate）-> DSH review PASS。
完成标准：NodeContainer 非 Rust 仿制（黑盒观察真实 Cordis 生命周期）；编译
plan hash 与 graph/manifest 三方一致；Admin 能力面只读；DSH 无 P0/P1。

Phase 3 —— Config Compiler 完整化与冻结
目标：routecodex-v4-config 按 config-compiler-plan 达到独立 freeze 门槛：
authoring -> validate -> registry -> manifest 全链 typed、unknown field 拒绝、
deterministic manifest + SHA-256、secret 只允许 env/token_file handle 且不进
manifest、无 authoring 目录运行时扫描；完成 freeze 生命周期（begin-version ->
evidence/review/promotion/regression/compile/publish/protected）。
验证：config L2 >= 15 tests + 正反成对 -> test-consumer -> verify:v4-foundation
-> appsdk verify/admission -> freeze 记录绑定 source/artifact/API/scope hash ->
DSH review PASS。
完成标准：routecodex-v4-config 进入 frozen；active artifact 可被 runtime 消费；
无 path dep；DSH 无 P0/P1。

Phase 4 —— 标准插件库 + 逐节点 V3 行为迁移
目标：建立标准插件库（合同/控制/错误/诊断/协议/Chat Process/路由/Provider
类别，每插件有版本/owner/依赖/artifact+contract hash/独立回归），按 foundation
framework Phase 2-4 准则把 V3 已验证行为逐节点迁移为 V4 插件算子；provider
差异收敛为配置与 action operators；V4 核心 pipeline 无 provider-specific 分支；
旧算子 + 新算子同节点注册、manifest 选唯一 active，promotion 前 V3 行为不变。
验证：每迁移模块先 V3 对照样本 -> 红测 -> V4 实现 -> compat slice
unexplained_diff=0 -> 在线旧样本同入口复测 -> test-consumer ->
verify:v4-foundation -> DSH review PASS（每批独立）。
完成标准：六面 compat（request/response/error/streaming/lifecycle/audit）全部
unexplained_diff=0；迁移模块资源 anchored 双源一致；无 fallback/重复实现；
DSH 无 P0/P1。

Phase 5 —— Admin API + WebUI 可视化
目标：routecodex-v4-admin + routecodex-v4-webui：WebUI 可视化 Skeleton、节点
插件链、插件库、候选 diff、验证、发布与运行状态；UI 不拥有排序/权限/业务语义，
只从 Admin API/Inspector 重建；Admin API 只读投影 + 变更请求，不读 payload、
不存 secret。
验证：admin contract -> API 实现 -> WebUI -> 黑盒验证 UI 与 Manifest/active
hash 一致 -> 红测（UI 直接改 active、UI 读 payload、UI 存 secret 必红）->
verify:v4-foundation -> DSH review PASS。
完成标准：管理面只读投影闭环；服务端 Manifest/active hash 为真源；DSH 无 P0/P1。

Phase 6 —— V4 runtime 完整垂直切片 + V3 行为等价验证
目标：V4 runtime（六链 request/response/error/config/lifecycle/diagnostic）以
Cordis 插件框架运行完整垂直切片，与 V3 同入口真实样本行为等价，可逐步接管；
性能基线不劣化（Phase 4 准则：重复转换/序列化/非必要 clone 有测量证据）。
验证：完整切片测试 -> V3/V4 对照矩阵（真实样本 replay，unexplained_diff=0）
-> 性能对比 -> test-consumer 全量 -> verify:v4-foundation（全 gate）-> 全局
安装/聚合重启/在线验证 -> DSH review PASS。
完成标准：V4 完整垂直切片可运行且行为等价 V3；接管/切换按 Jason 另行授权，
不在本 goal 自动执行；DSH 无 P0/P1。

验证总纲（每 Phase 套用）：
- 定向测试 + 红测（正反成对）-> cargo test --workspace --manifest-path
  Cargo.toml -> build-link test-consumer（全部模块）-> verify:v4-foundation
  -> verify:v4-foundation-red -> appsdk verify v4 / appsdk verify --admission v4
  -> gen/verify-index -> DSH review（opencode-go/deepseek-v4-flash）语义 PASS。
- 涉及 runtime 行为/配置的 Phase，增加全局安装、聚合 restart（仅
  `routecodex restart` exec 原位置重启）、在线旧样本复测。

完成标准（长线总闸）：
- Phase 0-6 全部语义 PASS，gate 全绿，无遗留 P0/P1；
- 49/49 资源 + 全部新模块 contract_bound/anchored 双源一致；三链 node-graph
  active；插件框架与标准插件库落地；config frozen；Admin/WebUI 只读闭环；
  V4 垂直切片行为等价 V3 且可接管（接管动作另行授权）；
- 冻结基线未被静默修改，所有 owner/范围偏差有 plan 记录与证据；
- 每个 Phase 的 DSH review 无 P0/P1、无“修复后再审”。

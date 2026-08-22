/goal
目标：V4 资源注册表全锚定：49/49 资源 binding_status=anchored，24 条 design
资源补齐真实 owner（新建 routecodex-v4-debug / routecodex-v4-router /
routecodex-v4-provider / routecodex-v4-server，扩展 runtime/config），全部
资源有 owner crate + owner node + owner symbols + 机器 gate；构建门禁统一，
workspace 门禁不遗漏任何模块。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
v4/docs/goals/v4-resource-anchor-complete-plan.md

执行规范：
- 先红后绿：每条资源先落负类红测（缺 owner / 缺 symbol / owner crate 不存在 /
  node 未注册 / 越权 writer / 控制或诊断字段进 payload / 双源漂移），确认红再实现。
- 资源锚定禁止自证：nodeIds 只来自 node-graph 三链 + skeleton checkpoints +
  registered_nodes，不得把 resource.owner_node 并入校验集合。
- 控制面只走 typed carrier / MetadataCenter / Error 链，payload 不得重建控制
  状态；禁 fallback、禁 silent strip、禁请求侧 cleanup。
- 冻结 crate 不静默修改：base-node / edge / control / error active artifact 不得
  改写；确需 control 扩展时先报 Jason 批准 re-freeze，或按实现证据迁移 owner 并
  记录偏差。
- 新 crate 走 active-link 模式（build-consumer/test-consumer），禁 frozen 源码
  path dep；只动 v4/ + verify 脚本 + package.json + CI，不碰 V3；commit 显式列路径。

验证：
- 定向测试（每 crate L2 正反成对 + 红测）-> cargo test --workspace ->
  build-link test-consumer（全部模块）-> verify:v4-foundation（含资源全锚定 gate）
  -> verify:v4-foundation-red -> appsdk verify --admission v4 -> gen/verify-index
  -> DSH review（opencode-go/deepseek-v4-flash）语义 PASS。

完成标准：
- 49/49 资源 anchored 且 .appsdk 双源一致，gate 校验符号/节点/模块真实存在；
- 新 crate 全部 contract_bound、L2 回归挂入 CI，workspace 门禁不遗漏模块；
- 冻结基线未被静默修改，control 决策点有批准或证据记录；
- 先红后绿证据在案，全量验证矩阵绿；
- DSH review 无 P0/P1 的语义 PASS。

# RouteCodex 路由入口（Project Entry）

## 索引概要
- L1-L7 `purpose`：入口用途与使用方式。
- L9-L22 `route-table`：按任务类型分发。
- L24-L30 `dispatch-order`：标准分发顺序。
- L32-L37 `update-rule`：更新策略。

## 目标
把项目级 AGENTS 保持为“短入口”，复杂规则全部路由到细节文档或 skill。
先读总纲与闭环合同，再进细节路由；路由只负责分发，不负责定义完成标准。

## 分类分发表
1. 总纲/闭环合同 → `05-foundation-contract.md`
2. 架构/语义真源边界 → `10-runtime-ssot-routing.md`
3. 构建/测试/发布 → `20-build-test-release-routing.md`
4. servertool 生命周期（stopless/followup） → `30-servertool-lifecycle-routing.md`
5. BD/记忆/任务轨迹 → `40-task-memory-routing.md`
6. 用户纠偏（全局） → `~/.codex/docs/agent-routing/10-alignment-and-profile.md`

## 写死的前置查询（必须执行）

每个任务一律先执行以下查询，且对目标功能不允许跳过：  

1. 读总纲：`docs/agent-routing/05-foundation-contract.md`  
2. 定位功能：在 `docs/architecture/function-map.yml` 用 `feature_id` 查 owner 与允许路径。  
3. 锁主线：在 `docs/architecture/mainline-call-map.yml` 用 `feature_id` 查主线边与 caller/callee。  
4. 验收：在 `docs/architecture/verification-map.yml` 查最小验证栈。
5. 查 `docs/architecture/wiki/mainline-call-graph.md`（或该功能对应 wiki 页面）确认节点闭环。  

若以上任一步无法 1-2 次定位到“唯一 owner/唯一主线边”，必须先补 map/contract，再修改实现。

## 分发顺序
1. 先读 `05-foundation-contract.md`，锁完成合同与证据门槛。
2. 再按任务目标判类。
3. 读对应路由文档（本目录）。
4. 再跳转目标文档/skill执行。
5. 若跨类别，按“主路径优先，辅路径补充”并行使用。

## 更新策略
- 新规则先决定归属：入口 / 路由文档 / skill。
- 入口文件不写长流程。
- 索引概要必须随内容变更同步更新。

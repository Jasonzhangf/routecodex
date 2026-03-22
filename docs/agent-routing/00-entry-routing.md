# RouteCodex 路由入口（Project Entry）

## 索引概要
- L1-L7 `purpose`：入口用途与使用方式。
- L9-L22 `route-table`：按任务类型分发。
- L24-L30 `dispatch-order`：标准分发顺序。
- L32-L37 `update-rule`：更新策略。

## 目标
把项目级 AGENTS 保持为“短入口”，复杂规则全部路由到细节文档或 skill。

## 分类分发表
1. 架构/语义真源边界 → `10-runtime-ssot-routing.md`
2. 构建/测试/发布 → `20-build-test-release-routing.md`
3. servertool 生命周期（sm/heartbeat/clock） → `30-servertool-lifecycle-routing.md`
4. BD/记忆/任务轨迹 → `40-task-memory-routing.md`
5. 用户纠偏（全局） → `~/.codex/docs/agent-routing/10-alignment-and-profile.md`

## 分发顺序
1. 先按任务目标判类。
2. 读对应路由文档（本目录）。
3. 再跳转目标文档/skill执行。
4. 若跨类别，按“主路径优先，辅路径补充”并行使用。

## 更新策略
- 新规则先决定归属：入口 / 路由文档 / skill。
- 入口文件不写长流程。
- 索引概要必须随内容变更同步更新。

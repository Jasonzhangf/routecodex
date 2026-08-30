# Goal prompt: V3 SSE / client-provider decoupling full audit and repair

```text
/goal
目标：审计并修复 RouteCodex 全项目的 SSE、HTTP client connection、Direct 全缓冲与 Relay 流式链路，使 SSE/client transport 与 provider 业务语义彻底解耦；让所有错误严格进入统一 ErrorErr01 -> ErrorErr02 -> ErrorErr03 -> ErrorErr04 -> ErrorErr05 -> ErrorErr06 错误链；完成真实运行验证后精确合并到 main、commit 并 push。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词；直接按实现文档执行。

实现文档：
docs/goals/v3-sse-client-provider-decoupling-full-audit-plan.md

执行规范：
- 先读 AGENTS.md、USER.md、实现文档、项目 routing、resource/function/mainline/verification maps、wiki/manifest、相关 SSE/error-chain skill/reference 与 .agent-collab/PROTOCOL.md；先刷新 run/claim/dirty-main 视图，确认唯一 owner、allowed/forbidden paths、相邻调用边和验证 gate，再读源码、改代码。
- 先只读审计并写详细报告：docs/goals/v3-sse-client-provider-decoupling-full-audit-report.md。报告必须包含生命周期图、入口/错误/连接矩阵、Direct/Relay 差异边界、逐文件逐符号证据、首次偏离节点、唯一 owner、根因、最小修复、正反测试、live 证据、剩余风险和明确未修复项；不得把 design、binding_pending、局部测试通过或 health 当成完成。
- SSE 只处理 bytes/line/field/data/frame/limits/idle/backpressure/disconnect/EOF；event: 和 [DONE] 不得产生 provider/client 语义。provider JSON codec 是 terminal/failure/tool/continuation/usage/incomplete 的唯一语义 owner；Direct 与 Relay 只能消费同一 typed outcome，不得在 runtime、kernel、server、handler、SSE 或 outbound 重复解析/补偿。
- Direct 全缓冲只改变交付策略，不得形成第二条错误路径。first-frame commit 前允许统一 Error04/05 决策重选；commit 后不得 reroute/rebuild/rewrite/伪造成成功或 bare EOF。client disconnect/abort/timeout/backpressure/EOF/body error 必须作为 typed transport/client source 进入错误链或规定的 health side-channel；不得静默吞错。
- 所有 provider、transport、codec、body、connection、projection 错误都必须沿 ErrorErr01 -> ErrorErr06 单向流转；server/SSE/client projection 只能消费已确定的 Error05/06，不能重新分类、创建第二错误中心或绕过路由决策。
- 禁止 fallback、silent strip、请求侧 cleanup、payload 裁剪、metadata/debug/control 泄漏、provider-specific 通用层分支、恢复已删除实现、旁路、死代码保留和为过 gate 增加别名。跨文件或同文件多位置语义修改逐文件核实后用 apply_patch；不得用脚本批量替换。保留其他 worker dirty 改动，不使用 reset/checkout/stash/broad cleanup。
- 每个确认 finding 先固化最小 failing red test/真实样本，再修改唯一 owner；补齐正反测试、maps、manifest、wiki/HTML、test design、CI/build wiring。生成物只能由 canonical generator 生成；实现、架构边界自检、验证和运行证据完成前不得 review。
- 先在声明的 owner worktree 完成，再回当前 main 做精确集成验证。按项目规则执行全局安装，只用 `routecodex restart` 聚合重启，检查全部配置成员端口 `/health`，用同入口真实旧样本分别 replay Direct 与 Relay；记录 installed version、requestId、port、sample path、raw provider request/response、client projection 和 Error01-06 trace。
- 前置验证全部通过后，只使用默认 AGY Review MCP 做只读 review；P0/P1、坏 JSON、超时、无明确 PASS 均视为失败，修复后新建 review。review 后任何代码/测试/build/config/runtime 变化都使旧证据失效，必须重跑受影响闭环。
- review PASS 后只精确 stage 本任务 change set；提交前检查 `git diff --cached --stat` 与 `git diff --cached --name-status`，不得带入其他 worker 或运行产物；确认本地 HEAD 与待推送 commit 一致后合并/提交并 push 到 main。任何 blocker 必须显式停在报告中，不得改写为成功。

验证：
- 定向 red -> green、正反生命周期测试、Direct/Relay parity、transport/codec/error/client projection 测试。
- Rust/TS workspace build/test、资源/function/mainline/manifest/wiki/CI/架构 gates、diff-check；串行执行共享运行资源的测试并记录原因。
- 全局安装、`routecodex restart`、所有配置端口 `/health`、Direct/Relay 同入口真实 replay，取得运行版本与改动一致的证据。
- AGY Review 明确 PASS；若 review 后有任何修改，重新执行受影响验证、安装、重启、live replay 和 review。

完成标准：
- 详细审计报告已完成并逐项闭合或明确记录 blocker/延期，不遗漏 SSE、client connection、Direct、Relay、provider codec、错误链和 projection 入口。
- SSE/client transport 与 provider 语义物理解耦；Direct/Relay 共享 typed semantic contract、commit policy 和 Error01-06 链；没有 fallback、silent EOF、错误吞咽、重复错误中心或 payload/control 泄漏。
- 架构 gate、构建、安装、重启、全部 health、Direct/Relay live replay 和 AGY Review 全部有可复核证据。
- change set 已精确合并到 main，commit 已创建并 push；最终报告写明 commit、远端状态、验证命令、review verdict 和剩余风险。
```

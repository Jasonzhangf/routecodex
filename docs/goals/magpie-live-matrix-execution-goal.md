# 本轮执行目标：Magpie live mock-provider 基线矩阵

此文件记录 2026-10-12 的基线设施子任务，不作为当前全节点重构的并发或权限安排。历史结果继续保留；未核实的集成与清理项不自动改为完成。当前全节点实现由 REQ02 owner 推进。

## 执行身份与目标

当前 Codex goal 执行者是本轮编排者。按 `codex-orchestrator` 派独立 worker、验收、解阻、审查和交付，不接管既有 REQ02 重构。

在架构不变的条件下，实现四协议 fixture mock provider 与真实 RCC HTTP matrix runner，提取固定 Magpie source 的代表性案例，跑出完整基线并保留 runtime 缺口。

总体计划：`magpie-protocol-matrix-overall-plan.md`。本轮不修改 runtime operator，不推进 P2/P3 实现，不安装或重启生产 daemon，不修改真实 provider/凭据/生产配置。

后续用户修订：mock 完成后移除本次新增的常规 CI 接入，作为本仓库自包含的参考工具。保留手动 support/matrix 入口及作者验证；本地运行不需要 Magpie checkout 或源码环境变量。CI 不拉取 Magpie，也不执行本次新增的 mock support/matrix 链。固定来源、许可和显式参考源码审计独立保留。

## 工作位置与来源

- 独占 worktree：`/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012`。
- 分支：`codex/magpie-live-matrix-20261012`。
- 起始 base：`88715b2fe74ce4e6254f4d29ef1528b6848d4dff`；集成边界组合最新 main，按差异复用/补验。
- Magpie：`/Volumes/extension/code/magpie`，`bfaedf18301d02a423bd5422d22e41432d231ab8`，只读。
- 任务记录：`/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435`。
- 需求：本 worktree `.appsdk/requirements.json` 的适用 active 条目及当前用户“架构不改”指令。

## 工作项与依赖

| ID | 工作项 | owner / 依赖 | 验收 |
|---|---|---|---|
| E1 | 最小 fixture/capture 接口与四协议 mock | runner worker；复用既有 controlled upstream 思路 | method/path/headers/body 捕获；JSON/SSE/fault 脚本可控 |
| E2 | 真实 RCC HTTP 测试实例生命周期与 client | runner worker；E1 | 独占 loopback 配置、真实入口 smoke、身份记录、退出与清理 |
| E3 | 固定 source corpus 与独立断言 | corpus worker；E1 接口；来源整理可先并行 | 16 协议格，适用 JSON/SSE、代表性工具/media/reasoning/usage/错误/字段边界案例 |
| E4 | 基线运行与报告 | runner worker；E2/E3 | 每格结果、原始证据、失败分类、未覆盖原因，不能只列汇总数 |
| E5 | 作者验证与独立整体 Review | 作者完成 E1–E4；独立 Reviewer | runner 自身行为正确、原始 baseline 红项不被掩盖、完整 scope review PASS |
| E6 | 授权集成与远端回执 | 编排者/集成 worker；E5及适用 CI | 无 hook 绕过；最新 main 候选；commit/PR/merge/push 原始回执 |
| E7 | 证据移交与自有资源收口 | 编排者与创建者；相应资源不再需要 | 测试实例、临时配置和自有干净 worktree 清理；长期 corpus/报告可访问 |

初始状态：计划与来源已落盘；E1/E3 开始执行，其余按依赖推进。不预记验收通过。

当前修订状态：E1–E4 有已接受的历史基线证据，E5 未改内容有独立审查。自包含与 CI 移除修订待作者验证及受影响复核；E6/E7 待集成、远端和清理回执。原始 48 例中 12 例通过、36 例不匹配的记录保持不变，不据此声称 operator 缺陷已确认或修复。

## 测试设施契约

mock 只根据 case 返回固定 JSON/SSE/fault，并抓取真实 provider request。fixture 中使用假 token，不读取真实账户。所有 provider URL 指向自有 loopback upstream。probe 与业务 attempt 分开；状态隔离避免 cooldown 污染后续 case。

真实 client 必须访问 RCC HTTP listener。内部 codec、Rust driver、dry-run 或 health 不替代该证据。候选 build/test 与稳定 installed-runtime 行为分别标注；记录实际 binary path、运行命令及安装/运行回执，不额外计算哈希，也不能从源码提交推断已安装 runtime。

断言至少覆盖 provider wire、client 语义/原始字节及副作用。工具代表用例使用无副作用 echo consumer 执行后提交 output；不授予来源请求未声明的工具权限。SSE 分片/终态/提前 EOF 按实际语义断言。

未登记字段按有效需求处理；Provider 错误留内部，耗尽关闭连接。独立断言不能调用被测转换生成 expected。任何刻意削弱断言、skip、吞错或修改 golden 以掩盖 product gap 均不允许。

## 通过标准与证据

本轮通过 iff：runner 和 corpus 可使用；受影响作者验证通过；全部基线工作项有真实执行结果或明确未执行原因；16 格不存在未记录空格；代表性边界已实际运行；原始红项与 runner 缺陷可区分；整体 Review 与适用集成/资源回收完成。

基线 product failure 可以保留，不要求本轮修 runtime；这不豁免测试设施本身的正确性，也不将失败案例计为产品成功。报告应有明确计数和 P2 缺口列表。

证据保存实际 RCC 入口、所用 config/fixture 引用、Magpie 源测试、provider capture、client 原始结果、断言和清理回执。共享输入只记录一次，不另建身份清单。保留失败恢复需要的资料，不保存秘密。源码、测试、build、installed、live、review、merge 和远端 receipt 分开记录。

停止/恢复：实际权限拒绝不绕过；共享资源冲突只停该链；runtime gap 记入 P2，继续其余基线；实现范围需扩大或架构变更时交编排者重新规划。只删除自有且已移交证据的资源。

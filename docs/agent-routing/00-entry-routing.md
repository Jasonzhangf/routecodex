# RouteCodex 任务入口

项目合同以 [AGENTS.md](../../AGENTS.md) 为准。V3 是生产实现；V4 的任务先读其局部合同，不沿用 V3 的命令。

只读与纯文档任务直接检查受影响内容。开发/debug 使用 [rcc-dev-skills](../../.agents/skills/rcc-dev-skills/SKILL.md)，先检查受影响 DAG，再按 feature 查询 V3 maps。已经得到的有效定位与证据直接复用，不因切换路由页重新查询。

| 任务 | 入口 |
| --- | --- |
| 完成标准与反馈 | [完成合同](05-foundation-contract.md) |
| 架构职责与调用边 | [运行时路由](10-runtime-ssot-routing.md) |
| 构建、安装、运行验收 | [交付路由](20-build-test-release-routing.md) |
| servertool 与 continuation | [工具路由](30-servertool-lifecycle-routing.md) |
| 任务证据与记忆 | [记忆路由](40-task-memory-routing.md) |

路由页只提供入口，不重复维护实现流程、门禁清单或逐行索引。找不到当前任务的唯一 owner 或必需调用边时，只补该缺口；不因查询次数或无关索引缺失扩大任务。

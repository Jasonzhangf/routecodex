# V3 架构审阅入口

先看 [业务图](../dagpipe/README.md)，再通过 [V3 四张 maps](../README.md) 定位当前 feature。下表用于审阅已有接线，不是第二份 owner 或执行流程。

| 关注点 | 审阅面 |
| --- | --- |
| 主线调用与固定骨架 | [caller flow](v3-mainline-caller-flow.md)、[skeleton](v3-mainline-skeleton-sop.md) |
| Direct 与 Relay | [Direct](v3-responses-direct-mainline.md)、[Relay](v3-hub-relay-fixed-pipeline.md) |
| 协议归一化与工具治理 | [边界](v3-protocol-normalization-tool-governance-boundary.md) |
| 业务数据与控制资源 | [控制边界](v3-execution-control-payload-architecture.md) |
| 配置与服务 | [配置入口](v3-config-server-full-function.md)、[生命周期](v3-managed-server-lifecycle.md) |
| 客户端传输 | [SSE 提交](v3-client-sse-head-commit.md)、[传输观测](v3-client-transport-observation.md) |

每次只读相关页面与 map 条目。页面记录的是其证据范围内的状态；live 行为以当前真实入口验证为准。生成页面通过其生成器维护，不能手工修改生成结果。

本目录其他旧 `mainline-call-graph`、TS/HubPipeline、迁移与 HTML 页面是历史审阅材料，不作为当前 V3 默认路径。需要 HTML 展示时才生成适用页面；一般源码或文档审计不增加渲染、截图或重复同步步骤。所需 gate 由 [V3 verification map](../v3-verification-map.yml) 与 [开发 Skill](../../../.agents/skills/rcc-dev-skills/SKILL.md) 决定。

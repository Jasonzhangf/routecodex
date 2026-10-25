# RouteCodex 架构入口

V3 是生产实现。项目合同见 [AGENTS.md](../../AGENTS.md)，业务图与接入边界见 [DAGPipe](dagpipe/README.md)。V4 是独立重构域，见 [V4 文档](../../v4/docs/README.md)，不能用其结果证明 V3 已交付。

| 要回答的问题 | 唯一来源 |
| --- | --- |
| 资源由谁读写、怎样流转 | [V3 resource map](v3-resource-operation-map.yml) |
| 功能由谁实现、能改哪些路径 | [V3 function map](v3-function-map.yml) |
| 请求、响应、错误怎样调用 | [V3 mainline map](v3-mainline-call-map.yml) |
| 改动需要哪些验证 | [V3 verification map](v3-verification-map.yml) |
| 人工审阅接线与专题 | [Wiki 入口](wiki/README.md) |
| 开发、修复与交付操作 | [rcc-dev-skills](../../.agents/skills/rcc-dev-skills/SKILL.md) |

按受影响 feature 查询，复用已有绑定。仅在资源、owner、调用边或验证要求变化时更新对应 map；生成的 review 面沿原生成入口更新，不手写第二份真源。图登记、静态 gate 和 Node01 接入分别证明各自范围，不能推断整条流水线已经运行。

未带 `v3-` 前缀的旧 maps、HubPipeline/TS 迁移索引及旧 wiki 页面保留为历史材料，不再是默认开发入口。不要沿旧索引恢复 V2、启动旧构建或新增旧治理绑定。历史证据需要复用时，先确认对应 owner 与当前 feature 的关系。

不把全部 gate、HTML 渲染或迁移清单附加到每个任务。必要验证取自当前 feature 的声明和项目合同；文档修改只做受影响的合同与引用检查。

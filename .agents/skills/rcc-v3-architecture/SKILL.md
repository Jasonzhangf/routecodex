---
name: rcc-v3-architecture
description: "查询 RouteCodex V3 的唯一 owner、模块边界、调用关系与必需验收。"
---

# RouteCodex V3 架构查询

项目事实与边界见 [AGENTS.md](../../../AGENTS.md)；map 查询和开发流程见 [rcc-dev-skills](../rcc-dev-skills/SKILL.md)。本入口不维护第二份架构或执行流程。

缺失或冲突绑定只阻止依赖它的修改。按实际调用关系判断 owner，不按搜索命中数量推断。

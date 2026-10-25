# RCC servertool 架构：已退役设计

`routecodex-v3-no-rcc-servertool` 已取代旧 `servertool-core`、本地搜索和 client-exec projection 设计。本页不再声明这些组件为当前 owner，也不要求保留旧注册表、CLI 或专用 followup 状态。

当前普通工具、Provider hosted search、有界 refill 及控制/业务分离的边界由 [工具生命周期路由](../agent-routing/30-servertool-lifecycle-routing.md) 统一维护。代码删除由既有实现 owner 完成，不以文档退役冒充源码或运行交付。

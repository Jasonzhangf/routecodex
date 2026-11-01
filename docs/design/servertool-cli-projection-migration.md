# RCC servertool CLI projection：已退役设计

`routecodex-v3-no-rcc-servertool` 已退役 RCC 专用 CLI 子命令和 descriptor projection。本页不再要求实现或测试旧 `exec_command` 包装链。普通客户端工具和原生 `apply_patch` 不属于该删除范围。

当前保留边界与验收入口由 [工具生命周期路由](../agent-routing/30-servertool-lifecycle-routing.md) 统一维护。源码是否已删除、测试是否通过和运行是否交付，须看对应 owner 的实际证据，不能由本页的设计更新推断。

# CLI 命令模块

## 概述
CLI 命令实现包括：
- `validate.ts`：配置验证与基本 health‑check
- `provider-update.ts`：拉取 provider 模板/模型列表
- 历史命令 `offline-log.ts` 已移除

## 命令清单
- `validate`：加载配置并调用 Hub Pipeline 进行dry‑run检查。
- `provider-update`：用于更新 `~/.routecodex/provider/` 下的模板文件。
- CLI 主程序在 `cli.ts`，所有命令必须通过主入口。

## 调试相关
- Debug 相关能力由 `src/debug/*` 提供，CLI 只负责参数透传。
- 快照查看请使用 `npm run snapshot:inspect` 而非独立命令。

## 与 Hub Pipeline 的关系
- CLI 命令不直接操作 provider，所有验证/测试通过 `bootstrapVirtualRouterConfig` → Hub Pipeline 进行。

# 构建 / 测试 / 发布路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L20 `build-order`：构建与安装顺序。
- L22-L30 `verification`：最小验证栈。
- L32-L36 `release-boundary`：发布边界。

## 覆盖范围
适用于：本地编译、全局安装、release 打包、回归验证。

## 构建顺序
1. `sharedmodule/llmswitch-core` 先构建。
2. 根仓执行 `npm run build:dev`。
3. 需要发布时执行 `npm run install:release`。

## 最小验证栈
- 目标改动对应的最小测试（同路径回归）。
- 至少一条 failing-shape replay + 一条 control replay。
- 安装后版本/可执行性复核（`routecodex --version` / `rcc --version`）。

## 发布边界
- CLI release 用 `@jsonstudio/rcc`。
- `routecodex` 仅本地/调试路径。
- 不提交构建产物（`dist/`、tarball）。

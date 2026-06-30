# 构建 / 测试 / 发布路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L20 `build-order`：构建与安装顺序。
- L22-L30 `verification`：最小验证栈。
- L32-L36 `release-boundary`：发布边界。

## 覆盖范围
适用于：本地编译、全局安装、release 打包、回归验证。

## 构建前查询（必须）

凡是会进入 build / install / restart / smoke 的任务，先查：

1. `docs/agent-routing/05-foundation-contract.md`
2. `docs/architecture/function-map.yml`
3. `docs/architecture/mainline-call-map.yml`
4. `docs/architecture/verification-map.yml`
5. 对应 mainline source / wiki review surface

如果这一步无法在 1-2 次查询内锁到唯一 owner / 唯一主线边，先补 map/contract，再跑构建验证。

## 构建顺序
1. `sharedmodule/llmswitch-core` 先构建。
2. 根仓执行 `npm run build:dev`。
3. 需要发布时执行 `npm run install:release`。

## 最小验证栈
- 先补并跑目标改动对应的最小 red test / 同路径回归，必须先看到“当前为红”。
- 至少一条 failing-shape replay + 一条 control replay。
- red test 转绿后，必须在线重放旧错误样本或同入口真实样本；没有样本在线复测，不算闭环。
- 安装后版本/可执行性复核（`routecodex --version` / `rcc --version`）。
- 安装后真实 restart + `/health` 复核；仅 CLI 存在不算闭环。
- 验证完成后必须补架构 review：确认不是 fallback、临时绕路、补丁式修复、错层修复，且结果正确同时架构正确。

## 发布边界
- CLI release 统一走 `npm run install:release`（隔离构建 + release snapshot 安装 + restart/health smoke）。
- release 运行时真源是 `~/.rcc/install/current`；dev `install:global` 仍是独立语义。
- 不提交构建产物（`dist/`、tarball）。

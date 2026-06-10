# 安装与快速上手（rcc / routecodex）

## 1) Release 安装（推荐，本地源码）

前置要求：

- Node.js `>=20 <26`
- `tmux`
- `cargo`

```bash
npm run install:release
rcc --version
```

`npm run install:release` 会自动执行隔离构建、依赖准备、release snapshot 安装，并在安装后执行 `rcc restart --port 5520` 与 `/health` 验证。

升级/卸载：

```bash
npm run install:release
npm uninstall -g routecodex
```

## 2) 初始化配置（自动生成）

默认会写入：`~/.rcc/config.json`

交互式（推荐）：

```bash
rcc init
```

初始化成功后，`rcc init` 会把内置文档复制到：`~/.rcc/docs`

如果你希望一次性解压内置的脱敏 provider 模板到 `~/.rcc/provider`（便于后续直接填 key / tokenFile）：

```bash
rcc init default
```

非交互式（CI/脚本）：

```bash
rcc init --providers openai,tab --default-provider tab
```

查看内置 provider 列表：

```bash
rcc init --list-providers
```

生成后你需要把 `apiKey` / `tokenFile` / `cookieFile` 按需补齐（脱敏模板会用环境变量占位，例如 `${OPENROUTER_API_KEY}`）。

参考配置：
- `configsamples/config.reference.json`
- `configsamples/provider/*/config.v1.json`
- `configsamples/provider-default/*/config.v2.json`

## 3) 启动服务器

```bash
rcc start
```

自定义配置路径：

```bash
rcc start --config ./config.json
```

离线单模型（例如 LM Studio）建议单独配置并独立端口运行：

```bash
routecodex start --port 5520 --config "/Volumes/extension/.rcc/config.offline.json"
```

## 4) 验证服务可用

```bash
curl http://127.0.0.1:5555/health
curl http://127.0.0.1:5555/ready
```

## 5) Dev Worktree（本仓库）构建与全局安装

```bash
npm --prefix sharedmodule/llmswitch-core run build
npm run build:dev
npm run install:global
```

> 注意：release 统一通过本仓库 `npm run install:release` 生成并安装，不再依赖历史 npm rcc 包发布流程。
> 注意：旧 `scripts/install.sh`、`scripts/quick-install.sh` 已删除，禁止恢复第二套安装实现。

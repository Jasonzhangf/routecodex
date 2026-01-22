# 安装与快速上手（rcc / routecodex）

## 1) npm 安装（Release，推荐）

```bash
npm install -g @jsonstudio/rcc
rcc --version
```

升级/卸载：

```bash
npm update -g @jsonstudio/rcc
npm uninstall -g @jsonstudio/rcc
```

## 2) 初始化配置（自动生成）

默认会写入：`~/.routecodex/config.json`

交互式（推荐）：

```bash
rcc init
```

初始化成功后，`rcc init` 会把内置文档复制到：`~/.routecodex/docs`

非交互式（CI/脚本）：

```bash
rcc init --providers openai,tab --default-provider tab
```

查看内置 provider 列表：

```bash
rcc init --list-providers
```

生成后你需要把 `apiKey` / `tokenFile` / `cookieFile` 按需补齐（脱敏模板会用 `YOUR_API_KEY_HERE` 占位）。

参考配置：
- `configsamples/config.reference.json`
- `configsamples/provider/*/config.v1.json`

## 3) 启动服务器

```bash
rcc start
```

自定义配置路径：

```bash
rcc start --config ./config.json
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

> 注意：`routecodex` 仅用于本地/调试，严禁发布到 npm；release 只能用 `@jsonstudio/rcc`。

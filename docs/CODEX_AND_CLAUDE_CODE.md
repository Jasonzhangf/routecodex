# Codex / Claude Code 接入 RouteCodex

## 1) Codex（~/.codex/config.toml）

Codex 支持在 `~/.codex/config.toml` 里声明多个 `model_providers`。你可以把 RouteCodex 当作“上游 base_url”，让 Codex 的所有请求走本地代理。

一个参考写法（与当前常见的 `tc/tcm` 命名保持一致）：

```toml
[model_providers.tc]
name = "rc"
base_url = "http://127.0.0.1:5555/v1"
wire_api = "chat"
env_key = "ROUTECODEX_APIKEY"

[model_providers.tcm]
name = "rc"
base_url = "http://127.0.0.1:5555/v1"
wire_api = "responses"
env_key = "ROUTECODEX_APIKEY"

[profiles.tc]
model_provider = "tc"
model = "gpt-5.2"

[profiles.tcm]
model_provider = "tcm"
model = "gpt-5.2"
```

如果你在 `~/.routecodex/config.json` 中设置了服务端访问密钥（`httpserver.apikey`），则需要在环境变量里提供同样的值：

```bash
export ROUTECODEX_APIKEY="your-server-apikey"
```

> RouteCodex 会接受 `Authorization: Bearer ...` 与 `x-api-key: ...` 等多种 header；Codex 侧如何出 header 取决于其实现与 `wire_api` 行为。

## 2) RouteCodex 启动建议

### 标准启动

```bash
rcc start
```

### 针对 Codex / Claude 的系统提示词与 UA（可选）

```bash
rcc start --codex
# 或
rcc start --claude
```

## 3) Claude Code（rcc code）

RouteCodex CLI 内置了 `rcc code` 来启动 Claude Code，并把 Claude Code 的请求代理到本地 RouteCodex：

```bash
rcc code --ensure-server
```

常用参数：

- 指定 Claude Code 可执行文件：`rcc code --claude-path /path/to/claude`
- 指定模型：`rcc code --model <model>`
- 指定 profile：`rcc code --profile <profile>`
- 指定 server apikey：`rcc code --apikey <your-server-apikey>`


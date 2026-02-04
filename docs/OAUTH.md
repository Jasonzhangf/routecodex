# OAuth Guide（认证与刷新）

本页是 RouteCodex / RCC 的 **OAuth 统一说明**：如何认证、如何刷新、以及常见踩坑（尤其是 “我都授权了但服务器不拿 token”）。

> 说明：文中用 `${bin}` 表示 CLI 命令名：release 包是 `rcc`，dev 包是 `routecodex`。

## 1) Token 文件与 `tokenFile` 写法

### Token 存放位置

默认目录：`~/.routecodex/auth/`

常见命名：
- `qwen-oauth-<seq>-<alias>.json`
- `antigravity-oauth-<seq>-<alias>.json`
- `gemini-cli-oauth-<seq>-<alias>.json`
- `iflow-oauth-<seq>-<alias>.json`

### `tokenFile` 支持两种写法

1) **显式路径**（通用，最稳）：

```jsonc
"auth": { "type": "qwen-oauth", "tokenFile": "~/.routecodex/auth/qwen-oauth-1-default.json" }
```

2) **alias（仅文件名，不含路径）**：

```jsonc
"auth": { "type": "qwen-oauth", "tokenFile": "default" }
```

当前推荐 Qwen 用 alias：`default`。它会自动匹配 `~/.routecodex/auth/qwen-oauth-*-default.json` 中 seq 最新的那份。

## 2) 认证（授权登录）

### 2.1 手动认证（通用）

```bash
${bin} oauth --force qwen-oauth-1-default.json
```

- `selector` 支持：token 文件 basename、全路径、或 provider id（例如 `qwen` / `iflow` / `antigravity`）
- `--force`：强制重新授权（一定会走浏览器/portal）
- 不带 `--force`：如果 token 仍然有效，会直接跳过（避免“每次都让我重新认证”）

### 2.2 Camoufox 自动化（推荐：Qwen / Gemini / Antigravity / iFlow）

这些命令会用 Camoufox（固定指纹 + profile）帮你自动完成关键点击。

```bash
${bin} oauth qwen-auto qwen-oauth-1-default.json
${bin} oauth gemini-auto gemini-cli-oauth-1-youralias.json
${bin} oauth antigravity-auto antigravity-oauth-1-youralias.json
${bin} oauth iflow-auto iflow-oauth-1-youralias.json
```

Qwen 的自动化会在授权页自动点击：

`button.qwen-confirm-btn`（Confirm）

> 如果 auto 失败，会自动退到 headed 模式让你手动完成（Qwen 不走 localhost callback，因此不会再“等不到回调一直卡住”）。

## 3) 刷新（refresh）是怎么工作的？

### 3.1 后台刷新（默认：静默，不弹窗）

默认后台只做 **静默 refresh**（`openBrowser=false`），失败会记录并进入退避，不会突然弹出 Qwen/Gemini 登录页。

> 需要交互式修复时，使用上面的 `${bin} oauth ...` 显式触发。

### 3.2 显式刷新/重登（你主动触发）

- 刷新（有效就跳过）：`${bin} oauth <selector>`
- 强制重登：`${bin} oauth --force <selector>`

验证 token 状态：

```bash
${bin} oauth validate all
```

> `oauth validate ...` 只做读取/校验，不会拉起浏览器。

## 4) 常见问题（非常重要）

### “我都授权了，但服务器不拿 token / 还是 401/403”

按顺序排查：

1) **你的配置里有没有这个 provider**
   - 例如 Qwen：`virtualrouter.providers.qwen` 必须存在，否则 token 永远不会被使用

2) **`auth.type` 与 `tokenFile` 是否对得上**
   - Qwen：`"type": "qwen-oauth"` + `tokenFile: "default"`（或写全路径）
   - 认证生成的文件是否真的在 `~/.routecodex/auth/` 下

3) **token 文件内容是否具备可用字段**
   - 至少需要 `access_token`（部分 provider 还会有 `api_key`）

4) **你是不是在后台刷新时期待它弹窗**
   - 默认后台不会弹；需要交互请用 `${bin} oauth --force ...` 或 `${bin} oauth qwen-auto ...`

## 5) 相关文档入口

- 内置 Provider 配置：`docs/PROVIDERS_BUILTIN.md`
- Provider 类型：`docs/PROVIDER_TYPES.md`
- Antigravity 指纹/养号：`docs/providers/antigravity-fingerprint-ua-warmup.md`

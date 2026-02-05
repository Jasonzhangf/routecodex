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

当前推荐 Qwen 用 alias：`default`。

- 如果存在 `~/.routecodex/auth/qwen-oauth-1-default.json`，会优先使用它（固定文件名，避免“我刚 reauth 但 server 读的是另一个 seq”的坑）
- 否则会回退到 `~/.routecodex/auth/qwen-oauth-*-default.json` 中 seq 最新的那份

## 2) 认证（授权登录）

### 2.1 手动认证（通用）

```bash
${bin} oauth --force qwen-oauth-1-default.json
```

- `selector` 支持：token 文件 basename、全路径、或 provider id（例如 `qwen` / `iflow` / `antigravity`）
- `--force`：强制重新授权（一定会走浏览器/portal）
- 不带 `--force`：如果 token 仍然有效，会直接跳过（避免“每次都让我重新认证”）
- 若你的 `oauthBrowser=camoufox`，Qwen 在 `authorize` 页面需要点一次 Confirm；`oauth` 默认会启用 `qwen` auto（等价于 `oauth qwen-auto ...`）

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

WebUI（daemon-admin）里点 “Authorize OAuth” 时也会强制走 Camoufox；若未安装，会返回错误 `camoufox_missing` 并提示安装命令。

当 token 被标记为 `verify required`（Google 风控校验）时，daemon-admin 会提供 `open` 链接，点击后会用 Camoufox 打开验证 URL（固定 profile + 指纹），不要再用系统浏览器。

Portal 健康检查（`/health`）默认会等待 **300s**（网络慢时避免过早 timeout），可用环境变量调整：

- `ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS`（总等待）
- `ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS`（单次请求）
- `ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS`（轮询间隔）

Camoufox 自动化（Google / Antigravity / Qwen）相关等待也有独立超时（默认 **300s**，避免网络慢/跳转慢导致误判）：

- `ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS`（Gemini / Antigravity account/confirm/callback 总等待）
- `ROUTECODEX_CAMOUFOX_PORTAL_BUTTON_TIMEOUT_MS`（token portal `Continue` 按钮等待）
- `ROUTECODEX_CAMOUFOX_PORTAL_POPUP_TIMEOUT_MS`（portal 点击后 popup 或同页跳转等待）
- `ROUTECODEX_CAMOUFOX_PAGE_LOAD_TIMEOUT_MS`（portal 后 OAuth 页 `domcontentloaded` 等待）

> Antigravity/Gemini 的确认按钮点击不依赖文案（locale/font 变化），按容器 selector 点击 primary action。

## 3) 刷新（refresh）是怎么工作的？

### 3.1 后台刷新（默认：静默，不弹窗）

RouteCodex 运行时会启动 token-daemon 做 **后台刷新**（默认提前刷新窗口：到期前 **30 分钟**；可用 `ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN` 覆盖）。

默认情况下后台会先尝试 **静默 refresh**（`openBrowser=false`）。对以下 provider：

- `antigravity`
- `qwen`
- `iflow`

当静默 refresh 失败且需要交互式修复时，会尝试用 Camoufox 做 **auto OAuth**（headless），并在 auto 失败时退到 headed 让你手动完成。

为避免“无限认证 / 无限弹窗”，如果连续 **3 次**都等不到用户完成（例如 device-code 超时 / callback 超时），token-daemon 会对该 token **自动暂停**后续后台认证，直到 token 文件被你手动更新（例如执行一次 `${bin} oauth --force ...` 成功写回文件）。

> 需要交互式修复时，使用上面的 `${bin} oauth ...` 显式触发。

### 3.3 403 账户验证（Antigravity / Gemini）

如果上游返回 `HTTP 403` 且包含以下关键字之一：

- `verify your account`
- `validation_required`
- `accounts.google.com/signin/continue`

说明账号需要在浏览器里完成验证/风控解除（不是简单的 token 过期）。此时 RouteCodex 会尝试自动拉起 Camoufox 交互式 OAuth/验证流程。

为避免“无限弹窗/无限认证”，同一个 token（provider + tokenFile）在该类 403 下会有 **30 分钟冷却**（可用环境变量覆盖）：

- `ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS`（默认 `1800000`）

另外，所有 **交互式 OAuth repair**（例如持续 401/403 导致的自动 reauth）也有统一冷却，避免在网络抖动或上游风控期内“疯狂弹窗/疯狂认证”：

- `ROUTECODEX_OAUTH_INTERACTIVE_COOLDOWN_MS`（默认 `1800000`）

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

# 50 RCC Config SSOT

## 何时用
- 你要查 provider 是否真配置了
- 你要查某端口实际命中什么 route / provider
- 你要改 provider 配置、auth、模型、forwarder

## 真源顺序
1. `~/.rcc/config.toml`
2. `~/.rcc/config.<provider>.toml`
3. `~/.rcc/provider/<providerId>/config.v2.toml`
4. `~/config/merged-config.<port>.json`

第 4 项只是派生快照，不是首要真源。

## 当前目录布局
- `~/.rcc/codex-samples/`
- `~/.rcc/auth/`
- `~/.rcc/config/`
- `~/.rcc/diag/`
- `~/.rcc/install/`
- `~/.rcc/log/` / `~/.rcc/logs/`
- `~/.rcc/provider/`
- `~/.rcc/quota/`
- `~/.rcc/run/`
- `~/.rcc/servertool/`
- `~/.rcc/sessions/`
- `~/.rcc/state/`

## 快速命令
- 看真实请求 / provider 样本（所有问题第一步）：
  - `find ~/.rcc/codex-samples -type f | grep '<requestId>\\|<providerKey>\\|<model>'`
  - `find ~/.rcc/codex-samples/<endpoint>/ports/<port> -maxdepth 2 -type f | sort`
  - `sed -n '1,220p' ~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/client-request.json`
  - `sed -n '1,220p' ~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/provider-request*.json`
  - `sed -n '1,220p' ~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/provider-response*.json`
  - `sed -n '1,220p' ~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/client-response*.json`
- 看根配置：
  - `sed -n '1,120p' ~/.rcc/config.toml`
- 看 provider 样本：
  - `ls ~/.rcc/provider/1token/`
  - `cat ~/.rcc/provider/1token/config.v2.toml`
  - `cat ~/.rcc/provider/DF/config.v2.toml`
- 看当前安装真相：
  - `ls -la ~/.rcc/install/current`
- 看当前日志命中：
  - `rg -n 'gateway-priority-5555|\\[port:5555' ~/.rcc/log ~/.rcc/logs`
  - `sed -n '1,220p' ~/.rcc/logs/server-<port>.log`

## provider config.v2.toml 常见字段
- 顶层：
  - `version`
  - `providerId`
- `[provider]`
  - `id`
  - `enabled`
  - `type`
  - `baseURL`
  - `compatibilityProfile`
  - `transportBackend`
  - `defaultModel`
- `[provider.auth]`
  - `type`
  - `entries = [{ alias, apiKey }]`
- `[provider.responses]`
  - `process`
  - `streaming`
- `[provider.concurrency]`
  - `maxInFlight`
  - `acquireTimeoutMs`
  - `staleLeaseMs`
- `[provider.models."<modelId>"]`
  - `supportsStreaming`
  - `supportsThinking`
  - `thinking`
  - `maxTokens`
  - `maxContext`
  - `capabilities`
  - `aliases`

## durable 规则
- `provider.models.<modelId>` 是 upstream wire model 真名
- `aliases` 只给客户端展示 / 客户端输入匹配
- provider 出站 `body.model` 必须回写 `modelId`，不能发 alias
- 每个 routingPolicyGroup 的 `routing.default` 池必须包含该组其他池出现过的所有模型/forwarder。
- `default.targets` 排序按业务 priority 排序；同等可用时，支持 `web_search` 和 `multimodal` 的模型/forwarder 靠前。
- GPT forwarder 分类：`fwd.gpt.*` 表示 free/限免动态池，默认优先于 `fwd.paid.*`；free 池只保留当前免费 provider，paid 池承载付费 provider 聚合。

## 修改流程
1. 编辑 `~/.rcc/provider/<id>/config.v2.toml`
2. 跑 schema 校验：
   - `routecodex config validate`
3. 先确认当前运行配置就是要启动的配置，避免用户刚回退旧配置时误重启
4. live 验证必须使用全局安装版本；不要用 repo-local `node dist/cli.js start ...` 或 `routecodex start ...` 作为交付口径
5. 用任一成员端口定位 aggregate instance，只执行一次重启：
   - `routecodex restart --port <locator-port>`
6. 健康检查配置中的全部成员端口：
   - `curl -s http://127.0.0.1:<member-port>/health`
   - 所有成员必须 `ready=true`、`pipelineReady=true`、version 一致，listener PID identity 一致。
7. 再做 live `/v1/responses` 或 `/v1/chat/completions` probe

## 安装面边界
- 交付级测试默认只认全局 `routecodex` 安装面；repo-local build、手工 snapshot、临时 shim 只能定位问题。
- 实验验证顺序：安装目标产物 → `routecodex --version` → `routecodex restart --port <locator-port>` 一次 → 全部成员端口 `/health`/version → live probe。端口是 locator，不是独立 restart target。
- 未经 Jason 明确要求，不覆盖 `rcc` release 安装或 Homebrew/global shim；不要为了验证 `routecodex` 产物顺手改掉 `rcc` 的 release 面。
- 若用户要求验证 `rcc` release，全局安装后必须证明 `rcc --version`、`routecodex --version`、`~/.rcc/install/current/package.json`、`/health.version` 一致。
- 若怀疑某个测试导致 server 停止，先记录 `server-<port>.log` 行数和 `/health`，只运行该测试，再检查新增 lifecycle 行；没有新增 `signal_received` / `self_termination` / `restart_signal_received` 时，不得把停止归因给该测试。Jest/WebUI 单测必须保持无 live server 生命周期副作用。
- Jason 已手动恢复 live server 后，默认冻结生命周期动作：不要继续执行会 stop/restart/install/start 的命令，也不要用新的 live probe 反证现场。只能做离线 diff/代码检查；需要再动 live server 时必须等 Jason 明确指令。

## 排障顺序
1. 先看 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/` 的真实样本四件套。
2. 再看 `~/.rcc/logs/server-<port>.log` 里同 requestId / `[port:<port>]` 命中。
3. 再看 `~/.rcc/config.toml`
4. 再看目标 provider `config.v2.toml`
5. 最后才看 merged-config 快照

## snapshot/debug 固化规则
- live `--snap` 的 canonical 主桶只能是 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`。
- live `--snap` 样本验证前先清目标 `ports/<port>` 和同 endpoint 的旧非 canonical 目录，再用全局 `routecodex restart --port <port>` 重跑新样本。
- 默认先核四件套：`client-request` / `provider-request` / `provider-response` / `client-response`；若失败再看 `provider-error*`。
- 看到 `port-unknown/`、根目录 `req_*`、裸 provider 目录重新增长，不要当作“兼容路径”；这代表还有写盘 owner 没带 `entryPort`，应回源码修掉并在验证后物理清理旧样本。
- 样本证据与日志证据要成对看：样本负责 payload/raw 真相，`server-<port>.log` 负责路由/provider/error 时序真相。

## 反模式 / 边界
- ❌ 没看 `codex-samples` 就判断协议、payload、model rewrite 或上游 shape
- ❌ 只看根目录 `req_*` 或 `port-unknown` 样本就宣称路径正确；应以 `ports/<port>/` 为唯一主桶
- ❌ 用 repo-local `node dist/cli.js start ...`、`routecodex start ...` 或其他 start 口径替代全局 `routecodex restart --port <port>` 做 live 交付验证
- ❌ 先查 repo `config/`
- ❌ 把 `~/.codex/config.toml` 当 RouteCodex 运行时真源
- ❌ 把 alias 当 upstream wire model
- ❌ 只做 schema validate，不做 restart + health + live probe
- ❌ 用户已经回退运行配置后，未经确认就直接 restart

## 相关 references
- [40-owner-registry.md](./40-owner-registry.md)
- [70-gate-discovery.md](./70-gate-discovery.md)
- [92-lessons-2026-06.md](./92-lessons-2026-06.md)

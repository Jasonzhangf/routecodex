# V4 基建任务计划（CLI / lifecycle / config / server / install / logs）

## 当前真源与缺口

- V4 独立 runtime 工作树：`v4/playground/v4-independent-runtime-admission-20260818T031744Z-Macstudio-38512-26190`。该工作树已跑通真实 Responses JSON/SSE、真实 provider transport、`/health`、`/v1/models`，并已全局安装过 `~/.local/bin/rccv4`。
- 主 HEAD 的 `v4/Cargo.toml` 仍只登记 foundation/plugin crates；runtime-bin、provider、router、server 等独立 runtime 接线仍分散在未合并工作树，不能直接当 main 已完成。
- `rccv4 start --snap` 在任意 cwd 仍失败：runtime-bin 的 manifest 路径按 cwd 解析，`--help` 也会先加载 manifest。
- 当前 CLI 只有 `rccv4-plugin` 的 admission baseline，不是 V3 对齐的完整 CLI。
- V3 CLI 功能面真源：`config check`、`init`、`start`、`status`、`restart`、`stop`、`servertool run`，以及隐藏 `server` 子命令 `start/status/restart/stop/run-managed-child`。
- V3 禁止逐端口循环 restart；V4 必须保持同一独立实例一次 restart，端口只是 locator，不能把端口写死到路由名或命令名。

## 目标

让 `rccv4` 成为真实、全局安装、cwd-independent 的 V4 入口，功能面按 V3 CLI 对齐，架构按 V4 Cordis 插件化收敛：

- CLI 只做解析与分发，是 Cordis 风格的薄入口插件；server/lifecycle 语义归对应 owner。
- config 从 authoring 编译为 deterministic manifest；runtime 只消费 manifest，不扫描 authoring 目录。
- server 和 provider 都不是 mock，必须能跑真实 provider 请求。
- 端口、provider、model、路由全部来自配置/compiled manifest；禁止硬编码端口或把端口写进路由名。
- V4 与 V3 独立共存：V4 使用 `config.v4.toml`、`~/.rcc/v4`、独立 listener 集合，不碰 V3 config/process/tmux/admin。

## 任务列表

### M1：建立干净 V4 基建基线

1. 从当前 main HEAD 创建干净 worktree，先合并独立 runtime worktree 中已被验证的 runtime-bin/provider/router/server/config 接线，形成可复现基线。
2. 记录 base commit、合并来源、已验证 evidence；任何未验证来源不得混入。
3. 核对 V3 端口集合与 V4 端口集合互斥；新增 V4 端口前先 `lsof -nP -iTCP -sTCP:LISTEN` 确认空闲。
4. 跑 `cargo test --manifest-path v4/Cargo.toml` 与 V4 source gate，锁定基线绿。

### M2：CLI 插件解析

1. 在 `routecodex-v4-cli-plugin` 或对应 CLI owner 内用 clap 定义完整命令树，对齐 V3：
   - `rccv4 config check [-c <config>]`
   - `rccv4 init [-c <config>] [--force] [--provider] [--base-url] [--model] [--api-key] [--env] [--token-file] [--port]`
   - `rccv4 start [-c <config>] [--snap] [--snapall] [--snap-stages] [--debug] [--sse-dump]`
   - `rccv4 status [-c <config>]`
   - `rccv4 restart [-c <config>] [--timeout-ms] [--snap] [--snapall] [--snap-stages] [--debug] [--sse-dump]`
   - `rccv4 stop [-c <config>] [--timeout-ms]`
   - `rccv4 servertool run <tool-name> --input-json ... [--flow] [--session-id] [--request-id]`
   - 隐藏 `rccv4 server start|status|restart|stop|run-managed-child`，参数与 V3 对齐。
2. `--version`、`--help` 不加载 manifest、不绑定端口，任意 cwd 可用。
3. CLI 不实现 server/lifecycle/config 语义；只把 typed command intent 分发给对应 owner。
4. 禁止把端口硬编码到子命令名、路由名、manifest 默认值；缺配置时用 V4 默认路径 `~/.rcc/config.v4.toml` 或显式 `-c`，并显式报错。
5. 增加 CLI 正反测试：未知命令、冲突 flag、空 snapshot stages、任意 cwd help/version、配置缺省解析。

### M3：Config / Manifest

1. 完成 `routecodex-v4-config` authoring -> validate -> registry -> manifest 的独立闭环；manifest 记录 chain version、listen address、candidate/provider/model alias/forwarder、digest。
2. `config check` 使用真实 manifest；`manifest_digest` 漂移、未知字段、secret 进 manifest 全部 fail-fast。
3. 支持 V3 等价的前向模型语义：入口 model 与 provider wire model 分离，alias/forwarder 只作为 manifest 声明，由 VR 消费；禁止 CLI 猜测替换。
4. 增加 `rccv4 config check` 黑盒测试与任意 cwd 测试。

### M4：Lifecycle

1. 新增或收口 V4 lifecycle owner：PID file、state dir、socket/lock、managed child、graceful shutdown、exec restart。
2. `rccv4 start` 支持任意 cwd；启动后打印可观测输出，且由 managed 流程维护，不依赖调用者 cwd。
3. `rccv4 restart` 只重启 V4 独立 aggregate instance 一次，再验证该实例全部 listener；禁止逐端口循环 restart。
4. `stop` 显式等待、显式超时；错误不静默降级。
5. lifecycle 状态不进入 provider/client payload；PID/socket/state 属于 V4 独立 runtime state，不与 V3 共用。
6. 增加 lifecycle 正反测试：start/status/restart/stop、锁冲突、超时、stale PID、任意 cwd。

### M5：Server / Pipeline 接线

1. 真实 server 使用 `routecodex-v4-server` listener，请求进入 SkeletonRuntime/插件链，禁止 admission handler 旁路。
2. 支持 `/health`、`/v1/models`、`/v1/responses`；后续按 V3 对齐补齐 chat/messages 入口时走同一 pipeline。
3. 请求/响应/错误三链显式分离；provider wire 只由 provider runtime/transport owner 处理。
4. 增加真实 HTTP/SSE 黑盒测试与 `/health` 版本检查。

### M6：Global Install / Logs / Console

1. 构建 release `rccv4`，全局安装到 `~/.local/bin/rccv4`，codesign 后验证 hash 与版本。
2. 任意 cwd 验证 `rccv4 --version`、`--help`、`config check`、`start --snap`。
3. 日志输出插件化：managed console 可观测，另有 `~/.rcc/logs/rccv4.log`；`--debug`/`--sse-dump` 不写业务 payload 到正常响应。
4. 安装/重启/在线真实请求证据：health、JSON、SSE、provider 真实返回，不使用 mock。

### M7：Maps / Gates / Review

1. 注册 CLI、lifecycle、server、provider、router、runtime-bin 的 module owner、function map、mainline call map、verification map。
2. 把新增 gate 接进 `verify:ci`，禁止只存在于文档。
3. 完成后按项目顺序做 build、install、restart、live replay，再跑 DSH review；review 后改动必须重跑。

## 验证矩阵

| 类别 | 最小验证 |
|---|---|
| CLI 定向 | `cargo test -p routecodex-v4-cli-plugin --locked`；任意 cwd help/version/config check |
| Config | `rccv4 config check -c <v4-config>`；manifest digest 校验 |
| Lifecycle | `rccv4 start --snap`、`status`、`restart`、`stop` 从任意 cwd |
| Server | `/health`、`/v1/models`、真实 Responses JSON/SSE |
| Install | `~/.local/bin/rccv4` hash/version；与 V3 二进制互不影响 |
| Gates | V4 `verify:ci`、红测、isolation |
| Live | V4 独立端口真实 provider 请求；V3 listener/config 不变 |

## 完成定义（DoD）

- `rccv4` 全局安装、任意 cwd 可解析/启动/管理；V3 CLI 命令面全部对齐或显式登记差异。
- 无硬编码端口、无路由名带端口、无 mock provider。
- config 是唯一真源，manifest digest 可验证；runtime 不扫描 authoring 目录。
- server/provider 真实可跑，响应链和请求链均通过 V4 pipeline，不靠 admission handler 旁路。
- 全部 map/gate/CI 同步；DSH 无 P0/P1 语义 PASS。

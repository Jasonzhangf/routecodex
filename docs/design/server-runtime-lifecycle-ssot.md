# Server Runtime Lifecycle SSOT（无 pid 文件真源设计）

本文定义 RouteCodex 本地 server runtime 的生命周期真源设计与落地。审计起点：`~/.rcc` 根目录散落 16 个 `server-<port>.pid`、5 个 `daemon-stop-<port>.json`、12 个 `token-stats.json.tmp-*`、3 个 `config.toml.bak-*`、2 个 `config.<provider>.toml`，且 13/16 pid 对应进程已死；`daemon-stop` 全部超过 60s TTL 但未被消费或清理。结论：pid 文件是“辅助索引”而非真源，daemon-stop 缺独立 reaper。修复目标是把运行时真相从“文件系统散落”改成“控制面 + 实例 registry + port/identity 探测”，让 pid 不再是必需输入。

## 1. 原则

1. **进程身份不属于文件系统真相**。pid 是 OS 进程属性，需要发信号时动态解析。`server-<port>.pid` 只作为 cache，不作为真源；缺失不应报错，过期必须清理。
2. **生命周期真相来自控制面**。HTTP server 的 `start/stop/restart/status` 由 `/health` 与 `/shutdown` 控制面表达；guardian 作为多实例的 owner 时，再以 control plane 表达。
3. **端口 + identity 是存活的唯一证明**。判定 server 状态：先 HTTP `/health`；连接失败再 `lsof -iTCP:<port> -sTCP:LISTEN` 拿 listener 集合；对每个 listener pid 调 `ps -o command=` 做 trusted RouteCodex 判定；命中即 `running`，不命中即 `port-conflict`。
4. **状态文件按功能分层**，禁止散落在根目录。`run/` 放运行态瞬时 cache；`state/runtime-lifecycle/` 放实例 registry 与 stop intent；`state/backups/` 放历史 snapshot；`config/archive/` 放历史 config。根目录只留真源。
5. **每个受管端口只允许一个 instance 声明**。同一端口不允许多个 pid cache 叠加；冲突时 stop 全部、走 start 重建。
6. **stop intent 必须有 reaper**。`daemon-stop-<port>.json` 是 cross-process 信号，不是状态真相。它必须带 TTL，独立 reaper 必须在 TTL 内消费或清理。

## 1.1 Session Dir Clarification

- `ROUTECODEX_SESSION_DIR` is a runtime workdir root, not a semantic `sessionId`.
- 合法 owner 只有 runtime bootstrap / runtime filesystem modules，例如：
  - `src/server/runtime/http-server/session-dir.ts`
  - `src/server/runtime/http-server/port-registry.ts`
  - `src/server/runtime/http-server/session-client-registry.ts`
- 这些 owner 只负责“当前 server instance 的工作根目录放哪里”，不得借目录名推导 `tmuxSessionId / sessionId / conversationId` 语义。
- `session-client-registry.ts` 若在该 workdir root 下保存 `session-bindings.json`，其语义也仅限 tmux/client attachment 与 `conversationSessionId -> tmuxSessionId` runtime lookup；它不是 request session 真源，也不是 protocol-independent continuation store。
- `session-bindings.json` 的生产 owner 现在也必须由 runtime bootstrap 显式注入 store path；`SessionClientRegistry` 不再作为生产路径 owner 自己从功能链里推断哪个 `sessionDir` 才是当前实例真源。
- stopless / CLI / routing-state 等功能链路如果需要 `sessionDir`，只能从 runtime metadata carrier 显式传递；禁止在功能链路内部再从 env 回填 metadata，也禁止从 metadata 顶层字段回填 `__rt.sessionDir`。截至 2026-06-17，`routing_state_store.rs` 里的 `ROUTECODEX_SESSION_DIR` storage override 已物理删除，底层 routing-state owner 只接受显式 override 或 canonical `~/.rcc` 路径。

## 2. 目标目录布局

```text
~/.rcc/
├── config.toml                              # 唯一真源配置
├── config/archive/                          # 历史 config (从根目录 / config/ 收口)
├── provider/<id>/config.v2.toml             # provider 真源
├── auth/                                    # 已存在
├── quota/                                   # 已存在
├── servertool/                              # 已存在
├── docs/                                    # 已存在
├── precommand/default.sh                    # 已存在
├── install/current -> releases/<...>        # 已存在
├── state/
│   ├── runtime-lifecycle/
│   │   ├── ports/<port>/instance.json       # instance registry（声明 + status）
│   │   ├── ports/<port>/stop-intent.json    # stop intent（cross-process signal）
│   │   └── ports/<port>/pid.cache           # 短期 cache（可选，TTL=启动期）
│   ├── responses-continuity/                # 已存在
│   ├── router/                              # 已存在
│   ├── routing/                             # 已存在
│   ├── quota/                               # 已存在
│   ├── token-manager/                       # 已存在
│   ├── windsurf/                            # 已存在
│   ├── provider-traffic/                    # 已存在
│   └── backups/                             # 已存在
├── run/
│   ├── pids/                                # 进程 pid cache（短期、可删、不参与真源）
│   ├── guard/                               # guardian socket/lock（仅 guardian 模式使用）
│   └── config/                              # merged-config 等派生快照
├── logs/                                    # 已存在（含 log rotate）
└── codex-samples/                           # 已存在（采样本）
```

**禁止的根目录内容**：

- `server-<port>.pid`（迁移到 `state/runtime-lifecycle/ports/<port>/pid.cache` 或 `run/pids/server-<port>.pid`）
- `daemon-stop-<port>.json`（迁移到 `state/runtime-lifecycle/ports/<port>/stop-intent.json`）
- `config.dbittai.toml` / `config.long.omlx.toml`（已迁 config.v2 体系，移入 `config/archive/`）
- `config.toml.bak-*`（移入 `config/archive/`）
- `windsurf-ls/` / `windsurf-workspaces/` / `rcc-protocols/`（迁出 `~/.rcc` 顶层，挂 `integrations/<tool>/`）

## 3. 生命周期阶段

```text
declare  -> bind  -> ready  -> healthy  -> degraded  -> shutdown-intent  -> stop  -> released  -> released-cleaned
```

- `declare`：调用方声明要起一个 server instance。owner = `src/cli/commands/start.ts` 或 guardian。registry 写入 `state/runtime-lifecycle/ports/<port>/instance.json`。
- `bind`：server 进程创建 socket，端口开始 LISTEN。状态由“identity 探测”确认。
- `ready`：HTTP `/health` 200 且 `pipelineReady=true`。
- `healthy`：业务正常服务。
- `degraded`：`/health` 失败但端口仍 LISTEN 且 listener 是 trusted RouteCodex。`restart` 路径必须显式定义 transition，不靠 stale pid 推断。
- `shutdown-intent`：调用方写入 `stop-intent.json`。`maxAgeMs=60s` 内必须被 server 消费。
- `stop`：server 主动退出或被显式 SIGTERM。pid cache 立刻 unlink。
- `released`：端口不再 LISTEN。
- `released-cleaned`：instance registry 归档或删除，pid cache 清理完成。

## 4. 状态判定（无 pid 文件也能跑通）

`rcc status --port 5555`：

1. GET `http://127.0.0.1:5555/health`。
   - 200 且 identity = RouteCodex → `running`。
2. 连接失败或非 200：
   - `lsof -nP -iTCP:5555 -sTCP:LISTEN -t` 拿 listener pid 集合。
   - 集合为空 → `stopped`。
   - 对每个 pid 跑 `ps -p <pid> -o command=`，做 trusted RouteCodex 判定（`routecodex/dist/index.js` / `install/current/dist/index.js` / `install/releases/routecodex-.../dist/index.js`）。
   - 命中 trusted → `degraded`。
   - 全部不命中 → `port-conflict`（不杀、不重试，fail-fast 报错给用户）。

`rcc stop --port 5555`：

1. 写 `state/runtime-lifecycle/ports/5555/stop-intent.json`（TTL=60s）。
2. POST `http://127.0.0.1:5555/shutdown`（带 caller audit headers）。
3. 等待端口释放（最多 `STOP_WAIT_MS=8000`）。
4. 端口已释放 → `stopped`，清理 instance registry + pid cache。
5. 端口未释放：
   - listener identity 重新判定。
   - trusted RouteCodex → `managed-stop-timeout`，显式报给用户，不靠 stale pid 重杀。
   - 非 trusted → `port-conflict`，不杀。

`rcc restart --port 5555`：

1. `status(port)`。
2. `stopped` → fail-fast 提示先 `start`；`restart` 不负责新建 detached session。
3. `running` / `degraded` → 请求现有进程重启：优先 `/daemon/restart-process`，否则只对目标 listener pid 发 `SIGUSR2`。
4. 受管 `start` parent 存在时，server child 以 restart code `75` 退出，由原 parent supervisor 在原 session 内重新拉起 child。
5. `port-conflict` → fail-fast 报 `port-conflict`，要求用户手动处理。
6. 禁止 `restart` 命令自行 spawn `start --restart` 接管；版本落后也必须通过原进程/原 supervisor 重启。
7. install/release 验证也不得用 `start --restart` 或 `/shutdown` 接管旧 runtime；live runtime 存在时只能调用 `rcc restart`，重启后版本仍不匹配则显式失败。

`rcc start --restart --port 5555`：

1. 这不是 restart transport。若目标端口/端口组已有 listener 或健康 RouteCodex runtime，必须在写 stop-intent 和调用端口释放逻辑之前 fail-fast。
2. 用户需要原 session 内重启时使用 `rcc restart --port 5555`。
3. 只有目标确认处于 stopped/free 状态时，`start` 才能继续 launch；若需要显式停止，必须走 `rcc stop` 或明确 destructive/exclusive 流程。

`rcc start --port 5555`：

1. `declare` instance → 写 registry。
2. spawn server child process。
3. server 内置 HTTP `/health` + `/shutdown`。
4. server 启动后异步写 `state/runtime-lifecycle/ports/5555/pid.cache`（best-effort）。
5. server 退出（无论成功/异常）必走 cleanup hook，删除 pid cache。

## 5. PID 文件降级

### 5.1 物理位置

- 受管 server instance：`<rccUserDir>/state/runtime-lifecycle/ports/<port>/pid.cache`。
- guardian：`<rccUserDir>/state/runtime-lifecycle/guardian/guardian.pid`（仅 guardian 模式）。

### 5.2 行为约束

- pid.cache 是“上一刻观察”的 cache，**不**作为真源。
- pid.cache 缺失不报错；pid.cache 与当前 listener identity 不一致立即清理。
- 同一端口只允许一个 pid.cache；start 路径在 spawn 前必须先 rm 旧 cache。
- pid.cache 写入异步完成；server exit（`SIGTERM` / uncaughtException / `process.exit`）必须 best-effort unlink。
- 老位置 `<rccUserDir>/server-<port>.pid` 视为 stale；CLI 启动时 best-effort 迁移或删除。

### 5.3 读取路径改造

- 所有 `readFile(server-<port>.pid)` 改为先 `lsof` port，再读 `pid.cache`，二者交集取 trusted。
- `cleanup-stale-server-pids.mjs` 改为扫描 `state/runtime-lifecycle/ports/*/pid.cache` 与根目录 stale 文件。

## 6. daemon-stop-intent 收口

- 路径：`state/runtime-lifecycle/ports/<port>/stop-intent.json`。
- TTL：60s。
- reaper：每次 `rcc start / stop / status / restart` 进入时扫描所有 stop-intent，过期者 unlink；同时启动一次性 1s 定时器扫所有 instance。
- `start` 写入前必须先 `consume`（删除）；`consume` 命中 TTL 内记录则不再起新 server，进入 stop 流程。

## 7. tmp / bak / archive 收口

- `config.toml.bak-*`：迁 `config/archive/`，按 `config.toml.bak-<UTC>.toml` 命名。
- `config.<provider>.toml`（dbittai / omlx 等已迁 v2 的）：迁 `config/archive/legacy-variants/`。
- `windsurf-*` / `rcc-protocols/`：迁出 `~/.rcc`，挂 `~/rcc-protocols/`、`~/.rcc/integrations/<tool>/` 或外部 dir，由各自 skill 真源管理。

## 8. 真源唯一性

- 真源：HTTP `/health` + listener identity + instance registry。
- 辅助源：pid cache（短期）。
- 删除：根目录所有 pid、daemon-stop、tmp、bak。
- 物理删除铁律：迁出后旧的 `server-*.pid`、`daemon-stop-*.json` 必须从代码路径中删除读取/写入逻辑，不得保留“以防万一”的 fallback。

## 9. 改动 owner 与边界

| 改动 | 唯一 owner | 禁止改 |
|---|---|---|
| pid 写入/读取 helper | `src/utils/server-runtime-pid.ts`（新建） | `src/index.ts` 直写 `path.join(home, "server-...")` |
| stop intent 路径 | `src/utils/server-runtime-stop-intent.ts`（重命名自 `daemon-stop-intent.ts`） | 散落字符串拼接 |
| instance registry 路径 | `src/utils/runtime-instance-registry.ts`（新建） | 各 CLI 命令自写 |
| 老路径迁移脚本 | `scripts/runtime-migrate-legacy-paths.mjs` | 业务模块散改 |
| 红测 | `tests/utils/server-runtime-pid.spec.ts`、`tests/utils/server-runtime-stop-intent.spec.ts`、`tests/utils/runtime-instance-registry.spec.ts`、`tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts` | 复制到其他目录 |
| 验证 gate | `npm run verify:runtime-lifecycle-pid-rebase`（新建） | 手工执行 |

## 10. 验证口径

- 老路径在 `~/.rcc/` 根目录不再出现任何 `server-*.pid` / `daemon-stop-*.json` / `token-stats.json.tmp-*`。
- 新路径下，start 路径生成 pid.cache，server exit 路径 unlink，stop 路径必消费 stop-intent，reaper 清理 TTL 过期 stop-intent。
- 红测先红后绿：先写一个 grep 根目录禁止路径的 red test，确认当前根目录命中为红；改造后该 red test 必绿。
- 真实运行回归：`rcc start --port 5555`、`rcc status --port 5555`、`rcc stop --port 5555`、`rcc restart --port 5555` 全部跑通，lsof identity 命中 trusted RouteCodex。
- Live probe：`curl /health` 200，`POST /shutdown` 200，端口在 `STOP_WAIT_MS` 内释放。

## 11. 反模式 / 边界

- ❌ 根目录再出现 `server-*.pid` / `daemon-stop-*.json` / `token-stats.json.tmp-*` / `*.bak`。
- ❌ pid 文件被当成“判断 server 是否在跑”的真源。
- ❌ start 路径不写 stop intent 消费；stop intent 永久残留。
- ❌ 一端口多 pid 文件并存；多进程共享同一端口。
- ❌ pid 文件的清理靠 `pkill` / `killall` / `lsof | xargs kill`。
- ❌ 把老 `~/.routecodex` 与新 `~/.rcc` 混用（迁移必须一次完成）。

## 12. 与现有契约的关系

- `src/config/user-data-paths.ts` 的 `RCC_SUBDIRS` 必须新增 `runtimeLifecycle` = `state/runtime-lifecycle`，并提供 helper。
- 任何 `resolveRccPath` 调用者读/写 `state/runtime-lifecycle/...` 必须经过 helper，禁止散写。
- `npm run verify:architecture-forbidden-path-growth` 必须把 `state/runtime-lifecycle/ports/<port>/pid.cache` 加入允许白名单，把 `<rccHome>/server-*.pid` / `<rccHome>/daemon-stop-*.json` 加入禁止路径。
- `function-map.yml` 与 `verification-map.yml` 必须新增 `feature_id: runtime.lifecycle.pid_cache`、`feature_id: runtime.lifecycle.stop_intent`、`feature_id: runtime.lifecycle.instance_registry`。

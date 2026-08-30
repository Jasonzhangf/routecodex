# V3 执行生命周期、控制/负载与持久化隔离：执行方案

状态：执行中；Phase 0-4 源码整改与定向验证已完成，Phase 5 全链/live/review 待完成

基线：`db0715925cdb7cd5c3d8e09b1d6b8f20f3738ca0`

唯一工作树：`/Users/fanzhang/Documents/github/routecodex/playground/v3-arch-audit`

唯一分支：`codex/v3-execution-control-audit`

问题合同：`docs/goals/v3-execution-control-payload-architecture-audit-problem.md`

目标设计：`docs/goals/v3-execution-control-payload-architecture-audit-design.md`

## 1. 目标与验收标准

### 主目标

在一个独立 worktree 内完成 V3 跨模块整改：统一 request/attempt 生命周期，Direct/Relay 共用有界 attempt store，控制读取与 payload/diagnostics 解耦，失败归属保持 typed，健康与观测持久化退出全局锁和请求热路径，并用真实 TCP、容量、错误归属、门禁 mutation、global install/live replay 证明闭环。

### 最低验收

| 场景 | 必须证明 |
| --- | --- |
| Direct 持续非终态 frames | append 前命中 byte/frame/request/global admission；无无限驻留 |
| 多请求并发大响应 | process-global resident bytes 有硬上限，额度释放无泄漏 |
| provider 中途失败后真实 TCP SSE 替代 | 同一常驻 Runtime 驱动到协议终态；无临时 Runtime |
| Direct↔Relay 多次 transition | 同一 request context、TargetPlan、attempt/deadline budget；VR 不重入 |
| HTTP 2xx 后 SSE 失败 | 未产生 success receipt，不恢复健康、不 commit route/continuation |
| 成功终态后 client disconnect | provider success 保持；delivery 单独关闭；不反向惩罚 provider |
| buffer/observation/persistence failure | 内部 598/599；不构造 provider 502、不扣 health |
| 大量 terminal queries | 不 clone raw SSE/完整 diagnostics；成本与 payload 大小无关 |
| health/ledger persistence 抖动 | request/health lock 临界区无磁盘 I/O；队列/错误显式可见 |
| 长期 request records | active/recent memory、queue、file hard cap、bounded startup load 均有边界；本批次不自动删除历史 |
| test module 后生产违规 | module gate 必须识别 |
| full-attempt marker 假实现 | mutation gate 必须失败 |

## 2. 范围与边界

### In scope

- `routecodex-v3-runtime`：request context、attempt controller、Direct/Relay attempt store、handoff、success receipt、control/diagnostics split、typed failure attribution。
- `routecodex-v3-provider-responses`：health mutation与锁外 persistence writer。
- `routecodex-v3-server` / `routecodex-v3-debug` / `routecodex-v3-config` / Admin：observability event、storage owner、retention/rotation/page query、Config path/policy-only。
- resource/function/mainline/module/verification maps、manifest、wiki/HTML review surface、test design、red fixtures、CI/build wiring。
- global binary build/install、唯一 managed aggregate restart、真实旧样本/受控 TCP replay、AGY review、定向 commit/push。

### Out of scope

- 改为增量业务 token commit。
- 修改 provider route priority、provider config、真实凭据或客户端 payload。
- 新 provider、新协议、Stopless/servertool/continuation 语义扩展。
- 文件/模块机械拆分。
- 无证据的磁盘 spill、fallback、双路径兼容。
- 删除历史样本、清理其他 worktree/claim、reset/checkout/stash。

## 3. 执行前硬门禁

### 3.1 Claim/并发协调

当前基线存在可能重叠的旧 claim：

- `v3.responses_direct_full_attempt_commit`
- `resource_id:v3.responses_direct.client_sse_stream`
- `v3.module_decomposition`
- `v3.request_record_store_and_query_projection`
- `resource_id:v3.provider.health_state`

执行 worker 必须刷新 owner、heartbeat、events、handoff、merge queue 与 live agents。未证明 stale 或拿到 checked handoff 前，不得覆盖其 runtime 语义。跨 claim 只能在本工作树按以下顺序接管/协调；禁止另建第二个实现 worktree。

### 3.2 架构 admission

第一笔 runtime edit 前必须：

1. 把本目标拆成 active feature/resource IDs；不能继续以一条模糊 cross-cutting owner 覆盖所有模块。
2. 更新 `v3-resource-operation-map.yml`、`v3-function-map.yml`、`v3-mainline-call-map.yml`、`v3-runtime-module-registry.yml`、`v3-verification-map.yml`。
3. 每个 entry symbol、allowed/forbidden path、相邻 edge、resource read/write、positive/negative gate 可反查。
4. `design` / `binding_pending` 不得当实现真源；先补 source anchor 和 red gate，再改 runtime。
5. 生成 Markdown + dedicated HTML wiki review surface与 machine-readable manifest；浏览器 smoke 通过。

## 4. 技术方案与候选文件

文件清单是 owner discovery 起点，不是预授权修改列表；实际改动必须以 admission 后 map 为准。

### Execution/attempt

- `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`
- `v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs`
- `v3/crates/routecodex-v3-runtime/src/kernel.rs`
- `v3/crates/routecodex-v3-runtime/src/nodes.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs`
- existing provider failure runtime policy / Error05 consumers
- focused runtime tests and controlled TCP integration tests

### Provider health persistence

- `v3/crates/routecodex-v3-provider-responses/src/health.rs`
- `v3/crates/routecodex-v3-provider-responses/src/global_cooldown.rs`
- provider health contract/probe/persistence tests

### Observability persistence

- `v3/crates/routecodex-v3-server/src/webui_observability.rs`
- `v3/crates/routecodex-v3-debug/src/observability_store.rs`
- `v3/crates/routecodex-v3-debug/src/*` 或 admission 后登记的唯一 storage owner
- `v3/crates/routecodex-v3-admin/src/api/observability.rs`
- WebUI/retention/rotation/page query tests

### Gates/docs

- `v3/scripts/architecture/verify-v3-direct-sse-full-attempt-commit.mjs`
- `v3/scripts/architecture/verify-v3-module-boundaries.mjs`
- red fixture scripts、package/CI/build wiring
- `docs/architecture/v3-*.yml`
- direct SSE manifest/wiki与本目标 dedicated review surface
- 现有矛盾 test-design 文档

## 5. 分阶段实施

### Phase 0 — 合同、历史与红测锁定

1. 固化问题源提交：handoff `205ca8337`，full-attempt buffer `19a122ba8`，terminal snapshot `1858125d1`，request ledger `6e7ad4a5b`；检查中间修复是否改变合同。
2. 为每条 finding 建立最小 reproduction/test design，区分已静态确认与需动态证明。
3. 统一 atomic full-attempt 文档；删除“first business frame authorizes incremental commit”旧语义。
4. 落 active resource/feature/mainline/verification contracts与 dedicated wiki/manifest/HTML。
5. 先写并确认以下 red：
   - real TCP handoff Runtime lifetime；
   - Direct unbounded bytes/frames；
   - global concurrent reservation；
   - wrapper executor/Runtime/VR reentry static mutation；
   - early success/route commit；
   - terminal snapshot large-copy instrumentation；
   - local failure错误归属；
   - health lock内 persistence；
   - WebUI lock内 append与无 retention；
   - module gate test-module-tail blind spot；
   - marker-only full-attempt fake implementation。

出口：maps/gates/source anchor 绿；所有目标 red 在基线按预期失败；不得提前改 runtime。

### Phase 1 — 生命周期唯一 + bounded attempt store（第一交付批次）

1. 提炼/复用一个 bounded attempt store，Direct/Relay 接同一接口。
2. 加 per-attempt、per-request、global、deadline reservation；append/copy 前 admission，所有路径 RAII 释放。
3. 建一份 request-local execution context与 immutable TargetPlan/payload/config handles。
4. 把 Direct SSE handoff 改为同一 controller 内 Error05 state transition。
5. 删除 `spawn_blocking`/OS thread/current-thread Runtime与完整 executor重入。
6. 替换 `Option<Stream>` 为完整 typed AttemptOutcome。
7. 确认 Direct/Relay transition 不重入 VR、不重置 failed candidates/attempt budget。
8. 物理删除旧 `V3DirectSseAttemptBuffer` 与重复 retry controller。

出口：真实 TCP替代流到终态；容量/并发/timeout正反测试通过；无旧 symbol/Runtime创建路径。

### Phase 2 — success receipt + typed failure ownership（第二交付批次）

1. 协议 terminal + seal 唯一产生 `AttemptSuccessReceipt`。
2. provider health success、route policy commit、continuation commit只消费 receipt。
3. client delivery receipt独立；disconnect不反向改变 provider attempt truth。
4. local resource、observation、persistence、client cancel、upstream/protocol failure保持 typed attribution进入 Error01→06。
5. 删除 local error→`V3ProviderError::ResponseBody` 与提前 success/commit 分支。
6. compat owner编译 typed plan；execution skeleton删除具体 profile字符串判断。

出口：success/failure矩阵正反全绿；598/599/外部 provider 状态码与 health side effects精确。

### Phase 3 — control/diagnostics split（第三交付批次）

1. 拆 `AttemptControlState` 与 `StreamDiagnostics`。
2. terminal query只读取 small state；per-frame路径禁止 full snapshot clone。
3. raw SSE capture保持有界，snapshot只在 explicit debug/export边界构造。
4. observation failure独立记录，不改变 attempt/provider truth。
5. 添加 payload-size-independent terminal query benchmark/operation counter gate。

出口：2 MiB raw SSE与空 diagnostics条件下 terminal query操作量/分配无负载相关增长。

### Phase 4 — persistence isolation（第四交付批次）

1. provider health mutation在短锁内产生 generation/delta；锁外单 writer coalesce/persist。
2. 相同 generation/content不重复写；队列、writer error、shutdown flush有显式 receipt。
3. WebUI request ledger改为 typed event + bounded queue + single writer。
4. 内存拆 active + bounded recent terminal；历史达到 file hard cap 时 append 前 fail-fast；startup只读 bounded recent window。
5. runtime observability I/O从 Config移到登记 owner；Config只留 path/policy manifest。
6. 写盘失败不得改变请求成功、route、health；独立 internal alarm/error resource。

出口：磁盘延迟/失败注入下请求控制锁不等待 I/O；memory/file/startup load均有硬边界。

### Phase 5 — Gate 强化、全链验证、交付

1. full-attempt gate从 marker检查升级为行为/mutation/type gate。
2. module gate使用 Rust item-aware scan或正确 test-module span removal；添加“test模块后生产代码”红 fixture。
3. gate接入 `verify:v3-architecture-ci`、build/install preflight与 CI；缺接线即红。
4. 运行完整验证栈、global install、唯一 aggregate restart、全部配置端口 health、旧样本/同入口 live replay。
5. 在线证据完成后才启动 AGY review；P0/P1 必须修复并重跑受影响全闭环。
6. controller PASS 后定向 stage，检查 cached stat/name-status，只提交本目标路径；证明 HEAD=push commit 后 push。

## 6. 测试计划

### 6.1 白盒/组件

- attempt append exact limit、limit+1、frame limit、deadline、reservation release。
- global budget并发 admission；失败请求释放；cancel/panic/drop释放。
- terminal receipt无法从 headers/status/stream handle创建。
- Error05 witness缺失时 handoff fail-fast。
- non-SSE replacement outcome保留完整语义。
- terminal control read allocation/clone counter不随 raw SSE增长。
- local/observation/persistence/client/provider failure分类与 health side effect矩阵。
- health generation/coalesce/single writer/queue full/disk failure/shutdown。
- ledger active/recent bounds、file hard cap、bounded startup window、queue full。

### 6.2 模块黑盒

- Direct Responses、OpenAI Chat、Anthropic各一条完整终态。
- Direct partial/non-terminal/network EOF → same-plan replacement。
- Direct↔Relay多次 transition，共享总 budget/deadline。
- Relay local buffer limit不切 provider。
- success terminal后client disconnect health-neutral/delivery-failed。
- provider真正失败仍按 Error05 health policy执行。

### 6.3 真实 TCP/HTTP

必须用本地 TCP listener + chunked/SSE真实 socket，不得只用 `stream::iter`：

1. provider A响应 headers + frames后中断。
2. provider B由同一 resident Runtime连接，延迟发送多帧与terminal。
3. client最终只收到 B完整 attempt；A bytes为零。
4. 测试期间记录 Runtime/request/attempt IDs，证明无新 Runtime/new request lifecycle。
5. 慢磁盘/写盘错误注入不阻塞 attempt controller锁。

### 6.4 Gate/Mutation

- 删除byte increment或先append后check → 红。
- 恢复`new_current_thread`/完整executor call → 红。
- terminal read改回snapshot → 红。
- local error改回provider ResponseBody → 红。
- success在receipt前调用 → 红。
- module违规放在`#[cfg(test)] mod tests`后 → 红。
- runtime ledger I/O放回Config或锁内flush → 红。
- CI/build移除gate wiring → 红。

### 6.5 Live closeout

顺序不可变：

```text
focused red/green
  -> affected crate/workspace tests
  -> architecture/resource/module/gate suite
  -> release build + global install
  -> installed binary hash/version
  -> one `routecodex restart`
  -> every configured member `/health`
  -> exact old failure samples / same-entry real replays
  -> concurrency/residency evidence
  -> AGY review
  -> precise commit/push
```

禁止 `server stop/start`、手动 foreground start、逐端口 restart、repo-local binary冒充交付。

## 7. 风险与规避

| 风险 | 规避 |
| --- | --- |
| 跨 active claim 冲突 | Phase 0 checked handoff；未获 ownership不改同一语义 |
| 统一 controller变成新巨型抽象 | 留在 Runtime现有骨架；只提炼两条生产路径真实共享的state/store/outcome |
| global budget选值拍脑袋 | 先收并发/响应分布证据；compiled manifest显式默认；压力测试证明 |
| atomic commit首字延迟 | 保持已声明取舍；keepalive transport-only；不偷偷改增量模式 |
| queue异步化变silent drop | queue full/disk failure显式 typed alarm/error；无 fallback |
| observation failure影响业务 | diagnostics独立；不得改 request outcome/health |
| persistence crash丢状态 | generation、atomic replace、shutdown receipt、restart recovery成对测试 |
| 大改造成双路径 | 每个新owner接线后立即物理删除旧实现；static red锁旧symbol |
| 测试绿但旧binary在线 | 安装hash/version/health三点一致后才live结论 |

## 8. 完成定义（DoD）

全部满足才可关闭：

1. 问题文档每条 finding有根因、首次偏离、唯一 owner、正反证据。
2. resource/function/mainline/module/verification maps全部 active、source-bound、CI/build-wired；无目标条目停在 `design/pending`。
3. Direct/Relay共用唯一 bounded attempt store与request-level controller；旧 buffer/重入 executor/临时 Runtime物理删除。
4. attempt/request/global/deadline预算有强制 admission与释放证明。
5. health/route/continuation成功只消费同一 success receipt。
6. control terminal query与payload/diagnostics体积无关。
7. 本地/观测/持久化/client/provider错误归属准确，598/599/外部码与health副作用成对锁定。
8. health与ledger磁盘I/O不在控制锁/请求热路径；内存、queue、file、retention、startup load有边界。
9. 真实 TCP handoff、并发大响应、旧错误样本、成功控制样本全部通过。
10. global installed binary、`routecodex --version`、所有 `/health.version` 与目标 commit一致。
11. dedicated Markdown/HTML review surface浏览器验证通过。
12. AGY controller最终 PASS；review后无未重验代码变化。
13. cached stat/name-status只含声明change set，commit/push HEAD一致。
14. run `evidence.jsonl`、handoff/merge record、`note.md`/`MEMORY.md`/skill精华与MemPalace re-mine/search闭环完成。

## 9. 当前执行状态

已完成并取得定向证据：

1. resident Direct lifecycle、共享 request budget、Direct↔Relay typed handoff、统一 bounded attempt store；
2. 真实 TCP SSE reselect、success receipt、local/provider failure attribution、terminal control/diagnostics split；
3. health/ledger lock 外 writer，Debug runtime observability store owner，Config path/policy-only；
4. module gate test-tail 修复、unavailable Direct candidate fallback 删除、active maps/manifest/mutation gates；
5. Provider Action Gate resident caller、pre-commit failure edge与 audit-lock 已按 Jason 本轮授权刷新。

剩余强制顺序：affected build/test与全部可运行 gate → global release install → 唯一一次 `routecodex restart` → 配置全部端口 health → 旧样本/同入口 live replay → AGY review → 精确集成/commit/push。与本 change set 无关的 `v3.codex_sample_retention_snap_scope` 既有 audit-lock 漂移必须单独处理，不能借本任务授权顺带刷新。

# V3 Provider Error Disposition Path Config Plan

Status: design prompt source（实现前需确认）
Created: 2026-08-09
Supersedes scope: 在 `docs/goals/v3-provider-error-unified-interface-contract-plan.md`（2026-07-24，已部分落地）骨架之上做增量演进，不重写其已落地部分。

## 1. 定位与目标

`v3-provider-error-unified-interface-contract-plan.md` 已建立统一骨架：三入口（A direct / B semantic / C hook-codec）→ `ProviderErrorSignal` → `ProviderErrorRulePort::normalize_provider_error_signal(signal, manifest_policy)` → `ProviderErrorExitBundle` → Error01-06 链。其中 semantic 层（HTTP 200 业务诊断）已接入配置编译的 `provider_error_action_policy` / `client_error_projection_policy`。

本 plan 是其处置模型演进，解决一个结构性问题：**当前每个分类只有「单值 action」（retry_mode + 单一 cooldown_ms），无法表达「一类错误先怎样、再怎样、最后怎样」的多步处置；transport 层（4xx/5xx/超时）的 retry budget 与 cooldown 仍是硬编码常量，不在配置面。**

目标形态（用户需求）：

```text
出错走中心 → 分类（特征捕获配置：满足 ABC 条件）→ 处置路径（配置：每一步做什么）
   1. 等待 retry（同 provider / 换 provider：次数、间隔、退避）
   2. 周期冷却（scope、时长）
   3. 返回客户端（status、public code、message mode）
   4. （预留扩展点）
```

验收：

- provider 错误（transport 4xx/5xx + semantic 200 诊断 + hook/codec）全部归一化为 `ProviderErrorSignal`，由 manifest policy 匹配分类。
- 每个命中策略的处置是**有序 steps 链**（`wait_retry` / `cooldown` / `project` 任意组合，参数全部来自配置）。
- transport 层现有硬编码常量（同 provider retry budget=3、cooldown=15min）迁移为配置默认路径，代码中不再出现 `MAX_CONSECUTIVE_FAILURES=3` / `15*60_000` 类魔法常量。
- 现有 `provider_error_action_policy` authoring 配置零破坏（旧单 action 语法归一化为等价单步 path）。
- 硬护栏全部保持（见 §7）：任何 path 不能把错误投影为 HTTP 成功；exhaustion 判定与 default 池不可空仍是中心硬语义；client_disconnect health-neutral。

## 2. 现状与差距清单

| 面 | 现状 | 差距 |
| --- | --- | --- |
| 特征捕获（matcher） | `V3ProviderErrorMatcherManifest`：http_status / provider_code / provider_type_code / terminal_status / finish_reason / usage_total_tokens / input_tokens / output_tokens / choices_count / has_valid_model_output / content_contains_any（`v3/crates/routecodex-v3-config/src/types.rs:1132`） | 无——特征字段已覆盖 transport + semantic 两路证据 |
| 分类（scope+matcher→策略） | 已存在，semantic 层消费 | transport 层（`provider_failure_runtime_policy.rs`）不查询 manifest policy，仍走硬编码分支 |
| 处置（action） | `V3ProviderErrorActionManifest`：kind / reason_code / retry_mode（单值）/ cooldown_ms（单一可选）/ disable_scope（`types.rs:1147`） | 单 action 无法表达多步链；`retry_mode=RetrySame` 无次数/间隔/退避参数 |
| transport 硬编码 | `V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES = 3`（`provider_failure_runtime_policy.rs:29`）；Error03 `duration_ms = 15 * 60_000`（`routecodex-v3-error/src/lib.rs:695`） | 不在配置面，无法按错误类调整 |
| 客户端投影 | `client_error_projection_policy`（reason_code / action_class → public_code / message_mode）已存在 | project step 需能显式携带 status；projection 策略保留为显示层 |

结论：**matcher（特征捕获）与分类骨架已具备；核心增量是把单值 action 升级为有序处置路径，并把 transport 层硬编码接入同一 policy 面。**

## 3. 处置路径模型

一类错误命中一条策略后，得到一条**有序 steps 链**。step 类型：

### 3.1 `wait_retry` — 等待重试

```rust
V3DispositionWaitRetryStep {
    retry_mode: V3ProviderErrorRetryMode,   // RetrySame | ReselectBeforeClientProjection
    max_attempts: u32,                      // 本 step 允许的最大尝试数（含首次失败后的重试）
    backoff_ms: u64,                        // 每次重试前等待
    backoff_multiplier: Option<u64>,        // 可选退避倍数（指数退避），确定性，禁止 jitter
}
```

语义约束：

- `max_attempts` 有界（1..=10）；`backoff_ms` 有界（100..=60_000）；`backoff_multiplier` 有界（1..=10）。
- `retry_mode=ReselectBeforeClientProjection` 的重试目标是当前轮可选池内其他候选；`RetrySame` 重试同一候选。
- 次数耗尽后进入下一步骤；若 path 已结束，进入 Error04/05 中心 exhaustion 判定（见 §7 硬约束，此判定不被配置关闭）。

### 3.2 `cooldown` — 周期冷却

```rust
V3DispositionCooldownStep {
    scope: V3ProviderErrorActionScope,      // ProviderInstance | AuthKey | ProviderModel
    duration_ms: Option<u64>,               // 有界（1_000..=86_400_000）；与 until_restart 二选一
    until_restart: Option<bool>,            // true = disable_until_restart 语义
}
```

语义约束：

- `duration_ms` 与 `until_restart` 恰好二选一；`until_restart=true` 时恢复只靠进程重启。
- 同 scope 至多一个 cooldown step。
- 写入进程内 provider health 状态（`V3ProviderHealthStore`），重启必须清空（既有事实，见 AGENTS.md 当日事实 2）。

### 3.3 `project` — 返回客户端

```rust
V3DispositionProjectStep {
    status: u16,                            // 编译校验 >= 400
    reason_code: String,                    // 稳定 reason code（进 observability + projection matcher）
    public_code: Option<String>,            // 覆盖默认 client_error_projection_policy 的 public_code
    message_mode: V3ClientErrorProjectionMessageMode,
}
```

语义约束：

- 必须且只能出现在 path 末尾。
- `status >= 400` 为编译期强制（`debug_assert!(status >= 400)` 保留为运行时兜底）。
- 只作用于 Error06 显示层；不得反向影响 Error02/03/04/05 或 health（既有硬锁）。

### 3.4 路径级规则（编译校验）

- 至少 1 步，至多 5 步；`project` 必须唯一且在末尾。
- `kind`（`recoverable_no_penalty` / `disable_until_restart` / `periodic_recovery`）**不再单独 authoring**，由 path 编译期推导并投影（供 `client_error_projection_policy.match.action_class` 与 observability 兼容使用）：
  - path 只有 `wait_retry` 且无 cooldown → `recoverable_no_penalty`
  - path 含 `cooldown{until_restart:true}` → `disable_until_restart`
  - path 含 `cooldown{duration_ms}` → `periodic_recovery`
- 推导冲突（如 `until_restart` 与非末端 project 并存）为编译错误。

## 4. Authoring 配置 Schema 草案

`config.v3.toml` `[error]` 段。主形态（path）：

```yaml
[error.provider_error_action_policy]
policies = [
  {
    policy_id = "glmrelay_openai_200_diagnostic_zero_usage",
    scope = { provider_id = "glmrelay_openai", provider_type = "openai_chat" },
    match = {
      http_status = 200,
      finish_reason = "stop",
      usage_total_tokens = 0,
      content_contains_any = ["mac超负荷运载，应该是挂了"],
    },
    path = [
      { step = "wait_retry", retry_mode = "reselect_before_client_projection",
        max_attempts = 2, backoff_ms = 500, backoff_multiplier = 2 },
      { step = "cooldown", scope = "provider_model", duration_ms = 300000 },
      { step = "project", status = 503, reason_code = "provider_temporarily_unavailable",
        message_mode = "code_only" },
    ],
  },
  {
    policy_id = "common_401_auth_denied",
    match = { http_status = 401 },
    path = [
      { step = "wait_retry", retry_mode = "reselect_before_client_projection",
        max_attempts = 3, backoff_ms = 1000 },
      { step = "cooldown", scope = "auth_key", until_restart = true },
      { step = "project", status = 502, reason_code = "provider_auth_denied",
        public_code = "E_PROVIDER_AUTH_DENIED", message_mode = "code_only" },
    ],
  },
]
```

兼容形态（旧单 action 语法，归一化为等价单步/双步 path，零破坏）：

```yaml
# 旧语法：kind + retry_mode + cooldown_ms 仍接受
{
  policy_id = "...",
  scope = {...},
  match = {...},
  action = { kind = "periodic_recovery", reason_code = "...",
             retry_mode = "reselect_before_client_projection",
             cooldown_ms = 300000, disable_scope = "provider_model" },
}
```

归一化映射：

- `action.retry_mode = RetrySame` → `[wait_retry{RetrySame, max_attempts=1, backoff_ms=0}]`（语义：同候选重试 1 次，立即）
- `action.retry_mode = ReselectBeforeClientProjection` → `[wait_retry{Reselect, max_attempts=1, backoff_ms=0}]`
- `action.cooldown_ms = Some(ms)` → 追加 `[cooldown{scope=disable_scope, duration_ms=ms}]`
- `action.kind = DisableUntilRestart` 且无 cooldown_ms → 追加 `[cooldown{scope=disable_scope, until_restart=true}]`
- 末位自动追加 `[project{status=503, reason_code=action.reason_code, message_mode=code_only}]`（Error06 默认投影，status 与现有一致）

默认路径（未命中任何策略时）：

```yaml
[error.provider_error_default_path]   # 缺省 = 现有硬编码语义的配置化投影
steps = [
  { step = "wait_retry", retry_mode = "same_provider", max_attempts = 3, backoff_ms = 0 },
  { step = "cooldown", scope = "provider_model", duration_ms = 900000 },  # 15min
  { step = "project", status = 503, reason_code = "provider_failure", message_mode = "code_only" },
]
```

## 5. Manifest 结构（config 编译产物）

```rust
pub struct V3ProviderErrorActionPolicyManifest {   // 扩展
    pub policy_id: String,
    pub scope: V3ProviderErrorPolicyScopeManifest,
    pub matcher: V3ProviderErrorMatcherManifest,
    pub path: Vec<V3DispositionStepManifest>,      // 替代单一 action
    pub action_class: V3ProviderErrorActionClass,  // path 推导投影，兼容旧消费方
}

pub enum V3DispositionStepManifest {
    WaitRetry(V3DispositionWaitRetryStep),
    Cooldown(V3DispositionCooldownStep),
    Project(V3DispositionProjectStep),
}
```

- 旧 `V3ProviderErrorActionManifest` 删除；authoring 层把旧 `action` 语法编译为 `path`（§4 归一化映射）。
- `client_error_projection_policy` matcher 的 `action_class` 字段继续可用（取 path 推导值）。
- `V3ErrorManifest` 新增 `provider_error_default_path: Vec<V3DispositionStepManifest>`。

编译链 owner：`routecodex-v3-config`（`compile_error`，`v3.config_interpreter_contract`），资源 `v3.provider_error.policy_manifest`。

## 6. 运行时消费（Error01-06 链）

```text
transport 4xx/5xx/超时 ─┐
semantic 200 诊断 ──────┤→ ProviderErrorSignal → normalize_provider_error_signal(signal, manifest)
hook/codec 失败 ────────┘            │
                                     v
                    策略命中（matcher 匹配，至多一条，平局=编译错误）
                                     │
                                     v
                    disposition path（有序 steps）
                                     │
      ┌──────────────┬───────────────┼───────────────┐
      v              v               v               v
  wait_retry      cooldown        project        (预留扩展)
  → Error03        → health        → Error06
  retry/backoff    cooldown        client status
  budget 消费      写入            + projection
      │              │
      └──→ Error04/05 中心 exhaustion 判定（硬语义，见 §7）
```

- Error03 `duration_ms`（现硬编码 `15*60_000`）改由当前命中的 cooldown step 提供；默认路径的 15min 来自配置默认值。
- Error03 action 计划的 retry budget（现 `V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES=3`）改由 `wait_retry.max_attempts` 提供；默认 3 来自配置默认值。
- Error04/05 的 exhaustion / default pool / reselect 判定逻辑**不动**，只消费 path 提供的参数。
- observability：`provider_failure_events[]` 增加 `path: [step 摘要]`、`action_class`（推导值）、`path_step_index`。

## 7. 硬护栏边界（配置不可覆盖）

以下保持代码硬约束，配置仅提供参数，不允许关闭或绕过：

1. **错误不得投影为成功**：`project.status >= 400` 编译期强制；Error06 `debug_assert!(status >= 400)` 保留。
2. **exhaustion 判定中心化**：`candidateExhausted=false` 或 `defaultPoolAvailable=true` 时，任何 path 都不得提前 project/rethrow；唯一停止条件是「相关可选池 + default 池同时为空」。`default 池永远不可空` 是配置/VR 真源硬约束。
3. **client_disconnect health-neutral**：不切、不投影 provider 4xx，不受 path 配置影响。
4. **控制语义不进 payload**：path、reason_code、action_class 只走 typed side-channel / Error 链 / observability，绝不进入 provider/client normal payload。
5. **provider 特例只在 policy 面**：`scope.provider_id` 匹配只存在于 manifest policy（Provider runtime 内生效）；Hub Pipeline / Virtual Router 不读 provider 特例分支。
6. **Error06 显示层隔离**：project step 的 public_code/message_mode 只影响显示，不得反向影响 Error02/03/04/05 或 health（沿用既有 projection policy 隔离锁）。
7. **确定性**：禁止 jitter/随机退避；backoff 计算必须确定性、可复现（续写式转换要求同位置字节稳定）。
8. **重启清 cooldown**：进程重启后 provider cooldown 无条件清空（既有事实），path 的 `until_restart` 语义以进程生命周期为界。

## 8. 模块 Owner 与边界

| 模块 | owner | 改动 |
| --- | --- | --- |
| authoring + 编译 + 校验 | `routecodex-v3-config`（`compile_error`，feature `v3.config_interpreter_contract`） | schema：`path` 字段 + step 类型 + 旧 action 归一化 + 默认路径 + 编译校验（§3.4 / §4 / §5） |
| 处置决策执行 | `routecodex-v3-runtime`（`provider_failure_runtime_policy.rs` + `responses_relay_runtime.rs`） | transport 层接入 manifest policy 面；wait_retry/cooldown 执行消费 path 参数；移除硬编码常量 |
| Error 链 | `routecodex-v3-error`（`V3ErrorHandlingCenter` / Error01-06） | Error03 消费 cooldown step 的 duration；分类/决策骨架不动 |
| 红测 | `scripts/tests/` + config 测试 | 新 red fixtures（§9） |

边界约束：

- `routecodex-v3-error` 不得新增 provider 特例；path 语义只由 config manifest 注入。
- `routecodex-v3-runtime` 不得把 path 写回业务 payload；path 执行结果只进 Error 链 / health / observability。
- `routecodex-v3-config` 不得读取 provider health / runtime 状态（编译期纯函数）。
- 允许路径：`v3/crates/routecodex-v3-config`、`v3/crates/routecodex-v3-runtime`、`v3/crates/routecodex-v3-error`、`scripts/tests/`、`docs/architecture/*`（map/wiki 同步）、`docs/goals/`。

## 9. 红测清单（先红后绿）

实现前必须固化并确认当前为红：

1. **source red**：`provider_failure_runtime_policy.rs` 中出现 `V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES` / `15 * 60_000` 魔法常量（迁移后必须消失）——`npm run test:v3-source-gate-red-fixtures` 扩展。
2. **config red**：authoring `path` 字段含非法 step 组合（`project` 非末尾 / `until_restart` 与 `duration_ms` 并存 / `max_attempts=0` / `status<400` / 超界 backoff/cooldown）必须编译失败。
3. **config red**：`path` 与 `action` 同时出现必须拒绝（二义性）。
4. **unit red**：`wait_retry` 次数耗尽且无剩余 step 时，必须进入 Error04/05 exhaustion 判定（`candidateExhausted=false` 或 `defaultPoolAvailable=true` 时不得 project）——反例：默认池可用却提前 project 必须红。
5. **unit red**：`cooldown{until_restart:true}` 在进程内不得自动过期；`cooldown{duration_ms}` 到期后必须自动回池。
6. **unit red**：旧 `action` 语法归一化等价性（旧配置编译出的 path 与手写 path 行为一致）。
7. **integration red**：现有 5555 样本（`20260724T120002045-611803-2288`，200 SSE 诊断零 usage）当前仍被投影为 `requires_action`/stopless——配置 path 后必须走 provider failure 链并携带 `path` 证据。
8. **relay red**：`v3-relay-response-semantics-red-fixtures` 扩展——semantic 诊断命中 `wait_retry→cooldown→project` path 后，Resp03 之前必须离开正常成功路径。

绿化后必须：`npm run verify:v3-architecture-docs` / `verify:v3-resource-map` / `verify:v3-module-boundaries` / `test:v3-workspace` / `git diff --check` 全绿；全局安装 + `routecodex restart --port 5555` + `/health` 验证 + 重放旧样本或同入口 live 样本。

## 10. 完成定义

- 处置路径（`wait_retry` / `cooldown` / `project` 有序链）成为 provider 错误处置唯一真源；transport 层魔法常量移除。
- 旧 `provider_error_action_policy` authoring 零破坏迁移；`action_class` 投影保持 `client_error_projection_policy` 兼容。
- §7 硬护栏全部保持且有 red 测试证明（exhaustion 判定、status>=400、client_disconnect health-neutral、控制语义不进 payload）。
- 红测全部先红后绿；旧样本在线复测证明不再走 stopless/requires_action。
- map / wiki / verification map 同步更新；提交不含无关 dirty 文件。

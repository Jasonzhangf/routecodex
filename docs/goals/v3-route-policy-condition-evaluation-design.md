# V3 Route Policy / Condition Evaluation Design

## 1. 文档状态

- `status`: design
- `scope`: V3 Virtual Router 路由条件与策略扩展
- `runtime_change`: none; 本文不授权实现
- `owner_candidate`: Rust route-policy / route-classifier owner，编码前必须绑定
- `canonical_context`:
  - `docs/architecture/v3-resource-operation-map.yml`
  - `docs/architecture/v3-function-map.yml`
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-verification-map.yml`
- `related_design`:
  - `docs/goals/v3-virtual-router-full-function-plan.md`
  - `docs/goals/v3-compaction-request-routing-test-design.md`
  - `docs/goals/v3-web-search-current-turn-routing-test-design.md`
  - `docs/architecture/wiki/virtual-router-ownership-map.md`

只定义目标合同、边界、实施顺序、验证门槛。未同步 map、未修改配置、未修改 runtime。

## 2. 背景与问题

当前 V3 路由链已有：

```text
Config authoring
  -> schema validation
  -> compiled V3 manifest
  -> typed request facts
  -> route classification
  -> Virtual Router pool selection
  -> opaque target plan
```

当前 route facts 主要是当前轮事实：

- 当前轮是否有 user 输入；
- 当前轮是否有 tool output；
- 当前轮最后 assistant tool category；
- 当前轮 web search / image / long-context / compaction 信号；
- continuation owner 等已登记控制事实。

因此当前 `search` 语义接近：

```text
当前 active turn 的最后 tool category == search
```

它不能表达：

- 最近 10 轮是否持续出现 search / grep / 重复搜索；
- 最近 10 轮工具行为是否超过配置阈值；
- 最近 5 轮是否累计发生超过指定次数的错误；
- 命中条件后是否只切一次主 thinking 模型；
- Compact 是否绑定配置声明的 route object。

当前 route pool match 已支持有限静态条件：

- `entry_protocol`；
- `models`；
- `required_capabilities`；
- `min_input_tokens` / `max_input_tokens`；
- `precedence`。

这些是单 pool 字段式匹配，不是可组合、可扩展的 route policy engine。

## 3. Compact 现有设计与本需求关系

已有 Compact 设计覆盖：

```text
/v1/responses/compact
x-deepseek-harness-compact: 1
x-routecodex-request-purpose: compaction
        |
        v
typed request purpose
        |
        v
is_compaction = true
        |
        v
route_name = compact
        |
        v
compact pool
```

当前合同是“注册入口选择固定 `compact` route signal”，不是“Compact 指定任意命名 route object”。

目标演进：

```text
registered compaction purpose
  -> compact policy binding
  -> named route object
  -> compiled route action
  -> V3 Virtual Router selection plan
```

Compact route object 必须是 typed control resource，不能进入 provider request body、client response body、协议 `metadata`、continuation payload 或历史记录。

## 4. 设计目标

### 4.1 功能目标

1. 每次模型调用可基于当前轮、请求事实、历史窗口、错误窗口和配置条件进行确定性路由判断。
2. 新增条件只扩展已注册 observation / condition schema，不把规则散落到 VR、provider runtime、handler。
3. Compact 可绑定配置声明的 route object，不永久绑定 Rust 硬编码的 `compact` route 名称。
4. 支持历史行为触发一次主 thinking 模型路由。
5. 支持错误窗口触发一次主 thinking 模型路由。
6. 路由动作、条件证据、规则命中原因可审计，但不进入业务 payload。

### 4.2 架构目标

```text
当前请求/响应历史（只读）
  -> Route Observation Projection
  -> Typed Route Observation Facts
  -> Compiled Condition Evaluation
  -> Route Policy Action
  -> VR Selection Plan
  -> opaque Target handoff
```

控制状态必须：

- 不修改历史；
- 不在请求侧 cleanup；
- 不从 payload 反向重建控制状态；
- 不把 route object、命中状态、计数器、cooldown 写入正常 payload；
- 不在 provider runtime、SSE、handler、outbound 增加补偿分支；
- 保持 provider health、retry、availability、error action 的既有 owner。

### 4.3 非目标

- 不把 VR 变成 provider health / retry / cooldown owner；
- 不在 VR 内展开 provider、forwarder、auth key；
- 不用自由文本、prompt 关键词、日志文本作为长期路由真相；
- 不引入 provider-specific route branch；
- 不用 fallback 隐藏条件错误、schema 错误或 route object 缺失；
- 不改变 Direct / Relay / continuation owner 隔离；
- 不修改历史轮内容以标记已搜索或已错误。

## 5. 目标分层

### 5.1 Observation：事实提取

Observation 只回答“发生了什么”，不回答“应该选哪个模型”。

输入：

- 当前规范化请求；
- 当前 active turn 工具调用分类；
- 已提交的 session/conversation 历史只读投影；
- Error chain 完成后的错误事件投影；
- entry protocol、client model、capabilities、token estimate；
- continuation owner 等 typed control facts。

输出必须是 typed facts，不把原始 payload 暴露给 VR policy evaluator。

### 5.2 Condition Evaluation：条件判定

只消费 compiled route policy 和 typed observation facts。

输出：

- `matched: true/false`；
- typed condition evidence；
- condition id；
- observed scope；
- threshold comparison result。

不选择 provider，不读取 health，不修改 payload。

### 5.3 Route Policy Action：路由动作

动作最终只引用 manifest 中存在的 route pool；route object 只作为配置绑定层：

- `select_route_pool`；
- `select_pool`；
- `force_primary_route_pool`；
- `continue_normal_policy`。

引用缺失必须 fail-fast。

### 5.4 Virtual Router Selection：池与目标计划

VR 继续负责：

- routing group；
- matched pool / route object 对应的 pool；
- precedence；
- default floor；
- priority / weighted / round-robin；
- opaque target plan；
- one-shot target handoff。

VR 不负责：

- 统计历史；
- 分类 provider error；
- provider health / cooldown；
- 展开 provider / forwarder；
- 根据日志或 payload 猜 route state。

## 6. Typed observation facts

### 6.1 当前轮事实

保留当前轮 owner：

```text
CurrentTurnRouteFacts {
    latest_message_from_user
    has_current_turn_tool_output
    has_current_turn_web_search
    last_assistant_tool_category
    has_image_attachment
    reached_long_context
    is_compaction
    continuation_owner
}
```

当前轮 `web_search` 仍只来自当前 active-turn 语义，不能由历史关键词、tool declaration 或 assistant 文本重建。

### 6.2 历史窗口事实

新增目标资源，不复用 `CurrentTurnRouteFacts`：

```text
HistoryWindowRouteFacts {
    scope: session/conversation/port/group
    window_turns: u32
    observed_turns: u32
    eligible_turns: u32
    tool_bearing_turns: u32
    tool_call_count: u32
    search_like_turns: u32
    search_like_call_count: u32
    repeated_search_signature_count: u32
    latest_turn_search_like: bool
    evidence_version: u16
}
```

要求：

- 历史只读；
- 不修改历史 byte/value；
- 只在允许的 session/conversation scope 内统计；
- 缺失 scope 时不得跨 session 猜测；
- 窗口不足显式返回 `insufficient_observation`；
- 统计结果不能写入 provider/client payload。

### 6.3 错误窗口事实

错误窗口必须从统一 Error chain 的已提交事件生成，不从客户端文字或响应 payload 推断：

```text
ErrorWindowRouteFacts {
    scope: session/conversation/port/group
    window_turns: u32
    observed_turns: u32
    error_turn_count: u32
    retryable_provider_error_count: u32
    tool_execution_error_count: u32
    protocol_error_count: u32
    terminal_error_count: u32
    last_error_class: Option<ErrorClass>
    evidence_version: u16
}
```

错误窗口必须明确“计数事件”，不能把同一请求的 Error01~Error06 计成六次错误。

推荐默认：

```text
一个 request/call scope 最终产生一个 client-visible failure，计一轮 error。
```

provider 中间失败是否计入，必须通过配置化 error event policy 明确，不能由 route evaluator 猜测。

## 7. 条件模型

### 7.1 条件树

不把字段无限增加到 `V3RoutePoolMatchManifest`，而是编译显式条件树：

```text
Condition
  = all [Condition]
  | any [Condition]
  | not Condition
  | atom ObservationPredicate
```

初始 atom：

```text
request.entry_protocol
request.client_model
request.capability
request.input_tokens
current_turn.tool_category
current_turn.is_compaction
history_window.tool_ratio
history_window.search_like_ratio
history_window.repeated_search_count
error_window.error_turn_count
error_window.retryable_provider_error_count
continuation.owner
```

每个 atom 声明：

```text
source
value_type
operator
threshold/value
missing_observation_behavior
scope
```

### 7.2 比较操作

初始闭集：

```text
eq / neq / gt / gte / lt / lte / in / contains
```

不先支持脚本表达式、任意 JSONPath、运行时 eval 或自由文本 predicate。原因：难验证、难审计，容易混合 payload/control，也容易产生跨模块隐式读取。

### 7.3 Missing observation

历史/错误窗口可能因 scope 缺失、窗口不足、事件尚未提交而无法判断。显式区分：

```text
true
false
insufficient_observation
invalid_policy
```

每条 policy 必须声明：

```text
missing_observation = fail_fast | not_matched
```

涉及安全、continuation、owner 的条件只能 `fail_fast`；纯统计增强条件可在合同批准后使用 `not_matched`。

## 8. Route object

### 8.1 定义

Route object 是配置 manifest 中的命名控制对象，不是 provider payload 对象：

```text
RouteObject {
    route_object_id
    routing_group
    target_pool
    precedence
    selection_strategy
    trigger_policy
    allowed_entry_protocols
    continuation_owner_constraint
}
```

初期 `target_pool` 只引用现有 route pool。禁止 route object 内嵌 provider、key、forwarder 展开结果。

### 8.2 Compact 绑定

目标：

```text
compact request purpose
  -> compact policy
  -> route_object_id = configured compact route object
  -> target_pool
  -> VR selection plan
```

Compact route object 缺失、指向未知 pool、违反 entry protocol 或 continuation owner 时 fail-fast。

Compact 使用独立的 `compact` route pool，不并入 thinking/coding 主模型池；它应成为 manifest 中的显式 route pool，而不是只存在于 `ROUTE_PRIORITY` 常量中。

### 8.3 主模型绑定

“主模型”用 route pool 引用表达：

```text
force_primary_route_pool = thinking
```

条件 evaluator 不直接携带 provider/model。provider/model 绑定仍由 Config manifest 与 Target owner 解析。

## 9. 首批两条历史策略

### 9.1 Search pool 高密度

目标：

```text
最近 10 个 turn 中，工具池分流比例 > 80%
且这些分流属于 search pool（grep、ls 等搜索命令也归入 search 分流观察）
-> 下一次模型调用选择一次主 thinking route pool
```

推荐 policy 形态：

```text
policy_id: history.search_pool_density_to_primary_thinking
window_turns: 10
condition:
  all:
    - history_window.observed_turns >= 10
    - history_window.search_pool_turn_ratio > 0.80
action:
  select_route_pool: thinking
trigger:
  consume: once
  scope: session/conversation
```

工具池分流比例的语义已锁定为 search pool 分流比例。具体计数单位需在 Stage 0 产出合同中固定；不得回退为 provider failure 或原始命令文本统计。

新用户输入会 reset 工具池分流统计为 0；窗口不能跨用户任务拼接。历史窗口包含当前轮。

如果没有足够历史窗口，不读取跨用户任务的旧历史，直接使用当前轮 route facts；当前轮判断仍受已注册 current-turn route policy 约束。

search 分流观察包括：

- 注册的 search tool category；
- grep；
- rg；
- git grep；
- ls 等实际用于搜索工作区的注册命令；
- 已注册 hosted web-search tool。

这些行为归入 search pool 观察，不新增独立 search-like 路由池。

### 9.2 错误窗口

目标：

```text
过去 5 个 turn 中，工具执行结果错误 >= 3
-> 下一次模型调用选择一次主 thinking route pool
```

推荐 policy 形态：

```text
policy_id: error_window_to_primary_thinking
window_turns: 5
condition:
  all:
    - error_window.observed_turns >= 5
    - error_window.tool_execution_error_turn_count > 2
action:
  select_route_pool: thinking
trigger:
  consume: once
  scope: session/conversation
```

只统计工具调用的执行结果。provider failure、provider intermediate failure、reroute 后 provider success 均不进入此错误窗口。

工具错误的去重粒度必须在 Stage 0 合同中锁定，候选是“一次 turn 任一工具错误计一次”。

### 9.3 主模型 route pool

本需求的主模型不是单个 provider/model，而是两个 route pool；Compact 独立于主模型池：

```text
primary_model_pools = [thinking, coding]
default_primary_model_pool = thinking
compact_pool = compact
```

历史 search pool 高密度与工具执行错误窗口默认触发 thinking pool。coding pool 只有在显式配置条件命中时才成为主模型目标；Compact 始终走独立 compact pool。

所有调度 action 必须引用 route pool；不允许 policy 直接携带 provider/model。

### 9.4 历史窗口边界

历史窗口包含当前轮：

```text
history_window = previous turns + current turn
```

新用户输入会 reset 工具池分流统计为 0。没有历史窗口时只看当前轮，不用跨用户任务的旧历史补足。

## 10. 触发、消费与优先级

### 10.1 一次性触发

“路由一次主模型”不是永久强制主模型。需要 typed trigger state：

```text
RouteTriggerState {
    policy_id
    scope
    generation
    consumed_at
    expiry
    evidence_digest
}
```

生命周期：

```text
condition matched
  -> trigger created
  -> next eligible model call consumes trigger
  -> route action applied once
  -> trigger released
```

目标调用在进入 provider 前失败是否算已消费，必须由 execution contract 定义，不能由 handler 补偿。

### 10.2 同时命中多条策略

规则必须有显式 precedence：

```text
request-purpose / continuation-owner safety
  > explicit compact route object
  > explicit model route object
  > history/error intervention policy
  > current-turn route signal
  > static capability/token match
  > default floor
```

这只是设计候选，不是最终 runtime 常量。最终优先级必须进入 compiled manifest，同 precedence 冲突时 fail-fast。

Compact 与 continuation owner 冲突时，continuation owner 约束优先，不能用 Compact route object 跨 Direct/Relay lane。

### 10.3 多策略不自动合并

首版禁止叠加多个 intervention route object：

- 有显式 precedence：选择最高优先级；
- 同 precedence：fail-fast ambiguity；
- 不自动 merge provider/model/pool；
- 不重新进入 VR 做第二次选择。

## 11. 配置目标形态

以下是设计示意，不是当前可用配置语法：

```toml
[route_objects.primary-thinking]
pool = "thinking-primary"
selection = "priority"

[route_objects.compact-default]
pool = "compact"
selection = "priority"
entry_protocols = ["responses"]

[[route_policies]]
id = "compact-purpose"
precedence = 10
when = { atom = { field = "request.purpose", op = "eq", value = "compaction" } }
action = { select_route_pool = "compact" }
consume = "once"

[[route_policies]]
id = "history-search-density"
precedence = 30
when = { all = [
  { atom = { field = "history.search_like_ratio", op = "gt", value = 0.80 } },
  { atom = { field = "history.observed_turns", op = "gte", value = 10 } },
  { atom = { field = "history.repeated_search_count", op = "gte", value = 2 } }
] }
action = { select_route_pool = "thinking" }
consume = "once"
scope = "conversation"

[[route_policies]]
id = "recent-errors"
precedence = 40
when = { atom = { field = "errors.error_turn_count", op = "gt", value = 2, window = 5 } }
action = { select_route_pool = "thinking" }
consume = "once"
scope = "conversation"
```

Schema要求：

- `deny_unknown_fields`；
- route object / pool 引用完整性校验；
- condition field 必须来自注册表；
- comparator 与 value type 必须匹配；
- window、scope、consume 语义闭集；
- 不能写明文 provider key / secret；
- 编译输出确定性；
- runtime 只消费 compiled manifest，不动态扫描目录或拼装配置。

## 12. 由易到难的实施路径

原则：先复用已有 typed facts 和 pool selection，逐步增加统计 projection 与策略状态。每阶段独立验证；当前阶段 gate 未通过，不进入下一阶段。

### Stage 0：合同与口径冻结（最易，设计工作）

目标：不改 runtime，先冻结语义。

工作：

1. 确认 `search-like` 分类表；
2. 确认 10 轮 eligible turn；
3. 确认 80% 分子、分母、窗口不足行为；
4. 确认错误事件计数粒度；
5. 确认“错误后最终成功”是否计入；
6. 确认一次触发的 scope、consume 时点、expiry；
7. 确认 Compact route object 默认绑定；
8. 确认 policy precedence 与 ambiguity 行为。

完成证据：

- 设计文档完成；
- 示例矩阵覆盖 success / insufficient / ambiguity / consumed；
- 无 runtime diff；
- 统计口径已确认。

### Stage 1：固定路由信号声明为 route object（低难度）

目标：不引入历史统计，消除 Compact 和固定 route name 对 Rust 常量的耦合。

工作：

1. Config 增加 route object 声明与编译合同；
2. Compact 绑定默认 route object；
3. 现有 `compact`、`thinking`、`search`、`tools` route signal 映射到已声明对象；
4. VR 继续使用现有 pool selection 与 one-shot plan；
5. 保持 Direct / Relay / continuation owner 隔离。

禁止：

- route object 内嵌 provider/model；
- route object 写入 payload；
- 删除 default floor；
- route object 绕过 VR；
- handler 直接选模型。

最低验证：

- config schema / manifest 编译；
- Compact positive/negative tests；
- route object missing / unknown pool / ambiguity red tests；
- VR one-shot selection plan；
- provider/client payload isolation。

### Stage 2：条件树与当前轮条件迁移（低到中难度）

目标：增加 `all/any/not` 和 typed atom，只消费当前轮已有事实。

工作：

1. 编译 condition AST；
2. 实现闭集 comparator；
3. 将当前硬编码条件投影到 condition evaluator；
4. 保留 current-turn web-search 规则；
5. route classifier 产出 observation，policy evaluator 产出 action；
6. VR 只消费 action / compiled selection input。

最低验证：

- AST 正反测试；
- unknown field / wrong type / invalid comparator fail-fast；
- all/any/not truth table；
- 当前轮 route parity；
- Compact/普通请求隔离；
- control 不泄漏 payload。

### Stage 3：历史窗口只读 projection（中等难度）

目标：支持最近 10 轮事实统计，但先只产出 facts，不触发主模型路由。

工作：

1. 定义 session/conversation scope；
2. 从已提交历史建立只读 turn projection；
3. 复用 Rust tool classifier 生成 search-like classification；
4. 计算窗口计数、比例、重复 signature；
5. 缺 scope / 窗口不足显式输出；
6. 绑定 resource/function/mainline map；
7. 设计离线 fixture。

最低验证：

- 10-turn boundary；
- 9 / 10 / 11 turns；
- 80% exact boundary；
- duplicate search positive/negative；
- old history 不覆盖新 active-turn semantics；
- history byte/value immutable；
- cross-session isolation；
- projection 不进入 provider/client payload。

### Stage 4：错误窗口 projection（中等难度）

目标：把 Error chain 已提交事件投影成最近 5 轮统计。

工作：

1. 确认 Error event 唯一计数 owner；
2. 按 request/call scope 去重 Error01~Error06；
3. 建立 session/conversation error window；
4. 区分 terminal error、provider intermediate failure、tool execution error、protocol error；
5. 生成 typed `ErrorWindowRouteFacts`；
6. 暂不触发 action，先验证统计准确性。

最低验证：

- 同一请求 Error chain 不重复计数；
- final success / final failure boundary；
- 2 / 3 / 4 errors boundary；
- 5-turn boundary；
- session isolation；
- error projection 不进入 payload；
- provider error owner 不被 VR 取代。

### Stage 5：启用 search-density intervention（中高难度）

目标：启用第一个跨轮条件到主 thinking route pool 的动作。

工作：

1. 注册 `history-search-density` policy；
2. 绑定 `thinking` route pool；
3. 增加一次性 trigger state；
4. 明确 trigger 创建、消费、释放时点；
5. 记录 typed evidence；
6. 保持当前轮 signal 与历史 intervention 的优先级可审计。

最低验证：

- 10 轮中 9 次满足、8 次不满足；
- 重复 search positive；
- 非 search tool negative；
- 触发后只切一次；
- 未触发不改变原路由；
- trigger consumed 后恢复普通策略；
- provider failure 不触发第二次 VR hit；
- action 只引用 route pool。

### Stage 6：启用 error-window intervention（高难度）

目标：启用最近 5 轮超过 2 次工具执行错误到主 thinking route pool。

工作：

1. 注册 `recent-errors` policy；
2. 绑定 error event policy；
3. 绑定 `thinking` route pool；
4. 处理与 search-density 同时命中；
5. 增加 trigger dedup / precedence / expiry；
6. 接入真实错误样本与同入口重放。

最低验证：

- 0 / 1 / 2 / 3 errors boundary；
- provider intermediate failure 计数矩阵；
- tool execution error 计数矩阵；
- final success / final failure；
- simultaneous search + error deterministic precedence；
- trigger 不重复消费；
- error policy 不绕过 Error05 / Target owner；
- 在线旧错误样本重放。

### Stage 7：启动时 manifest 与生产闭环（最难）

前置：

- Stage 1~6 完成；
- resource/function/mainline/verification map active；
- architecture gates 接入 CI/build；
- source binding 与 owner boundary 通过；
- DSH review 前置验证完成。

目标：启动时编译并发布 deterministic policy manifest；live reload 不进入首版。

工作：

1. 编译 policy manifest；
2. 发布 deterministic manifest；
3. runtime 只消费启动时 compiled manifest；
4. 策略变化通过重新编译、安装、重启进入运行时；首版不实现 live reload；
5. 验证所有配置成员 health；
6. 使用 managed aggregate `routecodex restart`；
7. 在线重放 Compact、连续 search、错误窗口样本；
8. 验证 route evidence、payload isolation、trigger lifecycle。

最低验证：

- schema / manifest / unknown field gates；
- architecture resource/function/mainline gates；
- Rust focused tests；
- build；
- global install；
- aggregate restart；
- all configured health endpoints；
- exact old sample replay；
- DSH Review PASS；
- review 后代码/配置变化重跑受影响闭环。

## 13. 阶段依赖图

```text
Stage 0 口径冻结
    |
    +--> Stage 1 route object / Compact binding
    |        |
    |        +--> Stage 2 condition AST / current-turn policy
    |                    |
    |                    +--> Stage 3 history projection
    |                    |        |
    |                    |        +--> Stage 5 search-density intervention
    |                    |
    |                    +--> Stage 4 error projection
    |                             |
    |                             +--> Stage 6 error intervention
    |
    +----------------------------------> Stage 7 live production closure
```

Stage 3 与 Stage 4 可在合同确认后并行设计，但不能共用未定义的统计资源，也不能并行修改同一 owner 文件。

## 14. 测试矩阵

### Positive

- Compact purpose 命中独立 `compact` route pool；
- 当前轮 search continuation 保持既有 route parity；
- 最近 10 轮 search pool 分流比例超阈值命中一次 `thinking` route pool；
- 最近 5 轮工具执行错误超阈值命中一次 `thinking` route pool；
- route pool 引用合法；
- 同一 session trigger 生命周期确定；
- 多 listener / 多 session scope 不互相污染。

### Negative

- prompt 出现 `compact` 不触发 Compact route；
- 未注册 header 不触发 Compact；
- 旧历史 search 不覆盖新 active-turn 非 search 语义；
- 9/10 或 8/10 不满足时不触发 80%；
- 2/5 errors 不触发 `>2`；
- 同一 Error chain 不重复计数；
- 缺 scope / 窗口不足不静默满足条件；
- 未知 route object / pool fail-fast；
- 同 precedence policy ambiguity fail-fast；
- route object、trigger、counter、evidence 不出现在 provider/client payload；
- VR 不访问 provider health、retry、quota、auth key；
- trigger 消费后不二次 route；
- provider failure 不触发 VR 重入。

## 15. Map / owner 更新要求

进入 Stage 1 前必须更新并通过审查：

- `v3-resource-operation-map.yml`：route object、compiled policy、observation facts、trigger state；
- `v3-function-map.yml`：唯一 owner、entry symbols、allowed/forbidden paths；
- `v3-mainline-call-map.yml`：Observation → Condition → Action → VR 相邻边；
- `v3-verification-map.yml`：每阶段 required tests/build/live gates；
- wiki review surface：请求链、历史投影、错误投影、route action、trigger lifecycle。

Map 状态必须区分：

- `design\)：本文提出但尚未绑定实现；
- `binding_pending\)：合同已批准但 source symbol 尚未落地；
- `active\)：source、map、gate 已绑定；
- `controlled_runtime_verified\)：完成安装、重启、在线旧样本；
- `reviewed\)：完成规定架构 review。

不得使用 design 条目作为 runtime 已实现证据。

## 16. 编码前决策清单

必须确认：

1. 10 轮 eligible turn 定义；
2. 80% 分母；
3. search-like 分类表；
4. repeated search signature 定义；
5. 5 轮错误事件计数单位；
6. provider 中间失败是否计数；
7. tool execution error 是否计数；
8. trigger consume 时点；
9. trigger expiry / cooldown；
10. session vs conversation scope；
11. Compact route object 默认绑定；
12. Compact 与 continuation owner 冲突处理；
13. policy precedence；
14. missing observation 行为；
15. route object 与 pool 引用关系；
16. live reload 已排除在首版之外；首版只消费启动时 compiled manifest。

任一项未锁定，只能停留在 Stage 0/设计，不得写 runtime。

## 17. 当前结论

本需求不是给现有 classifier 增加两个条件分支。正确增量是：

```text
现有 current-turn classifier
  -> typed route observations
  -> compiled condition evaluator
  -> named route object
  -> one-shot route trigger
  -> history/error intervention
```

推荐顺序：

```text
口径冻结
  -> Compact route object
  -> condition AST
  -> history projection
  -> error projection
  -> search-density intervention
  -> error intervention
  -> live policy production closure
```

先完成低风险、可局部验证的结构，再引入跨轮统计和有状态触发，避免一次性修改 VR、历史、Error chain、Config manifest、runtime lifecycle。

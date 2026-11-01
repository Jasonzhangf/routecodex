# Magpie 调度与加密 reasoning 审计

基线：`/Volumes/extension/code/magpie`，HEAD `bfaedf18301d02a423bd5422d22e41432d231ab8`，工作树 clean。
只读审计，未修改 Magpie 源码，未触碰任何真实登录态。

## 结论先行

1. Magpie 的调度不是单一算法，而是三层：会话粘性 → 轮次/分类 → 单 provider 内的 key 排序。三层各自独立，粘性优先于排序。
2. 单 provider 内排序由 `provider.Provider.Routing` 决定，四种模式：`Smart`（默认）、`Ordered`、`Rotate`、`Weighted`、`LeastUsed`、`Pace`。
3. 加密 reasoning 的处理是**不持有、不修改、只转发**：同一供应商的 seal 原样回传，跨账号/跨供应商的 seal 通过识别上游拒绝错误后删除重发，并记忆该供应商已拒绝的 seal 避免重复尝试。
4. 与 RCC 的差异：Magpie 是「多账号负载均衡网关」，可以为了成本/配额主动换账号并丢弃不可读的 seal；RCC 是透明代理，语义保真优先，不能靠丢弃 payload 字段换取通过。

---

## 第一层：会话粘性（affinity.go）

粘性解决的问题是供应商 prompt cache 的钱：一段对话已经被某个账号缓存，换账号等于全量重发、全额计费。

实现（`internal/gateway/affinity.go`）：

- `cacheWorth = 1024` tokens：上次回答读回 cache 达到这个量，跨轮次继续保持粘性。
- `cacheCold = 5 * time.Minute`：按 Anthropic/OpenAI 最短 cache 寿命取值，超过即视为失效。
- `stickKeep = 24 * time.Hour`：粘性记忆窗口。
- `sticksKept = 512`：磁盘最多保留 512 条会话粘性记录。
- 粘性按会话 key 存 `affinity.json`（与 providers 同目录），重启或更新后不丢失，避免重启后把有缓存的会话交给排序第一个的账号。
- 会话 key 用 `crypto/sha256` 派生，不保存原始标识。

粘性有四种粒度：整会话、仅轮次内（agent 回传 tool result 到用户再次说话之间）、永不、或按 cache 划算与否自动判断。

**关键判断**：粘性是成本决策，不是协议语义。RCC 的等价物只有会话亲和路由（同一 thread 落到同一 provider key），当前 RCC 没有跨请求的会话粘性 owner，是一个可评估的缺口。

## 第二层：轮次意图分类（classify.go / decide.go）

这一层决定「这个请求该走哪条规则、该给多少 reasoning effort」。

- 带 `Rule.Intent` 的规则需要分类器判断用户消息属于哪个 intent。
- 分类在**轮次开始时做一次**，之后轮次内不再重判（`TestRuleDecidesAtTurnStartAndHolds`）。
- 分类器本身就是 magpie 的一个模型调用，走 magpie 自己的 key、failover、usage 统计，以 `RouterAgent = "magpie-router/1"` 的 User-Agent 标识。
- 超时 `classifyTimeout = 8s`，同一条消息的判定缓存 `classifyKeep = 10 * time.Minute`，失败后 `classifyRest = 30s` 冷却。
- 分类器失败、超时或答非所问时**不匹配任何 intent**，而不是猜测匹配。trace 里记录原因。
- `decide.go` 的 Jev 路径（来自 TypeSafe）一次性同时决定 intent 与 effort，返回各选项的置信度而非文本。
- `jevSure = 0.4`：置信度低于 0.4 视为「没把握」，等同无 intent。
- effort 分四档：`low` / `medium` / `high` / `xhigh`，每档在 `jevLevels` 里有明确的工作量描述。

**关键判断**：分类器不可用则降级为「无 intent」，不阻塞请求，也不猜测。这与 RCC「显式失败、不隐式 fallback」的方向一致。

## 第三层：单 provider 内 key 排序（routing.go）

入口是 `route(p, cs, model, from)`，内部调 `weigh`，再按 Sink 决定是否把限流的账号排到最后（`sink.go`）。

`weighRouted` 的实现要点：

| 模式 | 排序逻辑 |
|---|---|
| `Smart`（默认，空值） | 先按配额分三档：`fine`（有余量）、`low`（接近用尽）、`spent`（基本用尽）。`fine` 档内按**配额刷新时间**排序，刷新最近的优先，因为剩余量马上作废；刷新时间按小时截断比较，几分钟的差异不重排。同刷新时间保持原顺序以维持供应商 prompt cache。`low`/`spent` 档内按已用比例升序。未知配额的账号（Claude Code 通过 `rate_limit_event` 自报）在未知期间优先答一次，否则永远学不到。 |
| `Ordered` | 完全按配置顺序，不做任何重排。 |
| `Rotate` | 按 `routed.turn[p.ID] % len(cs)` 做轮转，轮次计数器在 provider 维度。 |
| `Weighted` | `weightedFirst(p.ID, cs)`，按权重取第一个。 |
| `LeastUsed` | 订阅账号按其额度已用比例；其他 key 按 magpie 近期发给它的 token 量。 |
| `Pace` | 按「每周剩余量 ÷ 距离刷新的剩余小时」的消耗速率排序，速率最高优先。这是为了防止「最闲的账号」把 3% 剩量+1 小时到刷新 的账号排到 90% 剩量+2 小时 的账号前面。 |

用量衰减（`routing.go` 顶部）：

- `usageHalfLife = time.Hour`：`tokenUse.now(t) = n * exp2(-elapsed_seconds / 3600)`，一小时后计数减半。
- 成功应答会清零该 key 的失败计数（`delete(routed.failures, rest)`），并调 `provider.NoteServed` / `provider.Unretire`。

休息时长（`restAfterMarked`）按失败原因分级，是显式的、可解释的：

- 额度耗尽：30 分钟，等人工充值。
- 配额耗尽：按供应商返回的 reset 时间。
- 订阅配额：按其窗口刷新时间。
- 限流：按 `Retry-After` 头，且**每次重试递增**。
- 其他：1 分钟，重试时递增。

休息时长和设置它的原因都会写进 trace，这样 Routing 页面显示的时间就是账号真实回来的时间。

全局状态是包级 `routed` struct（`turn` / `used` / `failures` 三个 map + 一个 `sync.Mutex`），不是 per-provider 实例。

**关键判断**：Magpie 的 Smart 模式核心是「配额即将作废的先花」，RCC 的等价物是 provider health 的冷却与探测阶梯（5s → 10s → 30s → 60s → 120s → 900s → 1800s）。RCC 目前按「精确 provider+auth key+model 身份」冷却，Magpie 额外做了**账号间配额经济学**（刷新时间、周速率），这是 RCC 没有的维度。

---

## 加密 reasoning 的处理

### 抽象层（ir.go）

`Part` 用三种字段表达 reasoning，语义严格分开：

- `Signature`：明文 thinking 的签名。Anthropic 的 signature，或 Gemini 的 thought signature。
- `Sealed`（`json.RawMessage`）+ `SealedBy`（`sealAnthropic` / `sealResponses`）：**上游密封的 reasoning**，按原 API 的字节原样保存。注释写明「只有该 API 的 builder、encoder、renderer 写它，byte for byte」。
- 其他任何协议收到 `Sealed` 内容时，降级为「无文本的 reasoning」或 `Text`（#1445）。

`Request.Include` 单独保存 Responses 客户端的 `include` 字段，其中包含 Codex 的 `reasoning.encrypted_content`。注释：中继可能拒绝不带该字段的请求（#315）。

### Responses 上游构造（responses.go）

`buildResponses` 的 reasoning 分支：

1. `replay := replaysReasoning(model, host)`：只有 DeepSeek 需要回传明文 `reasoning_text`。注释：DeepSeek 报 "The reasoning_text in the thinking mode must be passed back"（#388）。OpenAI 及其前面的中继只认自己密封的 reasoning，不带 `encrypted_content` 的 reasoning item 会被拒。
2. 命中 `sealedReasoning(p)`（有 `encrypted_content` 且 `content` 为空）且 `replay` 为 false：**直接把 `p.Sealed` 原样 append 到 input**，保留 `id`、`summary`、`encrypted_content` 三个字段（#1445）。
3. 否则若 `replay` 为 true 且有文本：构造 `{"type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":...}]}`。
4. `include` 重建规则：`reasoning.encrypted_content` 只在本次请求确实带了 `reasoning` 时才保留。注释：OpenAI 会拒绝一个不 reasoning 的模型带上该字段。回传密封内容按「若无 magpie 它会怎样」的原则处理。

### 跨账号/跨供应商的 seal 处理（affinity.go + gateway.go）

这是 Magpie 最精巧的部分。当一段对话从一个账号换到另一个账号（或换供应商），Codex 会把每一轮的 reasoning 原样带回，新账号读不了旧的 seal。

识别（`affinity.go:453`）：

```go
var foreignReasoning = regexp.MustCompile(`(?i)invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content`)
```

注释里的两个真实供应商文案：

- OpenAI："The encrypted content for item rs_… could not be verified"
- xAI/Grok："Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response."

处理（`gateway.go:2299` 附近）：

1. 触发条件：`resealed < 2`、来源协议是 Responses、非 passing、状态码 >= 400、错误体匹配 `foreignReasoning`。
2. `resealed == 0`：先 `withoutReasoning(body)` 删除所有 `type: "reasoning"` 的 input item，同时 `refused(stuck, c.who(), attemptBody, "reasoning")` 记下这个账号在这个会话里已拒绝的 seal。
3. 被拒或没有 reasoning 可删：`resealed == 2`，再 `withoutCompaction(body)` 删除 `type: "compaction"` / `compaction_summary`。注释：waroy 复现的 "Codex 在 GPT 上 compact 后切到 Grok" 场景。
4. 删除成功则重试同一候选（`i--`），最多重试两次。

记忆（`refusedSeals`，包级 `sync.Mutex` + map）：

- key 是 `conversationScope|conversationKey|who`（账号维度）。
- value 是被拒 seal 的 SHA-256 集合（`sha256.Sum256([]byte(encrypted_content))`，只哈希，不存原文）。
- `sealsRefused.at` 时间戳，超过 `stickKeep`（24h）清理。
- map 超过 4096 条时淘汰 24h 前的记录。
- `withoutRefused` 在下一次请求前就过滤，不需要等上游再拒一次。

只删哪两类 item（`sealedKinds`）：`reasoning`、`compaction`、`compaction_summary`。注释说明 compaction 是 OpenAI 在 Codex 用自己的模型压缩早期轮次时产生的，其他账号也读不了。

**明确保留的部分**：删掉的只是「模型的私人笔记」。实际说过的话、做过的操作全部保留。

### 提示词约束

`codex_backend.go:371` 起：只有「原生 sealed agent task」需要额外指导。其他 `encrypted_content` 一律不动。判断方式是 `nativeSealedAgentPayload.MatchString(part.EncryptedContent)` 正则匹配 payload 内容。

`prompt.go:778`：`Encrypted string \`json:"encrypted_content"\`` 只是解析字段，不参与提示词构造。

**关键判断**：Magpie 对加密 reasoning 的策略是「不持有密钥、不解密、不篡改」。它做的只有三件事：原样转发、识别不可读的 seal、在明确收到拒绝后删除并记忆。提示词不被读取或修改。

---

## 与 RCC 的对照建议

| Magpie 能力 | RCC 现状 | 建议 |
|---|---|---|
| 会话粘性 + prompt cache 经济学 | 无跨请求会话粘性 owner | 评估是否需要在 Target 层加会话亲和（按 thread id → auth key）。RCC 是透明代理，加粘性属于控制面决策，需走 typed control resource。 |
| 轮次意图分类 + effort 自动档 | RCC 有 reasoning effort 配置，但无自动分档 | 与「请求链路不打洞」冲突风险高。分类器调用是额外一次 provider 请求，RCC 的固定骨架里目前没有这个节点。不建议引入。 |
| 配额经济学排序（Smart/Pace） | RCC 按精确 provider+key+model 冷却 | Magpie 的「刷新最近的先花」是订阅经济学，不是健康判定。RCC 当前无多账号共享场景，暂缓。 |
| `usageHalfLife = 1h` 衰减 | RCC 无用量衰减 | 无对应需求。 |
| 加密 reasoning 原样转发 | RCC 已按 V3 语义保真要求处理历史 reasoning 与 tool 输出 | 与 RCC 方向一致，无需改。 |
| 跨账号 seal 删除重发 | RCC 无多账号 failover 到不同供应商的场景 | **不建议引入**。删除 input 字段是主动改写 payload，违反「outbound 只在白名单下丢弃、且白名单是逐步审查结果」的要求。RCC 的替代是保持请求与响应的请求-响应绑定：response tools 是请求声明 tools 的子集，不自动授予别名。 |
| `refusedSeals` 记忆被拒 seal | RCC 无 | 无对应需求。 |
| `foreignReasoning` 正则识别上游拒绝 | RCC 的错误链已有外部状态保留 | RCC 应保持错误原样，不做跨供应商语义推断。 |

## 值得借鉴的两点

1. **粘性按 cache 划算与否决定**：`cacheWorth = 1024` 且 `cacheCold = 5min` 的显式阈值，比「永远粘性」或「永不粘性」都合理。若 RCC 要做会话亲和，应同样给显式阈值而不是默认全粘。
2. **失败原因分级休息 + trace 记录**：`restAfterMarked` 把「为什么休息、休息多久」同时写进 trace，让路由决策可审计。RCC 的冷却阶梯已有类似设计（5s → 1800s），但没有记录「是哪个原因设的」。

## 不建议借鉴的两点

1. **删除跨账号 seal 并重试**。这是 Magpie 作为多账号网关的必要妥协，因为它的目标是「让请求通过」。RCC 的目标是语义保真与透明，删除 input item 属于主动改写 payload。
2. **引入分类器做自动 intent/effort 路由**。这会为每个请求引入一次额外 provider 调用，且分类器调用本身要经过 RCC 自己，形成自引用依赖。与「固定骨架 + 无打洞」冲突。

# 24 Node Contract Debug Method

## 何时用
- 复杂生命周期问题。
- stopless / continuation / servertool / tool governance / hook restore / schema gate。
- 用户要求“先别改代码，先把生命周期、白盒、黑盒理清楚”。

## 这是高优先级方法

任何复杂 debug 或设计，默认顺序固定为：

```text
先生命周期
  -> 再逐节点合同
  -> 再白盒测试设计
  -> 再两端黑盒测试设计
  -> 最后才 debug / 改代码
```

只做 grep、只看一两个红测、或者直接改代码，都是违规捷径。

## 核心原则

1. 黑盒锁结果面，不锁实现细节
- client-facing 黑盒：客户端收到什么、何时收到、是否泄漏内部语义。
- provider-facing 黑盒：发给 provider 的 request 到底带了什么。

2. 白盒锁节点合同
- 每个节点必须写清：
  - 读取什么
  - 交付什么
  - caller/callee
  - 正常怎么走
  - 错误怎么走
  - 超预期怎么走

3. 先合同，后代码
- 如果节点合同没锁清楚，代码修改基本等于乱改。

4. 黑盒红了，回白盒定位节点
- 黑盒只告诉你“外部不对”。
- 真修复必须回到对应白盒节点 owner。

5. 先判“这是什么红”，再决定下一步
- 合同红：生命周期/节点合同/字段要求本身没锁清楚。
- owner 红：合同清楚，但唯一 owner 行为不符合合同。
- 产物旧红：代码已改，但黑盒仍在消费旧 `.node` / 旧 standalone binary / 旧全局安装。
- 前置 gate 红：当前问题已绿，但整链跑到下一个独立 blocker。
- 不先分型就改代码，容易把“旧产物假红”或“无关下一红”误修成业务逻辑。

5.1 证据层 != owner 层
- 样本/日志/SSE/client-response 只能证明“症状出现在哪一层”，不能直接证明 owner 在这一层。
- 先用样本锁“哪一轮、哪一个节点之后断了”，再回 function map / mainline call map 锁唯一 owner。
- 典型反模式：看到 client-response 停在 `tool_calls`，就把问题归到 `resp_outbound` / `SSE`；如果合同写的是 direct request-side continuation / tool-result follow-up owner，则必须回那个 owner。
- transport / outbound / handler 层默认只作为证据面；除非 function map 明确把该语义归给它，否则不得把症状层当修复 owner。

5.2 数据与控制分流是刚性规则
- `MetadataCenter` 只承载控制信号，不承载请求数据、响应数据、上下文对象、normalized input、payload 镜像。
- 请求协议字段属于数据面：HTTP headers、请求 body 标准字段、`metadata`、`client_metadata`、`x-*` / `x-codex-*` 等客户端协议字段默认按协议透传。它们不是 RouteCodex 控制信号，不能因为字段名含 metadata/header 就写入 `MetadataCenter`。
- RouteCodex 控制信号必须由 server/hub/VR/servertool 等唯一 owner 生成并写入 `MetadataCenter`；禁止从客户端协议字段搬运或恢复控制状态。
- 凡是“为了后面方便取值”而把 `requestContext` / `responsesRequestContext` / `payload` / `context` 塞进 metadata 的做法，一律视为违规 owner shortcut。
- continuation restore/save 需要的数据，必须走 continuation/store 的专用真源或当前函数局部变量传递，不能借 `MetadataCenter` 走私。
- 看到 `MetadataCenter.write*` 写入大对象、payload、context 时，先判定为合同红，再回 owner 层删除，而不是补 clone/deep-copy。

5.3 Responses continuation 不可变区
- 固定生命周期：`resp_chatprocess save -> immutable store interval -> req_chatprocess restore`。
- save 后到 restore 前，`resp_outbound` / SSE / server handler / adapter / provider-response converter / `req_inbound` 只能做归一化、投影、传输、scope 校验和释放。
- 这些层禁止做语义转换、上下文恢复、history/tool 修补、required_action 判断、stopless/servertool guidance 注入、request rebuild。
- 看到 `entryOriginRequest` / `capturedChatRequest` / `requestSemantics` / session-only scope 被用于 continuation 恢复或历史补偿，先按 owner 违规处理：删除越界逻辑，回 Chat Process save/restore owner 修。

6. 每轮只收一个 blocker
- focused 白盒/黑盒绿了，只能说明这一层过了。
- 必须立即回整链 gate，暴露下一个真实 blocker。
- 不能把“当前层已绿”误报成“整链闭环完成”。

## 节点合同模板

每个节点最少写这 8 项：

```text
Node:
阶段:
Owner:
Caller -> Callee:
Input:
Output:
Normal path:
Error path:
Unexpected path:
Blackbox observable:
```

### `Unexpected path` 的定义
- 输入缺失
- 输入 malformed
- harvest 失败/抓不到
- 顺序错误
- 跨 owner 越权
- 内部语义泄漏到 client/provider
- 本应 terminal 却继续 loop
- 本应继续修复却被错误 terminal

## 两类测试怎么分

### 白盒

目标：
- 证明单个节点或相邻节点之间的 contract 成立。

必测：
- 输入完整时正常产出。
- 输入缺失时如何 fail-fast 或如何进入修复闭环。
- malformed / invalid / empty 时如何分类。
- 顺序是否正确。
- caller/callee 是否在正确 owner。

### 黑盒

目标：
- 证明系统外显闭环成立，不关心中间实现。

必分两端：

1. client-facing
- 最终响应是什么
- 是否收到 `exec_command`
- 是否直接 stop
- 是否泄漏 raw internal tool
- 第 N 轮是否正确终止/继续

2. provider-facing
- request 是否带了预期 guidance/tool/result
- 下一轮 request 是否把修复信号带回模型端
- 是否丢了正常工具面

## 当前 stopless 的标准分析法

先按轮次切，不先按文件切：

```text
Round 1 Request
  注入完整 system schema + normal tools
  不注入 provider-facing stopless tool

Round 1 Response
  拦截 stop/tool_call
  normalize
  terminal or CLI
  save canonical continuation
  return to client

Round 2 Request
  restore continuation first
  current resume output -> private repeat state
  CLI call/result -> one ordinary user prompt
  重新注入 system schema

Round 3 Guard
  no_schema >= 3
  停止 endless stop -> CLI rewrite
```

### stopless 节点级白盒最小集

1. Request inject stop guidance
2. Request does not inject provider-facing `reasoningStop`
3. Request preserve normal tools (`exec_command` 不丢)
4. Response intercept `finish_reason=stop`
5. Response stop schema judgment reads assistant text/fence
6. Schema harvest / parse / malformed classification
7. Normalize to terminal vs CLI, including `simple_question=true` natural stop
8. Missing request-truth `sessionId` -> no interception, no stopless state write, diagnostic alarm
9. Same-session consecutive schema-error counter reset on non-stop/progress/session-change/terminal
10. Save canonical continuation after normalize
11. Restore continuation before request-side hook restore
12. CLI stdout/current resume -> private repeat state
13. CLI call/result pair -> ordinary user prompt, no tool-pair restore
14. `no_schema=3` loop guard

### stopless 两端黑盒最小集

1. Provider-facing round 1
- request 带 stop guidance
- request 不带 `reasoningStop`
- request 保留正常工具面

2. Client-facing round 1
- terminal valid -> normal stop
- simple question -> normal stop without CLI
- missing request-truth `sessionId` -> natural stop plus diagnostic alarm, no CLI
- no schema / invalid / malformed / harvest miss -> `exec_command`
- 不泄漏 raw `reasoningStop`
- non-stop/tool progress -> preserve normal tool response and reset stopless repeatCount
- different `sessionId` -> starts fresh, does not inherit previous repeatCount

3. Provider-facing round 2
- request 带回修复 guidance
- request 不带回 stopless tool/call/result pair
- request 仍保留正常工具面

4. Client-facing round 2
- 收到继续修复或继续执行的响应
- 不泄漏 raw internal tool

5. Client-facing round 3
- 第 3 次连续 `no_schema` / invalid schema 直接放行原始 `finish_reason=stop`，不再投影 `reasoningStop` CLI

## 当前 stopless 的异常闭环口径

### no schema
- deny stop
- project CLI
- next request 使用固定透明 user prompt
- system instruction 持续提供完整 schema

### bad schema
- deny stop
- project CLI
- CLI 可返回私有 `schemaFeedback{reasonCode,missingFields}`
- next request 对 provider 只使用固定透明 user prompt；合法 next_step 则原文使用

### harvest miss / parse miss
- 不允许直接放过
- 必须按 deny-stop 处理
- 通过 CLI 把修复信号送回模型

## Debug 顺序

1. 先看生命周期图是否完整。
2. 再列节点合同。
3. 再列白盒测试清单。
4. 再列 provider/client 两端黑盒清单。
5. 再跑现有测试，标出哪几格没锁。
6. 先分清是合同红 / owner 红 / 旧产物红 / 前置 gate 红。
7. 最后才允许改代码。

## 验证升级顺序

```text
focused whitebox
  -> focused provider/client blackbox
  -> build native / standalone binary / global install
  -> replay exact failing request sample online
  -> rerun full gate chain
```

- 改 Rust owner 后，如果黑盒吃的是 standalone binary 或 native `.node`，必须先重编产物再看黑盒结果。
- 改完 focused slice 不回整链 gate，就看不到“当前问题已过、下一个独立 blocker 已出现”的真实状态。
- runtime bug 修完后必须重放触发问题的原始出错请求样本；泛化 live smoke 只能补充健康信号，不能替代样本复打。样本仍失败时继续修，不得宣称闭环。

## 禁止
- 黑盒没设计完就改代码。
- 生命周期没切清楚就讨论 root cause。
- 只锁 client，不锁 provider。
- 只锁 provider，不锁 client。
- 只锁 happy path，不锁 error / unexpected path。
- 把 SSE/transport 当业务 owner 修。
- 改了 Rust/TS owner 后直接看旧 binary / 旧 global install 的黑盒结果。
- 当前 blocker 已绿却不回整链 gate，继续围着旧问题兜圈。

## 未接线 Controlled-Upstream Harness

- 触发信号：协议 codec 与相邻节点白盒已存在，但完整 Runtime 主链尚未接线，需要为 integration worker 前置真实外部观测面。
- 关键判断：harness 必须由外部 driver 执行真实 Runtime，并以受控 upstream capture、client projection、固定节点 trace 三方对账；fixture transformer 或伪造 trace 不算主链证据。
- 可复用动作：先固化 deterministic JSON/SSE/error/isolation fixtures和证据 schema；无 driver 时固定 `wiring_missing` 非零退出并列出缺失相邻边；再用 mutation gate 锁住 capture 数量、节点顺序、side-channel 隔离和禁止伪绿。
- 反模式/边界：不得把未接线改成 skip/pass，不得 mock 掉主链，不得因 harness 建设修改 Runtime/Server/Provider 业务语义；未接线红态只证明 integration-ready harness，不证明 live 功能。

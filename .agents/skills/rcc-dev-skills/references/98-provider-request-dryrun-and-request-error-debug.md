# Provider-request dry-run 与请求错误定位 SOP

## 1. Provider-request dry-run

用途：让真实入口完整执行 `HTTP -> Req -> VR/Target -> ProviderReqCompat -> provider wire`，在网络发送前停住并返回最终 provider request。它证明 RouteCodex 实际会发什么，不证明 provider 会接受什么。

### 精确指定 provider/model

客户端请求的 `model` 使用 `provider.model`：

```json
{"model":"opencode-go.deepseek-v4-flash"}
```

显式目标存在时必须命中该 provider/model，并把 provider wire `body.model` 改为裸 model id；不存在必须 404。禁止用普通 model 的池路由结果、最终 fallback 200 或另一 provider 代替精确目标证据。

### curl 模板

```bash
curl -sS \
  -H 'content-type: application/json' \
  -H 'x-routecodex-dry-run: provider-request' \
  --data-binary @client-request.json \
  http://127.0.0.1:7777/v1/responses \
  > dry-run.out
```

若原请求 `stream=true`，dry-run 返回 SSE；取 `data: {...}` 中的 JSON 事件。若 `stream=false`，直接按 JSON 读取。权威字段是：

```text
dry_run.provider_network_send == false
dry_run.provider_request.providerId
dry_run.provider_request.url
dry_run.provider_request.headers
dry_run.provider_request.body
```

`dry_run.response_payload` 是 no-network cutpoint 的合成终态，不是 provider 响应证据。`provider_request` 缺失时只说明失败发生在 transport 前，按节点 trace 查 Route/Target/Compat/Wire owner；禁止转而猜 provider、SSE 或 client projection。

### dry-run 后必须做的两步

1. 将 `dry_run.provider_request.body` 不改一字地保存，使用同一 endpoint、同一 key 直接 curl。只允许补 transport auth/header，不允许重写 body。
2. 去掉 dry-run header，用同一 client request 在线回放；日志必须证明精确 `provider.model` 的实际 attempt 成功且没有借 provider switch/fallback 得到最终 200。

## 2. 请求错误 Debug / 修复流程

### A/B/C 责任判定

固定同一 provider/model/key/endpoint 和同一失败样本：

1. A：最小 provider 直连。A 失败才查 endpoint/key/model/provider 状态。
2. B：失败请求经当前 runtime dry-run 得到的完整 provider body，原样直连。A 成功、B 失败，责任在 provider-bound 请求形状、序列化或历史内容。
3. C：同一 client request 经过已安装并重启的 RouteCodex。A/B 成功、C 失败，才查 transport、provider response codec、SSE 或 client projection。

console 摘要、最终 HTTP 200、另一个 key、另一个 provider、普通 smoke 都不能替代 A/B/C。

### 定位第一个错误形状

当 A 成功、B 失败：

1. 从完整历史按 turn 前缀二分，找最短失败前缀；不能先删字段或关闭 thinking 当修复。
2. 在首个失败 turn 内做单变量排列/字段差分，每次直接 curl 相同 key。
3. 记录最简成功、最简失败、首次偏离 item/字段、provider 原始错误 body。
4. 查 git 历史中的旧修复、回归 commit 和首次偏离节点。
5. 绑定 resource/function/mainline/module/verification maps，确认生成错误 provider body 的唯一 owner。
6. 先写精确红测，证明当前 owner 生成已证伪形状；再做最小修复。

工具调用顺序问题要同时检查 provider 的两个合同：reasoning 与整个 assistant tool turn 的相对位置，以及 call/output 是否相邻。不能只移动一个 item 让某条错误消失而制造另一条 400。

### 修复闭环

```text
最小红测确实红
-> 唯一 owner 修复
-> 正向/反向回归测试
-> provider crate / compat / architecture gates
-> dirty main 组合构建
-> 全局安装
-> 一次 aggregate routecodex restart
-> 全部 listener /health 版本一致
-> 旧样本 dry-run 检查最终 wire
-> B：完整 wire 原样 curl 同 key 成功
-> C：provider.model 在线回放且该 provider attempt 成功
-> 最后 code review
```

禁止通过 routing、provider switch、fallback、thinking=false、payload 裁剪、silent strip、错误码改写、handler/SSE/outbound 补偿掩盖请求错误。

## 3. DeepSeek thinking 工具轮 reasoning 合同

触发条件：目标是 `responses:deepseek-console-go`、模型是 DeepSeek thinking 模型，且新 user 轮次后第一个 assistant 行为是 tool call。Console Go 要求每个 thinking assistant tool turn 都携带非空 `reasoning_text`；这个合同不因客户端没有回传 reasoning 而消失。

provider wire 的最小合法投影是把下面的 item 放在新 user message 与首个 tool call 之间：

```json
{
  "type": "reasoning",
  "content": [{"type": "reasoning_text", "text": " "}]
}
```

已验证边界：缺少 reasoning item 失败；`reasoning_text` 为空字符串失败；单空格成功。新 user 轮次不得继承上一轮 assistant reasoning，单空格是当前轮“客户端没有 reasoning 表示”的最小非空协议值，不是对历史 payload 的清洗或补写。

必须锁两类回归：

1. 正向：`user -> function_call -> function_call_output` 经最终 provider wire 变为 `user -> reasoning_text(" ") -> function_call -> function_call_output`，相同 wire 原样 curl 成功。
2. 反向：已有当前轮 reasoning 时不得重复插入；跨 user 边界不得搬运旧 reasoning；非 DeepSeek Console Go、非 thinking、非 Responses provider wire 不得触发该投影。

修复 owner 只能是对应 provider wire compat builder。禁止在 Hub、Virtual Router、handler、SSE、响应投影或历史 restore 中补这个 provider-specific wire 语法。

## 4. Fully buffered SSE 交接与 499 定位

正确生命周期：Front 先接住客户端请求并只发送 transport heartbeat；Runtime 完整读取、校验并缓存 provider attempt；只有完整 attempt 出现已登记 semantic terminal 后，Runtime 才 seal client projection 并把 typed committed stream 交给 Front；Front 随后向客户端 replay。provider 业务帧在 seal 前不得越过 client edge。

完成判定必须由 Runtime validator 写进 typed committed carrier，至少携带首次 semantic terminal frame 的位置。不能把 `poll_next(None)`、HTTP EOF、Hyper Body Drop 或“客户端读完物理最后一帧”当唯一完成证据，因为合法 provider 可能在 `response.completed` 后继续发送 `ping` 等 transport tail，客户端也会在 semantic terminal 后正常停止读取。

判定矩阵：

- terminal frame 前 Drop：真实 `client_disconnect`，保持 health-neutral 499。
- terminal frame 已交给 Front 后 Drop，即使 trailing `ping`/`[DONE]`/EOF 未消费：已完成，不得投影 499。
- provider 未产生 semantic terminal：attempt 不得 seal，不得作为成功交接。
- provider terminal failure：保持 typed failure，不得改写成 client disconnect 或成功。

唯一 owner 是 Runtime 的 provider-response validator + committed handoff carrier。Server/Front 只消费 typed terminal，不重新解析 SSE event 文本；不得在 handler、HTTP body、console finalizer、outbound 或 provider health 增加补偿分支。

在线验证使用成对客户端：正向客户端读到 `response.completed` 立即关闭且不消费 trailing `ping`/EOF，同 requestId 必须 completed、无 499；反向客户端在 heartbeat/terminal 前关闭，必须仍走 health-neutral client disconnect。两组都要确认 provider failure events 为空，避免把客户端行为污染 provider health。

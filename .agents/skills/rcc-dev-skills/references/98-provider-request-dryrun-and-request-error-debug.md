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


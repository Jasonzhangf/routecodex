# V3 7777 错误样本审计与修复执行目标

## 目标

审计并修复 7777 canonical samples 中的 599、400、598 错误。必须按 V3 架构回到首次偏离节点和唯一 owner 修复，完成构建、全局安装、managed restart、原始 payload 在线复验，并将本次 change set 提交、推送到 `main`。

## 真源与样本

- 项目：`/Users/fanzhang/Documents/github/routecodex`
- 配置：`/Users/fanzhang/.rcc/config.v3.toml`
- 样本：`/Users/fanzhang/.rcc/codex-samples/openai-responses/ports/7777/`
- 日志：`/Volumes/extension/.rcc/logs/server-v3-7777.log`
- 架构/功能/调用/验证 map：项目内 `v3-resource-operation-map.yml`、`v3-function-map.yml`、`v3-mainline-call-map.yml`、`v3-verification-map.yml` 及 owner registry/wiki/manifest

## 强制流程

1. 先读项目 `AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、`.agents/skills/rcc-v3-architecture/SKILL.md` 和上述 map；建立当前 run notes。
2. 每类错误先做同一 requestId 的 A/B/C 归因：A 为 provider/model/key 最小直连 ping；B 为完整 `provider-request.json` 原样直连；C 为同入口 7777 在线重放。
3. 先写最小 failing red test，再修改唯一 owner；正向/反向测试成对。
4. 禁止 fallback、换 provider、改优先级掩盖问题、裁剪 payload、请求侧 cleanup、SSE/handler/outbound 补偿、把控制状态写入 payload。

## 样本线索与修复边界

### 400：内部请求阶段错误

样本：`openai-responses-router-gpt-5.5-20260827T075604571-1005221-4633`。错误：`provider_request_payload_invalid`。典型未映射字段：`$.request.text.output_config.format.name`。

回到 request protocol → provider compat → provider wire 唯一 owner；不得删除或静默忽略字段。RouteCodex 自己产生的请求阶段错误必须走内部 `598`；外部 provider 原始 HTTP 400 才能保留 400。

### 599：内部响应阶段错误

重点错误：`provider_response_sse_event_invalid`、`provider_response_body_error`。

SSE 只处理 framing/transport 语法；provider raw response 交给 provider response inbound / provider manifest owner。不得补 type、补 event、把错误转 EOF/成功。HTTP 200 但响应解析、SSE、RespInbound、RespChatProcess 或 RespOutbound 失败，必须投影 `599`。配置声明的 provider 语义错误必须经 manifest matcher 进入错误链，禁止硬编码到 SSE/handler。

### 598：内部资源/请求阶段错误

重点错误：`v3_debug_failure` / `debug sink failed: Too many open files`。

回到 debug sink 文件生命周期、并发打开、关闭、rotation、retention owner 修复；不得关闭 debug、减少样本或吞错掩盖。请求阶段内部资源错误为 `598`，响应阶段为 `599`。

## 错误链与架构锁

所有错误必须单向经过：`ErrorErr01SourceRaised → ErrorErr02HostCaptured → ErrorErr03RuntimeClassified → ErrorErr04RouterPolicyApplied → ErrorErr05ExecutionDecision → ErrorErr06ClientProjected`。

provider/runtime/direct/executor 不得自行投影 HTTP 状态、retry、cooldown 或 fallback。provider-specific 差异只能由对应 provider runtime/manifest owner 处理。

## 必跑验证

```bash
git diff --check
npm --prefix v3 run install
routecodex restart --config /Users/fanzhang/.rcc/config.v3.toml
curl -sS http://127.0.0.1:7777/health
curl -sS http://127.0.0.1:4444/health
```

重启后必须用原始 canonical payload 复验 400、599、598 样本；普通 smoke 不能替代。检查 raw request、provider-bound request、raw response、client projection，证明错误阶段和状态码正确、payload 未裁剪、控制状态未泄漏。

构建、安装、重启、在线旧样本复验全部完成后才能运行 AGY review。提交前只暂存本次 change set：

```bash
git diff --cached --stat
git diff --cached --name-status
git commit -m "fix(v3): repair internal error projection"
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

最终汇报必须列出首次偏离节点、唯一 owner、修改文件、A/B/C 证据、测试、安装版本、重启 health、原始 payload replay、commit/远端 SHA 和剩余风险。

## 实现计划

### 目标与验收标准

- 599、400、598 样本均回到正确的首次偏离节点和唯一 owner。
- 内部请求阶段错误统一为 598，内部响应阶段错误统一为 599；外部 provider 原始状态码保持外部语义。
- 原始 payload 在线 replay 通过，错误链、provider 切换、SSE 语义和 debug sink 生命周期均正确。

### 范围与边界

范围：7777 Responses 请求/响应错误链、provider compat/wire、provider response inbound、debug sink 资源生命周期及其测试。

不在范围：改路由优先级、删除 provider、裁剪 payload、重写历史、添加 fallback、修改客户端协议语义。

### 设计原则

- 控制面与业务 payload 物理隔离。
- 错误只经统一 Error 链；SSE 只处理 transport/framing。
- provider-specific 语义只由 provider manifest/runtime owner 处理。
- 先红后绿，正反测试成对，禁止 handler/outbound 补偿。

### 技术方案与文件清单

先由 map/owner 查询锁定真实文件；候选区域包括：

- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
- `v3/crates/routecodex-v3-runtime/src/provider_failure_global_probe.rs`
- `v3/crates/routecodex-v3-provider-responses/src/wire.rs`
- `v3/crates/routecodex-v3-server/src/` 中对应 Error06/debug sink owner
- `v3/crates/routecodex-v3-config/` 中 provider manifest 映射 owner

不得凭路径猜 owner；实现前必须由 function map、mainline call map 和源码共同确认。

### 风险与规避

- 错误状态码归属混淆：用 A/B/C 和错误链节点证据锁定。
- provider 200 SSE error 被误判成功：保留 raw response，交 provider response inbound/manifest。
- debug sink 句柄泄漏：做并发、rotation、retention 和失败释放测试。
- 脏工作区混入：提交前只暂存本次 change set。

### 测试计划

- provider compat/wire 定向单测与反向测试。
- SSE/RespInbound 合法与非法帧测试。
- Error06 598/599 投影测试。
- debug sink 资源生命周期测试。
- 原始 canonical payload A/B/C 在线 replay。
- 构建、安装、managed restart、7777/4444 health、AGY review。

### 实施步骤

1. 读取架构文档、map、owner registry、run notes。
2. 采集并固定 400、599、598 最小 failing samples。
3. 完成 A/B/C 归因并锁定首次偏离节点。
4. 编写 red tests，修改唯一 owner，完成 green tests。
5. 运行定向测试、构建、安装、managed restart 和原始 payload replay。
6. 运行 AGY review；只在通过后提交并推送 `main`。

### 完成定义（DoD）

代码、测试、构建、安装、重启、在线旧样本复验和 AGY review 全部有证据；本地 HEAD 与 `origin/main` 相同；最终报告列出根因、owner、证据、剩余风险。

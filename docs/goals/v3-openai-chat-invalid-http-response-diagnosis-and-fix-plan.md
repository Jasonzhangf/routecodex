# V3 OpenAI Chat `InvalidHTTPResponse` 诊断与修复计划

## 目标与验收标准

处理 `/v1/chat/completions` 偶发客户端报错：

```text
InvalidHTTPResponse fetching http://127.0.0.1:7777/v1/chat/completions
```

根因必须通过同一 requestId 的完整证据链确认：

```text
client request
-> V3Server03HttpRequestRaw
-> admission/front wait
-> route_selected
-> provider-bound request
-> provider raw response
-> Chat response projection
-> client HTTP/SSE frame
```

验收：

- 明确区分 provider failure、RCC 内部错误、client disconnect、前端/请求 admission 等候、连接重启/重挂接。
- 找到首次偏离节点、唯一 owner、回归 commit（如存在）和最小 failing sample。
- Chat 成功请求保持原始协议语义、SSE framing、tool call、finish reason、usage，不裁剪 payload。
- 客户端不再因 RCC 返回空响应或不完整 HTTP 响应而得到 `InvalidHTTPResponse`。
- provider 真实错误仍进入 Error01-06；不得通过 fallback、换 provider、改路由或吞错掩盖问题。
- 合并入 `main` 后，owner worktree 无未提交改动、owner 分支无未合并唯一提交，并完成清理。

## 范围与边界

In scope：

- V3 OpenAI Chat Relay 请求/响应链。
- Chat 前端 HTTP/SSE channel、request activity/admission、front transport lease、provider concurrency/admission wait。
- `499 client_disconnect` 到客户端 `InvalidHTTPResponse` 的错误投影关系。
- 同 requestId 的 raw request、provider-bound request、provider raw response、client projection 和日志/样本采集。
- 相关 Rust runtime/server owner、测试、verification map、必要 goal/wiki/manifest 同步。

Out of scope：

- 不迁移到 Responses 入口。
- 不修改 provider 选择策略来绕开问题。
- 不降低 thinking、工具、上下文、SSE 或请求字段。
- 不改 provider-specific payload 兼容逻辑，除非 A/B/C 证明该 provider-bound request 是首次错误节点。
- 不处理与该 requestId 无关的已有 dirty 改动。

## 设计原则

1. 先诊断后修改。先读取项目 MemoryPalace、`note.md`、当前 run notes、resource/function/mainline/verification map 和相关 SOP。
2. 遵守 V3 唯一链：`HTTP -> Hub Pipeline -> Provider V2 -> upstream`；Chat 仍走 Chat Relay canonical path。
3. 控制语义只走 typed side-channel / Error chain，不进入 request/response normal payload 或协议 metadata。
4. 不做 fallback、静默 EOF、空响应成功化、handler/SSE/outbound 补偿或请求侧 cleanup。
5. provider 归因严格执行 A/B/C：
   - A：相同 provider/model/key 的最小直连。
   - B：失败 requestId 的完整 `provider-request.json` 原样直连。
   - C：相同客户端请求经过真实 7777 Chat 入口。
6. 只有 A/B/C 结果允许归因：A 失败归 provider；A 成功 B 失败归 provider-bound 构造；A/B 成功 C 失败归 front/transport/response projection。
7. `client_disconnect` 是 health-neutral terminal；不能计入 provider health，也不能当 provider 错误重试。
8. 任何 runtime 代码变更必须在独立 clean worktree 完成；主 tree 只接收通过验证的精确 change set。

## 技术方案与文件清单

先核对真实 owner，不预先假定文件。当前候选 owner：

- Chat Relay runtime：
  `v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs`
- Relay shared/admission/provider failure orchestration：
  `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs`
- Server execution/front response shell：
  `v3/crates/routecodex-v3-server/src/executors.rs`
  `v3/crates/routecodex-v3-server/src/endpoint_handlers.rs`
  `v3/crates/routecodex-v3-server/src/frame_builders.rs`
  `v3/crates/routecodex-v3-server/src/lib.rs`
- Request activity/front transport/admission：按 function/mainline map 实际 owner 确认，禁止仅凭 grep 选择修改点。
- Error chain：
  `v3/crates/routecodex-v3-error/src/lib.rs`

必须同步核对：

- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `contracts/maps/module-registry.json`
- `docs/architecture/wiki/v3-mainline-skeleton-sop.md`
- 相关 Chat Relay / SSE / runtime restart handoff manifest、wiki 和 test-design 文档

若 map 无法给出唯一 owner 或相邻调用边，先补 contract/map，再改 runtime。

## 测试计划

### 1. 失败样本与白盒测试设计

先固化最小 failing sample，测试必须覆盖：

- Chat JSON response：正常成功、provider error、RCC request error、RCC response error。
- Chat SSE：首帧前 failure、首帧后 client disconnect、正常 terminal、provider stream malformed、未完成 EOF。
- 20 秒左右 admission/front wait：
  - 正向：等待结束后完整 Chat response 正确送达。
  - 反向：客户端在等待阶段断开，进入 `client_disconnect`，不触发 provider retry/health 污染。
- 已启动 response 与未启动 response：
  - 已启动：只做已登记 SSE closeout。
  - 未启动：不得静默关闭或返回空 HTTP response；按当前 contract 产生显式 terminal。
- 同一 front connection 的并发/keep-alive 请求：每个 request 使用独立 lease、sequence、deadline 和 closeout。
- provider concurrency/admission：
  - permit 可用时不增加无界等待。
  - permit 等待被 client deadline 打断时，明确记录等待原因和终态。
- provider A/B 结果：
  - A/B 成功、C 失败必须锁住 front/transport 回归。
  - A 失败不得错误归因本地 Chat 链。

### 2. 最小红测

红测至少锁定：

- `received -> route_selected` 等待超出客户端 deadline 时，不能产生零字节/无 headers 的 client response。
- `client_disconnect` 不得被当作 provider failure、provider retry 或 cooldown。
- 已接受 Chat SSE 不得把 provider error 静默变成 EOF。
- 正常 Chat SSE 必须仍有合法 data frame 和 terminal `[DONE]`。
- error chain 必须保持 `Error01 -> Error06`，不得由 handler/SSE 重建错误。
- 一个请求的 closeout 不得影响并发请求或下一次 keep-alive request。

红测先在当前源码/当前安装版本确认失败，再改唯一 owner。

### 3. 回归测试

至少运行：

- Chat Relay runtime focused tests。
- Chat Relay integration/controlled tests。
- Server front/SSE/error projection tests。
- request activity/front transport/admission tests。
- positive/negative SSE closeout tests。
- provider failure/error-chain tests。
- source boundary/red-fixture tests，防止 fallback、空成功、非相邻转换、payload 控制字段泄漏。

## 验证方案

### 源码与架构门禁

- 复查 module registry 的 owner、`owned_paths`、allowed/forbidden paths。
- 复查 resource map、function map、mainline call map 的相邻边和资源关系。
- `git diff --check`。
- V3 architecture/resource/module-boundary/rust-only/forbidden-pattern gates。
- Chat Relay integration gate、SSE/front boundary gate、error-chain gate。

### 构建与定向验证

- V3 Rust fmt。
- V3 clippy，`-D warnings`。
- Chat Relay 定向测试。
- Server/SSE/front 定向测试。
- V3 workspace 测试。
- V3 CLI build。

具体命令以当前 `docs/architecture/v3-verification-map.yml` 和 package scripts 真源为准；执行前核对脚本仍存在，禁止伪造命令。

### 安装、重启、在线验证

代码通过本地测试后：

1. 使用项目规定的全局安装版本构建/安装。
2. 只用 `routecodex restart` / 当前项目规定的 managed restart 路径，不使用 `server stop`、`server start`、手工 foreground start 或第二 supervisor。
3. 验证配置中的全部 listener `/health`，确认运行版本与改动 commit 一致。
4. 用失败样本同一入口、同一协议、同一 request shape 重放 Chat `/v1/chat/completions`。
5. 保存同 requestId 的：
   - client request
   - `request.json`
   - `provider-request.json`
   - `provider-response.json`
   - client response/projection
   - server log
6. 重放成功样本、provider failure 样本、client disconnect 样本和并发等待样本。
7. 验证修复后无 InvalidHTTPResponse、无零响应体、无静默 EOF；provider 错误仍显式进入统一错误链。

没有 exact old-sample replay、运行版本 identity 和在线证据，不得宣称完成。

### Review 门禁

只有实现、定向测试、构建、全局安装、managed restart、health 和在线旧样本重放全部通过后，才运行默认 AGY Review。Review FAIL 必须修复后重新完成受影响验证，再创建新 review。

## 实施步骤

1. 创建 `run_id`，刷新 `.agent-collab` runs/claims/handoff/merge-queue/KILL_SWITCH 视图。
2. 读取 `note.md`、相关 run notes、MemoryPalace 命中源文件、Chat Relay SOP 和五类 architecture map。
3. 在 clean base 建立唯一 owner worktree：
   `./playground/chat-invalid-http-response-<run_id>/`
4. 声明 semantic claim：`feature_id:v3.openai_chat_invalid_http_response`；若已占用，读取 owner 并交接，不覆盖。
5. 查当前日志和 canonical samples，锁定 exact requestId、入口、端口、execution mode、provider/model/key、front identity、session scope。
6. 先完成 A/B/C；若没有完整 B 或 raw provider response，先补受控采集，不修改代码。
7. 检查 git 历史，锁定回归 commit、历史修复 commit、首次偏离节点和唯一 owner。
8. 写并确认最小 red test/test design。
9. 只在唯一 owner 做最小修复；禁止 handler/SSE/outbound 补偿、fallback、换 provider、裁剪字段。
10. 在 owner worktree 完成模块边界自检、定向测试、构建、全局 gates 和必要在线验证。
11. 写 `.agent-collab/runs/<run_id>/evidence.jsonl` 与 handoff/merge-queue，记录每项命令、结果、版本、样本路径和 commit。
12. checker 复核 change set、dirty 状态、evidence、map 边界和 required gates。
13. 将精确 change set 合并入 `main`；合并后在主 tree 重跑受影响定向验证、构建/安装 identity、managed restart、health 和 exact old-sample replay。
14. 主 tree 验证通过后运行 AGY Review；若 review 后有任何代码/测试/配置修改，旧证据与 review 失效，重新验证和 review。
15. 定向提交并 push；确认远端 commit 与主 tree HEAD 一致。
16. 仅在以下条件全部满足后清理 worktree 和 owner branch：
    - 主 tree 无未提交的本任务改动。
    - owner worktree `git status --short` 为空。
    - owner branch 无未合并的本任务 commit。
    - 远端 commit 已确认与主 tree HEAD 一致。
    - claim/evidence/handoff 已记录完成。
17. 清理后再次检查 `git worktree list`、主 tree HEAD、分支状态和 evidence；清理失败则停止并报告，不强制删除。

## 风险与规避

- 日志只显示 `499` 而没有 exact request sample：只能判定 client disconnect，不能继续归因 payload；先补样本。
- provider 502 与 Chat 499 混在同一日志：按 requestId/entry protocol 分离，不能混判。
- 请求在 `received` 到 `route_selected` 间等待：记录 admission/front wait 起止和 owner，不用改 timeout 掩盖。
- 客户端提前断开：不把 499 当 provider health，不重试，不切 provider。
- managed restart 中有并发 listener：按项目 restart identity 只重启聚合实例一次，验证全部端口。
- 主 tree 已有他人 dirty 改动：只做精确合并，禁止 reset、checkout、stash、restore 或 broad cleanup。

## 完成定义（DoD）

- 根因、回归节点、唯一 owner、A/B/C 结果和证据链已写入 evidence。
- 最小 red test 先红后绿；正向/反向生命周期测试均通过。
- 定向测试、构建、架构 gates、全局安装、managed restart、health、exact old-sample replay 全通过。
- 运行版本与本次改动 commit 一致。
- AGY Review controller PASS。
- 主 tree 已合并精确 change set 并完成提交/push。
- owner worktree 和 owner branch 已在合并入 `main` 后清理，且有可验证证据。
- 最终报告包含：改动、根因、验证、剩余风险、未完成项、worktree 清理结果。

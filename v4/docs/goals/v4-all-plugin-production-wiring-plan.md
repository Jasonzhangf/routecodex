# V4 全量插件生产接线计划

状态：`proposed_execution_plan`
目标：完成当前 V4 skeleton、standard plugin catalog 与真实生产语义之间的全部接线，使所有生产 request、response、error、config、routing、provider、SSE 与 terminal 路径经过对应的 `NodeContainer -> NodePluginPlan`，完成验证、AGY Review 与精确提交。

## 1. 验收标准

1. skeleton 中每个 active node 都有真实 NodeContainer、编译后的 immutable NodePluginPlan、typed handle 与 production execution evidence。
2. standard plugin catalog 中的 28 个插件均有唯一 production owner、descriptor、handle、plan entry、visited evidence；mock/keyless 实现不得成为 production success path。
3. `/v1/responses` 与 `/v1/chat/completions` 的 JSON/SSE 请求和响应均经过统一相邻节点链：

   ```text
   Server -> Inbound -> ChatProcess -> Routing/Target -> Provider Outbound
   -> Provider Transport -> Provider Inbound -> ChatProcess -> Client Outbound -> Server
   ```

4. error chain、config chain、client-drop/cancel、continuation、publish/drain/dispose 使用声明的 typed resource/control owner，不由 runtime-bin 或 payload 重建。
5. runtime-bin 不再拥有 client/provider/SSE 业务语义 helper；只保留 listener、typed dispatch、epoch/lease、生命周期和错误终止编排。
6. SSE 只负责 framing/lifecycle；provider SSE 与 client SSE 均经过独立 frame boundary plugin，禁止 SSE in/out 直通和 SSE 层业务治理。
7. client/provider 只通过相邻 typed semantic、wire、transport contract 连接；provider-specific protocol 逻辑归 provider/plugin owner，client projection 归 client outbound owner。
8. 生产 NodeContainer/plugin coverage、visited-node/plugin coverage、重复 semantic owner、direct business helper、mock/fallback production path、unexplained differential 均达到目标值 `100% / 100% / 0 / 0 / 0 / 0`。

## 2. 范围与边界

### In scope

- 28 个 standard plugin 的 production descriptor/handle/plan 接线；
- `V4ServerReqInbound01ClientRaw`、`V4ServerSseIn02FrameBoundary`、`V4HubReqInbound03Normalized`；
- `V4HubReqChatProcess04Governed`、routing/target nodes、request outbound、provider wire/transport；
- `V4ProviderSseIn01FrameBoundary`、response inbound/chat-process/outbound、client SSE/frame terminal；
- Error01-06、config authoring-to-manifest、scope/payload-cycle、diagnostic/observation 通过真实 owner 接入；
- Chat->Responses、Responses/provider wire、provider response/SSE decode、client semantic/frame projection 迁移到唯一插件 owner；
- production-path architecture gate、layer barrier、12 类 differential fixtures；
- build、V4 canary install、`rccv4` aggregate restart、在线验证、AGY Review、精确 commit/push。

### Out of scope

- 修改、安装、重启、停止或替换 V3；
- 未被当前 V4 contract/map 注册的新协议或新产品语义；
- 未授权的真实用户配置、provider secret、生产流量切换；
- 以 fallback、silent strip、跳过 gate 或伪造成功处理缺失能力。

## 3. 唯一 owner 与迁移规则

- Skeleton/相邻节点：`routecodex-v4-skeleton`。
- NodeContainer/Cordis lifecycle/typed dispatch：`routecodex-v4-node-container` 与已登记 Cordis host/bridge owner。
- Plugin descriptor/catalog/plan artifact：`routecodex-v4-standard-plugins`、`routecodex-v4-plugin-catalog`、`routecodex-v4-plugin-plan`。
- request/response semantic plugin：对应 protocol/chat-process plugin owner；standard library 只保留 catalog/bundle/descriptor，不复制真实业务实现。
- routing/target/control：`routecodex-v4-router` 与 `routecodex-v4-control`。
- provider protocol/wire/transport：`routecodex-v4-provider` 或拆分后的登记 provider plugin owner；不得由 client/server/runtime-bin 修补。
- error source/classify/policy/decision/project：`routecodex-v4-error`。
- listener/client framing：`routecodex-v4-server`。
- runtime-bin 只能消费 compiled manifest、active epoch、typed ports 与 terminal decision。

所有 owner、owned/allowed/forbidden paths、resource edges、mainline edges 和 required gates 必须先在 V4 resource/function/mainline/verification/module maps 中核对。无法唯一绑定时先修合同/map，不先改实现。

## 4. 实施顺序

### Phase 0：基线与治理

1. 读取 `AGENTS.md`、`note.md`、当前 run notes、V4 contracts/maps、AppSDK Active/Protected 状态。
2. 固定当前 V4 HEAD/tree、skeleton graph hash、manifest hash、plugin artifact set hash。
3. 审计 `RUNTIME-002/007` epoch、lease、pin、drain、dispose、restart identity；只补确证缺口，不建立第二 epoch owner。
4. 创建唯一 integration claim、`playground/<semantic>-<run_id>` clean worktree、actor/evidence/handoff 记录。

### Phase 1：独立 source-green barrier

按现有 owner 分组完成并分别提供红测、正反测试、NodeContainer blackbox、边界审计和 evidence：

1. Config/Manifest exact NodePluginPlan compiler；
2. Cordis mount、typed bridge、plan/hash publication；
3. request plugins：normalize、Chat->Responses、governance、provider semantic、wire build；
4. response plugins：provider raw/SSE decode、response governance、tool harvest、client projection、frame build、typed fault intake；
5. SSE input/output frame boundary plugins；
6. routing、provider capability/auth/transport typed plugins；
7. scope、payload-cycle、diagnostic、snapshot、error source/intake/project plugins；
8. request/response/error typed ports、epoch lease、production-path gate、layer barrier、differential harness。

独立层必须全部 `source_green`、red gate PASS、boundary audit PASS、evidence complete，且 duplicate semantic owner 为零，才允许接线。

### Phase 2：单一 integration owner 接线

严格按相邻边接入：

```text
compiled manifest
 -> real Cordis graph/Fibers
 -> NodeContainer registry
 -> ActiveExecutionEpoch/lease
 -> server request/SSE inbound
 -> request normalize/governance/continuation
 -> route/target
 -> provider semantic/wire/transport
 -> provider raw/SSE inbound
 -> response decode/governance/continuation
 -> client semantic/SSE/frame terminal
```

错误和断线从每个 owning boundary 进入 typed ErrorChain 或 registered client-drop terminal。每个请求只获取一次 epoch lease，每个合法 terminal 恰好释放一次；禁止 runtime-bin 重新读取 active epoch、从 payload 猜 control、或保留旧 helper 双路径。

### Phase 3：删除重复实现与静态锁

1. 对旧 runtime-bin/provider/client/SSE helper 做调用图和依赖证明。
2. 将已迁移且无引用的死语义物理删除；不得注释保留或建立兼容旁路。
3. production-path gate 必须能在 mutation fixture 下锁住：direct protocol/provider/response helper、SSE bypass、NodeContainer 缺失、未访问插件、跨节点 dispatch、mock/fallback path、payload/control 泄漏和重复 owner。

## 5. 验证矩阵

1. 定向 Rust crate tests、L2、compile-fail、NodeContainer/Cordis blackbox、正反生命周期测试。
2. 全部 V4 architecture gates：node graph、standard plugins、resource binding、module/function/mainline/verification binding、production path、layer barrier 与 red fixtures。
3. `npm --prefix v4 run test`、`verify`、`verify:red`、`verify:ci`、AppSDK admission、Active index generation/verification。
4. release build，安装匹配 artifact 的 `rccv4`，使用 V4 专用 aggregate restart，检查所有配置 listener `/health` 与 `/v1/models`。
5. 在线同入口验证 Responses/Chat JSON/SSE、continuation、provider success/4xx/429/5xx、malformed SSE、EOF、timeout/cancel、client disconnect、publish/drain/dispose、restart identity。
6. 每次真实请求保存并核对同一 requestId 的 raw request、provider-bound request、raw response、client projection、visited nodes/plugins、binding/epoch/hash。
7. 12 类 differential fixtures 要求 `unexplained_diff=0`。
8. 验证与安装版本一致后，启动默认 `agy-review`；任何 P0/P1 或 FAIL 必须回唯一 owner 修复，重跑受影响验证和新 review。

## 6. 提交与完成定义

1. review PASS 后检查 `git diff --cached --stat`、`git diff --cached --name-status`，只暂存本任务声明的 V4 change set。
2. 提交前证明已验证 tree、安装 binary、review candidate、commit 内容一致；不暂存或覆盖无关 dirty 文件。
3. 定向 commit/push；push 后证明远端 commit 与本地 HEAD 一致，再清理 worktree/claim。
4. 最终报告只引用可复核 evidence：变更路径、测试/gate、安装版本、重启身份、在线样本、AGY verdict、commit/remote HEAD 和剩余风险。


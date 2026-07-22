# Snapshot Stage Contract

本文件定义 `--snap` / `--snap-stages` / 模块级 snapshot 的唯一命名与默认捕获 contract。

## 1. 默认 `--snap` contract

### 1.1 V3 live `rccv3 --snap`

V3 live `rccv3 start --snap` 默认必须打开四类真实边界快照：

- `client-request`
- `provider-request`
- `provider-response`
- `client-response`

说明：

- 这是 V3 live 在线闭环的最小审计合同，必须能从 client request → provider request → provider response → client response 还原真实链路。
- `provider-request` 在 V3 live 中不是手工构造、dry-run 构造或 Hub 重建样本；唯一 owner 是 live provider transport cutpoint recorder，在真实 provider send 前记录已经构造好的 provider transport request。
- `provider-response` 在 V3 live 中记录真实 provider JSON body / SSE chunk / provider error response 经过 transport 时的原始观测，不消费 stream，不拥有 SSE 或响应语义。
- `client-response` 在 V3 live 中必须记录实际回客户端的 JSON body 或 raw SSE frame；SSE 情况下 `response.json.rawSse` 至少能对账 `response.*` 事件和 `[DONE]`，不得只写 `stream:true/status/node_trace` 这类 metadata 占位样本。
- Hub/module snapshot hooks 仍必须拒绝 `provider-request` body；provider-request replay artifact 不得从 Hub、SSE、handler、RespOutbound、ReqInbound 或 MetadataCenter 重建。
- V3 `--snap-stages "<selector>"` 可以局部选择上述 stage；显式 selector 覆盖默认四件套。
- `provider-error`、`*.retry`、`*.contract`、`chat_process.*`、`hub_followup.*`、`servertool.*` 不属于默认最小集。
- `--mode analysis` 可强制 `*`，但普通 V3 `--snap` 不能默认膨胀成全量模块快照。

### 1.2 V2 / legacy TS snapshot policy

V2 / legacy TS `src/utils/snapshot-stage-policy.ts` 的默认 `--snap` 仍保持三类边界快照：

- `client-request`
- `provider-response`
- `client-response`

说明：

- V2/legacy `provider-request` 不属于默认集：完整 provider 出站 body 只允许在显式 `--snap-stages provider-request`、provider-request contract/debug writer，或失败复现的 force-local debug 捕获中写入。
- 这条 legacy policy 不得反向限制 V3 live `rccv3 --snap` 的四段样本合同。

## 2. 命名族

### 2.1 边界快照

- `client-request`
- `provider-request`
- `provider-request-contract`
- `provider-request.retry`
- `provider-response`
- `provider-response-contract`
- `provider-response.retry`
- `provider-error`
- `provider-preprocess-debug`
- `provider-body-debug`
- `client-response`
- `client-response.error`

规则：

- 边界快照必须使用 kebab-case 基名，必要时只允许 `.retry` / `.error` 这类受控后缀。
- `provider-*` / `client-*` 是 transport / protocol edge 观测，不得混入模块语义。

### 2.2 模块级快照

- `chat_process.req.*`
- `chat_process.resp.*`
- `hub_followup.*`
- `servertool.*`
- `repair-feedback`

规则：

- 模块级快照必须表达 owner 模块和方向，禁止用无 owner 的临时名单独漂浮。
- 模块级快照只在显式 `--snap-stages` 或 analysis/hub snapshots 打开时记录，不得污染默认边界最小集。

## 3. 开关语义

- `--snap`：启用默认边界三件套。
- `--snap-stages "<selector>"`：显式选择快照 stage；支持精确匹配和 `*` 前缀匹配。
- `--snap-off`：显式关闭。
- `ROUTECODEX_HUB_SNAPSHOTS=1`：允许 `chat_process.*` / `hub_followup.*` / `servertool.*` 等模块级快照。

推导规则：

1. selector 只包含 `client-*` / `provider-*` / `http-*` 时，不强制 hub snapshots。
2. selector 包含 `chat_process.*` / `hub_followup.*` / `servertool.*` / `*` 时，必须启用 hub snapshots。

## 4. 路径与归档

- 边界快照和模块级快照统一落到 `~/.rcc/codex-samples/`。
- 目录桶必须优先按 entry endpoint / port / requestId 归档，不得按 provider 反推主桶。
- snapshot metadata 只能留在 snapshot root / meta，禁止写回 provider wire payload 或 client response payload。
- `client-request` 若因 payload 超过 debug 限额而不能保留完整正文，必须由 debug owner 写显式 oversize artifact；禁止写出仅含 `meta` 的假成功快照。
- `__runtime.json` 若已有 request truth / runtime metadata，可观测面必须保留足以区分历史主线的链路识别字段，例如 `sessionId`、`conversationId`、`continuationOwner`、`responsesResume/continuation`、stopless runtime control；禁止把不同 continuation / stopless / 独立 create 链压扁成不可区分的同桶样本。
- Stopless 相关 snapshot metadata 与 `__runtime.json` 只允许作 diagnostic correlation only，属于 L8 observability/debug；它们必须保留在观测侧，must never restore or own StoplessCenter control truth，也不得替代 L5 Metadata Center。
- snapshot/debug artifact 中的 Stopless 标识只能关联同一请求链的样本；禁止从 snapshot metadata、debug metadata 或 `__runtime.json` restore / hydrate / rebuild StoplessCenter state，禁止据此驱动 guidance、CLI、repeat guard 或 terminal 判定。

## 5. 测试覆盖要求

至少保持以下测试/门禁存在：

- `tests/utils/snapshot-stage-policy.spec.ts`
- `tests/providers/core/utils/snapshot-writer.release-gating.spec.ts`
- `tests/debug/snapshot-store-port-isolation.red.spec.ts`
- `tests/provider/http-request-executor-sse-snapshot.spec.ts`
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`
- `npm run verify:architecture-snapshot-stage-contract`
- `npm run verify:architecture-snapshot-stage-owners`

## 6. 反模式

- 默认 `--snap` 缺失 `client-request` 或 `client-response`
- 用 provider 名或上游协议反推主目录桶
- 把 snapshot metadata / runtime carrier 混入正常 payload
- 模块级 snap 无 owner 前缀，或用临时命名漂移
- 修改了 snapshot stage 选择但没有补测试或 gate

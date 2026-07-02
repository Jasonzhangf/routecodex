# Snapshot Stage Contract

本文件定义 `--snap` / `--snap-stages` / 模块级 snapshot 的唯一命名与默认捕获 contract。

## 1. 默认 `--snap` contract

`--snap` 默认只打开三类边界快照：

- `client-request`
- `provider-response`
- `client-response`

说明：

- 这是最小审计闭环，保证能从 client → provider response → client 还原真实链路。
- `provider-request` 不属于默认集：完整 provider 出站 body 只允许在显式 `--snap-stages provider-request` 或失败复现的 force-local debug 捕获中写入；不得由普通 `--snap` 默认记录。
- Hub/module snapshot hooks 仍必须拒绝 `provider-request` body；provider-request replay artifact 的唯一 owner 是 provider/debug snapshot writer，不得从 Hub、SSE、handler 或 MetadataCenter 重建。
- `provider-error`、`*.retry`、`*.contract`、`chat_process.*`、`hub_followup.*`、`servertool.*` 不属于默认最小集。
- `--mode analysis` 可强制 `*`，但普通 `--snap` 不能默认膨胀成全量模块快照。

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

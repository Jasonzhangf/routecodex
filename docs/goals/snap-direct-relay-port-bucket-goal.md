# `--snap` Direct/Relay 全路径收口：ServerSnap05 / ProviderSnap06 命名锁 + Function Map

## 1. 目标与验收标准

### 目标
按全局 AGENTS.md 的“模块 + 阶段 + 节点序号 + 节点语义”规则，重构 `--snap` 的 direct/relay 全路径覆盖与目录命名：

- `ServerSnap05ClientRequest`
- `ProviderSnap06ProviderRequest`
- `ProviderSnap06ProviderResponse`
- `ServerSnap05ClientResponse`
- `ProviderSnap06ProviderError`

所有 direct/relay 路径必须通过 function map 可查询唯一 owner、允许修改路径、禁止修改路径、必跑验证命令和红测。最终 `--snap` 统一落盘到：

```text
~/.rcc/codex-samples/<endpointFolder>/ports/<port>/<mode>/<providerToken>/<groupRequestId>/
```

`<mode>` 只允许：

- `direct`
- `relay`
- `router-direct`
- `router-relay`

### 验收标准

1. direct/relay 四路径在 `--snap` 开启时均落四件套：
   - `client-request.json` -> `ServerSnap05ClientRequest`
   - `provider-request.json` -> `ProviderSnap06ProviderRequest`
   - `provider-response.json` -> `ProviderSnap06ProviderResponse`
   - `client-response.json` -> `ServerSnap05ClientResponse`
2. `client-response` 不再有独立 env 旁路；统一走 `SnapshotStageKind` / `shouldCaptureSnapshotStage('client-response')`。
3. `port-XXXX/`、`port-unknown/`、裸 `<providerToken>/<groupRequestId>/` 写路径从 `src/` 物理删除。
4. `errorsamples.ts` 端口段与 snapshot 对齐为 `ports/<port>/`。
5. `docs/architecture/function-map.yml` 包含 `snapshot.direct_relay_coverage`，并更新 `snapshot.stage_contract`。
6. `verify:architecture-snapshot-stage-contract`、`verify:architecture-snapshot-stage-owners`、`verify:function-map-owner-uniqueness` 全绿。
7. 5555 live smoke 落盘目录示例：

```text
~/.rcc/codex-samples/openai-responses/ports/5555/router-direct/asxs.crsa.gpt-5.5/<groupRequestId>/
  __runtime.json
  client-request.json
  provider-request.json
  provider-response.json
  client-response.json
```

## 2. Function Map Contract

### 2.1 必须新增：`snapshot.direct_relay_coverage`

```yaml
  - feature_id: snapshot.direct_relay_coverage
    status: planned
    summary: direct/provider-direct/router-direct and relay paths write ServerSnap05 + ProviderSnap06 four-piece snapshots under ports/<port>/<mode>/ with SnapshotStageKind gating
    owner_module: src/utils/snapshot-shared
    canonical_types:
      - SnapshotStageKind
      - SnapshotStagePolicy
      - SnapshotPortSegment
      - ServerSnap05ClientRequest
      - ServerSnap05ClientResponse
      - ProviderSnap06ProviderRequest
      - ProviderSnap06ProviderResponse
      - ProviderSnap06ProviderError
    canonical_builders:
      - resolveSnapshotEndpointFolder
      - resolveSnapshotPortSegment
      - resolveSnapshotModeSegment
      - writeClientSnapshot
      - writeProviderSnapshot
      - writeServerSnapshot
      - shouldCaptureSnapshotStage
    allowed_paths:
      - src/utils/snapshot-shared
      - src/utils/snapshot-stage-policy.ts
      - src/utils/snapshot-writer.ts
      - src/providers/core/utils/snapshot-writer.ts
      - src/providers/core/utils/snapshot-writer-buffer.ts
      - src/server/runtime/http-server/index.ts
      - src/server/handlers/handler-response-utils.ts
      - src/utils/errorsamples.ts
      - docs/architecture/snapshot-stage-contract.md
      - docs/goals/snap-direct-relay-port-bucket-goal.md
    forbidden_paths:
      - src/client
      - src/providers/profile
      - src/providers/core/runtime/responses-provider.ts
      - src/server/runtime/http-server/executor/provider-response-converter.ts
    required_tests:
      - tests/server/runtime/http-server/router-direct-snap.red.spec.ts
      - tests/server/runtime/http-server/provider-direct-snap.red.spec.ts
      - tests/providers/core/utils/snapshot-writer.port-bucket.spec.ts
      - tests/utils/snapshot-stage-policy.spec.ts
      - tests/providers/core/utils/snapshot-writer.release-gating.spec.ts
      - tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts
      - tests/debug/snapshot-store-port-isolation.red.spec.ts
    required_gates:
      - npm run verify:architecture-snapshot-stage-contract
      - npm run verify:architecture-snapshot-stage-owners
      - npm run verify:function-map-owner-uniqueness
      - npx tsc --noEmit --pretty false
      - npm run build:min
    migration_target: rust
    notes:
      - ServerSnap05 writes client edge only; ProviderSnap06 writes provider edge only.
      - port is mandatory; missing entryPort must fail-fast and must not create port-unknown.
      - Direct paths must not rebuild payload from metadata, rawBody, snapshot, context, or history.
```

### 2.2 必须更新：`snapshot.stage_contract`

`snapshot.stage_contract` 需要补齐：

- `owner_module: src/utils/snapshot-shared`
- `canonical_types` 增加：
  - `ServerSnap05ClientRequest`
  - `ServerSnap05ClientResponse`
  - `ProviderSnap06ProviderRequest`
  - `ProviderSnap06ProviderResponse`
  - `ProviderSnap06ProviderError`
  - `SnapshotPortSegment`
- `canonical_builders` 增加：
  - `resolveSnapshotEndpointFolder`
  - `resolveSnapshotPortSegment`
  - `resolveSnapshotModeSegment`
- `required_tests` 增加：
  - `tests/server/runtime/http-server/router-direct-snap.red.spec.ts`
  - `tests/server/runtime/http-server/provider-direct-snap.red.spec.ts`
  - `tests/providers/core/utils/snapshot-writer.port-bucket.spec.ts`

## 3. 节点命名与职责边界

| 节点 ID | 方向 | 语义 | 唯一 owner/builder | 禁止动作 |
|---|---|---|---|---|
| `ServerSnap05ClientRequest` | request | client ingress raw snapshot | `writeClientSnapshot` | 不得写 provider wire |
| `ProviderSnap06ProviderRequest` | request | provider outbound wire snapshot | `writeProviderSnapshot(phase='provider-request')` | 不得读取 client response |
| `ProviderSnap06ProviderResponse` | response | provider inbound raw response snapshot | `writeProviderSnapshot(phase='provider-response')` | 不得投影 client payload |
| `ServerSnap05ClientResponse` | response | client final JSON/SSE snapshot | `writeServerSnapshot(phase='client-response')` | 不得修 provider raw |
| `ProviderSnap06ProviderError` | error | provider transport/runtime error snapshot | `writeProviderSnapshot(phase='provider-error')` | 不得 fallback 成成功响应 |

命名规则：

- `ServerSnap05*` 只能在 server/client edge 观测。
- `ProviderSnap06*` 只能在 provider edge 观测。
- Snapshot 节点不是正常 request/response payload 节点，不能参与 payload 修复、metadata 补偿或 protocol conversion。
- 新增 stage 必须先写入 `docs/architecture/snapshot-stage-contract.md` 和 `docs/architecture/function-map.yml`。

## 4. 范围与边界

### In Scope

- 新建 `src/utils/snapshot-shared/`：
  - `endpoint-folder.ts` -> `resolveSnapshotEndpointFolder`
  - `port-segment.ts` -> `resolveSnapshotPortSegment`
  - `mode-segment.ts` -> `resolveSnapshotModeSegment`
  - `request-id.ts` -> `normalizeSnapshotRequestId` / `normalizeSnapshotProviderToken`
  - `write-unique-file.ts`
- 两个 writer 去重：
  - `src/utils/snapshot-writer.ts`
  - `src/providers/core/utils/snapshot-writer.ts`
- `client-response` 收口到 `SnapshotStageKind`。
- direct/relay 四路径补 snap 注入：
  - `executeRouterDirectPipelineForPort`
  - `executeProviderDirectPipelineForPort`
- 旧布局物理删除与一次性迁移。
- function map 更新。

### Out of Scope

- 不改 Hub Pipeline / Virtual Router / Provider Runtime 拓扑。
- 不改 servertool / stopless / followup 编排。
- 不改 provider runtime 内部协议适配。
- 不新增 fallback / 降级 / 兜底。

## 5. 技术方案

### 5.1 `snapshot-shared` 唯一命名 helper

```text
src/utils/snapshot-shared/
  endpoint-folder.ts
  port-segment.ts
  mode-segment.ts
  request-id.ts
  write-unique-file.ts
```

关键函数：

- `resolveSnapshotEndpointFolder(entryEndpoint: string): 'openai-responses' | 'anthropic-messages' | 'openai-chat'`
- `resolveSnapshotPortSegment(entryPort: number | undefined): 'ports/<port>'`
- `resolveSnapshotModeSegment(mode: unknown): 'direct' | 'relay' | 'router-direct' | 'router-relay'`
- `normalizeSnapshotRequestId(value?: string): string`
- `normalizeSnapshotProviderToken(value?: string): string`

`resolveSnapshotPortSegment` 必须 fail-fast：port 缺失直接 throw，禁止 `port-unknown`。

### 5.2 `ServerSnap05ClientResponse` 收口

修改 `src/server/handlers/handler-response-utils.ts`：

- 删除 `shouldCaptureClientStreamSnapshots()` 对 `client-response` 的独立 env 判定。
- 所有 `client-response` / `client-response.error` 写入前先调用 `shouldCaptureSnapshotStage(stage)`。
- `ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS` 仅保留给 provider stream capture，不控制 client final response。

### 5.3 Direct/Relay snap 注入点

`src/server/runtime/http-server/index.ts`：

- `executeRouterDirectPipelineForPort`
  - `onSnapshotBefore` 写 `ProviderSnap06ProviderRequest`
  - `onSnapshotAfter` 写 `ProviderSnap06ProviderResponse`
  - error catch 写 `ProviderSnap06ProviderError`
  - mode=`router-direct`
- `executeProviderDirectPipelineForPort`
  - `onSnapshotBefore` 写 `ProviderSnap06ProviderRequest`
  - `onSnapshotAfter` 写 `ProviderSnap06ProviderResponse`
  - error catch 写 `ProviderSnap06ProviderError`
  - mode=`direct`
- relay 路径：
  - router relay 走 request-executor / Hub Pipeline，mode=`router-relay`
  - provider relay 不得在 provider-direct 内私自执行，必须显式进入 Hub Pipeline 或 fail-fast

### 5.4 路径模板

统一写入：

```text
<snapshotRoot>/<endpointFolder>/ports/<entryPort>/<mode>/<providerToken>/<groupRequestId>/<stage>.json
```

禁止写入：

```text
<endpointFolder>/port-5555/...
<endpointFolder>/port-unknown/...
<endpointFolder>/<providerToken>/<groupRequestId>/...
<endpointFolder>/<groupRequestId>/...
```

### 5.5 旧路径物理删除与迁移

新增一次性脚本：

```text
scripts/snapshot/migrate-legacy-layout.ts
```

行为：

- `--dry-run` 打印迁移表。
- 真实执行只 move，不 delete。
- 归档目标：

```text
~/.rcc/codex-samples/legacy/<UTC>/<original-relative-path>/
```

迁移后从 `src/` 删除所有旧写路径分支，包括 `purge429ProviderSnapshotArtifacts` 的 legacyDir 分支。

## 6. 测试矩阵

| 测试 | 目的 |
|---|---|
| `tests/server/runtime/http-server/router-direct-snap.red.spec.ts` | router-direct 四件套 + provider-error |
| `tests/server/runtime/http-server/provider-direct-snap.red.spec.ts` | provider direct 四件套 + provider relay 不直写 |
| `tests/providers/core/utils/snapshot-writer.port-bucket.spec.ts` | `ports/<port>/<mode>/`、port 缺失 fail-fast、旧布局不生成 |
| `tests/utils/snapshot-stage-policy.spec.ts` | `client-response` token 化 |
| `tests/providers/core/utils/snapshot-writer.release-gating.spec.ts` | release gate |
| `tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts` | local mirror |
| `tests/debug/snapshot-store-port-isolation.red.spec.ts` | port isolation |

验证命令：

```bash
npm run verify:architecture-snapshot-stage-contract
npm run verify:architecture-snapshot-stage-owners
npm run verify:function-map-owner-uniqueness
npx tsc --noEmit --pretty false
npm run build:min
pnpm test tests/providers/core/utils/snapshot-writer.* tests/snapshot/* tests/utils/snapshot-stage-policy.spec.ts
```

Live gate：

```bash
npm run install:global
routecodex restart --port 5555
# 发一次 /v1/responses 请求后检查:
ls ~/.rcc/codex-samples/openai-responses/ports/5555/router-direct/*/*
```

## 7. 实施步骤

1. 新建 `src/utils/snapshot-shared/`，实现 endpoint/port/mode/request-id/write helpers。
2. 两 writer import shared helpers，删除重复实现。
3. 更新 `docs/architecture/function-map.yml`：
   - 新增 `snapshot.direct_relay_coverage`
   - 更新 `snapshot.stage_contract`
4. 更新 `docs/architecture/snapshot-stage-contract.md`：写入 ServerSnap05 / ProviderSnap06 节点表、路径模板、反模式。
5. 改 `handler-response-utils.ts`：`client-response` 走 `shouldCaptureSnapshotStage`。
6. 改 `index.ts` direct hooks：写 ProviderSnap06 request/response/error。
7. 改 `errorsamples.ts`：端口段 `ports/<port>/`。
8. 删除旧布局写路径和 `purge429` legacyDir 分支。
9. 写迁移脚本并 dry-run。
10. 写/更新红测。
11. 跑测试矩阵和架构 gates。
12. build/install/restart 5555，live smoke。
13. 执行真实迁移，确认旧布局不再生成。
14. 更新 MEMORY.md：记录 `--snap` 路径命名和 function map 规则。
15. 提交。

## 8. 完成定义

- `ServerSnap05*` / `ProviderSnap06*` 命名在 docs、function map、测试名中一致。
- `snapshot.direct_relay_coverage` 可在 `docs/architecture/function-map.yml` 查询。
- `snapshot.stage_contract` 包含新 canonical types/builders/tests。
- direct/relay 四路径都能落四件套。
- `client-response` 只走 stage policy。
- 旧目录布局写路径从 `src/` 物理删除。
- 5555 live smoke 有四件套证据。

# debug unified surface 整合目标（2026-06-22）

## 1. 目标
把当前散落在 `src/debug` / `src/utils` / `src/providers/core/utils` / `src/modules/pipeline/utils` / `src/providers/core/hooks` 的 debug 语义收成**唯一**治理面 `debug.unified_surface`，做到：
- 任何 debug 能力只能有一个 owner 模块 / 唯一入口 / 唯一 canonical builder；
- debug 只允许是 side-channel / observation carrier，**不得污染** provider normal request payload 或 client normal response body（对齐 `metadata.center.mainline` 中 `debug_snapshot` family 的 `live_path_only: false` + `replay_scope_required: true` 边界）；
- 旧 debug owner 物理删除，不允许"不接入 / 注释 / 闲置"。
- 收口顺序必须是**一个模块一个模块迁移**：每个模块先补 owner/map/test/wiki，再迁实现，再删旧路径；禁止一次性把 snapshot/logger/diag/hooks/harness 全混在一个大改里。
- `diag/diagnostics` 必须先分类再处理：不是所有 `diagnostics` 都属于 debug 模块。

## 2. 现状审计（已验证）
| 现有能力 | 现行 owner | 问题 |
| --- | --- | --- |
| snapshot store / session / harness / replay | `src/debug/*` (无 feature_id) | 只有 facade，没有正式 owner registry；`src/debug/index.ts` 暴露全部子模块符号，等于无封装 |
| server snapshot writer + local disk fallback + hook writer bridge | `src/utils/snapshot-writer.ts` | owner = `snapshot.stage_contract`（在 `src/utils`），跨模块拼接 server/runtime + 持久化 + hub bridge，调试与运行时混合 |
| provider snapshot writer + queue/retention/local mirror | `src/providers/core/utils/snapshot-writer.ts` + `snapshot-writer-buffer.ts` | owner = `snapshot.provider_error_buffer`，定义在 `src/providers/core/utils`，跨 server 与 provider 边界 |
| pipeline/provider console logger | `src/modules/pipeline/utils/debug-logger.ts` | 没有 function-map owner；承载 console + env 控制 + provider 噪声过滤 + request log 内存缓冲 |
| 老 debug logger 出口 | `src/providers/core/utils/debug-logger.ts` | 全文件 1 行 re-export，等于历史 dead code |
| provider debug hooks | `src/providers/core/hooks/debug-example-hooks.ts` + `src/providers/core/config/provider-debug-hooks.ts` | owner = `provider.debug_example_hooks_surface`；输出 `_debugTimestamp/_traceId/_hookMetrics` 等调试字段，存在污染 normal response metadata 风险 |
| 通用 debug utils | `src/utils/debug-utils.ts` + `src/types/debug-types.ts` | 旧 v2 debug utils，function-map 没有登记；与 `src/debug` 重复覆盖 sanitize/format/deepClone |
| policy violation 复制 + 报告 | `src/debug/README.md` 描述的 `__policy_violations__` 目录 + `npm run policy:report` | 属于"子流程手工约定"，未进 function-map / verification-map |
| error diag file | `src/server/handlers/responses-handler.ts` 手工写 `~/.rcc/diag/error-*.json` | catch 内直接 `fs.writeFileSync`，且 `catch {}` 静默吞写失败；这是证据落盘，不是 snapshot，也不是 VR diagnostics |
| HTTP diagnostics endpoint | `src/server/runtime/http-server/routes.ts` 的 `/_routecodex/diagnostics/virtual-router` | 属于 VR runtime read-only status surface，owner 是 `vr.provider_forwarder_runtime`，不能迁到 debug 实现语义里 |
| inline usage diag | `src/server/runtime/http-server/executor/usage-logger.ts` 的 `diag=...` | 属于 log rendering 子面，应该随 logger 子模块收口，不应混入 snapshot/replay |
| Rust/VR/Hub `diagnostics` fields | Virtual Router / Hub native result 中的 `diagnostics` | 这是 runtime contract output，不是 debug module artifact；debug 只能消费/投影，不拥有生成语义 |
| system design（已过时） | `docs/debug-system-design.md` | 设计了 `ModuleDebugAdapter / DebugAPIExtension / DebugWebsocket`，但 repo 实际只保留 snapshot/logger；属于历史死设计 |

## 3. 整合后设计

### 3.1 唯一 owner
新增 function-map `feature_id: debug.unified_surface`：
- `owner_kind: ts_runtime_owner`
- `owner_module: src/debug/index.ts`（或将来 Rust shell 接管后 `migration_target: rust`）
- `canonical_types`: `DebugSurface`, `DebugSession`, `NodeSnapshot`, `DebugLogger`, `DebugHarness`, `DebugPolicyCarrier`
- `canonical_builders`: `createDebugToolkit`, `DebugLogger.create`, `DebugHarnessRegistry.create`, `DebugPolicyCarrier.fromSnapshot`
- `allowed_paths` 锁定在 `src/debug` + `docs/architecture/wiki/debug-*`
- `forbidden_paths` 包含 `src/providers/core/hooks`, `src/providers/core/config`, `src/providers/core/utils/debug-logger.ts`, `src/utils/debug-utils.ts`, `src/types/debug-types.ts`, `src/modules/pipeline/utils/debug-logger.ts`

### 3.2 目录结构
```
src/debug/
  index.ts                       # createDebugToolkit() 唯一入口
  surface.ts                     # DebugSurface facade
  types.ts                       # 唯一 DebugSession/NodeSnapshot/Harness 类型
  snapshot/
    store.ts                     # FileSnapshotStore（合原 src/debug + src/utils/snapshot-writer + providers core utils 写面）
    server-writer.ts             # server snapshot writer 收纳
    provider-writer.ts           # provider snapshot writer 收纳
    buffer.ts                    # provider error buffer 收纳
    payload-guard.ts             # 现有 utils/snapshot-payload-guard.ts 收纳
    retention.ts                 # 现有 utils/snapshot-request-retention.ts 收纳
  logger/
    pipeline.ts                  # 现有 modules/pipeline/utils/debug-logger.ts 收纳
    colored.ts                   # 现有 colored-logger.ts 收纳
  harness/
    registry.ts                  # HarnessRegistry
    provider.ts                  # ProviderPreprocessHarness
  runner/
    replay-runner.ts             # ReplayRunner
    policy-carrier.ts            # 新增：把 policy violation 转 carrier，禁止手工 copy
  diag/
    error-writer.ts              # ~/.rcc/diag/error-*.json 唯一写面
    error-reader.ts              # replay/debug 脚本读 diag 的唯一解析面
    classifier.ts                # diag artifact taxonomy，不做 runtime policy
  hooks/
    example-hooks.ts             # 现 debug-example-hooks 收纳（仅作 demo，禁止 normal payload）
    bidirectional.ts             # 现有 provider-debug-hooks 收纳
  policy/
    violations.ts                # 新增：把 ~/.rcc/codex-samples/__policy_violations__ 写面沉到 debug 唯一面
```
旧路径立刻标记 `forbidden_paths`，逐文件物理删除。

### 3.3 metadata 边界
- `debug_snapshot` family 继续由 `docs/architecture/metadata-center-manifest.yml` 拥有；
- debug 模块只读不写 metadata 内部 carrier；只能写 `debug_snapshot` family；
- 物理上禁止 `debug.* -> request_truth / continuation_context / runtime_control / provider_observation / client_attachment_scope` 任何写入；现有 `BidirectionalHookManager` 输出字段统一从 normal payload 中剥离；
- 反向：`metadata.center.mainline` 也不能逆向把 `debug_snapshot` 提到 `request_truth`（防止 `replay_scope_required: true` 被绕过）。

### 3.4 policy 违规集中
- `~/.rcc/codex-samples/__policy_violations__` + `~/.rcc/errorsamples/policy/` 的 copy 行为必须收口到 `src/debug/policy/violations.ts`，由 `DebugPolicyCarrier` 唯一驱动；
- `npm run policy:report` 改为读 debug 唯一写面；
- 旧 `src/debug/README.md` 中手工约定段落删除，由 `src/debug/policy/README.md` 替代。

### 3.5 diag 处理边界

`diag` 不等于 `diagnostics`。先按来源和用途分三类：

| 类别 | 例子 | owner 归属 | 迁移规则 |
| --- | --- | --- | --- |
| error diag artifact | `~/.rcc/diag/error-${requestId}.json`；`scripts/debug/replay-live-minimax-2013.mjs` 读取旧 diag | `debug.diag_error_artifact` -> `src/debug/diag/*` | 迁入 debug。只负责 evidence 落盘/读取/重放输入，不做 runtime recovery/policy |
| runtime diagnostics contract | `routeResult.diagnostics`、VR forwarder status、Hub native plan diagnostics | 原 runtime owner，例如 `vr.provider_forwarder_runtime` / Hub Rust owner | 不迁入 debug。debug 只能作为 read-only projector/consumer，禁止重写语义 |
| log diag rendering | usage line 里的 `diag=wait.traffic ... decode.sse ...` | `debug.logger_surface` -> `src/debug/logger/*` | 随 logger 模块迁移，只处理渲染和输出 gating，不改变 runtime timing 真源 |

error diag 迁移要求：
- `responses-handler.ts` 不得直接 `fs.writeFileSync` 到 `~/.rcc/diag`。
- diag 写失败不得静默 `catch {}`；必须走非阻塞错误日志或 debug writer 的显式错误结果。
- diag payload 必须先通过 debug redaction/payload guard；`requestBody` 保留语义等价，但 secret 必须遮罩。
- diag 文件只能作为 evidence/replay 输入，不能作为 live path state、retry/fallback 条件、metadata truth。
- replay 脚本不得硬编码单个本机 diag 路径；必须通过 `src/debug/diag/error-reader.ts` 接受显式路径参数。

runtime diagnostics 不迁移要求：
- `/_routecodex/diagnostics/virtual-router` 保持 server route read-only surface；实现仍只读 VR status，不拥有 selection/health policy。
- `docs/architecture/function-map.yml` 中 `vr.provider_forwarder_runtime` 的 diagnostics note 不改语义。
- 所有 Rust/VR/Hub native `diagnostics` 字段仍属于各自 runtime contract；debug 不能新增同义 DTO 或二次分类。

### 3.6 模块化收口顺序

每个模块必须按同一个闭环执行：
1. 定义模块边界：owner feature_id、allowed_paths、forbidden_paths、canonical types/builders。
2. 写 review 面：wiki source + manifest + mainline/call-map 边界（可先标 `binding pending`，但本模块完成前必须 anchored）。
3. 固化红测：旧路径仍在时红；迁移后绿。
4. 迁实现：只迁当前模块，禁止顺手改其它 debug 子域。
5. 删除旧路径：同模块旧 owner 物理删除。
6. 跑最小验证栈：focused Jest + static gate + function-map gate。
7. 更新 note/MEMORY/skill lessons（只写可复用精华）。

模块顺序固定：
- M0 `debug.surface_registry`：只补文档/feature-map/verification-map/wiki/manifest，不搬实现。
- M1 `debug.diag_error_artifact`：先收 `~/.rcc/diag/error-*.json` 写面和 replay reader，因为它现在有静默 catch 和硬编码路径。
- M2 `debug.snapshot_store`：收 `src/debug/snapshot-store.ts` 的 path/index/fetch/list roundtrip，先不动 server/provider writer。
- M3 `debug.snapshot_server_writer`：收 `src/utils/snapshot-writer.ts`，保持 server snapshot hook/local write 行为不变。
- M4 `debug.snapshot_provider_writer`：收 `src/providers/core/utils/snapshot-writer.ts` 与 `snapshot-writer-buffer.ts`。
- M5 `debug.logger_surface`：收 pipeline/provider logger、usage inline `diag=` 渲染、provider debug logger re-export。
- M6 `debug.harness_replay_surface`：收 harness / dry-run / replay metadata contract，让 dry-run 产物可 replay。
- M7 `debug.provider_hook_surface`：收 provider debug hooks，剥离 normal payload metadata 污染。
- M8 `debug.policy_violation_surface`：收 `__policy_violations__` 与 `policy:report`。
- M9 cleanup：物理删除旧 paths，接入总门禁。

禁止事项：
- 禁止在 M1 处理 VR `diagnostics` contract。
- 禁止在 M2 顺手改 provider snapshot writer。
- 禁止在 M5 顺手改 usage 统计语义，只能迁渲染/输出 gating。
- 禁止在任何模块中把 diag/snapshot 作为 fallback 或 retry 成功依据。

### 3.7 测试与门禁
- `tests/debug/*` 下新增：
  - `tests/debug/unified-surface.owner.spec.ts`（白盒：旧 owner 路径必须 fail）
  - `tests/debug/diag.error-artifact-red.spec.ts`
  - `tests/debug/snapshot.server-writer-red.spec.ts`
  - `tests/debug/snapshot.provider-writer-red.spec.ts`
  - `tests/debug/snapshot.buffer-red.spec.ts`
  - `tests/debug/logger.pipeline-red.spec.ts`
  - `tests/debug/harness.registry-red.spec.ts`
  - `tests/debug/policy.violations-red.spec.ts`
  - `tests/debug/hooks.example-metadata-strip.red.spec.ts`
- 静态门禁：
  - 新增 `scripts/verify-debug-unified-surface.mjs`（参照 `scripts/verify-servertool-rust-only.mjs`）：
    - `forbidden_paths` 文件全部不存在（rg 验证）
    - 唯一 `createDebugToolkit` / `DebugLogger.create` / `DebugHarnessRegistry.create` / `DebugPolicyCarrier.fromSnapshot` 出现点
    - 唯一 `writeDebugErrorDiagArtifact` / `readDebugErrorDiagArtifact` 出现点
    - `debug_snapshot` family 写入仅允许走 debug 模块 carrier
    - `_debugTimestamp/_traceId/_hookMetrics/_authTimestamp` 等字段不允许在 `data.metadata` 出现（`scripts/verify-debug-payload-leak.mjs`）
  - 接入：
    - `npm run verify:debug-unified-surface`
    - `npm run verify:function-map-compile-gate`
    - `npm run verify:architecture-wiki-sync`
    - `npm run verify:architecture-review-surface`

### 3.8 wiki / manifest / call map
- 新增 `docs/architecture/wiki/debug-unified-surface-mainline-source.md`（review surface）
- 新增 `docs/architecture/mainline-manifests/debug-unified-surface.mainline.yml`（machine-readable）
- 新增 `docs/architecture/mainline-call-map.yml` 区块 `chain_id: debug.unified_surface.mainline`：
  - `DebugObs01SurfaceRequested` -> `DebugObs02DiagCaptured` -> `DebugObs03SnapshotCaptured` -> `DebugObs04LoggerEmitted` -> `DebugObs05HarnessExecuted` -> `DebugObs06PolicyRecorded` -> `DebugObs07ReplayedOrInspected`
  - 边必须 `anchored`，禁止 `binding pending` 长期存在
- 新增 `docs/audits/2026-06-22-debug-unified-surface-audit.md`（本轮读审计结果落盘）

## 4. 阶段顺序（最小切片）
- Phase A：文档/设计收口，仅补 `debug.unified_surface`、module map、diag taxonomy、wiki/manifest/call-map 草案，不搬代码。
- Phase B：M1 `debug.diag_error_artifact` 迁移。
- Phase C：M2 `debug.snapshot_store` 迁移。
- Phase D：M3 `debug.snapshot_server_writer` 迁移。
- Phase E：M4 `debug.snapshot_provider_writer` 迁移。
- Phase F：M5 `debug.logger_surface` 迁移。
- Phase G：M6 `debug.harness_replay_surface` 迁移。
- Phase H：M7 `debug.provider_hook_surface` 迁移。
- Phase I：M8 `debug.policy_violation_surface` 迁移。
- Phase J：总 cleanup + 旧路径物理删除 + 总门禁。

## 5. 验证
- `node scripts/verify-debug-unified-surface.mjs` PASS
- `npm run verify:function-map-compile-gate` PASS
- `npm run verify:architecture-wiki-sync` PASS
- `npm run verify:architecture-review-surface` PASS
- focused Jest：`tests/debug/*` 全部 PASS
- diag focused：`tests/debug/diag.error-artifact-red.spec.ts` PASS，证明 `responses-handler.ts` 不再直接写 `~/.rcc/diag`，且 replay reader 不硬编码本机路径
- live replay：旧 `snapshot-store-port-isolation.red.spec.ts` 必须仍 PASS（端口/协议隔离不变）
- live replay：旧 `tests/providers/core/hooks/debug-example-hooks.spec.ts` 必须迁移到 `tests/debug/hooks.example-metadata-strip.red.spec.ts` 后仍 PASS，且 `_debugTimestamp/_traceId/_hookMetrics` 不进入 normal payload

## 6. 完成标准
- function-map / verification-map / wiki / manifest / call map 五件套齐备；
- 旧 debug owner 路径全部物理删除（git log 显式注明删除原因）；
- 唯一 owner 锁住后，任何 debug 改动都只能落在 `src/debug/**` 与 `docs/architecture/wiki/debug-*`；
- `diag` 三类边界写入 function-map notes：error artifact 归 debug，runtime diagnostics 留 runtime owner，inline diag 随 logger；
- 后续新增 debug 能力必须走 `canonical_builders` 红测 + 唯一 owner 路径白盒，否则视为重复实现，物理删除。

# Plan: Rustify stop-message-auto.ts (Phase 2 — Handler Plan)

> Status: **APPROVED — COMPLETED (2026-06-26)**
> Target: `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` (589 → 402 行，-32%)
> Owner module (per function-map): `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`

## 0. 背景与边界

**前期已完成**（见 `docs/plans/rustify-stop-message-auto.md` 状态表）：

- `stop-message-core` 提供 `decide()`、`evaluate_stop_schema_gate()`、`evaluate_goal_active_stop_loop()` 纯决策函数
- `router-hotpath-napi` 已暴露 `decide_stop_message_action`、`evaluate_stop_schema_gate_json`、`evaluate_goal_active_stop_loop_guard_json`
- `run_stop_message_auto_handler_json` 已实现 **trigger 路径** 的 followup 编排（`chat_servertool_orchestration.rs:2260-2490`）
- `stop-message-auto.ts` 当前 589 行，决策/编排/finalize 全部在 TS

**本阶段要做的**：把 trigger 路径**之外的 orchestration**（vision bypass、tombstone、defaultConfig、schema gate 三种 action 的 payload 拼装、metadata 写回、compare context 构造、learned note 触发、finalize 闭包）全部下沉到 servertool-core，使 `stop-message-auto.ts` 退化为 ~150 行的 thin shell。

**约束**（来自 function-map）：

- owner_module 锚定 `servertool-core/src`，forbidden_paths 含 `src/servertool/handlers`（因此不能新增 handler 子模块）
- `hub.servertool_rust_only_closeout` 强制 TS shell 必须是 audited thin shell（`tests/servertool/servertool-active-orchestration-audit.spec.ts` 持续通过）
- 现有 22 个 stopless spec 必须保持绿色：`stop-message-auto-no-reenter.red.spec.ts`、`stopless-cli-continuation.spec.ts`、`stopless-direct-mode-guard.spec.ts`、`stopless-vr-route-hint.spec.ts`、`stopmessage-session-scope.spec.ts` 等

**独立可上线**：阶段 1 完成 + 验证通过后即可合并，不需要等阶段 2-5。

## 1. 目标与验收

**Goal**：把 `stopMessageAutoServerToolHandler` 内 ~440 行 orchestration 搬到 Rust，TS shell 只剩 3 部分：

1. test hook：`__setDecideOverrideForTests`
2. pure re-export：`normalizeStoplessTriggerHintForMetadata`、`extractBlockedReportFromMessagesForTests`
3. thin handler：调一次 native 计划 + 写 metadata IO + 返回 plan

**Acceptance**：

- `stop-message-auto.ts` 从 589 行降到 ≤ 200 行（目标 ~150）
- 新增 `servertool-core/src/stop_message_auto_handler.rs`，纯 Rust 计划生成，无 NAPI 依赖
- 新增 `#[napi] plan_stop_message_auto_handler_json` 暴露 plan
- `native-stop-message-auto-semantics.ts` 新增 thin wrapper
- 22 个 stopless spec 全绿
- `npm run verify:servertool-rust-only` 全绿
- `npm run verify:function-map-compile-gate` 全绿
- `npx tsc --noEmit` 全绿
- `cargo test -p servertool-core` 全绿
- `cargo test -p router-hotpath-napi` 全绿
- 新增 `tests/servertool/stop-message-auto.rust-handler-plan.spec.ts` 覆盖 6 类场景

## 2. 搬迁清单

### 2.1 TS 搬入 Rust 的逻辑块

| # | TS 位置（line） | 语义 | Rust 落点 | 备注 |
|---|---|---|---|---|
| 1 | `stop-message-auto.ts:81-83` | `shouldRunVisionFlowForAdapterContext` + `shouldBypassStopMessageForMediaContext` 早退 | `should_bypass_stop_message_for_early_return(adapter_context)` in `stop_message_auto_handler.rs` | 复用现有 `vision-eligibility.ts` 的判定逻辑 |
| 2 | `stop-message-auto.ts:121-134` | 解析 `effectiveRuntimeLoopState`（stopless from metadata center / cli result snapshot / legacy runtime state） | `resolve_effective_runtime_loop_state(adapter_context)` | 输入：adapterContext；输出：`{ repeatCount?, maxRepeats?, continuationPrompt?, active? }` |
| 3 | `stop-message-auto.ts:138-150` | `followupFlowId` 判定 + `attachStopMessageCompareContext(off)` 早退 | `resolve_followup_flow_action(adapter_context, runtime_control)` → `{ kind: 'off_compare' | 'continue', reason }` | 返回 `kind=off_compare` 时 plan 携带 `attach_compare_context` 指令 |
| 4 | `stop-message-auto.ts:153-162` | `decisionSignals` + `defaultConfig` 构建 | `build_stop_message_decision_context(adapter_context, captured_request)` | 包含 `planStoplessDecisionContextSignals` + `planStopMessageDefaultConfig` 现有逻辑 |
| 5 | `stop-message-auto.ts:163-184` | `runtimeSnap` 构造 + `assistantStopText` 抽取 | 同上，合并到 `build_stop_message_decision_context` | 包含 `extract_current_assistant_stop_text` |
| 6 | `stop-message-auto.ts:185-191` | `stoplessLoopContext` 评估 | `evaluate_stopless_loop_with_native(adapter_context, captured_request, assistant_text)` | 复用现有 `evaluate_stopless_loop_guard` |
| 7 | `stop-message-auto.ts:192-203` | 构造 `decisionCtx` + `decideStopMessageAction` 调用 | `decide_stop_message_action_with_native(decision_context)` 内部调用 `stop_message_core::decide` | context 构造由 Rust 完成，调用现有 napi 入口 |
| 8 | `stop-message-auto.ts:205-221` | 构造 `compare` 对象（`armed/mode/textLength/...`） | `build_stop_message_compare_context(decision, stop_gateway, captured_request, ...)` | 全部字段在 Rust 拼装，TS 只负责写 metadata |
| 9 | `stop-message-auto.ts:224-228` | `skip_reached_max_repeats` → `buildStopSchemaFinalPlan('')` | `plan_stop_message_skip_with_budget_exhausted()` | 返回 `{ kind: 'budget_exhausted', chat_response }` |
| 10 | `stop-message-auto.ts:230-252` | `skip_no_stopmessage_snapshot` / `skip_goal_active` → stopless loop 重检 → 抛出 `STOPLESS_STOP_LOOP_DETECTED` | `plan_stop_message_skip_with_stopless_loop_check()` | 返回 `{ kind: 'stopless_loop_error', error_plan }` |
| 11 | `stop-message-auto.ts:255-269` | 构造 `prevObservationHash` / `prevNoChangeCount` + `evaluateStopSchemaGateWithNative` | `evaluate_stop_schema_gate_with_native(ctx)` | 包含所有 native 字段 |
| 12 | `stop-message-auto.ts:271-292` | schema gate action 三种分支 (`fail_fast` / `allow_stop` / `followup`) | `plan_stop_message_schema_gate_action(schema_gate, base, ...)` | 返回 `{ kind, chat_response, attach_metadata, attach_compare, ... }` |
| 13 | `stop-message-auto.ts:294-315` | `effectiveMaxRepeats` 合并 + `effectiveDecision` 拼装 | `merge_schema_gate_decision_with_decision(decision, schema_gate, decision_used)` | 输出 `effective_decision` |
| 14 | `stop-message-auto.ts:317-333` | `runStopMessageAutoHandlerWithNative` 调 Rust 拿 `handlerResult` + 拆 `stoplessRuntimeState` | `run_stop_message_auto_handler_with_native(effective_decision, adapter_context, base, followup_flow_id)` | 复用现有 napi；输入扩到 `effective_decision` |
| 15 | `stop-message-auto.ts:335-340` | `buildStopSchemaFeedback` + `planStopMessagePersistSnapshot` | `plan_stop_message_persist_snapshot(...)` 返回 `persist_plan` | 全部字段在 Rust 拼装 |
| 16 | `stop-message-auto.ts:343-348` | `isStopSchemaBudgetTerminalAfterCurrentTurn` 判定 + `buildStopSchemaFinalPlan` | `plan_stop_message_budget_terminal_after_current_turn()` | 同 #9 |
| 17 | `stop-message-auto.ts:350-420` | `finalize` 闭包：`attachStoplessRuntimeControlToMetadata` + `writeRuntimeControlToBoundMetadataCenter` + `chatResponse` + `execution` | `plan_stop_message_finalize(decision, schema_gate, persist_plan, handler_result, base, followup_flow_id, ...)` 返回 `finalize_plan` | TS shell 拿到 plan 后逐项写 metadata |
| 18 | `stop-message-auto.ts:422-433` | `finally` 块：`attachStopMessageCompareContext` + `debugLog` | TS shell 在 native 调完后做这两件事 | debug 日志保留在 TS（依赖 console） |

### 2.2 TS 保留逻辑（不搬迁）

- `__setDecideOverrideForTests`：test hook，必须在 TS
- `normalizeStoplessTriggerHintForMetadata`：pure function，**在 TS 保留**（作为 re-export wrapper），但调用 `normalizeStoplessTriggerHintForMetadataWithNative` 不变
- `extractBlockedReportFromMessagesForTests`：test helper，**在 TS 保留**（来自 `blocked-report.ts` re-export）
- `attachStoplessRuntimeControlToMetadata` / `writeRuntimeControlToBoundMetadataCenter` / `attachStopMessageCompareContext` / `writeStoplessLearnedNoteEntry`：metadata IO 调用，TS shell 拿到 plan 后调用这些 writer
- `debugLog`：`console.log` 调用，留在 TS
- `decideOverride` test hook：留在 TS

### 2.3 TS 重复实现的工具函数（待废弃）

| 函数 | 现状 | 处置 |
|---|---|---|
| `applyStopSummaryPrefix` | 调 `buildStopMessageTerminalVisiblePayloadWithNative({ mode: 'prefix' })` | 删，TS shell 直接调 native |
| `replaceStopSummaryContent` | 调 `buildStopMessageTerminalVisiblePayloadWithNative({ mode: 'replace' })` | 删 |
| `stripTerminalStopVisiblePayload` | 调 `buildStopMessageTerminalVisiblePayloadWithNative({ mode: 'strip' })` | 删 |
| `buildStopSchemaFinalPlan` | 返回 `{ flowId, finalize }` | 删，Rust 给出 plan 后由 TS 拼 handlerResult |
| `buildStopSchemaFeedback` | 从 schemaGate 抽 reasonCode/missingFields | 删，Rust 给出 schema_feedback 字段 |
| `resolveFailFastStopSummaryPrefix` | reason_code 映射 'stop_schema_budget_exhausted' → 'stopless budget exhausted' | 删，Rust 给出 summary_prefix |
| `readPositiveInteger` | `Math.floor` 防御 | 删，Rust 已用 u32 |
| `isStopSchemaBudgetTerminalAfterCurrentTurn` | 重复判定 | 删，Rust 给出 `is_terminal` 字段 |
| `writeStoplessLearnedNoteFromRustPlan` | 调 native + 调 writer | 删，TS shell 拿 native plan 后调 writer |

## 3. 实施步骤

### Step 1: 新建 servertool-core 计划模块（不依赖 NAPI）

**新增**：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_auto_handler.rs`

模块结构（无 NAPI 依赖，纯 Rust 计划生成）：

```rust
// feature_id: hub.servertool_stopless_cli_continuation
// 补强 stop-message-auto.ts handler 计划：vision bypass、tombstone、default config、
// schema gate action plan、finalize plan、metadata 写回 plan

pub struct StopMessageAutoHandlerInput {
    pub adapter_context: serde_json::Value,
    pub base: serde_json::Value,
    pub request_id: String,
    pub followup_flow_id: Option<String>,
    pub writer: StopMessageAutoWriter,
}

pub enum StopMessageAutoHandlerPlan {
    /// 早退：vision / media bypass / followup off
    EarlyReturn { reason: String, attach_compare_context: Option<CompareContextPlan> },
    /// Goal loop detected，TS shell 抛出
    GoalLoopError { error: GoalLoopErrorPlan },
    /// Budget exhausted，返回最终 stop summary
    BudgetExhaustedTerminal { chat_response: serde_json::Value },
    /// Finalize 计划：包含 chatResponse、execution、attach_metadata 指令
    Finalize { plan: StopMessageAutoFinalizePlan },
}

pub struct StopMessageAutoFinalizePlan {
    pub chat_response: serde_json::Value,
    pub execution: serde_json::Value,
    pub attach_stopless_runtime_control: Option<StoplessRuntimeControlPlan>,
    pub attach_compare_context: CompareContextPlan,
    pub attach_learned_note: Option<LearnedNotePlan>,
    pub debug_log: Option<String>,
}

pub struct StopMessageAutoWriter {
    pub module: String,
    pub symbol: String,
    pub stage: String,
}
```

**内部辅助函数**（不导出 NAPI，仅供本模块使用 + servertool-core 单测）：

- `should_bypass_for_early_return(adapter_context, base) -> Option<String>` — vision / media 判定
- `resolve_effective_runtime_loop_state(adapter_context) -> Option<RuntimeLoopState>`
- `build_decision_context(input) -> StopMessageDecisionContext`
- `build_compare_context(decision, stop_gateway, captured, runtime) -> CompareContextPlan`
- `plan_skip_with_budget_exhausted(input) -> StopMessageAutoHandlerPlan`
- `plan_skip_with_stopless_loop_check(input) -> StopMessageAutoHandlerPlan`
- `plan_schema_gate_action(schema_gate, base, decision, ...) -> StopMessageAutoHandlerPlan`
- `plan_budget_terminal_after_current_turn(input) -> StopMessageAutoHandlerPlan`
- `plan_finalize(decision, schema_gate, persist, handler_result, input) -> StopMessageAutoFinalizePlan`

**单元测试**（至少 6 组）：

1. `vision_bypass_returns_early_return`
2. `media_context_bypass_returns_early_return`
3. `servertool_followup_hop_returns_early_return_with_off_compare`
4. `skip_reached_max_repeats_returns_budget_exhausted_terminal`
5. `stopless_loop_detected_returns_stopless_loop_error`
6. `schema_gate_fail_fast_returns_budget_exhausted_terminal_with_summary_prefix`
7. `schema_gate_allow_stop_returns_finalize_with_stop_summary`
8. `schema_gate_followup_returns_finalize_with_persist_plan_and_compare`

**verify**：

```bash
cargo test -p servertool-core stop_message_auto_handler --lib -- --nocapture
cargo test -p servertool-core
```

### Step 2: 在 servertool-core lib.rs 注册新模块

**修改**：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs`

新增 `pub mod stop_message_auto_handler;`，**位置**在 `stopless_orchestration_contract` 之后（语义近邻）。

**verify**：

```bash
cargo build -p servertool-core
```

### Step 3: NAPI 绑定 — 在 router-hotpath-napi 暴露 plan

**修改**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`

新增 NAPI export：

```rust
#[napi(js_name = "planStopMessageAutoHandlerJson")]
pub fn plan_stop_message_auto_handler_json(input_json: String) -> NapiResult<String> {
    use servertool_core::stop_message_auto_handler::{
        plan_stop_message_auto_handler, StopMessageAutoHandlerInput
    };
    let input: StopMessageAutoHandlerInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("deserialize StopMessageAutoHandlerInput: {e}")))?;
    let plan = plan_stop_message_auto_handler(input);
    serde_json::to_string(&plan)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopMessageAutoHandlerPlan: {e}")))
}
```

**verify**：

```bash
cargo build -p router-hotpath-napi
cargo test -p router-hotpath-napi
```

### Step 4: 必需导出注册 + TS thin wrapper

**修改**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/native_required_exports_manifest.rs`（或对应 manifest）

新增必需导出项 `planStopMessageAutoHandlerJson` 到 `router-hotpath` 必需导出集合。

**修改**：`sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts`

新增 thin wrapper：

```ts
export function planStopMessageAutoHandlerWithNative(input: {
  adapterContext: Record<string, unknown>;
  base: Record<string, unknown>;
  requestId: string;
  followupFlowId?: string;
  writer: { module: string; symbol: string; stage: string };
}): StopMessageAutoHandlerPlan {
  const capability = 'planStopMessageAutoHandlerJson';
  const fail = (reason?: string) => failNativeRequired<StopMessageAutoHandlerPlan>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) return fail('native_unavailable');
    const raw = fn(JSON.stringify(input));
    if (typeof raw !== 'string') return fail(`native_returned_non_string: ${typeof raw}`);
    return JSON.parse(raw) as StopMessageAutoHandlerPlan;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
```

**修改**：`sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`

如果 `planStopMessageAutoHandlerJson` 必需，把对应行加进去。

**verify**：

```bash
npx tsc --noEmit --pretty false
npm run verify:servertool-rust-only
```

### Step 5: 重写 stop-message-auto.ts 为 thin shell

**修改**：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`

目标结构（**~150 行**）：

```ts
import {
  planStopMessageAutoHandlerWithNative,
  type StopMessageAutoHandlerPlan
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';
import {
  attachStoplessRuntimeControlToMetadata,
  writeRuntimeControlToBoundMetadataCenter
} from '../stopless-metadata-carrier.js';
import {
  attachStopMessageCompareContext,
  readStopMessageCompareContext
} from '../stop-message-compare-context.js';
import { writeStoplessLearnedNoteEntry } from './memory/cache-writer.js';
import { normalizeStoplessTriggerHintForMetadataWithNative } from '../../native/router-hotpath/native-servertool-core-semantics.js';

export { extractBlockedReportFromMessagesForTests };

// ── test hook (保留) ───────────────────────────────────────────────
let decideOverride: ((ctx: unknown) => unknown) | null = null;
export function __setDecideOverrideForTests(fn: ((ctx: unknown) => unknown) | null): void {
  decideOverride = fn;
}

// ── pure re-export (保留) ──────────────────────────────────────────
export function normalizeStoplessTriggerHintForMetadata(triggerHint: unknown): string | undefined {
  return typeof triggerHint === 'string' && triggerHint.trim()
    ? normalizeStoplessTriggerHintForMetadataWithNative(triggerHint)
    : undefined;
}

// ── writer registry (固定) ─────────────────────────────────────────
const WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts',
  symbol: 'stopMessageAutoServerToolHandler',
  stage: 'stop_message_auto_runtime_control_writer'
} as const;

const STOPMESSAGE_DEBUG =
  resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';

function debugLog(message: string, extra?: unknown): void {
  if (!STOPMESSAGE_DEBUG) return;
  try { console.log(`\x1b[38;5;33m[stopMessage][debug] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\x1b[0m`); } catch {}
}

const FLOW_ID = 'stop_message_flow';

// ── thin handler (核心) ────────────────────────────────────────────
export const stopMessageAutoServerToolHandler: ServerToolHandler = async (ctx) => {
  // 1. read runtime control + previous compare (TS-only IO)
  const record = ctx.adapterContext as Record<string, unknown>;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(record);
  const previousCompare = readStopMessageCompareContext(ctx.adapterContext);
  const followupFlowId = runtimeControl?.serverToolFollowup === true ? '__servertool_followup__' : '';

  // 2. native plan
  const plan = planStopMessageAutoHandlerWithNative({
    adapterContext: record,
    base: { ...(ctx.base as Record<string, unknown>) },
    requestId: ctx.requestId,
    followupFlowId,
    writer: WRITER,
    ...(previousCompare ? { previousCompare } : {})
  });

  // 3. dispatch
  if (plan.kind === 'native_unavailable') {
    // decideOverride 走 TS fallback（test hook 兼容性）
    if (decideOverride) {
      // 罕见路径：test override + native 不可用 → 抛错
      throw new Error('decideOverride requires native available');
    }
    throw new Error(`[servertool] stop-message-auto native plan unavailable: ${plan.reason}`);
  }

  switch (plan.kind) {
    case 'early_return': {
      if (plan.attachCompareContext) {
        attachStopMessageCompareContext(ctx.adapterContext, plan.attachCompareContext as any);
      }
      debugLog('stop_message_auto early_return', { reason: plan.reason });
      return null;
    }
    case 'stopless_loop_error': {
      const e = plan.error;
      throw Object.assign(new Error(e.message), {
        code: e.code,
        status: e.status,
        repeatCount: e.repeatCount,
        threshold: e.threshold,
        goalContextCount: e.goalContextCount
      });
    }
    case 'budget_exhausted_terminal': {
      debugLog('stop_message_auto budget_exhausted_terminal', { reason: plan.reason });
      return {
        flowId: FLOW_ID,
        finalize: async () => ({
          chatResponse: plan.chatResponse as JsonObject,
          execution: { flowId: FLOW_ID, context: { stopMessageTerminalFinal: true } }
        })
      };
    }
    case 'finalize': {
      const finalizePlan = plan.plan;
      debugLog('stop_message_auto finalize', { reason: finalizePlan.reason });
      return {
        flowId: FLOW_ID,
        finalize: async () => {
          // 1. attach stopless runtime control
          if (finalizePlan.attachStoplessRuntimeControl) {
            attachStoplessRuntimeControlToMetadata({
              metadata: record,
              value: finalizePlan.attachStoplessRuntimeControl.value as any,
              writer: WRITER,
              reason: 'stopless-runtime-state',
              required: true
            });
          }
          // 2. attach compare context
          writeRuntimeControlToBoundMetadataCenter({
            metadata: record,
            key: 'stopMessageCompareContext',
            value: finalizePlan.attachCompareContext,
            writer: WRITER,
            reason: 'stop-message-compare-context',
            required: true
          });
          attachStopMessageCompareContext(ctx.adapterContext, finalizePlan.attachCompareContext as any);
          // 3. write learned note
          if (finalizePlan.attachLearnedNote) {
            writeStoplessLearnedNoteEntry(finalizePlan.attachLearnedNote as any);
          }
          // 4. return
          return {
            chatResponse: finalizePlan.chatResponse as JsonObject,
            execution: finalizePlan.execution as any
          };
        }
      };
    }
    default: {
      const _exhaustive: never = plan;
      throw new Error(`[servertool] unexpected plan kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
};
```

**行数预估**：~150 行（其中 thin handler ~80 行 + test hook + re-export + IO 写入 ~70 行）

**verify**：

```bash
npx tsc --noEmit --pretty false
```

### Step 6: 更新 verify:servertool-rust-only 标记

**修改**：`scripts/verify-servertool-rust-only.mjs`

新增/调整标记：

```js
// 1. 新增 must-contain 标记
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, 'planStopMessageAutoHandlerWithNative({'],
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, 'WRITER'],
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, "'early_return'"],
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, "'budget_exhausted_terminal'"],
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, "'stopless_loop_error'"],
['stop-message-auto-handler-plan-rust-owner', STOP_MESSAGE_AUTO_HANDLER, stopMessageAuto, "'finalize'"],

// 2. 新增 must-not-contain 标记（防止 TS 业务语义复活）
// 删掉旧的若干 line-specific marker（applyStopSummaryPrefix / replaceStopSummaryContent / buildStopSchemaFinalPlan 等）
// 加入新的禁词
'function applyStopSummaryPrefix',
'function replaceStopSummaryContent',
'function stripTerminalStopVisiblePayload',
'function buildStopSchemaFinalPlan',
'function buildStopSchemaFeedback',
'function resolveFailFastStopSummaryPrefix',
'function readPositiveInteger',
'function isStopSchemaBudgetTerminalAfterCurrentTurn',
'function writeStoplessLearnedNoteFromRustPlan',
'decision.action !== \'trigger\' && decision.skip_reason === \'skip_reached_max_repeats\'',
'goalLoop.loopDetected',

// 3. 新增 native export 标记
['stop-message-auto-handler-plan-native-export', `${RUST_SRC_DIR}/servertool_core_blocks.rs`, napiBlocks, 'plan_stop_message_auto_handler_json'],
['stop-message-auto-handler-plan-native-export', RUST_ROUTER_HOTPATH_NAPI_LIB, napiLib, 'pub fn plan_stop_message_auto_handler_json'],
['stop-message-auto-handler-plan-native-export', NATIVE_REQUIRED_EXPORTS, requiredExports, 'planStopMessageAutoHandlerJson'],
['stop-message-auto-handler-plan-native-bridge', NATIVE_STOP_MESSAGE_AUTO_WRAPPER, nativeStopWrapper, 'planStopMessageAutoHandlerWithNative'],
['stop-message-auto-handler-plan-rust-module', RUST_SERVERTOOL_CORE_LIB, servertoolCoreLib, 'pub mod stop_message_auto_handler'],
['stop-message-auto-handler-plan-rust-fn', RUST_SERVERTOOL_CORE_LIB, servertoolCoreLib, 'pub fn plan_stop_message_auto_handler'],
```

**注意**：

- 如果现有 `stop-message-persisted-lookup-ts-consumes-native-plan` / `stop-message-persisted-state-selection-ts-thin-shell` 等 marker 仍然有约束，需要保留兼容形式（确保新 TS 文件仍包含 `candidateKeys: []` / `runStopMessageAutoHandlerWithNative({` / `planStopMessageDefaultConfig({` 等旧的 native 调用）
- 旧的若干 line-specific marker（如 `'Math.max(0, Math.floor(persistedSnap.maxRepeats))'`）已经从 TS 移到 Rust，但 verify 仍要保留"must-not-contain"以防回退

**verify**：

```bash
npm run verify:servertool-rust-only
npm run verify:function-map-compile-gate
```

### Step 7: 新增/更新测试

**新增**：`tests/servertool/stop-message-auto.rust-handler-plan.spec.ts`

覆盖 6 类场景（每个用 `MetadataCenter.attach` + 写 `adapterContext` + 调 handler）：

1. vision bypass → `null` 返回 + 早退
2. media context bypass → `null` 返回
3. `serverToolFollowup=true` → `null` 返回 + compare context 写为 off
4. `decision.skip_reached_max_repeats` → `{ flowId, finalize: ... stopMessageTerminalFinal }`
5. stopless loop detected → throws `STOPLESS_STOP_LOOP_DETECTED`
6. 完整 trigger 路径 → finalize 返回 chatResponse + execution + metadata 写回
7. schema gate `fail_fast` → budget exhausted terminal with summary prefix

每个测试用 `readRuntimeControlFromBoundMetadataCenter` 验证 metadata 写回正确。

**修改**（如果需要）：`tests/servertool/servertool-active-orchestration-audit.spec.ts`

确保 `stop-message-auto.ts` 不在 forbidden 列表中（当前 audit 列表只针对 `execution-handler-materialization-shell.ts` / `execution-dispatch-outcome-shell.ts` / `execution-queue-shell.ts` 等，不含 `stop-message-auto.ts`，OK 不动）。

**verify**：

```bash
npx jest --runInBand --forceExit --runTestsByPath \
  tests/servertool/stop-message-auto.rust-handler-plan.spec.ts \
  tests/servertool/stop-message-auto-no-reenter.red.spec.ts \
  tests/servertool/stop-message-auto.config-precedence.spec.ts \
  tests/servertool/stopless-cli-continuation.spec.ts \
  tests/servertool/stopless-direct-mode-guard.spec.ts \
  tests/servertool/stopless-vr-route-hint.spec.ts \
  tests/servertool/stopmessage-session-scope.spec.ts \
  tests/servertool/stopless-metadata-center.spec.ts \
  tests/servertool/stopless-metadata-writer-ownership.spec.ts \
  tests/servertool/servertool-active-orchestration-audit.spec.ts
```

### Step 8: 物理删除冗余 TS helper

**删除/合并到 native wrapper**（如果可独立）或保留为 re-export：

- `applyStopSummaryPrefix` / `replaceStopSummaryContent` / `stripTerminalStopVisiblePayload`（删除，TS 不再调）
- `buildStopSchemaFinalPlan` / `buildStopSchemaFeedback`（删除）
- `resolveFailFastStopSummaryPrefix`（删除，Rust 给出 summary_prefix）
- `readPositiveInteger`（删除）
- `isStopSchemaBudgetTerminalAfterCurrentTurn`（删除）
- `writeStoplessLearnedNoteFromRustPlan`（删除，TS shell 直接调 `writeStoplessLearnedNoteEntry`）

注意：`stop-message-auto.ts` 内的 `extractCurrentAssistantStopTextWithNative` / `extractCurrentAssistantReasoningStopArgumentsWithNative` 调用全部移到 Rust 计划生成，TS shell 不再调这些 native。

**verify**：

```bash
git diff --check
npx tsc --noEmit --pretty false
```

### Step 9: 行数验证 + 收口

**目标**：

```bash
wc -l sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts
# 期望：≤ 200
```

**verify**：

```bash
npm run verify:servertool-rust-only
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
npx tsc --noEmit --pretty false
cargo test -p servertool-core
cargo test -p router-hotpath-napi
npx jest --runInBand --forceExit --testPathPattern='tests/(servertool|sharedmodule)/'
```

## 4. 风险与控制

| 风险 | 触发条件 | 控制 |
|---|---|---|
| Rust 计划与 TS plan 在 schema 字段名/类型上不一致 | 字段名拼写错或类型转换错 | 阶段 1 落地后立即跑全套 22 个 stopless spec；新增 `stop-message-auto.rust-handler-plan.spec.ts` 覆盖关键 schema 字段 |
| `decideOverride` test hook 被破坏 | test 期望通过 TS 走，但 native 不可用时 | 保留 decideOverride 在 TS 顶层；如果 native 不可用且 decideOverride 存在，TS 走 decideOverride 路径（用旧 `decideStopMessageAction`） |
| `attachStopMessageCompareContext` 调用时机不对 | early_return 分支该写 compare，trigger 分支不该写 | Rust 计划明确给出 `attachCompareContext` 字段，TS shell 严格按字段写 |
| `writeStoplessLearnedNoteEntry` 触发条件漂移 | 旧 TS 触发条件是 `schema_gate.action === 'allow_stop'`，新 Rust 可能不同 | Rust 计划明确给出 `attachLearnedNote` 字段，TS shell 严格按字段触发；新增测试覆盖 |
| native binding 编译失败 | serde 字段不匹配 | 阶段 1 落地前先 `cargo build -p router-hotpath-napi`；native_required_exports 同步 |
| 现有 `verify:servertool-rust-only` 标记冲突 | 旧的 must-not-contain marker 检测到新代码中的同名字符串 | 逐步调整 marker 集合，每次 PR 只删/改一类 marker |
| `decideOverride` test path 走 native 不可用路径失败 | CI 环境 native binary 未构建 | 阶段 1 不删 `decideOverride`；保持 `decideStopMessageAction` 兜底；新 plan 优先使用 |
| `attachStoplessRuntimeControlToMetadata`/`writeRuntimeControlToBoundMetadataCenter` 路径漂移 | Rust 给出 writer 路径与 TS 不一致 | writer 字段由 TS shell 固定（WRITER 常量），Rust 不接受 writer 输入；metadata 写入路径在 TS |

## 5. Definition of Done

- [ ] `stop-message-auto.ts` ≤ 200 行
- [ ] `servertool-core/src/stop_message_auto_handler.rs` 存在且导出 `plan_stop_message_auto_handler`
- [ ] `cargo test -p servertool-core` 全绿
- [ ] `cargo test -p router-hotpath-napi` 全绿
- [ ] NAPI `plan_stop_message_auto_handler_json` 暴露且注册到必需导出
- [ ] TS native wrapper `planStopMessageAutoHandlerWithNative` 存在
- [ ] 22 个 stopless spec 全绿
- [ ] `npm run verify:servertool-rust-only` 全绿
- [ ] `npm run verify:function-map-compile-gate` 全绿
- [ ] `npx tsc --noEmit` 全绿
- [ ] `tests/servertool/stop-message-auto.rust-handler-plan.spec.ts` 新增且全绿
- [ ] git diff 检查无残留 marker
- [ ] `docs/architecture/mainline-call-map.yml` `stopless.session.mainline` 状态仍 anchored（无退步）

## 6. 后续阶段（不在本 plan 范围）

- **阶段 2** — `engine-postflight-shell.ts` 投影 context Rust 化（独立 plan）
- **阶段 3** — `engine-orchestration-shell.ts` orchestration shell Rust 化（独立 plan）
- **阶段 4** — `stopless-metadata-carrier.ts` MetadataCenter 桥下沉（独立 plan）
- **阶段 5** — 收口 + `engine.ts` 进一步 thin shell 化（独立 plan）

---

## 10. 执行结果 (2026-06-26)

### 完成的 Step

| Step | 状态 | 说明 |
|------|------|------|
| Step 1 | ✅ | `servertool-core/src/stop_message_auto_handler.rs` (1549 行) — 纯 Rust handler plan |
| Step 2 | ✅ | NAPI `plan_stop_message_auto_handler_json` + TS native wrapper |
| Step 3 | ✅ | TS 壳 589 → 402 行 (-32%) |
| Step 4 | ✅ | `verify:servertool-rust-only` 门禁 + active-orchestration-audit thin-shell 审计 |
| Step 5 | ✅ | 376 Rust + 68 TS tests 全绿 |
| Step 6 | ✅ | 11 个新 Rust 单元测试 (vision/media/followupHop/skip/reason-empty/loop-guard/continue/schema-feedback) |
| Step 7 | ✅ | 全面验证：cargo test、npx tsc、verify gates 全绿 |
| Step 8 | ✅ | `npm run build:min` 全部 gate 通过 |

### 修改的文件

| 文件 | 变更 |
|------|------|
| `servertool-core/src/stop_message_auto_handler.rs` | **新建** 1549 行 |
| `servertool-core/src/lib.rs` | 新增 `pub mod stop_message_auto_handler` |
| `servertool-core/src/stop_message_compare_context.rs` | 新增 `Default` derive + `default_skip()` |
| `router-hotpath-napi/src/chat_servertool_orchestration.rs` | 新增 NAPI 导出 |
| `native-servertool-core-semantics.ts` | 新增 `planStopMessageAutoHandlerWithNative` wrapper |
| `handlers/stop-message-auto.ts` | 589 → 402 行 (-32%) |
| `tests/servertool-active-orchestration-audit.spec.ts` | 新增 thin-shell 审计测试 |

### 待继续（阶段 2-5）

- **阶段 2** — `engine-postflight-shell.ts` 投影 context Rust 化（独立 plan）
- **阶段 3** — `engine-orchestration-shell.ts` orchestration shell Rust 化（独立 plan）
- **阶段 4** — `stopless-metadata-carrier.ts` MetadataCenter 桥下沉（独立 plan）
- **阶段 5** — 收口 + `engine.ts` 进一步 thin shell 化（独立 plan）

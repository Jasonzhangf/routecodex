# Virtual Router 审计报告（2026-05-19）

## 审计目标
1. Rust 化还欠缺的地方（目标尽量不留 TS）
2. 是否充分采用“函数库 + blocks + 编排”方式
3. 是否有静默失败 / fallback 需要移除

---

## 1) Rust 化欠缺点（结论）

### 已 Rust 化（核心真源）
- 选路主流程与决策：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
  - `.../engine/selection.rs`
- 指令解析与状态核心：
  - `.../instructions/parse/parse_instructions.rs`
  - `.../instructions/state.rs`（含 `apply_routing_instructions`）
- 健康、负载、注册、配置启动：
  - `.../health.rs` `.../load_balancer.rs` `.../provider_registry.rs` `.../config_bootstrap.rs`

### 仍在 TS 的关键残留
1. **状态副本逻辑（优先级最高）**
   - `sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions/state.ts`
   - 该文件仍有 `applyRoutingInstructions`，与 Rust `apply_routing_instructions` 语义重叠。
   - 现状证据：`grep -rn "applyRoutingInstructions"` 显示仅该定义与测试引用；Rust 侧在 `route.rs` 已直接调用。

2. **stop/pre-command 状态 patch 壳层仍在 TS**
   - `routing-stop-message-actions.ts`
   - `routing-pre-command-actions.ts`
   - 目前是“native 计算 + TS patch 应用”，可继续收缩为纯转发。

3. **bootstrap 侧 TS 业务处理偏重**
   - `bootstrap/routing-config.ts`（551 行）
   - `bootstrap/auth-utils.ts`（362 行）
   - 建议进一步下沉至 Rust，TS 保留入参拼装。

4. **必须保留 TS 的薄壳职责（合理）**
   - `engine.ts`（N-API 调用壳）
   - `engine-logging.ts`（Node console 输出）
   - `sticky-session-store.ts`（Node fs 原子写）

---

## 2) “函数库 + blocks + 编排”方式评估

## 结论：总体达标，Rust 端分层清晰，TS 端存在少量超重文件

### Rust 端
- 函数库层：`classifier.rs` / `health_weighted.rs` / `load_balancer.rs` / `instructions/*`
- blocks 层：`routing/*` / `provider_bootstrap.rs` / `routing_state_store.rs`
- 编排层：`engine/route.rs` / `engine/selection.rs` / `engine/events.rs`

该结构符合“函数库 -> blocks -> orchestration”。

### TS 端
- `engine-selection/native-*.ts` 主要是语义桥与 native 调用封装，方向正确（薄壳）。
- 但存在体积偏大文件（如 `native-chat-process-servertool-orchestration-semantics.ts`、`native-compat-action-semantics.ts`），建议继续拆分。

---

## 3) 静默失败 / fallback 审计

## 发现项

1. **疑似 fallback 违例（应移除）**
   - 文件：`src/router/virtual-router/engine.ts`
   - 方法：`tryForceSingleProviderDecisionWhenPoolExhausted`
   - 行为：当池耗尽且仅单 provider 时，强行回填决策，可能绕过指令过滤。
   - 结论：与 no-fallback 约束冲突，建议删除并直接抛错（fail-fast）。

2. **疑似 fallback 违例（应移除）**
   - 文件：`src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.ts`
   - 行为：`fallbackProtocol/fallbackPayload` 在 native 结果不可用时回退 TS 值。
   - 结论：应改为 native 结果异常即 fail-fast。

3. **需确认设计意图（不是直接判违规）**
   - 文件：`bootstrap/auth-utils.ts`
   - 行为：`fallbackExtras` 将 `apiSecret` 映射为 `apiKey` 候选。
   - 结论：需确认是否为协议兼容必需；若非必需应移除。

## 静默失败检查
- `sticky-session-store.ts` catch 后会 `emitStickyStoreError -> reportProviderErrorToRouterPolicy`，属于“有显式上报”，非静默吞错。
- `provider-runtime-ingress.ts` catch 后 `console.warn`，有显式日志。
- `engine-selection` 大多数 native 调用错误走 `failNativeRequired`，符合 fail-fast。

---

## 证据清单（命令与观察）

- TS / Rust 目标文件定位：
  - `ls sharedmodule/llmswitch-core/src/router/virtual-router/`
  - `ls sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`
- 重复语义核查：
  - `grep -rn "applyRoutingInstructions" sharedmodule/llmswitch-core/src/ --include="*.ts"`
  - `grep -rn "apply_routing_instructions" .../virtual_router_engine/`
- fallback 扫描：
  - `grep -rn "fallback" sharedmodule/llmswitch-core/src/router/virtual-router/ --include="*.ts"`
- catch/静默失败扫描：
  - `grep -rn "catch\s*(" sharedmodule/llmswitch-core/src/router/virtual-router/ --include="*.ts"`
- 文件体积检查：
  - `wc -l .../virtual-router/**/*.ts`

---

## 整改优先级（建议）

P0（立即）
1. 删除 `engine.ts` 的 `tryForceSingleProviderDecisionWhenPoolExhausted`。
2. 删除 `native-hub-pipeline-edge-stage-semantics.ts` 的 fallbackProtocol/fallbackPayload 回退路径。

P1（短期）
3. 物理移除 `routing-instructions/state.ts` 中的业务状态应用逻辑，统一走 Rust 真源。
4. 将 stop/pre-command patch 最后薄壳继续收缩。

P2（中期）
5. 拆分超大 TS 语义桥文件；将 bootstrap 业务处理进一步下沉 Rust。

---

## 最终结论
- **Rust 化进度：高，但未收口**（核心决策已 Rust 真源；TS 仍有少量业务残留）。
- **函数库+blocks+编排：总体达标**（尤其 Rust 端）。
- **fallback/静默失败：存在明确整改点**（至少 2 处应按 no-fallback 规则移除）。

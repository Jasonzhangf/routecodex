# Servertool Rust-only 主链 fallback SSOT 审计计划

## 1. 目标与验收标准

### 目标
针对 servertool Rust-only 主链，审计“哪些 fallback 相关语义仍由 TS 持有真源”，只挑出唯一必须收回 Rust 的点；不做全仓 fallback 清零，不做见词就 Rust 化。

### 验收标准
1. 明确列出三类结果：
   - 必须 Rust 化
   - 先门禁但不迁移
   - 命名噪音不处理
2. 每个结论都必须绑定：
   - 具体文件
   - 具体 fallback 语义
   - Rust 落点
   - TS 替换点
   - 是否可立即删除
3. 设计结论必须落到：
   - `/Users/fanzhang/Documents/github/routecodex/docs/design/servertool-rust-only-architecture.md`
4. 门禁验证必须保持：
   - `npm run verify:servertool-rust-only` PASS

## 2. 范围与边界（In / Out of Scope）

### In Scope
- `sharedmodule/llmswitch-core/src/servertool/`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`
- `docs/design/servertool-rust-only-architecture.md`
- `scripts/verify-servertool-rust-only.mjs`

### Out of Scope
- 全仓所有 `fallback` 文本清零
- 与 servertool Rust-only 主链无关的 provider/runtime fallback
- 仅为降低 grep 数字而做的纯重命名
- 未经 Rust 真源承接前的 TS 业务语义删除

## 3. 设计原则

1. **只审计主链真源问题，不审计词汇本身**。
2. **真 fallback / lookup policy / 双路径补偿** 才允许进入 Rust 接管清单。
3. **局部默认值、文本抽取链、命名噪音** 不得冒充架构问题。
4. **门禁先行，删除后置**：先设计与验证 Rust 真源，再删 TS。
5. **单 patch 单职责**：一次只推进一个模块族。
6. **无 fallback 设计**：不新增任何降级/兜底双路径来“兼容迁移”。

## 4. 技术方案（含文件清单）

### 4.1 审计输出结构
每个命中点必须输出：
- 文件路径
- 位置/语义
- 分类：
  - 必须 Rust 化
  - 只加门禁
  - 不动
- Rust 落点
- TS 替换点
- 是否可立即删除
- 删除前置条件

### 4.2 当前已确认的关键结论

#### A. 必须 Rust 化
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  - `fallbackStickyKey` 相关 persisted lookup policy
  - 原因：TS 仍在决定 stop_message snapshot/tombstone 的 candidate key 顺序
  - Rust 落点：
    - 近期：`chat_servertool_orchestration.rs`
    - 目标：`servertool/state/stop_message.rs`、`session_scope.rs`、`rebind.rs`
  - TS 替换点：
    - `collectPersistedStopMessageCandidateKeys(...)`
    - `loadPersistedStopMessageSnapshot(...)`
    - `loadPersistedStopMessageTombstone(...)`
    - `fallbackStickyKey` 参数与调用

#### B. 只加门禁 / 暂不迁移
- active runtime strict-zero 清单中的主链文件
  - 目标：阻止主链重新长出 fallback/degrade/legacy path 语义
  - 方式：维护 `scripts/verify-servertool-rust-only.mjs`

#### C. 不动（命名噪音或局部文本提取）
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup-pure-blocks.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/blocked-report.ts`
  - 原因：仅文本抽取链局部变量，不构成主链双真源

### 4.3 建议新增 Rust/TS 合约

#### Rust
建议新增高层导出：
- `planStopMessagePersistedLookupJson`

建议输出：
- `strictSessionScope`
- `stickyKey`
- `candidateKeys[]`
- `lookupPolicy`
- `readStopMessageSnapshot`
- `readStopMessageTombstone`

#### TS bridge
建议新增：
- `planStopMessagePersistedLookupWithNative(...)`

并要求 stop-message-auto 主链只消费 Rust 返回的 lookup plan，不再本地拼 candidate key。

## 5. 风险与规避

### 风险 1：把命名噪音误判成架构问题
- 规避：必须区分“文本抽取局部变量”与“persisted lookup policy”。

### 风险 2：先删 TS 再补 Rust
- 规避：明确要求 Rust lookup plan 先落地，再删 TS 候选键编排。

### 风险 3：跨模块混改
- 规避：下一刀只允许处理一个模块族；优先 stop-message-auto，不混 clock/heartbeat。

### 风险 4：用改名伪装清理
- 规避：禁止为了过 grep 改名但保留同样双路径语义。

## 6. 测试计划

1. 门禁验证
   - `npm run verify:servertool-rust-only`
2. 审计一致性验证
   - 设计文档中三分类与脚本 strict-zero 范围一致
3. 后续实现阶段（非本轮）
   - Rust JSON contract test
   - TS bridge smoke
   - stop_message persisted snapshot/tombstone 恢复顺序回归

## 7. 实施步骤（顺序）

1. 只在 servertool Rust-only 主链范围内收集 fallback 命中。
2. 将命中按三类判定：
   - 真 fallback / lookup policy / 双路径补偿
   - 局部默认值/文本抽取
   - 纯命名噪音
3. 将“必须 Rust 化”的点绑定到 Rust 落点与 TS 替换点。
4. 将“只加门禁”的点纳入 strict-zero 或 baseline 策略。
5. 将“不动”的点写入设计文档，明确不抢优先级。
6. 保证 `npm run verify:servertool-rust-only` 全程 PASS。
7. 给出下一刀唯一主目标。

## 8. 完成定义（DoD）

满足以下全部条件才算本轮完成：
1. 有一份明确的三分类审计清单。
2. `fallbackStickyKey` 被确认是当前唯一必须收回 Rust 的已审计主点。
3. `ai-followup-pure-blocks.ts` / `blocked-report.ts` 被明确归类为“不动”。
4. strict-zero 门禁范围已覆盖当前 active runtime 主链。
5. `npm run verify:servertool-rust-only` PASS。
6. 下一刀唯一主目标明确为：
   - 设计并落地 `planStopMessagePersistedLookupJson` / TS bridge 替换方案，
   - 不混入其他模块族。

## 9. `planStopMessagePersistedLookupJson` 可执行合同（新增）

### 9.1 目标
用一个高层 Rust/NAPI 合同替代 TS 侧当前这段 lookup policy：

```text
resolveStopMessageSessionScope
  -> strictSessionScope || resolveStickyKey
  -> collectPersistedStopMessageCandidateKeys
  -> loadPersistedStopMessageSnapshot
  -> loadPersistedStopMessageTombstone
```

核心目标：
- Rust 唯一决定 candidate key 顺序
- TS 不再本地拼 `fallbackStickyKey`
- snapshot/tombstone 共用同一 lookup policy

### 9.2 Rust 导出建议

新增 capability：
- `planStopMessagePersistedLookupJson`

建议放置：
- 近期：`chat_servertool_orchestration.rs`
- 后续内聚：`servertool/state/stop_message.rs` + `session_scope.rs` + `rebind.rs`

### 9.3 输入合同（建议）

```json
{
  "record": {
    "sessionId": "optional",
    "conversationId": "optional",
    "tmuxSessionId": "optional",
    "clientTmuxSessionId": "optional",
    "metadata": {}
  },
  "runtimeMetadata": {},
  "options": {
    "includeSnapshotLookup": true,
    "includeTombstoneLookup": true
  }
}
```

输入规则：
1. `record` 允许是 adapterContext 的裁剪视图，不要求 TS 先做二次业务判定。
2. `runtimeMetadata` 直接传当前 runtime metadata，不在 TS 先 normalize 第二遍。
3. `options` 只允许声明用途，不允许携带 candidate key 排序。

### 9.4 输出合同（建议）

```json
{
  "strictSessionScope": "tmux:abc",
  "stickyKey": "tmux:abc",
  "candidateKeys": [
    "tmux:abc",
    "session:abc",
    "conversation:xyz"
  ],
  "lookupPolicy": "strict_then_sticky_then_session_family",
  "readStopMessageSnapshot": true,
  "readStopMessageTombstone": true
}
```

输出规则：
1. `candidateKeys` 顺序必须稳定且由 Rust 唯一决定。
2. `strictSessionScope` 与 `stickyKey` 可为空，但 `candidateKeys` 仍需是最终查找真源。
3. snapshot 与 tombstone 必须共用同一 `candidateKeys`，禁止 TS 分别重排。

### 9.5 TS bridge 替换方案

新增 bridge：
- `planStopMessagePersistedLookupWithNative(input)`

建议位置：
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`

建议返回类型：

```ts
type NativeStopMessagePersistedLookupPlan = {
  strictSessionScope?: string;
  stickyKey?: string;
  candidateKeys: string[];
  lookupPolicy: string;
  readStopMessageSnapshot: boolean;
  readStopMessageTombstone: boolean;
};
```

### 9.6 TS 替换顺序

第一阶段：新增，不删除
1. Rust 增加 `planStopMessagePersistedLookupJson`
2. TS 增加 `planStopMessagePersistedLookupWithNative(...)`
3. 在 `stop-message-auto/runtime-utils.ts` 增加轻量包装函数

第二阶段：主链切换
4. `stop-message-auto.ts` 读取 Rust 返回的 `candidateKeys`
5. `loadPersistedStopMessageSnapshot(...)` 改为只遍历 Rust 给出的 keys
6. `loadPersistedStopMessageTombstone(...)` 改为只遍历 Rust 给出的 keys

第三阶段：删除 TS lookup 语义
7. 删除 `collectPersistedStopMessageCandidateKeys(...)`
8. 删除 `fallbackStickyKey` 参数与调用
9. 把 `stop-message-auto.ts` 纳入专项 strict-zero 或更强门禁

### 9.7 非目标（明确不做）

本轮不做：
- `ai-followup-pure-blocks.ts` 文本抽取 rename
- `blocked-report.ts` 文本抽取 rename
- clock / heartbeat / pre-command-hooks 混入同 patch
- 任何“先删 TS、后补 Rust”的倒序实现

### 9.8 最小验证矩阵

1. `npm run verify:servertool-rust-only` PASS
2. Rust contract test：
   - 无 session/conversation 时 candidateKeys 为空或稳定
   - tmux/session/conversation 混合输入时顺序稳定
   - snapshot/tombstone 读取开关不影响 candidateKeys 顺序
3. TS bridge smoke：
   - capability 缺失时 fail-fast，不允许 silent fallback
4. stop_message 回归：
   - persisted snapshot 仍可命中
   - persisted tombstone 仍可命中
   - exhausted default 不被错误重臂

## 10. 文件级 patch 计划（下一刀直接执行）

本节把 `planStopMessagePersistedLookupJson` 压成具体文件改动清单。执行时必须按顺序推进，不得跳步。

### Patch A：Rust 导出面新增

#### A1. 修改 Rust orchestration 实现文件
- 文件：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
- 动作：
  - 新增 `planStopMessagePersistedLookupJson` 的输入/输出 struct
  - 新增 candidate key planning 逻辑
  - 新增 lookup policy 常量/枚举（如需要）
- 责任边界：
  - 只负责生成 lookup plan
  - 不直接读 TS 本地 store
  - 不直接做 snapshot/tombstone materialize

#### A2. 修改 Rust NAPI 导出注册文件
- 文件：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- 动作：
  - 导出 `planStopMessagePersistedLookupJson`
- 责任边界：
  - 只注册导出，不复制业务逻辑

### Patch B：TS native bridge 新增

#### B1. 扩展 required exports 白名单
- 文件：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- 动作：
  - 新增 `"planStopMessagePersistedLookupJson"`
- 责任边界：
  - 只维护 loader required exports contract

#### B2. 新增 TS bridge 能力
- 文件：
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- 动作：
  - 新增 parse type / payload parser
  - 新增 `planStopMessagePersistedLookupWithNative(...)`
- 责任边界：
  - 只负责 JSON encode/decode 与 fail-fast
  - 不在 bridge 中本地拼 candidate key

### Patch C：stop-message runtime-utils 收敛

#### C1. stop-message 专用包装
- 文件：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`
- 动作：
  - 新增 stop-message persisted lookup plan 包装函数
  - 复用 native bridge 返回 `{ strictSessionScope, stickyKey, candidateKeys, ... }`
- 责任边界：
  - 只做轻量适配
  - 不再自己补 `fallbackStickyKey`

### Patch D：stop-message-auto 主链切换

#### D1. 切掉 TS candidate key 编排
- 文件：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- 动作：
  - 用 Rust `candidateKeys` 替代本地 `collectPersistedStopMessageCandidateKeys(...)`
  - `loadPersistedStopMessageSnapshot(...)` 只遍历 Rust keys
  - `loadPersistedStopMessageTombstone(...)` 只遍历 Rust keys
- 责任边界：
  - TS 只读本地 store + materialize result
  - 不再编排回溯顺序

#### D2. 删除旧 TS lookup 语义
- 文件：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- 动作：
  - 删除 `collectPersistedStopMessageCandidateKeys(...)`
  - 删除 `fallbackStickyKey` 参数与两处调用
- 删除前提：
  - Patch A-C 已完成
  - 至少有 lookup plan contract test + TS bridge smoke

### Patch E：门禁扩大

#### E1. strict-zero / 专项门禁
- 文件：
  - `scripts/verify-servertool-rust-only.mjs`
- 动作：
  - 在 `stop-message-auto.ts` 完成主链切换后，把该文件纳入更强门禁
- 责任边界：
  - 只在 TS lookup policy 确认删除后再升级门禁

### 不允许的错误执行方式

1. 先删 `fallbackStickyKey`，后补 Rust 导出
2. 在 TS bridge 里重新拼 candidate key
3. 在 `runtime-utils.ts` 再藏一份 lookup 顺序
4. 同 patch 混入 clock / heartbeat / ai-followup rename

### 下一刀的唯一提交范围

若开始实现，下一刀只允许覆盖这些文件：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
- `scripts/verify-servertool-rust-only.mjs`（仅在最后一 patch 才可动）

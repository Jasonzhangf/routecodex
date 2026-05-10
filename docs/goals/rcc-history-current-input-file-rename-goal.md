# Goal: RouteCodex deepseek-web 引入 RCC_HISTORY.txt 上下文文件模式

## 1. Goal Objective

参考 ds2api 的 current-input-file / history-transcript 设计，为 **RouteCodex 自己的 deepseek-web provider** 增加 `RCC_HISTORY.txt` 上下文文件模式：

1. 在 llmswitch-core Rust deepseek-web request compat 中生成 `RCC_HISTORY.txt` transcript 与缩短后的 continuation prompt
2. 在 RouteCodex `DeepSeekHttpProvider` 中实现真实的 DeepSeek 文件上传能力
3. 将上传返回的 file id 合并进 `ref_file_ids`
4. 最终让 deepseek-web 能用“附件上下文文件 + 短 prompt”替代“长历史直接内联 prompt”

这次目标是改 **RouteCodex 自己的代码**，不是改 `../ds2api` 本体。

---

## 2. Success Criteria

### 必须全部成立

1. deepseek-web request compat 在触发条件满足时，能产出 `RCC_HISTORY.txt` transcript 文本
2. transcript 顶部标题恒为 `# RCC_HISTORY.txt`
3. 触发后 live prompt 改为引用 `attached RCC_HISTORY.txt context` 的 continuation prompt
4. TS `DeepSeekHttpProvider` 能读取显式 metadata 契约并完成真实文件上传
5. 上传返回的 file id 被合并进最终 completion body 的 `ref_file_ids`
6. upload 失败时显式报错，不允许静默 fallback 回旧长 prompt 模式
7. 未触发该模式时，deepseek-web 现有 prompt/tool/search/thinking 主路径不回归
8. 整个实现只修改 RouteCodex 自己的 Rust/TS 真源，不修改 `../ds2api`

---

## 3. Hard Constraints

1. **Do not modify `../ds2api` as the implementation target.**
2. ds2api 只能作为参考语义来源，不能当运行时真源。
3. **No fallback / no silent downgrade.**
4. transcript 生成语义必须留在 Rust deepseek-web request compat 真源。
5. 文件上传执行必须留在 RouteCodex provider runtime。
6. 不得在 TS provider 中重建第二套完整 prompt/history canonicalization 逻辑。
7. `RCC_HISTORY.txt` 为单一 canonical 文件名，不允许新写入继续产出 `DS2API_HISTORY.txt`。
8. 不得破坏当前 `ref_file_ids` 透传语义。
9. 不得破坏现有 deepseek-web tool guidance / tool harvest 主路径。
10. 任何完成宣称都必须带文件/测试证据。

---

## 4. Scope

## In Scope

1. `sharedmodule/llmswitch-core` Rust deepseek-web request compat
2. `src/providers/core/runtime/deepseek-http-provider.ts`
3. DeepSeek file upload client/helper（新增于 RouteCodex）
4. deepseek runtime options / tests / docs（仅与此能力直接相关）

## Out of Scope

1. 修改 `../ds2api` 本体
2. 改 deepseek-web 工具协议对齐任务本身
3. 改 qwen / gemini / mimoweb / 其他 provider
4. 改 admin history / token history / 其它 history 语义对象

---

## 5. Required Implementation Shape

### 5.1 Rust 真源必须负责

Rust deepseek-web request compat 必须负责：

1. 判断是否启用 `RCC_HISTORY.txt` 模式
2. 从 `messages` 生成 transcript 文本
3. 生成缩短后的 continuation prompt
4. 把 transcript 作为显式 metadata 契约下发给 provider

### 5.2 TS provider 必须负责

`DeepSeekHttpProvider` 必须负责：

1. 读取 Rust 输出的 context-file metadata
2. 复用已有 auth/session/browser headers
3. 执行上游文件上传
4. 将 file id 合并进 `ref_file_ids`
5. 发送最终 completion 请求

### 5.3 Canonical artifact rules

1. 文件名固定：`RCC_HISTORY.txt`
2. transcript 标题固定：`# RCC_HISTORY.txt`
3. continuation prompt 固定引用：`attached RCC_HISTORY.txt context`
4. 新写入不允许继续使用 `DS2API_HISTORY.txt`

---

## 6. File Targets

### Rust / llmswitch-core
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt/model.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt/content.rs`
- 建议新增 `history_context.rs`（或等价模块）

### Provider runtime / TS
- `src/providers/core/runtime/deepseek-http-provider.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- 建议新增 `src/providers/core/runtime/deepseek-file-upload.ts`（或等价 helper/client）
- `src/providers/core/contracts/deepseek-provider-contract.ts`

### Tests
- `tests/providers/core/runtime/deepseek-http-provider.unit.test.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/__tests__/deepseek-web-request.test.ts`
- `sharedmodule/llmswitch-core/scripts/tests/deepseek-web-compat-tool-calling.mjs`
- 必要时新增 Rust 单测

---

## 7. Execution Plan

### Phase 1 — Rust 语义落地

目标：让 Rust deepseek-web request compat 能输出 `RCC_HISTORY.txt` transcript 与 continuation prompt。

完成条件：

1. 新 transcript 生成函数存在
2. compat 输出包含显式 context-file metadata
3. prompt 在启用时不再内联完整历史

### Phase 2 — Provider 上传链路落地

目标：让 `DeepSeekHttpProvider` 在 completion 前上传 `RCC_HISTORY.txt`。

完成条件：

1. provider 能消费 context-file metadata
2. 有真实 upload client/helper
3. 最终 body 的 `ref_file_ids` 含新 file id

### Phase 3 — 配置与回归收口

目标：让能力可控且不破坏既有路径。

完成条件：

1. runtime options 明确
2. old path/no-context-file path 不回归
3. tests/scripts 覆盖到位

---

## 8. Verification Matrix

### Rust request compat

1. 触发后 metadata 中有 `RCC_HISTORY.txt`
2. transcript 含 `# RCC_HISTORY.txt`
3. live prompt 为 continuation prompt
4. transcript 保留 system/user/assistant/tool 关键历史

### TS provider runtime

1. 读取 metadata 成功
2. upload client 被调用
3. file id 合并进 `ref_file_ids`
4. 最终 completion body 使用短 prompt + file ids

### Regression

1. 未触发模式时旧 deepseek-web 路径不变
2. tool/search/thinking 行为不回归
3. upload 失败显式报错

### Suggested gates

```bash
npm run jest:run -- --runTestsByPath tests/providers/core/runtime/deepseek-http-provider.unit.test.ts
npm run jest:run -- --runTestsByPath sharedmodule/llmswitch-core/src/conversion/compat/actions/__tests__/deepseek-web-request.test.ts
node sharedmodule/llmswitch-core/scripts/tests/deepseek-web-compat-tool-calling.mjs
```

如新增 Rust 用例：

```bash
cargo test -p router-hotpath-napi deepseek_web
```

---

## 9. Anti-Patterns (Forbidden)

1. 去改 `../ds2api`，然后宣称 RouteCodex 已支持
2. 只改 prompt，不补真实 upload 链路
3. 只在 TS provider 层拼 transcript，绕开 Rust 真源
4. upload 失败后静默退回旧长 prompt 模式
5. 把任务扩展成其它 provider 的通用 history/file 模式重构
6. 把这次任务和 deepseek 工具协议对齐任务混成一个实现面

---

## 10. Unique Correctness Statement

这次任务的**唯一正确修改处**，不是 ds2api 本体，也不是纯 TS provider 单点补丁，而是 RouteCodex 自己的两段真源协作：

1. **Rust deepseek-web request compat** 负责 history transcript / continuation prompt 语义
2. **TS DeepSeekHttpProvider** 负责 authenticated file upload / `ref_file_ids` 合并

原因：

- 只有 Rust 真源掌握 RouteCodex deepseek-web prompt/history canonicalization
- 只有 TS provider runtime 掌握 DeepSeek 上游 auth/session/upload 传输能力
- 任意只改一边都会形成不完整实现或第二真源

因此，**唯一正确方案**就是：

> 参考 ds2api 的 current-input-file 思路，但在 RouteCodex 自己的 Rust deepseek-web request compat 中产出 `RCC_HISTORY.txt` transcript 与 continuation prompt，再由 RouteCodex 自己的 `DeepSeekHttpProvider` 负责真实文件上传和 `ref_file_ids` 合并；不改 ds2api 本体，不在 TS 重建第二套 history 语义，不允许 upload 失败时静默 fallback。 

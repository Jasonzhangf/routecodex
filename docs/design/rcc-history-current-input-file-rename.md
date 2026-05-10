# RouteCodex deepseek-web：参考 ds2api 引入 RCC_HISTORY.txt 上下文文件的实现设计

## 索引概要
- L1-L22 `goal`: 目标、范围、设计结论
- L23-L88 `current-state`: RouteCodex 当前 deepseek-web 真实行为
- L89-L164 `ds2api-reference`: ds2api 可借鉴的真义
- L165-L278 `target-architecture`: RouteCodex 自己该怎么落地
- L279-L382 `change-plan`: 文件级改造计划
- L383-L454 `verification`: 验证矩阵
- L455-L510 `risks`: 风险、边界、非目标
- L511-L566 `uniqueness`: 为什么这是唯一正确方案

---

## 1. 目标与范围

这次不是改 `../ds2api`，而是：

> **参考 ds2api 的 current-input-file / history-transcript 设计，改造 RouteCodex 自己的 deepseek-web provider，使其在长上下文或指定场景下把完整上下文转成 `RCC_HISTORY.txt` 文件上传给 DeepSeek Web，并把 live prompt 缩成 continuation 语义。**

也就是说：

- **参考对象**：`../ds2api`
- **真实修改对象**：`routecodex` 自己的 `sharedmodule/llmswitch-core` + `src/providers/core/runtime/deepseek-http-provider.ts`
- **新 canonical 文件名**：`RCC_HISTORY.txt`

### 设计结论

唯一正确方案不是去改 ds2api，也不是只在 TS provider 层随手拼一个 history 文件，而是：

1. **Rust deepseek-web request compat 真源**负责：
   - 决定是否启用 context-file 模式
   - 生成 `RCC_HISTORY.txt` transcript 文本
   - 生成缩短后的 continuation prompt
   - 把 transcript 作为显式 metadata 契约下发给 provider runtime
2. **TS `DeepSeekHttpProvider`** 负责：
   - 使用已有 DeepSeek auth/session header 能力
   - 调上游文件上传接口上传 `RCC_HISTORY.txt`
   - 把返回的 file id 合并进 `ref_file_ids`
   - 再发最终 completion 请求

这两层缺一不可：

- 只改 Rust：没有 authenticated upload，文件发不上去
- 只改 TS：会重建第二套 prompt/history 语义，违背真源边界

---

## 2. RouteCodex 当前 deepseek-web 真实行为

### 2.1 Rust request compat 现状

当前 deepseek-web 请求兼容真源在：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request.rs`
- `.../request/prompt.rs`
- `.../request/prompt/model.rs`
- `.../request/prompt/content.rs`
- `.../request/prompt/tool_guidance.rs`

当前行为已经明确：

1. 把 `messages` 序列化为单个 `prompt`
2. 保留/透传已有 `ref_file_ids`
3. 输出：
   - `chat_session_id`
   - `parent_message_id`
   - `prompt`
   - `ref_file_ids`
   - `thinking_enabled`
   - `search_enabled`
   - `metadata.deepseek.*`

关键证据：`request.rs` 当前只做了：

```rust
next.insert("prompt".to_string(), Value::String(prompt));
next.insert("ref_file_ids".to_string(), ... root.get("ref_file_ids") ...);
```

**没有任何 transcript 文件生成逻辑。**

### 2.2 Rust prompt 现状

当前 prompt builder 做的是：

- 把 user / assistant / tool 历史直接折叠到 prompt
- assistant 历史 tool_calls 仍按当前 deepseek-web 自有 `<tool_call>` wrapper 语义写回 prompt
- tool result 变成 `[Previous tool output ...]` 文本继续塞在 prompt 中

也就是说，当前 RouteCodex 的 deepseek-web 仍然是：

> **完整历史主要直接内联进 prompt**

而不是“拆成一个上下文文件再引用”。

### 2.3 TS provider runtime 现状

当前 provider runtime 真源在：

- `src/providers/core/runtime/deepseek-http-provider.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- `src/providers/core/runtime/deepseek-session-pow.ts`

当前事实：

1. provider 可以：
   - 建 session
   - 拿 PoW
   - 发 completion 请求
2. 最终 request body 只会组装：

```ts
{
  chat_session_id,
  parent_message_id,
  prompt,
  ref_file_ids,
  thinking_enabled,
  search_enabled,
  stream?
}
```

3. `ref_file_ids` 当前只是：

```ts
ref_file_ids: Array.isArray(body.ref_file_ids) ? body.ref_file_ids : []
```

**结论：provider 目前只会透传 file ids，不会自己上传任何 context file。**

### 2.4 当前仓库没有现成的 DeepSeek 文件上传链路

本轮 grep 结果显示：

- DeepSeek provider 现有实现只有 session create / pow challenge / completion
- 没有本地 `upload file` / `multipart` / `DeepSeek file upload client` 真实现
- 当前仓库里对 `ref_file_ids` 的处理仅限透传/断言 array shape

所以如果要在 RouteCodex 落 `RCC_HISTORY.txt`，**必须新增我们自己的上传链路**。

---

## 3. ds2api 可借鉴的真义

这次只能“参考 ds2api”，不能把 ds2api 本体当修改目标。

可借鉴的核心不是 repo 名字，也不是直接照搬文件路径，而是这三个设计动作：

### 3.1 current-input-file 设计动作

ds2api 的关键动作是：

1. 取完整 `messages`
2. 序列化成 transcript 文本
3. 上传为上下文文件
4. live prompt 只保留 continuation 提示
5. file id 放进 `ref_file_ids`

### 3.2 transcript 形状

ds2api 的 transcript 形状是：

```text
# DS2API_HISTORY.txt
Prior conversation history and tool progress.

=== 1. SYSTEM ===
...

=== 2. USER ===
...
```

RouteCodex 参考后，应把 canonical 名称换成：

```text
# RCC_HISTORY.txt
Prior conversation history and tool progress.
```

### 3.3 continuation prompt 语义

ds2api 的 prompt 不是重复塞完整历史，而是提示模型：

- 继续基于附件中的上下文工作
- 直接回答最新请求

RouteCodex 参考后，也应该这样做，但引用名必须是：

- `RCC_HISTORY.txt`

---

## 4. RouteCodex 的目标架构

### 4.1 目标链路

最终目标链路应是：

```text
client messages
  -> llmswitch-core Rust deepseek-web request compat
  -> 生成 prompt / 决定是否转 RCC_HISTORY.txt / 产出 transcript metadata
  -> TS DeepSeekHttpProvider 上传 RCC_HISTORY.txt
  -> provider 把 file_id 合并进 ref_file_ids
  -> provider 发最终 completion 请求
```

### 4.2 职责切分

#### A. Rust 真源负责“语义”

Rust deepseek-web request compat 必须负责：

1. 何时触发 context-file 模式
2. 如何把 `messages` 序列化成 `RCC_HISTORY.txt`
3. 如何在 transcript 中表达：
   - system
   - user
   - assistant
   - tool result
   - assistant tool_calls 历史
4. 如何把 live prompt 改成缩短后的 continuation prompt
5. 如何把这些信息作为 **显式 metadata contract** 输出给 provider

#### B. TS provider 负责“上游传输”

`DeepSeekHttpProvider` 必须负责：

1. 读取 Rust 输出的 context-file metadata
2. 用现有 auth/session header 能力调用 DeepSeek file upload 接口
3. 拿到 file id
4. 合并进 `ref_file_ids`
5. 把 `prompt + ref_file_ids` 发给 completion

### 4.3 为什么不能把 transcript 生成放到 TS provider

因为那会让 deepseek-web prompt/history 语义分裂成两份：

- Rust request compat 一份
- TS provider 又一份

这违背 RouteCodex 的真源边界。历史 transcript 的构建语义，必须和当前 deepseek-web prompt builder 在同一真源层。

### 4.4 为什么不能把上传放到 Rust compat

因为 Rust compat 当前不持有：

- provider auth headers
- Camoufox 指纹头
- session create / PoW runtime 能力
- 上游 HTTP 传输控制

所以它只能产出“要上传什么”，不能自己完成“怎么上传”。

---

## 5. 需要新增的 RouteCodex 契约

### 5.1 新 metadata 契约（建议）

建议由 Rust req compat 生成一个显式 metadata 节点，例如：

```json
{
  "metadata": {
    "deepseek": {
      "contextFile": {
        "enabled": true,
        "filename": "RCC_HISTORY.txt",
        "content": "# RCC_HISTORY.txt
Prior conversation history and tool progress.
...",
        "contentType": "text/plain; charset=utf-8"
      }
    }
  }
}
```

关键原则：

1. **显式契约**，不能靠 provider 从 prompt 反推
2. filename 固定 canonical 为 `RCC_HISTORY.txt`
3. content 就是 Rust 真源产出的 transcript

### 5.2 live prompt 契约（建议）

当启用 context-file 模式时，Rust 产出的 prompt 应不再内联完整历史，而改为 continuation prompt，例如：

```text
Continue from the latest state in the attached RCC_HISTORY.txt context. Treat it as the current working state and answer the latest user request directly.
```

这句要由 Rust 真源统一产出，而不是 provider 自己拼。

### 5.3 transcript 形状（建议）

建议 RouteCodex transcript 形状参考 ds2api，但保留 deepseek-web 自己的 tool history canonicalization：

```text
# RCC_HISTORY.txt
Prior conversation history and tool progress.

=== 1. SYSTEM ===
...

=== 2. USER ===
...

=== 3. ASSISTANT ===
...

=== 4. TOOL ===
...
```

需要特别说明：

- 这里的 assistant/tool 历史表达，应复用 deepseek-web 当前已验证的 prompt canonicalization 逻辑
- 不允许 provider 自己再编第二套 transcript 规则

---

## 6. 文件级改造计划

### Phase 1：Rust request compat 增加 RCC history transcript 语义

目标：让 llmswitch-core Rust 真源能在 deepseek-web 路径下输出：

1. `RCC_HISTORY.txt` transcript
2. 缩短后的 continuation prompt
3. provider 可消费的 metadata contract

重点文件：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request.rs`
- `.../request/prompt.rs`
- `.../request/prompt/model.rs`
- `.../request/prompt/content.rs`
- 建议新增：`.../request/history_context.rs` 或同类专属模块

建议新增能力：

1. `build_rcc_history_transcript(...)`
2. `should_use_rcc_history_context(...)`
3. `build_rcc_history_continuation_prompt(...)`
4. 把 `metadata.deepseek.contextFile` 写入 compat 输出

### Phase 2：TS provider runtime 增加 DeepSeek file upload 能力

目标：provider 在发 completion 前，能把 `RCC_HISTORY.txt` 上传成 file，并把 file id 合并进 `ref_file_ids`。

重点文件：

- `src/providers/core/runtime/deepseek-http-provider.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- 建议新增：`src/providers/core/runtime/deepseek-file-upload.ts` 或同级 helper/client

建议动作：

1. 在 provider runtime 读取 `metadata.deepseek.contextFile`
2. 复用现有 auth headers / browser headers
3. 实现上游 file upload client
4. 记录 `pendingRefFileIds` 或等价 provider 内部过渡状态
5. 在 `buildHttpRequestBody(...)` 时合并上传后的 file id

### Phase 3：兼容与配置收口

目标：把这能力变成 deepseek-web 的明确 provider 选项，而不是临时魔法逻辑。

候选文件：

- `src/providers/core/contracts/deepseek-provider-contract.ts`
- deepseek runtime options 解析链
- deepseek compat wrapper / tests

建议新增 runtime option：

- `historyContextFileEnabled`
- `historyContextFileMinChars`

但 canonical 文件名**不要开放配置**，固定为：

- `RCC_HISTORY.txt`

### Phase 4：测试与文档

目标：给 RouteCodex 自己补回归与设计文档。

重点文件：

- `tests/providers/core/runtime/deepseek-http-provider.unit.test.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/__tests__/deepseek-web-request.test.ts`
- `sharedmodule/llmswitch-core/scripts/tests/deepseek-web-compat-tool-calling.mjs`
- 必要时新增 Rust request compat 单测

---

## 7. 验证矩阵

### 7.1 Rust request compat

验证点：

1. 未触发 context-file 模式时，仍保持当前 prompt 主路径不变
2. 触发后：
   - prompt 变为 continuation prompt
   - `metadata.deepseek.contextFile.filename == RCC_HISTORY.txt`
   - `metadata.deepseek.contextFile.content` 含 `# RCC_HISTORY.txt`
3. transcript 保留 system/user/assistant/tool 历史
4. transcript 不丢 assistant tool_calls / tool result 关键语义

### 7.2 TS provider runtime

验证点：

1. 识别 `metadata.deepseek.contextFile`
2. 成功调用 file upload client
3. 上传结果 file id 被合并进 `ref_file_ids`
4. 最终 completion body 使用缩短后的 prompt + 新 `ref_file_ids`
5. 如果 upload 显式失败，必须 fail-fast，而不是静默透传旧 prompt

### 7.3 回归不破坏

验证点：

1. 不使用 context-file 模式的 deepseek-web 请求不回归
2. 当前 tool guidance / tool harvest 逻辑不被这次改造破坏
3. search / thinking flags 不回归
4. 原有 `ref_file_ids` 透传语义仍保留

### 7.4 最小建议验证链

建议至少执行：

```bash
npm run jest:run -- --runTestsByPath tests/providers/core/runtime/deepseek-http-provider.unit.test.ts
npm run jest:run -- --runTestsByPath sharedmodule/llmswitch-core/src/conversion/compat/actions/__tests__/deepseek-web-request.test.ts
node sharedmodule/llmswitch-core/scripts/tests/deepseek-web-compat-tool-calling.mjs
```

如 Rust 单测新增，再补：

```bash
cargo test -p router-hotpath-napi deepseek_web
```

---

## 8. 风险、边界、非目标

### 8.1 当前最大缺口

当前 RouteCodex 最大缺口不是 prompt builder，而是：

> **完全没有 DeepSeek 上下文文件上传链路。**

所以这次不能假装只改 prompt 就完成目标。

### 8.2 不能误改的边界

这次任务不是：

1. 改 `../ds2api` 本体
2. 改 deepseek-web 工具调用主协议（那是另一条任务）
3. 改 admin history / store / token history 等其它“history”概念
4. 改所有 provider 一起支持 `RCC_HISTORY.txt`

### 8.3 非目标

本轮目标不是：

- 把 RouteCodex 完全复制成 ds2api
- 一次性完成 ds2api 的全部 current-input-file 配置面
- 顺手改 qwen / mimoweb / gemini

### 8.4 失败路径要求

若 upload 失败：

- 必须显式报错
- 不允许静默退回“继续把完整历史塞 prompt”这种 fallback

因为这会制造双语义和静默行为分叉。

---

## 9. 为什么这是唯一正确方案

### 9.1 唯一正确修改点

这次任务的唯一正确修改面是：

1. **Rust deepseek-web request compat 真源**：生成 `RCC_HISTORY.txt` transcript 与 continuation prompt
2. **TS DeepSeekHttpProvider runtime**：执行真实文件上传并合并 file id

### 9.2 为什么不能只改 ds2api

因为 ds2api 只是参考实现，不是 RouteCodex 的运行时真源。改 ds2api 不能让 RouteCodex 的 deepseek-web provider 获得任何新能力。

### 9.3 为什么不能只改 provider TS

因为那会让：

- transcript 生成规则
- prompt 缩短规则
- 历史 canonicalization 规则

全都在 TS 再复制一遍，形成第二真源。

### 9.4 为什么不能只改 Rust

因为 Rust compat 不掌握 provider auth/session/upload HTTP 能力，无法完成真实上游文件上传。

### 9.5 唯一性结论

所以这次任务的**唯一正确方案**就是：

> 让 RouteCodex 自己的 Rust deepseek-web request compat 产出 `RCC_HISTORY.txt` transcript + continuation prompt + 显式 metadata 契约，再由 RouteCodex 自己的 `DeepSeekHttpProvider` 负责真实文件上传与 `ref_file_ids` 合并；不改 ds2api 本体，不在 TS 重建第二套 history 语义，也不允许 upload 失败后静默 fallback 回旧 prompt 模式。

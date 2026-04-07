# Web Search ServerTool Orchestration 设计文档

## 索引概要
- L1-L30 `background`: 背景、目标、原则
- L31-L60 `current-state`: 当前架构现状
- L61-L100 `gap-analysis`: 未实现/缺失部分
- L101-L150 `change-plan`: 最小改动计划
- L151-L180 `file-list`: 文件改动清单
- L181-L200 `execution-order`: 执行顺序
- L201-L220 `verification`: 验证点

---

## 背景

RouteCodex 需要支持 web search 作为标准工具能力，让所有 text-guidance 模式的 provider（qwenchat、deepseek、tabglm、ali-coding-plan）都能通过 heredoc 格式调用 web search。

**目标**：
1. 用户请求默认带 `websearch` 工具（和 `exec_command`/`apply_patch` 一样）
2. 模型通过 heredoc 格式调用 `websearch` 工具
3. Hub 收割工具调用 → 按 provider 适配原生 web search API
4. 直路由 web_search 时剥离其他工具

**原则**：
1. 日常工具列表都需要注入 — `websearch` 作为标准工具
2. text guidance 基于标准工具列表动态创建 — 不写 dead code
3. search followup 按 provider 适配原生 API — qwenchat/deepseek/tabglm 各自有实现
4. 直路由 web_search 时剥离其他工具 — forceWebSearch=true 移除 tools

---

## 当前架构现状

### 已实现

| 层 | 文件 | 功能 |
|---|---|---|
| 搜索意图检测 | `chat_web_search_intent.rs` | 中英文关键词检测 |
| servertool 编排计划 | `chat_servertool_orchestration.rs` | `resolve_chat_web_search_plan()` 判断是否注入 |
| forceWebSearch 元数据 | `hub_pipeline_target_utils.rs` | target 带 `forceWebSearch: true` 时注入 metadata |
| qwenchat search 模式 | `qwenchat-http-provider-helpers.ts` | `shouldUseSearchMode()` → `chatType: 'search'` |
| 直路由 bypass | `should_bypass_servertool_web_search()` | direct engine 时跳过 servertool 注入 |
| 响应工具名归一化 | `hub_resp_outbound_client_semantics.rs:1857` | `websearch`/`web-search` → `web_search` |
| heredoc 收割 | `hub_reasoning_tool_normalizer.rs:1723` | `<<RCC_TOOL_CALLS_JSON` 正则收割所有工具调用 |
| text guidance 动态生成 | `shared_tool_text_guidance.rs` | `build_tool_text_instruction(tools)` 从 tools 数组生成引导 |

### 未实现/缺失

| 层 | 问题 | 影响 |
|---|---|---|
| **websearch 工具定义注入** | `chat_servertool_orchestration.rs` 没有注入 `websearch` 工具的 `append_tool_if_missing` | 模型不知道有 websearch 工具可用 |
| **search followup 路径** | 收割到 `websearch` 调用后，没有触发 provider 原生 search API 的 followup | 搜索结果无法正确回注 |
| **直路由剥离工具** | `forceWebSearch=true` 只注入 flag，没有移除 tools | 进入 web_search 路由后仍带所有工具 |
| **provider 适配层** | qwenchat/deepseek/tabglm 没有 `handleWebSearchFollowup()` | 无法调用原生 search API |

---

## 改动计划

### Step 1: 在 servertool orchestration 中注入 `websearch` 工具定义

**文件**: `chat_servertool_orchestration.rs`

**改动**: 新增 `build_websearch_operations()` 函数

```rust
fn build_websearch_operations(server_tool_followup: bool) -> Value {
    if server_tool_followup {
        return Value::Array(Vec::new());
    }
    let parameters = json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Web search query" }
        },
        "required": ["query"],
        "additionalProperties": false
    });
    let websearch_tool = json!({
        "type": "function",
        "function": {
            "name": "websearch",
            "description": "Search the web for current information",
            "parameters": parameters,
            "strict": true
        }
    });
    json!([
        { "op": "append_tool_if_missing", "toolName": "websearch", "tool": websearch_tool }
    ])
}
```

并在 `resolve_chat_web_search_plan` 或 bundle 输出中合并 operations。

---

### Step 2: text guidance 自动包含 websearch

**文件**: `shared_tool_text_guidance.rs` — **无需改动**

`build_tool_text_instruction(tools)` 已是动态生成，Step 1 注入后自动包含。

---

### Step 3: search followup 按 provider 适配

**架构流程**:
```
模型 heredoc 输出 websearch 调用
  → hub_reasoning_tool_normalizer 收割
  → resp_process_stage1_tool_governance 识别为 servertool
  → provider-response-converter 触发 serverToolFollowup
  → 按 providerKey 路由到原生 search handler
  → 搜索结果作为工具执行结果回注
  → followup 请求带所有工具继续对话
```

**改动点**:

| Provider | 文件 | 改动 |
|---|---|---|
| **qwenchat** | `qwenchat-http-provider-helpers.ts` | 新增 `handleWebSearchFollowup(query)` → `createQwenChatSession({chatType: 'search'})` |
| **deepseek-web** | `deepseek-http-provider.ts` (待确认) | 新增 `handleWebSearchFollowup(query)` → deepseek 原生 search |
| **tabglm** | TBD | 待适配 |
| **ali-coding-plan** | TBD | 待适配 |

---

### Step 4: 直路由 web_search 时剥离其他工具

**文件**: `hub_pipeline_target_utils.rs` 或 `req_process_stage2_route_select.rs`

**改动**: `forceWebSearch=true` 时移除 `tools` 和 `tool_choice`

```rust
if force_web_search {
    if let Some(body_obj) = request.as_object_mut() {
        body_obj.remove("tools");
        body_obj.remove("tool_choice");
    }
}
```

---

## 文件改动清单

### Rust (llmswitch-core)

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `chat_servertool_orchestration.rs` | 新增函数 | `build_websearch_operations()` |
| `hub_pipeline_target_utils.rs` | 新增逻辑 | `forceWebSearch` 时移除 tools |
| `req_process_stage2_route_select.rs` | 可能改动 | 确认 forceWebSearch 处理位置 |

### TypeScript

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `qwenchat-http-provider-helpers.ts` | 新增函数 | `handleWebSearchFollowup()` |
| `deepseek-http-provider.ts` | 新增函数 | `handleWebSearchFollowup()` |
| `provider-response-converter.ts` | 可能改动 | 确认 serverToolFollowup 路径 |

---

## 执行顺序

1. **Rust Step 1** — 注入 `websearch` 工具定义 → `cargo build --release` → 复制 `.node`
2. **Rust Step 4** — 直路由剥离工具 → 同上
3. **TS Step 3** — qwenchat/deepseek provider 适配 → `npm run build:dev`
4. **重启 5520** — 验证 heredoc 引导 → 工具调用 → followup → 原生 search

---

## 验证点

1. **引导注入** — 请求默认带 `websearch` 工具，text guidance 中有 `websearch` schema
2. **heredoc 调用** — 模型输出 `<<RCC_TOOL_CALLS_JSON\n{"tool_calls":[{"name":"websearch","input":{"query":"..."}}]}\nRCC_TOOL_CALLS_JSON`
3. **收割识别** — `hub_reasoning_tool_normalizer` 正确收割，`finish_reason=tool_calls`
4. **followup 触发** — `serverToolFollowup=true`，按 provider 调用原生 search
5. **直路由剥离** — `forceWebSearch=true` 时请求不带 tools

---

## 待确认

1. deepseek 原生 web search API 调用方式（是否和 qwenchat 类似有 `chatType` 参数）
2. `serverToolFollowup` 的触发点在 `resp_process_stage1_tool_governance` 还是 `provider-response-converter`
3. tabglm / ali-coding-plan 的原生 search 能力是否存在


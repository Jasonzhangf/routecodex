# Goal: deepseek-web 对齐 ds2api 工具引导与收获语义

## 1. Goal Objective

让 RouteCodex 的 `deepseek-web` 从当前 `<tool_call>` JSON wrapper 主协议，收敛到 **ds2api-style DSML/XML 工具协议**，并在 **请求引导、响应收割、流式筛分、非流式 finalize、历史 tool_calls 回注** 五个层面形成单一路径闭环，从而提供完整工具调用能力支持。

最终闭环必须保持为：

```text
HTTP server
  -> llmswitch-core chat process / Rust SSOT
  -> deepseek-web DSML/XML prompt guidance
  -> upstream text response
  -> Rust DSML/XML harvest + finalize
  -> canonical client-visible tool_calls
```

这是一次**协议真源对齐**任务，不是单纯改 prompt 文案，也不是 provider 层补 parser 的局部兼容任务。

---

## 2. Success Criteria

### 必须全部成立

1. `deepseek-web` 请求侧主工具引导改为 **DSML/XML**，不再以 `<tool_call>` 作为唯一正确格式
2. 响应侧能把 **DSML/XML** 作为 deepseek-web 文本工具 harvest 的**主路径**解析为标准 `tool_calls`
3. 流式链路具备 ds2api 同等 wrapper-only sieve 语义：
   - explicit wrapper 才捕获
   - fenced examples / mention / prose 不误触发
   - 成功 harvest 的工具块不再回流普通文本
4. 非流式 finalize 具备 ds2api 同等语义：
   - visible content 为空时可从 thinking/reasoning 恢复合法工具调用
   - `tool_choice=required` 且无合法工具调用时显式失败
5. 历史 assistant `tool_calls` 回注 prompt 时，与当前轮主协议一致，使用 prompt-visible DSML/XML
6. 旧 `<tool_call>` / `<function_calls>` / `RCC_TOOL_CALLS(_JSON)` 仍可作为**兼容收割路径**，但不再是主引导协议
7. 全部主语义实现在 Rust 真源，不在 TS/provider 层复制第二套 parser/governance

---

## 3. Hard Constraints

1. **No fallback / no downgrade / no silent compensation.**
2. **唯一真源必须在 Rust chat process / compat 主链。**
3. **禁止在 provider TS / host helper 中重建第二套 tool harvest 语义。**
4. **禁止从 prose / shell 正文 / patch 正文猜工具。**
   - 只认显式 wrapper
   - 只做显式容器内的窄修复
5. **真实 payload 语义不可改写。**
   - 可以重建 wrapper / canonical tool payload
   - 不能借兼容名义推断模型未明确表达的工具语义
6. **兼容旧 `<tool_call>` 只限收割，不可继续当主协议。**
7. **有工具调用就必须 `finish_reason=tool_calls`。**
8. **显式 wrapper 存在但 harvest 失败时必须显式暴露，不得静默 stop。**
9. **历史工具调用回注必须与当前协议一致。**
10. **任何完成宣称都必须带文件/测试/live replay 证据。**

---

## 4. Scope

## In Scope

1. `deepseek-web` 请求侧 prompt contract
2. Rust 响应侧 DSML/XML harvest
3. 流式 sieve 对齐
4. 非流式 finalize / thinking-only tool recovery 对齐
5. 历史 tool_calls prompt-visible 语义对齐
6. 兼容旧 wrapper 的回归保护

## Out of Scope

1. 把全部 provider 一次性切到 DSML/XML
2. 把 deepseek-web 改造成原生 transport tools provider
3. 在 TS 层做另一个 parser 作为主实现
4. 用 heuristic 从普通文本中猜测工具调用

---

## 5. Design Requirements

### 5.1 请求侧 contract

`deepseek-web` 的主工具引导必须明确要求模型输出：

```xml
<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME">
    <|DSML|parameter name="ARG"><![CDATA[value]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>
```

并且必须写清：

1. string 参数必须 `CDATA`
2. object 用 nested XML
3. array 用 `<item>`
4. 不允许 markdown fence
5. `tool_choice=required` 时必须出合法 tool block

### 5.2 响应侧 harvest contract

Rust harvest 必须：

1. 把 DSML/XML wrapper 视为 deepseek-web 的主显式容器
2. 做与 ds2api 一致的 wrapper-normalize 语义
3. 支持：
   - DSML 噪声别名
   - canonical `<tool_calls>`
   - CDATA loose sanitize
   - object/array/JSON literal 恢复
4. fenced examples / mention 不执行
5. wrapper 外 prose 保留
6. wrapper 存在但 name/args/allowlist 不合法时显式处理，不猜正文

### 5.3 finalize contract

1. visible content 为空时，允许从 thinking/reasoning 中恢复 DSML/XML tool block
2. recover 成功则直接输出结构化 `tool_calls`
3. `tool_choice=required` 且最终无合法调用时 fail-fast
4. 不允许空 assistant + stop 静默返回

### 5.4 history contract

1. assistant 历史 `tool_calls` 回注 prompt 时，必须与当前协议统一为 DSML/XML
2. tool result 历史可继续文本可见，但其配对 tool call 示例必须与主协议一致
3. 不允许一边要求本轮输出 DSML，一边在历史里喂 `<tool_call>` 作为主要样本

---

## 6. File Targets

### 请求侧

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/shared_tool_text_guidance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt/tool_guidance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt/model.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request.rs`

### 响应/收尾侧

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`
- 必要时关联到现有 request-executor / response finalize bridge，但不得重建第二真源

### 历史回注侧

- deepseek-web prompt history serializer 相关文件
- 任何把 assistant/tool history 重新写回 prompt 的真源文件

---

## 7. Execution Plan

### Phase 1 — 协议对齐

目标：DSML/XML 成为请求主协议，响应侧主收 DSML/XML。

交付条件：

1. deepseek-web prompt 不再主推 `<tool_call>`
2. Rust harvest 能把 DSML/XML 转标准 `tool_calls`
3. 旧 wrapper 回归不坏

### Phase 2 — finalize 对齐

目标：补齐 thinking-only recovery 与 required fail-fast。

交付条件：

1. visible empty + thinking tool block 可恢复
2. required-without-tool 明确失败
3. `finish_reason` 与 `tool_calls` 一致

### Phase 3 — 历史对齐

目标：多轮工具历史统一到 DSML/XML。

交付条件：

1. 历史 assistant tool_calls 回注使用 DSML/XML
2. 多轮 followup 不退回 narrative/tool-intent leakage

---

## 8. Verification Matrix

### 单元/契约

1. DSML wrapper parse
2. canonical XML wrapper parse
3. DSML 噪声 normalize
4. fenced examples ignored
5. CDATA long text preserved
6. nested object/array restored
7. malformed explicit wrapper fail-fast
8. allowlist enforcement
9. prose preserved after successful harvest

### 流式

1. 成功识别后不回流普通文本
2. mention / prose / fence 不误触发
3. partial wrapper flush 恢复或显式失败

### 非流式 finalize

1. thinking-only tool recovery
2. required-without-tool failure
3. structured tool_calls => `finish_reason=tool_calls`

### 多轮历史

1. assistant tool_calls history reinjected as DSML/XML
2. tool result 后继续按 DSML 协议推进

### live replay

至少包含：

1. 原 deepseek-web 工具失败样本 same-shape replay
2. 一条成功的 `exec_command` loop
3. 一条长文本/CDATA 样本
4. 一条 `tool_choice=required` 样本

---

## 9. Anti-Patterns (Forbidden)

1. 只改 prompt，不改 harvest/finalize/history
2. 在 provider TS/host 层补第二套 parser
3. 继续让 `<tool_call>` 作为主协议，同时宣称“已对齐 ds2api”
4. harvest 失败后从 shell/patch/prose 正文猜工具
5. 用 fallback 把不合法 wrapper 自动改写成合法调用
6. 发现 explicit wrapper 但 harvest=0 时仍静默放行为普通 stop 回复

---

## 10. Unique Correctness Statement

这项改造的**唯一正确修改处**，不是 provider TS，也不是下游出口 remap，而是 RouteCodex 的 Rust 真源链路：

- 请求 prompt contract 真源
- 响应 tool governance 真源
- finalize/history 真源

原因：

1. ds2api 的工具能力本质上是“协议 + 收割 + 收尾 + 历史”一体化系统，不是 prompt 片段
2. RouteCodex 的项目硬约束要求工具治理单一路径、Rust 主导、无 fallback
3. 只有把 DSML/XML 放进 Rust 主链，deepseek-web 才真正获得完整的 ds2api 风格工具调用能力

因此，**唯一正确目标**就是：

> 让 DSML/XML 成为 deepseek-web 的新主工具协议，并在 Rust 真源中统一完成请求引导、响应收割、流式筛分、非流式 finalize 与历史回注；旧 `<tool_call>` 仅保留为兼容收割路径。

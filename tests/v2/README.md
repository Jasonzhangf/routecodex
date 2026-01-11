# V2 工具与协议回归测试说明

本目录下的测试（尤其是 `src/tool-processing-test.ts`）遵循一个原则：

> 「工具收割 / 文本治理 / finish_reason 处理」在生产和测试中只保留一套实现，由
> `sharedmodule/llmswitch-core` 提供；测试只调用这套实现，不再自带第二套逻辑。

## 一、生产链路（唯一真实实现）

响应侧工具治理的实际执行路径：

- pipeline 阶段：`resp_process_stage1_tool_governance`
  - 调用 `runChatResponseToolFilters()`：
    - 内部使用 `ResponseToolTextCanonicalizeFilter` →
      `normalizeAssistantTextToToolCalls()`（`conversion/shared/text-markup-normalizer.ts`）；
    - 再调用 `canonicalizeChatResponseTools()` 统一 `tool_calls` 形状。
  - 调用 `ToolGovernanceEngine.governResponse()`（`conversion/hub/tool-governance`）：
    - 做工具名治理、约束补齐等。
  - 最终由 `ResponseFinishInvariantsFilter` 确保：
    - 若存在 `tool_calls`：
      - `choices[n].finish_reason === 'tool_calls'`；
      - 对应 `message.content === null`（或空文本），避免工具标记作为正文残留。

所有文本→工具调用的解析（包括 `apply_patch`、`shell/<function=execute>`、
`<tool_call>` XML 以及 `list_directory` 这类 XML 片段）都必须在这条链路上实现。

## 二、回归测试架构（复用同一条链路）

`tests/v2/src/tool-processing-test.ts` 做的事情是：

1. 从 `~/.routecodex/codex-samples` 读取真实快照：
   - 当前仅使用 `openai-chat/*_provider-response.json`。
2. 对每个样本：
   - 取出 `response.body.data`（Chat completion 形状）。
   - 调用：
     - `runChatResponseToolFilters(chatPayload, { entryEndpoint: '/v1/chat/completions', requestId, profile: 'openai-chat' })`；
     - `new ToolGovernanceEngine().governResponse(filtered, 'openai-chat')`。
   - 从 `governed.choices[0].message.tool_calls` 中读取工具调用，并用于：
     - 统计（收割工具数量、处理时间等）；
     - 断言工具名 / arguments 形状是否符合预期。

重要的是：**测试不再实现任何自定义 `harvestTools()` / 正则解析器**，
而是完全依赖 llmswitch-core 的生产实现。这样一旦我们在核心模块里扩展新规则，
矩阵测试会自动覆盖。

## 三、apply_patch 等工具的回归规则

对于 `apply_patch` 这类有独立 validator 的工具：

- 规范化入口仍然是响应侧工具治理：
  - 文本中的结构化 payload（unified diff / JSON changes 等）通过
    `text-markup-normalizer + canonicalizeChatResponseTools` 变成标准 `tool_calls`。
- 逻辑正确性由 `validateToolCall('apply_patch', args)`（`tools/tool-registry.ts`）
  负责：
  - 单元层面已有测试：
    - `tests/sharedmodule/apply-patch-validator.spec.ts`
    - `tests/sharedmodule/apply-patch-full.spec.ts`
  - 矩阵层面建议：
    - 在 `tool-processing-test` 中，对所有 `function.name === 'apply_patch'`
      的 `tool_calls`：
      - 把 `function.arguments` 交给 `validateToolCall('apply_patch', args)`；
      - 断言 `ok === true`，并对 `normalizedArgs` 中生成的 `patch` 做基本形状检查
        （例如是否包含 `*** Begin Patch` / `*** (Add|Update) File:`）。

## 四、如何为新问题补样本 / 补测试

当遇到新的工具 / 文本治理 bug 时，推荐流程是：

1. **捕获样本**
   - 启用 hooks 快照（或使用已有 codex-samples），保存触发问题的
     `*_provider-response.json` 与对应 `*_client-request.json`。
2. **在 llmswitch-core 修复**
   - 只在以下模块扩展逻辑：
     - `conversion/shared/text-markup-normalizer.ts`（文本 → tool_calls）；
     - `conversion/shared/tool-canonicalizer.ts`（tool_calls 形状统一）；
     - 必要时更新 `tools/tool-registry.ts` 或相关 compat；
   - **不要**在 Host / Provider / 测试代码里写第二套解析逻辑。
3. **更新单元测试**
   - 在 `tests/sharedmodule/*` 下新增/扩展 spec，直接调核心函数（例如
     `normalizeAssistantTextToToolCalls`、`validateToolCall`）。
4. **将样本纳入矩阵测试**
   - 把捕获的快照放进 `~/.routecodex/codex-samples/openai-chat`；
   - 根据需要在 `tool-processing-test` 里增加对特定工具的断言：
     - 检查 `tool_calls` 是否存在；
     - 检查 `finish_reason === 'tool_calls'`；
     - 对 `apply_patch` / 其他工具进一步验证 arguments 内容。

通过这套规则，我们保证：

- 生产链路和回归测试共享同一实现；
- 每次针对工具 / 文本治理的修复，都能通过「增加样本 + 扩单元测试 +
  走一遍矩阵测试」实现完整回环。 


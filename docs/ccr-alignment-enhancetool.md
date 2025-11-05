# CCR enhancetool 行为与对齐方案（形状/语法修复，非语义重写）

本文档总结了 claude-code-router（下称 CCR）中内置 transformer “enhancetool”的关键行为，并给出在 llmswitch-core 中实现等价对齐的方案。对齐范围严格限定为“整体形状/语法/JSON(JSON5) 层”，不解析或重写具体命令语义（如 grep 正则、管道策略等）。

## 1. CCR enhancetool 行为摘要

- 非流 JSON（application/json）
  - 对 `choices[0].message.tool_calls[].function.arguments` 执行三段式容错修复：
    1) 尝试 `JSON.parse` 成功 → 使用原字符串。
    2) 失败则 `JSON5.parse` 成功 → `JSON.stringify` 输出合法 JSON 字符串。
    3) 再失败则进行“安全修复”（典型策略：去除围栏标记、去掉尾随逗号、单引号转双引号、补齐引号/括号等），成功后 `JSON.stringify`。
    4) 全部失败 → 回退为字符串 "{}"（空对象）。
  - 若存在 `tool_calls`：标准化 `content=null`；无 `finish_reason` 时补齐为 `tool_calls`。

- 流式（text/event-stream）
  - 吞掉“工具参数增量”片段，不向下游透出 arguments 的碎片增量。
  - 聚合策略：
    - 记录工具调用开始（OpenAI Chat: `delta.tool_calls`；Anthropic Messages: `content_block_start` 等），保存 `index/name/id`。
    - 聚合 `partial_json` / `function.arguments` 的增量数据到缓冲；不在增量阶段向下游发送 arguments 内容。
    - 在工具完成时（OpenAI: `finish_reason=tool_calls`；Anthropic: `content_block_stop`）一次性下发：
      - 将聚合后的 arguments 走上述“三段式容错修复”，最终保证为“单个 JSON 字符串”。
      - 构造新的 delta（含完整 `name` 与 `arguments`），并删除任何同时出现的 `delta.content`。
  - 思考文本（reasoning）在 CCR 中被专门转为 `thinking` 域；本轮对齐聚焦工具通路，不改变我们已存在的 reasoning 处理策略。

- 不做的事
  - 不解析或重写具体命令语义（不拆分正则、多 -e 重写、命令管道改写等）。
  - 不注入系统提示词；仅允许在 tools schema 描述中加入“形状/用法提示”（非 system）。

## 2. 我们的对齐原则（三端一致）

1) 形状优先：仅保障 `function.arguments` 在所有输出路径上都是“单个 JSON 字符串”，并保持 `content=null`、`finish_reason=tool_calls` 等不变式。
2) 三端统一：Chat（OpenAI）、Responses（OpenAI）、Messages（Anthropic）在非流与流式两条通路都执行一致策略。
3) 不解析命令语义：不对 grep/正则/管道等进行语义重写，避免引入不可预测副作用。

## 3. 对齐实施方案

### 3.1 非流（一次性 JSON）

- 入口：`llmswitch-core v2` 的响应治理（response 相位）。
- 动作：
  - 若 `function.arguments` 是对象 → 仅 `JSON.stringify`（保持语义原样）。
  - 若是字符串 → 走 `repairArguments`（JSON→JSON5→安全修复→失败回退 "{}"）。
  - 补齐 `finish_reason=tool_calls`（若缺），以及 `content=null`（当存在 `tool_calls`）。

### 3.2 流式（SSE 聚合）

- Chat（OpenAI /v1/chat/completions）：新增“Chat SSE 工具参数聚合器”。
  - 吞掉增量 arguments，不向下游透出；工具完成时合并缓冲并 `repairArguments`，一次性发送完整字符串。

- Messages（Anthropic /v1/messages）：新增“Messages SSE 工具参数聚合器”。
  - 聚合 `input_json_delta.partial_json`；`content_block_stop` 时进行 `repairArguments` 并一次性下发。

- Responses（OpenAI /v1/responses）：改造现有 `ResponsesSSETransformer` 为同策略。
  - 工具参数不再逐片外发，仅在工具结束时一次性输出完整字符串。

### 3.3 repairArguments（对齐 CCR，形状/语法修复）

- 实现在 `shared/v2/conversion/shared/jsonish.ts`：
  - `repairArguments(arg: unknown): string`：输入任意字符串/对象，输出“单个 JSON 字符串”。
  - 顺序：`JSON.parse` → `JSON5.parse` → 安全修复（去围栏/尾逗号/单引号等）→ 失败返回 "{}"。
  - 不触碰命令语义（值中的命令原封不动）。

### 3.4 tools schema 描述增强（非 system 提示）

- 在 `augmentOpenAITools` 的 `shell` 描述中追加“稳健用法提示”（仅描述层）：
  - 长 OR 模式建议使用多个 `-e` 或 `-f`（从 stdin 读模式列表）。
  - 可优先使用 `rg`（ripgrep）以减少引号/括号陷阱。
  - 避免将解释性文字混入 `arguments`；说明性文字放在普通对话文本中。

## 4. 开关与默认

- `RCC_TOOL_ENHANCE=1`（默认开）：启用 `repairArguments` 三段式修复（失败回退 "{}"）。
- `RCC_SSE_TOOL_AGGREGATE=1`（默认开）：吞掉参数增量，完结一次性下发完整 arguments。

## 5. 快照与验收

- 预期在 `*_provider-request.json`：
  - `assistant.tool_calls[].function.arguments` 均为合法 JSON 字符串；
  - 当有 `tool_calls` 时，`content=null`，`finish_reason='tool_calls'`；
  - 无 arguments 增量碎片。

- SSE：不再透出 arguments 增量；仅在工具完成时出现一次完整 arguments。

- 失败回退：当 JSON/JSON5/修复全部失败时，arguments 应为 "{}"。

## 6. 边界与不做项

- 不解析或重写具体命令语义（例如：不拆分大正则为多 `-e`，不重排管道）。
- 不在服务器端点或兼容层重复实现工具转换/聚合；统一入口仅在 `llmswitch-core`。

## 7. 实施清单（按顺序）

1) 文档到位（本文件 + AGENTS.md 对齐段落）。
2) 新增 `repairArguments`（JSON→JSON5→安全修复→"{}"）。
3) 改造响应相位（非流）调用 `repairArguments` 并保证 finish_reason/content 不变式。
4) 新增 Chat/Anthropic 两个 SSE 聚合器；改造 Responses SSE 统一策略。
5) 更新 tools schema 描述（仅描述增强）。
6) 严格按“先编译共享模块、再构建根包并全局安装”的顺序验证。

---

附：CCR 代码阅读锚点（仅供对照，不在代码注释中引用）
- `@musistudio/llms` 打包后的 `server.cjs` 中 `class name="enhancetool"`（非流/流式两条路径）；
- 流式路径中 `content_block_start/stop` 与 `partial_json` 聚合逻辑；
- 非流路径中 arguments 三段式修复与回退策略。


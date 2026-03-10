# SSE 双向转换骨架总览

> 当前骨架支持 **OpenAI Chat、OpenAI Responses、Anthropic Messages、Google Gemini** 四条协议。所有协议的 JSON↔SSE 编排共用相同的工具链：类型（`types/`）→ 编排器（`json-to-sse/`、`sse-to-json/`）→ Shared Writer/Parser → Registry。

## 1. 目标与原则

- **单一骨架**：所有协议都沿用 `JSON → Sequencer → Shared Writer → SSE` 与 `SSE → Shared Parser → Builder → JSON` 的流水线。
- **协议特定逻辑隔离**：仅在 `anthropic-*`、`gemini-*` 等文件内处理特殊字段；共享目录保持中性命名。
- **可配置推理/工具治理**：reasoning channel、tool call chunk、metadata 过滤等均由 shared actions / dispatcher 控制。
- **统一推理归档**：所有协议的 inbound format adapter 会调用 `conversion/shared/reasoning-normalizer.ts`，在进入骨架前将 `<think>`/`<reflection>` 等推理片段剥离并写入 canonical `reasoning` 字段，后续 SSE/JSON builder 仅依赖骨架数据结构。
- **完整双向验证**：`scripts/tests/loop-rt-*.mjs`、`run-matrix-ci` 都会运行每个协议的 roundtrip。

## 2. 目录/文件速查

| 路径 | 作用 |
| --- | --- |
| `types/` | 协议与共享类型。`core-interfaces.ts` 定义 `BaseSseEvent`、`StreamProtocol`。`chat-/responses-/anthropic-/gemini-types.ts` 描述各协议 payload/上下文/事件，`index.ts` 汇总导出。 |
| `json-to-sse/` | JSON→SSE 主入口。`chat-json-to-sse-converter.ts`、`responses-json-to-sse-converter.ts`、`anthropic-json-to-sse-converter.ts`、`gemini-json-to-sse-converter.ts` 负责各协议。`sequencers/` 下的 `chat-sequencer.ts`、`responses-sequencer.ts`、`anthropic-sequencer.ts`、`gemini-sequencer.ts` 统一生成 canonical 事件序列。 |
| `sse-to-json/` | SSE→JSON 主入口。`chat-sse-to-json-converter.ts`、`responses-sse-to-json-converter.ts`、`anthropic-sse-to-json-converter.ts`、`gemini-sse-to-json-converter.ts` 同步共享 parser。`parsers/sse-parser.ts` 识别所有事件类型，`builders/` 目录下的 builder 还原 JSON 形状。 |
| `shared/` | `writer.ts` 统一写入器（处理 backpressure/heartbeat），`serializers/` 输出 Chat/Responses/Anthropic/Gemini wire frame，`reasoning-dispatcher.ts` 控制推理 channel/text，`snapshot-utils.ts`、`streaming-text-extractor.ts` 等辅助模块。 |
| `conversion/shared/reasoning-normalizer.ts` | Chat/Responses/Gemini 三条协议的 `<think>`→`reasoning` 入站处理。前半段在格式化请求/响应时调用，确保骨架看到的内容已拆分。 |
| `registry/sse-codec-registry.ts` | 提供 `openai-chat` / `openai-responses` / `anthropic-messages` / `gemini-chat` 的 JSON↔SSE 编解码器，供 `provider-response` 层加载。 |
| `scripts/tests/loop-rt-*.mjs` | 各协议的最小 roundtrip（含 Gemini），由 `run-matrix-ci` 调用。 |

## 3. 协议模块对比

| 协议 | JSON→SSE 入口 | SSE→JSON 入口 | 特殊点 |
| --- | --- | --- | --- |
| OpenAI Chat | `json-to-sse/chat-json-to-sse-converter.ts` | `sse-to-json/chat-sse-to-json-converter.ts` | 支持角色 delta、tool call chunk、reasoning dispatcher |
| OpenAI Responses | `json-to-sse/responses-json-to-sse-converter.ts` + `responses-sequencer.ts` | `sse-to-json/responses-sse-to-json-converter.ts` | 输出 canonical `response.*` 事件，required_action + tool_outputs |
| Anthropic Messages | `json-to-sse/anthropic-json-to-sse-converter.ts` + `anthropic-sequencer.ts` | `sse-to-json/anthropic-sse-to-json-converter.ts` + builder | Content blocks（text/thinking/tool_use/tool_result）映射与 reasoning channel |
| Google Gemini | `json-to-sse/gemini-json-to-sse-converter.ts` + `gemini-sequencer.ts` | `sse-to-json/gemini-sse-to-json-converter.ts` + accumulator | 原生 `gemini.data`/`gemini.done` 事件，parts/functionCall/functionResponse 保留 |

## 4. Shared 骨架说明

1. **类型层（`types/`）**：所有 converter 只依赖统一的上下文和 event stats，这保证多协议共用 `writer.ts`/`parser.ts`。
2. **Sequencer / Builder 层**：Sequencer 负责把协议 JSON 映射为 canonical 事件流；Builder 将解析后的事件重新组合为协议 JSON。
3. **`writer.ts` + `serializers/`**：writer 了解 `StreamProtocol`，自动选择 Chat/Responses/Anthropic/Gemini 序列化器。新协议只需提供 `serialize*` 工具并在 writer 中注册即可。
4. **`sse-to-json/parsers/sse-parser.ts`**：支持四种协议事件类型；若未来新增协议，只需在 parser 中添加 event 类型和 `create*Event`。
   - 兼容提示：部分 OpenAI-compatible 上游（例如 LM Studio）可能省略 `event:` 行，仅在 `data` JSON 里提供 `type`；parser 会在严格校验开启时尝试用 `data.type` 推导事件类型（仅当其在 allowlist 中）。
5. **`registry/sse-codec-registry.ts`**：`convertProviderResponse` 通过此 registry 将 provider SSE 译回 JSON 或透传给客户端，是 provider 层的统一桥接点。

## 5. 测试与验证

| 测试脚本 | 说明 |
| --- | --- |
| `scripts/tests/loop-rt-chat.mjs` | Chat JSON→SSE→JSON roundtrip |
| `scripts/tests/loop-rt-gemini.mjs` | Gemini inbound smoke + Gemini SSE roundtrip |
| `scripts/tests/loop-rt-anthropic.mjs` | Anthropic roundtrip |
| `scripts/tests/loop-rt-responses.mjs` | Responses roundtrip |
| `scripts/tests/run-matrix-ci.mjs` | CI 总入口，会执行上述脚本并输出矩阵报告 |

确保任何协议改动后执行：`npm run build`（sharedmodule/llmswitch-core），它会顺带跑矩阵测试并生成 `test-results/matrix-ci-*.json`。

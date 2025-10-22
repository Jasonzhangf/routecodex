# LLM Switch 解耦方案（/v1/chat/completions、/v1/messages、/v1/responses）

## 背景

- 目前 `/v1/chat/completions`、`/v1/messages`、`/v1/responses` 统一走 `llmswitch-anthropic-openai`，会把原生 Chat 负载解构为 Responses 形态，导致 Chat 入口的 `messages` 丢失（GLM 返回 *Input cannot be empty*）。
- 必须恢复各入口独立的转换逻辑，避免不同协议互相影响，同时为 Responses 后续开发留出空间。

## 目标

1. **明确入口 → Switch 绑定**
   - `/v1/chat/completions` → `llmswitch-openai-openai`（仅做 OpenAI Chat 规范化，保持 `messages` 原样）。
   - `/v1/messages` → `llmswitch-anthropic-openai`（Anthropic↔OpenAI 双向转换）。
   - `/v1/responses` → `llmswitch-response-chat`（Responses↔Chat schema 对应）。
2. **流水线装配保留配置中的 Switch**，不再统一覆盖为 `llmswitch-anthropic-openai`。
3. **请求入口全链路可追踪**：在 `metadata` / `requestContext` 写入入口信息，方便响应阶段按原路径做逆向转换。
4. **每条通路独立落盘 Trace**：`~/.routecodex/codex-samples/{chat-replay,anth-replay,responses-replay}/…` 三个目录分别存储原始请求、转换结果、provider 响应、SSE 日志等。

## 实施步骤

1. Pipeline 组装 (`pipeline-assembler`)
   - 当合并配置含 `llmswitch-openai-openai` / `llmswitch-anthropic-openai` / `llmswitch-response-chat` 时，保持原值，不再 override。
   - 根据 routePool / endpoint 特征将对应的 Switch 挂载到流水线。
2. Handler 调整
   - ChatCompletionsHandler：检测到入口为 OpenAI Chat 时直接进入 Pipeline（必要时仅调用 `llmswitch-openai-openai` 做规范化），不再复用 `ResponsesToChatLLMSwitch`。
   - ResponsesHandler：继续使用 `llmswitch-response-chat` 完成 Responses ↔ Chat 的转换。
   - Anthropic Messages：保持使用 `llmswitch-anthropic-openai`。
3. 入/出站 Context 记录
   - 在请求 metadata 上标记 `entryEndpoint` / `entryProtocol`。
   - 响应阶段根据该标记选择正确的转换逻辑及输出格式。
4. Trace 落盘
   - 以入口划分文件夹，统一路径结构（raw-request / pre-pipeline / provider-response / sse-events 等）。
   - 日志中增加 `entry endpoint → switch` 信息，便于诊断。
5. 文档 & 配置
   - 更新 `config/*.json`、文档和 README 中的示例，说明三个入口的绑定关系与采集策略。

## 注意事项

- 解耦后才能继续推进 Responses 功能；在此之前先验证三个入口的基础功能是否恢复正常。
- 需要同步更新单元测试 / 集成测试覆盖新的 switch 绑定。
- 处理历史遗留 Trace 时注意目录变动，避免误判为“缺失记录”。


# ServerTool 框架设计草案

统一的 Server-Side Tool（ServerTool）框架，目标是用一套标准流程承载所有「由服务端执行的工具」：web_search、vision followup（图像模型 → 文本模型）以及未来的自定义工具。

## 核心流程（统一 5 步）

1. **注册 & 初始化**
   - 提供 `ServerToolRegistry`，在 llmswitch-core 初始化时注册各个工具 handler。
   - 通过配置（`virtualrouter.webSearch` 等）决定哪些工具启用、使用哪些后端引擎（providerKey / model / 参数）。

2. **命中条件 & 工具注入**
   - 请求阶段：由 Hub 的工具治理层根据分类结果和配置，完成：
     - 工具 **命名空间/名称规范化**（如统一 `web_search` 函数名）；
     - 工具 **强制注入**（force）或 **条件注入**（selective）到 tools 列表；
   - 响应阶段：从模型返回中统一抽取 `tool_call`（OpenAI style / Responses style），按 name 在注册表里匹配 ServerTool handler。

3. **工具调用拦截 & 执行**
   - 在 `runServerSideToolEngine()` 中：
     - 收集所有命中的 `tool_call`（支持多个工具、多个调用）。
     - 对每个 `tool_call` 调用对应的 ServerTool handler，由 handler 负责：
       - 解析 arguments；
       - 根据配置选择后端引擎（如 Gemini CLI、GLM）；
       - 通过 `providerInvoker` 调用后端 provider（HTTP + compat 已由 llmswitch-core/Host 处理）。

4. **执行结果归一化 & 虚拟 Tool 响应**
   - 每个 handler 返回统一结构：
     - 结构化结果 payload（如 web_search 的 `summary + hits[] + engine`）。
     - 与原始 `tool_call_id` 绑定的「虚拟工具消息」：
       ```jsonc
       {
         "role": "tool",
         "tool_call_id": "<原 tool_call.id>",
         "name": "<tool_name>",
         "content": "<JSON string or structured tokens>"
       }
       ```
   - ServerTool 框架负责把这些虚拟工具消息插入到 ChatEnvelope.messages 中，形成标准的「工具调用 + 工具结果」形态，供后续推理使用。

5. **二次请求（对客户端/主模型透明）**
   - 框架将更新后的 ChatEnvelope 交还给 Hub Pipeline：
     - 对 Responses 协议：作为「带 tool 结果的 responses 响应」，再经过 tool governance / finalize → 客户端看到的是已经融合工具结果的回答。
     - 对 Chat 协议：按 OpenAI 工具规范让主模型继续一轮对话（视为第二跳），调用对话/路由逻辑，但这一层对客户端和 provider runtime 透明。
   - 整个过程中，客户端仍然只看到一次 `/v1/responses` / `/v1/chat/completions` 请求，ServerTool 的所有调用和重放都封装在 llmswitch-core 内部。

## 模块划分

- `llmswitch-core/src/servertool/registry`（计划）
  - 负责 ServerTool handler 的注册与查找。
  - 提供按 tool name（如 `web_search`）查找 handler 的接口。

- `llmswitch-core/src/servertool/engine`（计划）
  - 替换/封装现有 `runServerSideToolEngine()` 的实现：
    - 统一抽取工具调用；
    - 调用 handler；
    - 注入虚拟 tool 消息；
    - 触发第二跳或返回更新后的 ChatEnvelope。

- `llmswitch-core/src/servertool/handlers/web_search`（计划）
  - web_search 的具体 handler：
    - 解析 `query/engine/recency/count`；
    - 根据 `virtualrouter.webSearch.engines` 选择后端引擎（Gemini CLI / GLM 等）；
    - 调后端 provider，解析返回结果，构造统一的搜索结果结构；
    - 返回绑定原始 tool_call_id 的虚拟 tool 消息。

后续 vision followup 等也会迁移为独立 handler，挂到同一框架上，尽量做到「ServerTool 框架 + 多个 handler」的统一模式。

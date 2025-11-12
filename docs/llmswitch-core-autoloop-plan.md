# llmswitch-core 透明工具代理执行（Autoloop）实施方案

目标：在 llmswitch-core 的 Chat 后半段（openai-chat/response-tools-stage）实现“工具代理执行 + 自动二轮请求”能力（对大模型透明），并提供可扩展的工具注册/执行框架与请求侧工具引导（广告）机制。

## 一、现状与重复性检查

- 已有（复用，不重复实现）
  - fetchRawHtml：`src/v2/tools/web-fetch-html.ts`，用于服务器侧抓取网页。
  - 工具响应抽取与规范化：`v2/conversion/openai-chat/response-tools-stage.ts`；目前会在开关开启时把抓取结果注入私有字段 `message.__server_tool_results`（仅诊断）。
  - 协议合成与 SSE：`v2/bridge/routecodex-adapter` + orchestrator + codecs（Anthropic/OpenAI/Responses）。

- 未有（本次新增）
  - Autoloop：劫持→执行→注入标准 tool_result→直接发起“第二轮请求”→返回与第一次端点一致的 SSE/JSON。
  - 可扩展工具代理框架：注册/匹配执行器（起步 web_fetch 家族）。
  - 请求侧工具引导（广告）：在 request-tools 阶段/Anthropic guidance 注入工具定义，支持策略：always/conditional。

## 二、总体设计

### 1. 劫持位置（Chat 后半段）
- 挂在 `openai-chat/response-tools-stage` 的末尾（工具响应抽取完成、未返回客户端）。
- 条件：`ROUTECODEX_SERVER_TOOLS=1` 且 `loopDepth<=1` 且命中受支持的工具（通过 registry 解析）。

### 2. 工具执行框架（core 内）
- 目录：`src/v2/tools/proxy/`
  - `types.ts`：ToolExecutor/ProxyPlan/ToolUseBlock/ToolResultBlock 类型
  - `registry.ts`：names→executor 注册与解析（去重与优先级）
  - `executors/web-fetch.ts`：复用 `fetchRawHtml`，裁剪内容长度，输出纯文本/HTML
  - `adapters/{anthropic|openai|responses}-second-round.ts`：按 entryEndpoint 构造第二轮 payload
  - `hijack-runner.ts`：协调“匹配→执行→构造第二轮 DTO→宿主回调→合成输出”

### 3. 第二轮请求发起（参考 CCR 透明模式）
- core 新增宿主回调（在 `routecodex-adapter` options 注入）：
  - `invokeSecondRound(secondReqDto, ctx) => Promise<{ data: any }>`
  - core 负责：执行器生成 `tool_result` 与第二轮 DTO；宿主负责：用 pipeline 执行 DTO 并回传 JSON；core 再用 codec 合成 SSE/JSON 返回。
- 端点一致：记录第一次 `entryEndpoint`，第二轮的 payload 与输出严格保持该端点形状（/v1/messages|/v1/chat/completions|/v1/responses）。

### 4. ID 一致性与回环保护
- 不额外生成 ID：
  - OpenAI Chat：使用 `tool_calls[].id`；第二轮注入 tool role 消息 `tool_call_id = id`。
  - Anthropic：使用 `tool_use.id`；第二轮注入 `tool_result.tool_use_id = id`。
- 回环保护：在 metadata 记录 `loopDepth`；autoloop 时 `+1`，超过 1 则不再劫持。

### 5. 请求侧“工具引导声明”（广告）
- 注入点：OpenAI 的 `request-tools-stage` 与 Anthropic 的 guidance/请求规范化阶段。
- 策略：
  - `always`：请求内只要存在任意工具，就追加代理工具定义（去重）
  - `conditional`：仅当命中某些工具名（可配置白名单）才追加
- 形状：
  - OpenAI：`tools[].type='function' + parameters JSON Schema`
  - Anthropic：`tools[].{ name, input_schema }`
- 注：广告仅声明工具，不强制执行；实际执行仍由响应劫持与模型的 tool 调用决定。

### 6. 配置与开关
- core 仅读取 `ROUTECODEX_SERVER_TOOLS=1|0`，由宿主按用户配置设置（唯一判断源）。
- 广告策略可放在宿主或 core 的 options 中（建议 options 传入，保持 core 通用）。

## 三、实施步骤

### 阶段1：最小清理
1) 从 `response-tools-stage` 去掉 `message.__server_tool_results` 注入（保留 Hook 快照）。
2) 发布 core 小版本（例如 0.2.98），RouteCodex 升依赖并 vendor（不改逻辑）。

### 阶段2：autoloop 与广告接入
3) 在 `response-tools-stage` 接入 HijackRunner（劫持→执行→二轮 DTO→宿主回调→合成输出）。
4) 在 `routecodex-adapter` 新增 `invokeSecondRound` 回调接口（默认 undefined 不启用）。
5) 在 `request-tools-stage/guidance` 接入工具广告（always/conditional，两模式）。
6) RouteCodex 仅在 `llmswitch-v2-adapters` 注入 `invokeSecondRound`，其内部通过 `pipelineManager.processRequest` 执行第二轮 DTO 后回传 JSON；不改 server/流水线。

## 四、验证与回退
- 验证：
  - Anthropic：第一轮出现 tool_use → 服务器执行 → 注入 tool_result → 第二轮流式返回；客户端不需要 submit_tool_outputs。
  - OpenAI Chat/Responses：按协议构造第二轮并返回对应 SSE/JSON。
- 回退：
  - 关开关或无匹配工具：不劫持，按原路输出。
  - 执行器失败：注入错误文本也可继续第二轮（或可配置直接回退，一阶段内先注入错误文本以明确失败原因）。

## 五、边界与不做的事
- core 不直接发 HTTP；统一通过宿主回调发起第二轮。
- 不在 server 端实现任何工具逻辑（已删除临时实现）。
- 不跨越职责边界（Provider/Compatibility 仅做自身工作）。


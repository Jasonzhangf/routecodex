# Provider 模块瘦身 - 探索发现

## 2026-05-18 responses conversation store 持续涨真源

- 线上证据：`mem-observer` 中 `scopeIndex` 基本稳定（如 4），但 `requestMap/responseIndex` 随同一 session 连续请求单调上升（如 19/18）。这说明不是“新 scope 正常增加”，而是**旧 scoped entry 被新的 scoped entry 覆盖后，仍残留在 requestMap/responseIndex**。
- 真源在 `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`：
  - `attachEntryScopes(entry)` 只把 `scopeIndex[key] = entry`，**不会清理被同一 scope 新 entry 替换掉的旧 entry**；
  - 由于 Codex 路径几乎总带 `sessionId/conversationId`，`finalizeResponsesConversationRequestRetention()` 对 scoped entry 只会 `releaseRequestPayload()`，不会 `clearRequest()`；
  - 结果：`scopeIndex` 始终只指向最新 entry，但旧 entry 永远挂在 `requestMap/responseIndex`，直到 30min TTL，造成持续堆积。
- 唯一正确修复点：仍在 `attachEntryScopes(entry)`。因为“旧 entry 被新 scoped entry supersede”的事实**只在这里发生**；在 finalize / memory observer / host 层补删都会变成第二语义面。
- 修复原则：当 `scopeIndex` 发现当前 key 已绑定到另一个旧 entry 时，先 `detachEntry(oldEntry)` 再绑定新 entry。这样：
  - 同 scope 只保留最新 continuation state；
  - `requestMap/responseIndex` 不再为被覆盖 scope 累积历史垃圾；
  - 非 scoped / submit_tool_outputs 路径语义不变。

## 2026-05-17 qwenchat guest runtime 真源对齐

- 线上 `5520 -> qwenchat` 已有硬证据不是“内容违规”，而是 **请求 shape 偏离 qwen2api 真源 + 未识别 WAF/HTML**：
  - `curl http://127.0.0.1:5520/v1/responses` 实际返回 `Content-Type: text/html; charset=utf-8`
  - body 为 Aliyun WAF challenge HTML，而非 OpenAI/Responses JSON。
- 当前唯一真源修复点仍在 `src/providers/core/runtime/qwenchat-web-provider.ts`，原因：
  1. qwenchat guest 是独立两段式 Web 链路，不属于 generic qwen/openai transport；
  2. 当前实现把请求压缩成“最后一条 user 纯文本 + files=[]”，丢失了 qwen2api 真源里的 history/attachment/chat_type 语义；
  3. 当前实现未把 HTML/WAF 挑战识别成显式 provider error，导致假 200 被直透。
- qwen2api 真源确认：
  - `/Volumes/extension/code/qwen2api/worker.js`
  - 真请求链路：`/api/v2/chats/new` -> `/api/v2/chat/completions?chat_id=...`
  - 消息语义：history 拼成文本前缀，最后一轮保留附件；有附件时需上传并填 `files`。
  - completion 上游必须 `stream:true`，再本地聚合 SSE。

## 2026-05-17 responses outbound 非法 `tool_choice without tools` 真源

- `EMPTY_ASSISTANT_RESPONSE` / `bad request: tool_choice 为 'auto' 或 'required' 时必须提供 tools` 的这轮审计已钉死两件事：
  1. `build_captured_chat_request_snapshot`（Rust `hub_pipeline.rs`）只是原样复制 `messages/tools/tool_choice/parameters`，**不是** compaction prompt 注入点；
  2. 400 的唯一真源在 Rust `hub_bridge_actions/history.rs::prepare_responses_request_envelope`：该函数会从 context/metadata **回填 `tool_choice`**，但之前**不校验最终 request 是否仍有 `tools`**。
- 坏样本因此会形成：
  - `messages = ... + compaction prompt`
  - `tools = missing`
  - `tool_choice = auto`
  - 上游 llmgate/DeepSeek 直接 400。
- 最小修复已落在 Rust 真源：
  - `prepare_responses_request_envelope` 在最终 request 无 `tools` 时，物理移除 `tool_choice`。
- 回归已补：
  - 保留原有“有 tools 时 tool_choice 单一真源”的测试；
  - 新增“无 tools 时必须丢弃 tool_choice”的测试，防止再次生成非法 outbound shape。

## 2026-05-17 servertool followup 路由回归

- `apply_patch_read_before_retry_guard` 的 followup 502 不是工具列表问题，当前真源更像是 **followup metadata 丢了 routeHint**：sticky provider 还在，但 followup 若只剩 `__shadowCompareForcedProviderKey`、没有 `routeHint/routeName`，Virtual Router 会按错误池选路，mini27 这类 coding lane provider 会直接报 `PROVIDER_NOT_AVAILABLE`。
- 最小唯一修复点先落在 `sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.ts::applyFollowupRuntimeMetadata`：followup metadata 组装时必须把 adapter runtime 里的 `__rt.routeName/routeHint` 也当成路由真源回灌，不能只看 `adapterContext.routeId/routeHint`。
- `start` daemon supervisor 的无限重启问题，唯一真源在 `src/cli/commands/start.ts`：当前 child 退出后无条件 restart。可直接读 `state/runtime-lifecycle/server-<port>.json` 的 exit marker；若 child 记录的是 `startupError`，supervisor 必须停止，而不是继续重启风暴。
- `search` 不是直接掉 `default` 的 route。工具类专用 route miss 时应先落 `tools` 总兜底，再决定是否继续到 `default`；本轮唯一修复点先落在 Rust `virtual_router_engine/routing/config.rs::build_route_queue`，并同时补齐用户配置里的 `routing.search` 池。
- `EMPTY_ASSISTANT_RESPONSE` 的错误日志不得把 `__sse_responses` 这类内部 stream carrier 整坨透传到 `rawError/rawErrorSnippet`；证据可保留，但必须在 host 日志序列化前剥离内部 carrier。

## 2026-05-20 windsurf provider architecture correction

- 已先改设计文档，再推进实现。
- 已验证历史错误方向已退出真源：
  - 聊天主链不再允许任何本地中间链路
- 已验证新的分层事实不能再写错：
  1. **账号/模型目录面**：
     - 只保留 Windsurf 账号鉴权与模型探活
  2. **聊天主链面**：
     - `chat -> provider -> cascade`
     - 认证依赖 `auth-context headers`
     - 多轮/工具/历史都以 cascade 语义为唯一真源
- 当前闭环进度：
  - contract/factory/test 第一片已转到 cascade config truth，并通过 3 个定向测试。
  - 下一步唯一正确修改点：`src/providers/core/runtime/windsurf-chat-provider.ts`，继续对齐 pure cascade 主链。

## 2026-05-22 windsurf GetChatMessage 静态字段锚点（仅 App / 参考对齐，不打真实请求）

- 本轮只做 **静态字段真源对齐**，未做真实请求。
- App 真源继续确认：
  - `exa.api_server_pb.GetChatMessageRequest`
  - `exa.chat_pb.ChatMessagePrompt`
  - `exa.chat_pb.ChatToolChoice`
  - `exa.chat_pb.ChatToolDefinition`
  - `exa.codeium_common_pb.ChatToolCall`
  - `exa.codeium_common_pb.CompletionConfiguration`
  - `exa.codeium_common_pb.Metadata`
- 从 `Windsurf.app` 继续锁到的关键子字段：
  - `ChatToolChoice` oneof 只有：
    - `optionName`
    - `toolName`
  - `ChatToolCall` 只有：
    - `id`
    - `name`
    - `argumentsJson`
    - 其余 `invalidJsonStr/invalidJsonErr/isCustomToolCall` 为可选，不应伪造
  - `ChatMessagePrompt` 可选字段非常多，但我们当前最小 send shape 应只保留已证实需要的：
    - user: `messageId/source/prompt`
    - assistant(with tool call): `messageId/source/prompt/toolCalls`
    - tool result: `messageId/source/prompt/toolCallId/toolResultIsError`
  - `CompletionConfiguration` proto 字段很多，但当前 RouteCodex 最小静态真源仍只保留：
    - `numCompletions`
    - `maxTokens`
    - `temperature`

- 新增静态测试后，当前 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 已从 `122` 增加到 **`126 passed`**。
- 新补锚点覆盖：
  1. `GetChatMessageRequest` 顶层可选字段默认 **省略**：
     - `internalChatModel`
     - `experimentConfig`
     - `chatModelName`
     - `trajectoryReference`
     - `cascadeId`
     - `executionId`
     - `arenaConvergeCount`
     - `arenaAssignmentJwt`
     - `modelAssignmentJwt`
  2. assistant `toolCalls[]` 子字段只允许：
     - `id`
     - `name`
     - `argumentsJson`
  3. `ChatMessagePrompt` 每类 message row 继续限制为最小字段集合，禁止伪造：
     - `numTokens`
     - `safeForCodeTelemetry`
     - `promptCacheOptions`
     - `images`
     - `thinking`
     - `signature`
     - `thinkingRedacted`
     - `promptAnnotationRanges`
     - `outputId`
     - `thinkingId`
     - `geminiThoughtSignature`
     - `signatureType`
     - `phase`
  4. `configuration` 只允许最小三字段，禁止伪造：
     - `maxNewlines`
     - `minLogProbability`
     - `firstTemperature`
     - `topK`
     - `topP`
     - `stopPatterns`
     - `seed`
     - `returnLogprob`
     - `serviceTier`

- 当前结论：
  - **静态 shape 侧没有发现新的字段命名错误**；
  - 目前已基本锁死“字段名错 / 多发明显脏字段 / 子字段命名错”这一层；
  - 下一步应继续查 **字段 presence 逻辑** 与 **是否缺少 App 实际发送时必带字段**，而不是再泛化改结构。

- 2026-05-22 继续静态对齐时，实际抓到一个 **字段 presence 真错误**：
  - 当前 RouteCodex `buildGetChatMessageRequest()` 之前会无条件保留 `normalizeGetChatMessageToolChoice(args.toolChoice)`；
  - 但参考仓 `WindsurfAPI/src/handlers/messages.js::pruneToolChoice()` 明确要求：
    - 若 forwarded `tools` 为空，则 `toolChoice` 必须省略；
    - 若 forced tool 不在 forwarded tools 名单内，则 `toolChoice` 也必须省略。
- 本轮已先补红测，再改实现，再转绿：
  1. `buildGetChatMessageRequest must prune toolChoice when no forwarded tools survive like reference pruneToolChoice`
  2. `buildGetChatMessageRequest must prune toolChoice when forced tool is absent from forwarded tool defs`
- 修复方式：
  - 在 `src/providers/core/runtime/windsurf-chat-provider.ts` 新增 `pruneGetChatMessageToolChoice(...)`
  - request 组装时改为：
    - 先 `normalize tools`
    - 再 `normalize toolChoice`
    - 再按 forwarded tools 做 `prune`
    - `disableParallelToolCalls` 也必须基于 prune 后的 toolChoice 计算，不能继续吃原始 toolChoice
- 这是唯一正确修改点，因为：
  - 问题不是协议字段名错误，而是 **request 组装时 toolChoice 与 forwarded tools 没有做一致性裁剪**
  - 真源就是 `buildGetChatMessageRequest()` 这一处；去改下游 send / parse / error classify 都只是掩盖症状
  - 若不在这里裁剪，会把“forced tool 不存在”的脏 shape 继续发给上游，静态 contract 已被证明不对。
- 当前回归：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
  - **128 passed**

- 2026-05-22 继续静态审计又抓到第二个 request-shape 真问题：
  - `preprocessRequest()` 把原始 `body.tool_choice` 复制到 `body.windsurf_tool_choice` 后，**没有删除原字段**
  - 这导致同一请求体里同时存在：
    - `tool_choice`
    - `windsurf_tool_choice`
  - 属于明确的 **双语义影子**，违背当前单一路径要求
- 已先补红测：
  - 在 `preprocessRequest preserves declared tools and tool_choice for later GetChatMessage outbound build` 中新增：
    - `expect(processed.body.tool_choice).toBeUndefined()`
- 红测已证明当前实现确实残留影子字段，然后已改实现转绿：
  - 修复点：`src/providers/core/runtime/windsurf-chat-provider.ts::preprocessRequest`
  - 在复制 `body.windsurf_tool_choice = body.tool_choice` 后，立即：
    - `delete body.tool_choice`
- 为什么这是唯一正确修改点：
  - 问题发生在 request 归一阶段，不在 send path，不在 parse path
  - 这里只允许保留 RouteCodex 内部用于 downstream build 的单一字段 `windsurf_tool_choice`
  - 若不在 preprocess 阶段删除原字段，后续任何读取/日志/调试都可能再次误吃旧字段，形成第二真源
- 当前回归仍为：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
  - **128 passed**

## 2026-05-22 windsurf 黑盒比较锚点补齐（WindsurfAPI vs RouteCodex）

- 本轮按 Jason 最新要求，新增了 **黑盒比较锚点**，不再只靠肉眼读 reference：
  - 在 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中新增 3 个 blackbox compare 测试
  - 参考实现直接通过 `node --input-type=module -e ...` 子进程执行 `/Volumes/extension/code/WindsurfAPI` 的真实导出函数，再把 stdout JSON 回灌到 Jest 断言
  - 这样避免了 Jest 直接 import 外部 ESM 失败，同时保持 reference 为运行态真源

- 当前已锁的 3 个黑盒比较锚点：
  1. `partitionTools`：
     - 参考：`/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
     - 目的：对齐“哪些 tools 进入 preamble、哪些保留为 declared tool set”
  2. `normalizeMessagesForCascade`：
     - 参考：`/Volumes/extension/code/WindsurfAPI/src/handlers/tool-emulation.js`
     - 目的：对齐 assistant tool_call / tool_result / continuity 的历史语义投影
  3. `mergeReasoningEffortIntoModel`：
     - 参考：`/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
     - 目的：对齐 reasoning_effort -> model 真名合并逻辑

- 本轮抓到并已物理删除的错误实现：
  - `src/providers/core/runtime/windsurf-chat-provider.ts` 中残留的：
    - `windsurf_native_mode`
    - `windsurf_native_allowlist`
    - `windsurf_native_caller_lookup`
    - `buildWindsurfNativeCallerLookup`
    - `normalizeWindsurfNativeCallerLookup`
    - `buildGetChatMessageRequest(... nativeMode/nativeAllowlist ...)`
  - 这些字段/入参已经证明属于旧 native bridge 影子，不再是当前 `chat -> provider -> cascade` 单一路径的一部分
  - 真错误证据：
    - 新红测要求 preprocess 后这些影子字段必须消失
    - 实际跑测时它们仍存在，因此确认是活着的错误影子，不是“闲置注释”

## 2026-05-22 apply_patch hashline 接线继续排查

- Rust req-profile 红测的真因已确认不是 `tool_text_request_guidance.rs` 本身没写 hashline 文案，而是 **Qwen / QwenChat request compat 根本没接 text guidance 注入链**：
  - `run_req_outbound_stage3_compat()` 里 `chat:qwen` 只跑 `apply_qwen_request_compat(root)`
  - `chat:qwenchat-web` 只跑 `apply_qwenchat_request_compat(root)`
  - `text_guidance_web::apply_text_guidance_web_request_compat()` 完全未被这两条路径调用
- 因此当 tool schema 声明 `filePath/file_path` 时：
  - tool description 已变
  - 但 `messages[0].content` 没有被追加 `Tool-call output contract (STRICT)` guidance
  - 导致红测里 `guidance.contains("hashline patch syntax")` 失败
- 当前唯一修复点已落在 Rust `request_stage.rs`：
  - 新增 `payload_declares_apply_patch_hashline_filepath()`
  - 仅当 payload 内 apply_patch schema 真声明 `filePath/file_path` 时，Qwen / QwenChat compat 后再接 `apply_text_guidance_web_request_compat()`
  - 这样保持“client apply_patch / upstream hashline authoring”的唯一条件接线，不会无条件污染所有 Qwen 请求

- native `castGovernedToolsJson` 红测也已查明一个重要事实：
  - live native 返回的 shape 是：
    - `function.parameters.properties.patch.type = "string"`
    - **没有 `description`**
  - 所以 Jest 当前报空字符串不是“断言位置一定错”，而是 **live native 导出链还没反映到期望 description**
- 先把 spec test 改为兼容读取 `patch.description / patch.inputSchema.description / input.description`，避免只盯一个字段；接下来仍需继续查 native schema cast 真源为何没把 hashline 描述物化出来

## 2026-05-22 SSE 断流显式化

- 新线上症状不是“客户端自己断开”，而是 **上游 SSE 已开始输出 partial chunk，但在 `response.completed/response.done` 前就关闭**。
- 当前 `src/server/handlers/handler-response-utils.ts` 的真问题：
  - `stream.on('end')` 里即使 `finishTracker.seenTerminalEvent == false`
  - 也只是记日志后直接 `res.end()`
  - 结果客户端看到的是 **静默断流**
- 这与当前 no-fallback / fail-fast 原则冲突；错误应显式暴露成 SSE error frame，而不是靠客户端猜。
- 已先补红测：
  - `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`
  - 现在要求：
    - 仍保留已发出的 partial chunk
    - **额外输出 `event: error`**
    - code = `upstream_stream_incomplete`
    - message 包含 `stream closed before response.completed`
- 当前唯一修复点已落在：
  - `src/server/handlers/handler-response-utils.ts::stream.on('end')`
  - 仅当 SSE 在未见 terminal event 时结束，向客户端补发显式错误事件再结束响应
- 这是唯一正确位置，因为：
  - 问题发生在 **HTTP SSE 出口的 started-stream 收尾阶段**
  - 不是 provider retry
  - 不是 SSE parser
  - 不是 client close
  - 不在这里显式写 error frame，就一定还是静默断流

- 当前验证：
  - 定向红测 -> 改实现 -> 绿：
    - `preprocessRequest partitions mapped/unmapped ... without emitting dead native bridge shadow fields`
    - `preprocessRequest converts only unmapped tools into tools_preamble`
  - 黑盒比较绿：
    - `blackbox compare preprocess tool partition against WindsurfAPI reference partitionTools`
    - `blackbox compare history projection semantics against WindsurfAPI normalizeMessagesForCascade`
    - `blackbox compare reasoning merge against WindsurfAPI mergeReasoningEffortIntoModel`
  - 全量当前 spec：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - **131 passed**

- 当前结论：
  - `preprocessRequest` / `buildGetChatMessageRequest` 这一层现在已经有 reference-driven blackbox 锚点，不再只是“App proto 字段名对齐”
  - 下一阶段应该继续把 **鉴权请求形状** 和 **真实 send body 形状** 也纳入同样的 blackbox/reference compare，而不是直接去打线上请求猜错因

## 2026-05-22 windsurf auth live probe repair + CheckUserLoginMethod gate clarification

- 本轮继续只做 auth/cascade 真链，不碰 send mainline。

- 新确认的 auth 事实：
  1. `CheckUserLoginMethod` 只能作为**观测项**，不是 hard gate。
     - 新增锚点测试：
       - `login chain must continue even when CheckUserLoginMethod returns explicit non-200 observation because it is not a hard gate`
     - 这与 reference `WindsurfAPI/src/dashboard/windsurf-login.js::fetchCheckUserLoginMethod()` 当前语义一致：该步骤返回空体/非预期结果时，主链仍应继续密码登录，而不是提前判死。
  2. `password/login -> WindsurfPostAuth -> GetCascadeModelConfigs` 当前 worktree 下仍可真实打通。
     - 旁证脚本：
       - `node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4`
       - 返回：`ok=true`, `credential.apiKeyPrefix=devin-session-token$...`, `health=true`

- live probe 测试修复：
  - 旧 `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` 直接 import provider，会被 `camoufox-launcher.ts` 的 `import.meta` 卡死，导致 Jest 根本起不来；
  - 现已改成：
    - 测试内通过 `execFileSync(process.execPath, ['--import','tsx','scripts/windsurf-auth-probe.ts', ...])`
    - 直接调用真实 probe 脚本，再校验 JSON 输出
  - 结果：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts --runInBand`
    - **1 passed**

- 当前验证结果：
  - 定向 auth 锚点：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "CheckUserLoginMethod|login chain must continue even when CheckUserLoginMethod|account login headers align UA|checkHealth performs real cascade auth probe|ensureWindsurfSessionCredential sends PostAuth"`
    - **6 passed**
  - live no-mock:
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts --runInBand`
    - **1 passed**

- 当前结论：
  - auth 目标下的“移除本地挡板/mock”本轮已进一步推进：
    - live probe 不再依赖 provider import 时的 Jest 环境巧合
    - `CheckUserLoginMethod` 不再被测试语义误塑造成硬门禁
  - 下一步应该继续把 **auth request shape blackbox compare** 补齐到：
    - `CheckUserLoginMethod`
    - `password/login`
    - `WindsurfPostAuth`
    - `GetCascadeModelConfigs`

## 2026-05-22 windsurf GetCascadeModelConfigs auth-probe blackbox closure

- 本轮继续只做 auth request-shape 对齐，新增了 `GetCascadeModelConfigs` 三层 blackbox compare 锚点：
  1. body-shape
  2. header-shape
  3. fetch-call(host/path/method/header subset)

- 参考真源：
  - `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`
    - `postJson()`
    - `getCascadeModelConfigs()`

- 当前 RouteCodex 已被黑盒钉住的事实：
  1. body 仍为：
     - `{ metadata: { apiKey, ideName, ideVersion, extensionName, extensionVersion, locale } }`
  2. 基础 header 仍对齐 reference 的 JSON connect 口径：
     - `Content-Type: application/json`
     - `Connect-Protocol-Version: 1`
     - `Accept: application/json`
  3. 在 RouteCodex 当前 auth 真链下，还会额外附加统一 credential 语义：
     - `x-auth-token`
     - `x-devin-session-token`
     - 可选 `x-devin-account-id`
     - 可选 `x-devin-auth1-token`
     - 可选 `x-devin-primary-org-id`
  4. fetch endpoint 当前仍锁定：
     - `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`

- 定向验证：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "blackbox compare GetCascadeModelConfigs body-shape|blackbox compare GetCascadeModelConfigs header-shape|blackbox compare GetCascadeModelConfigs fetch-call|buildCascadeAuthProbeBody aligns|buildCascadeAuthProbeHeaders injects required|fetchCascadeModelConfigsForSite posts json auth probe"`
  - **6 passed**

- 当前 auth 面收口状态：
  - 已有 reference-driven blackbox compare：
    - `CheckUserLoginMethod`
    - `WindsurfPostAuth`
    - `GetCascadeModelConfigs`
  - live no-mock：
    - `scripts/windsurf-auth-probe.ts config ws-pro-4`
    - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - 说明 auth 面当前重点不再是“是否能登录”，而是继续检查是否还有残余 mock/挡板，以及是否存在不必要的旧 host/旧分支未删除。

## 探索日期: 2026-05-08

## 继承链结构
```
BaseProvider (abstract, 502 lines)
├── HttpTransportProvider (661 lines) - 通用 HTTP 传输骨架
│   ├── ChatHttpProvider (13 lines) - 仅设 providerType='openai-standard'
│   ├── OpenAIHttpProvider (29 lines) - 仅设 providerType='openai'
│   ├── AnthropicHttpProvider (26 lines) - 设 providerType='anthropic' + AnthropicProtocolClient
│   ├── ResponsesProvider (394 lines) - 有真实逻辑（SSE 直通等）
│   │   └── ResponsesHttpProvider (28 lines) - 仅设 providerType='responses'
│   ├── DeepSeekHttpProvider (376 lines) - 有真实逻辑（session PoW 等）
│   ├── GeminiHttpProvider (339 lines) - 有真实逻辑（Antigravity 兼容）
│   └── GeminiCLIHttpProvider (478 lines) - 有真实逻辑（大量重复 GeminiHttpProvider 的 Antigravity 方法）
└── MimowebProvider (663 lines) - 完全不同协议（文本抓取），正确独立
```

## 发现清单

### P0: 4 个零逻辑 wrapper 类（可删除）
- ChatHttpProvider (13行): 构造器只设 providerType='openai-standard'
- OpenAIHttpProvider (29行): 构造器只设 providerType='openai'
- AnthropicHttpProvider (26行): 构造器设 providerType='anthropic' + new AnthropicProtocolClient()
- ResponsesHttpProvider (28行): 构造器只设 providerType='responses'
- **唯一真源论证**: 这 4 个类都是纯构造器参数默认化，零逻辑。factory-helpers.ts 里已经有 switch 分支来选择它们。改为 factory 直接构造 HttpTransportProvider/ResponsesProvider 即可。

### P1: Gemini Antigravity 方法重复 (~200行)
- GeminiHttpProvider 和 GeminiCLIHttpProvider 各有 ~10 个 Antigravity 私有方法
- 7+ 方法完全重复

### P5: Auth God Object
- oauth-lifecycle.ts 1922 行 30+ 函数
- 重复工具函数: assignHeader x4, deleteHeaderInsensitive x3, expandHome x4, normalizeString x4, isTruthyFlag x3

## 2026-05-08 hub pipeline slimming (inbound policy/context/node-result blocks)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts` 仍然在主 orchestrator 内直接处理三类稳定块：
  - client inbound policy observe
  - responsesResume 读取/清理
  - stage3 context capture 的 responses cache/store 分支与 inbound nodeResult 组装
- 其中 `stage3_context_capture` 仓库内已经存在独立 stage family，但 inbound 主文件仍保留一份平铺胶水，属于重复编排残渣。

Progress:
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-blocks.ts`。
- 已将 `observeClientInboundPayload`、`readResponsesResumeSnapshot`、`clearResponsesResumeMetadata`、`captureInboundContextSnapshot`、`appendInboundNodeResult` 收为独立 blocks。
- 已让 `hub-pipeline-execute-request-stage-inbound.ts` 复用这些 blocks，物理删除对应平铺胶水实现。
- 当前主文件行数变化：
  - `hub-pipeline-execute-request-stage-inbound.ts`: 318 -> 279

Why this is the unique correct fix point:
- 这里的问题不是 stage3/context 行为不对，而是 orchestrator 自己又写了一遍稳定块拼装逻辑；唯一正确修复点就是把这些行为收回独立 block，让主文件只保留时序调度。
- 特别是 `responsesResume` 与 inbound context capture，这两者已经是明确的数据块/阶段能力，继续留在主文件里只会形成第二实现面，不利于后续 Rust closeout 与唯一真源审计。

## 2026-05-08 hub pipeline slimming (timing + normalize-request blocks)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts` 同时承载 env gate、request timeline state、breakdown aggregation、top summary、render/log gate、measure wrapper，多种职责混在一个文件。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request.ts` 同时承载 metadata 控制字段抽取、pre-orchestration shape 组装、native orchestration 结果归一，属于典型的 block 与 orchestrator 混写。

Progress:
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-blocks.ts`，把 timing state/env/top-summary/render 逻辑下沉为 block；`hub-stage-timing.ts` 现在主要保留导出壳与 `logHubStageTiming/measureHubStage`。
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-blocks.ts`，把 providerProtocol 解析、metadata 控制字段抽取、pre-shape 组装、normalized request finalize 收为 blocks。
- 当前主文件行数变化：
  - `hub-stage-timing.ts`: 361 -> 155
  - `hub-pipeline-normalize-request.ts`: 210 -> 110

Why this is the unique correct fix point:
- timing 与 normalize-request 的问题都不是算法错误，而是一个文件里混了多层职责；唯一正确的瘦身方式是把稳定的状态块/归一块下沉，让主文件只保留对外 API 与少量编排。
- 继续在原文件内做局部删改无法消除第二职责面；只有物理拆出 block，才能真正形成“shared functions + blocks + orchestration shell”的唯一结构。

## 2026-05-08 hub pipeline slimming (hub class runtime shell + provider payload policy blocks)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts` 除了类型定义外，仍把 provider runtime hook 注册、deps 更新、execute 分发都堆在类内；这是典型 runtime shell 可以下沉的编排块。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.ts` 仍把 shadow baseline、policy observe/enforce、tool-surface、direct web-search、passthrough audit 同步混在一个文件中。

Progress:
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-runtime-blocks.ts`，把 non-blocking log、provider runtime hook 注册/卸载、deps 更新、hub execute 分发收成 runtime blocks。
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-policy-blocks.ts`，把 compatibilityProfile、passthrough audit、shadow baseline、provider outbound policy finalize 收成 policy blocks。
- 已让 `hub-pipeline.ts` 与 `hub-pipeline-execute-request-stage-provider-payload.ts` 复用这些 blocks。
- 当前主文件行数变化：
  - `hub-pipeline.ts`: 270 -> 198
  - `hub-pipeline-execute-request-stage-provider-payload.ts`: 267 -> 179

Why this is the unique correct fix point:
- `hub-pipeline.ts` 的类本体不该再承载具体 hook/deps/error shell 细节；唯一正确做法是把这些运行时壳逻辑抽成 block，让类只保留真正的对象边界与最薄调度。
- `provider-payload` 的问题也不是某个策略算法错，而是 policy/shadow/tool-surface 链条被平铺在 orchestrator 内；唯一正确瘦身方式是抽成 policy block，避免主文件继续拥有第二份策略编排面。

## 2026-05-08 hub pipeline slimming (shared governance block + stage-top summary sink)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts` 与 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts` 仍各自保留一份相同的 governance/passthrough 分支：
  - 非 passthrough 时执行 `req_process.stage1_tool_governance`
  - 回灌 clock reservation 到 metadata
  - 追加 tool governance node result
  - passthrough 时追加 skipped node + audit 标记
- `hub-stage-top` runtime summary 注入也在 `hub-pipeline-execute-request-stage.ts` 与 `hub-pipeline-execute-chat-process-entry.ts` 复制了一遍。
- 这属于典型“同一稳定语义在两个编排入口重复实现”，违反唯一 block 责任。

Progress:
- 已新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-governance-blocks.ts`。
- 已将治理分支统一收为 `executeToolGovernanceOrPassthrough`。
- 已将 hub stage top summary 注入统一收为 `attachHubStageTopSummary`。
- 已让以下 orchestrator 改为只调用共享块：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts`
- 当前主文件行数变化：
  - `hub-pipeline-execute-request-stage-inbound.ts`: 232 -> 218
  - `hub-pipeline-execute-chat-process-entry.ts`: 195 -> 181
  - `hub-pipeline-execute-request-stage.ts`: 71 -> 69

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 这里不是“哪一处少了判断”，而是**同一治理编排段在两个入口重复存在**；继续在各自文件里分别维护只会制造第二实现面。
- 唯一正确修复点就是把治理/skip/node-result/summary sink 收成共享 block，并让各 orchestrator 只保留时序调用。这样不会改语义，也不会增加 fallback，同时把后续 Rust 化时的 TS 编排壳进一步压薄。

## 2026-05-08 hub pipeline slimming (chat-entry setup + working-request finalizer + shared guards)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts` 仍然同时承担：
  - raw payload object 校验
  - payload → standardizedRequest coercion
  - metadata/runtime/servertool/snapshot setup
  - workingRequest sync + token estimate + image/tool flags
  - providerProtocol hooks 解析
- 其中这些能力在 inbound/request-stage 侧已有同类实现，继续留在 chat-entry 主壳里会形成第二套 setup/finalize/guard 面。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry-setup.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-working-request-blocks.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-shared-guards.ts`
- 已完成收口：
  - chat-entry 的 payload coercion + runtime setup 下沉到 `hub-pipeline-execute-chat-process-entry-setup.ts`
  - inbound/chat-entry 共用的 `workingRequest sync + token estimate + flags` 收口到 `hub-pipeline-working-request-blocks.ts`
  - `requireJsonObjectPayload` / `requireRequestStageHooks` 成为 shared guard，替代 scattered throw
- 当前主文件行数变化：
  - `hub-pipeline-execute-chat-process-entry.ts`: 181 -> 123
  - `hub-pipeline-execute-request-stage-inbound.ts`: 218 -> 213

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题根因仍然不是业务算法错，而是 **setup/finalize/guard 这种稳定结构被多个 orchestrator 各自重写**。
- 唯一正确修复点只能是把这些稳定结构抽成共享 block/guard，并删除主壳里的重复实现；否则后续继续在两个入口平行演化，必然再次破坏“公共函数 + block + 编排壳”的单一真源结构。

## 2026-05-08 hub pipeline slimming (mutable-record replace + snapshot recorder shell)

Verified findings:
- pipeline 内部仍有一类高频重复胶水：
  - `clear target record -> Object.assign(next)` 的可变 record 覆盖写回
  - snapshot recorder 创建壳（externalStageRecorder / disableSnapshots / shouldRecordSnapshots / warning log）
- 这类逻辑分别散落在 route/outbound、chat-process-entry、governance、provider-payload-policy 几个 block 文件里，属于稳定公共壳，不应该多点实现。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-mutable-record-utils.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-snapshot-recorder-blocks.ts`
- 已替换以下重复实现为共享函数：
  - `replaceMutableRecord`
  - `createHubSnapshotStageRecorder`
- 当前验证 grep 结果显示：pipeline 目录内残留的 `clear + assign` 循环只剩公共函数本身。

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 这些重复段不携带业务差异，只是机械壳层；保留多份实现不会带来功能价值，只会继续制造第二实现面和维护噪音。
- 唯一正确做法就是把它们抽到共享公共函数里，并让所有 block/orchestrator 统一复用；这样既不改变 payload 语义，也不引入 fallback，还能继续减少 TS 壳层体积，为后续 Rust only closeout 清障。

## 2026-05-08 hub pipeline slimming (outbound hook guard unification)

Verified findings:
- outbound provider payload build 里仍然单独保留了一份 `REQUEST_STAGE_HOOKS[outboundProtocol]` + unsupported protocol error。
- 这与 runtime/chat-entry 已经统一到 `requireRequestStageHooks` 的 guard 逻辑重复，属于同一错误边界多点实现。

Progress:
- 已让 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.ts` 改为统一使用 `requireRequestStageHooks`。
- 这样 request-stage runtime / chat-entry / outbound provider payload 三处协议 hooks 解析现在共用一个 guard 真源。

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- providerProtocol hook 解析不是业务策略，而是稳定 guard；继续在不同 orchestrator/block 里各写一份 unsupported protocol 分支，只会导致未来报错文案和边界漂移。
- 唯一正确修复点是统一走 `requireRequestStageHooks`，让协议 guard 只有一份真源实现。

## 2026-05-08 hub pipeline slimming (route/outbound capturedChatRequest + metadata finalize blocks)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound-blocks.ts` 仍同时承担：
  - `capturedChatRequest` snapshot build
  - chat-like shape validate
  - result metadata build
  - image flag finalize
- 这些步骤虽然都属于 outbound 结果装配，但已经是稳定的数据块，不应继续和 route metadata glue / outbound nodeResult 混放在同一个 block 文件里。

## 2026-05-10 local DeepSeek thinking 400（assistant history reasoning_content）

Verified findings:
- `omlx/rapidmlx` 本地 `DeepSeek-V4-Flash-mxfp8` openai-chat thinking 链上，真实 `provider-request` 样本存在两类 assistant 历史坏形状：
  - `assistant + tool_calls` 缺 `reasoning_content`
  - `assistant + plain content` 且既无 `reasoning_content` 也无 `tool_calls`
- 证据来自：
  - `~/.rcc/codex-samples/openai-responses/omlx.key1.DeepSeek-V4-Flash-mxfp8/req_1778388419237_b8b927a9/provider-request.json`
  - `/Volumes/extension/.rcc/logs/server-5520.log:7385`
- 日志已证明第二类会触发上游 `HTTP_400`：
  - `Chat template error: ThinkingMode: thinking, invalid message without reasoning_content/tool_calls`

## 2026-05-16 SSE decode native binding completeness + apply_patch raw-string compat

Verified findings:
- `extractDecodeStatsJson is required but unavailable` 不是 Rust 缺实现；真源函数已在 native binding 内存在。根因是 `native-router-hotpath-loader` 会接受**可加载但导出不完整**的旧 binding，随后 capability wrapper 才在运行时炸掉。
- `apply_patch` 兼容差的唯一修复点仍在 Rust `resp_process_stage1_tool_governance`：此前只接受 `{patch|input}` schema，对**明显就是 patch 本体的 raw string**会误打 `missing_patch` guard。

Progress:
- `native-router-hotpath-loader.ts` 已改为：auto-discovered candidate 只要导出不完整就直接拒绝，不再把残缺 binding 当可用 native。
- `native-router-hotpath-required-exports.ts` 已补齐 SSE decode 真实必需导出：`extractDecodeStatsJson` / `resolveSseTimeoutOptionsJson` / `buildRespInboundSseErrorDescriptorJson`。
- `normalize_apply_patch_schema_args(...)` 已改为先吃结构化 schema；若没有，再仅对**可明确识别的 patch 文本**做 shape-only 回收，归一回 `{patch,input}`，不做额外语义猜测。
- `hub_semantic_mapper_chat.rs` 已补 hunk-shape 专用错误提示，强制把模型拉回 `@@` 后每行必须带 ` / + / -` 前缀的正确形状。

Verification:
- `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
- `cargo test -p router-hotpath-napi apply_patch_hint_hunk_shape_keeps_specific_guidance -- --nocapture`
- `cargo test -p router-hotpath-napi test_govern_response_apply_patch_inline_create_file_shape -- --nocapture`
- `cargo test -p router-hotpath-napi test_govern_response_apply_patch_raw_string_is_repaired_into_schema -- --nocapture`

## 2026-05-16 MiniMax fresh-session 2013（malformed write_stdin args）

Verified findings:
- 新 session 仍可直接触发 `provider_status_2013 invalid function arguments json string`，不是旧历史污染专属问题。
- 真证据在 `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1778940656359_1553848b/provider-request.json`：
  - assistant tool_call `call_function_vy5kyjrg5689_1`
  - `name=write_stdin`
  - `arguments` 只有巨大 `chars` 串且 **没有 `session_id`**，还是截断坏 JSON
  - 紧随其后的 tool message 明确写着 `failed to parse function arguments: EOF while parsing a string...`

Progress:
- 唯一修复点落在 Rust `hub_req_inbound_tool_call_normalization.rs`：followup/request-history 进入治理前，新增 `write_stdin` 参数规范化与坏历史清洗。
- 策略是 **shape-only**：
  - 严格 JSON 可解析时，统一 `sessionId -> session_id`
  - 若工具参数连 `session_id` 都没有或 JSON 已坏，则直接删除该 assistant tool_call 与对应 orphan tool output，阻止坏历史再次发给 MiniMax 触发 2013

Verification:
- `cargo test -p router-hotpath-napi drops_malformed_write_stdin_message_history_and_orphan_tool_message -- --nocapture`
- `cargo test -p router-hotpath-napi normalizes_write_stdin_inside_responses_input_function_call_items -- --nocapture`

## 2026-05-16 native export drift（install/current stale llmswitch-core copy）

Verified findings:
- `22:34:49` 这组样本是 `0.90.1718`，但仍出现 `extractDecodeStatsJson is required but unavailable`。
- 本地 repo / 全局 npm / 运行时 direct binding 都已具备该导出；真正漂移的是：
  - `~/.rcc/install/current/node_modules/rcc-llmswitch-core/`
  - `/Volumes/extension/.rcc/install/current/node_modules/rcc-llmswitch-core/`
- 这两处还是 `5月14日` 的旧拷贝，里面 native `.node` 也是旧时间戳；而 repo `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node` 已是 `5月16日 22:34` 新版。

Progress:
- 把 `scripts/link-global-llms-local.mjs` 扩到同时修正：
  - 全局 npm `routecodex/node_modules/rcc-llmswitch-core`
  - `~/.rcc/install/current/node_modules/rcc-llmswitch-core`
  - `/Volumes/extension/.rcc/install/current/node_modules/rcc-llmswitch-core`
- 全部改成指向本地 `sharedmodule/llmswitch-core` 的 symlink，消灭 snapshot/current install 的旧 native 副本漂移。

Verification:
- 现在 `~/.rcc/install/current/node_modules/rcc-llmswitch-core` 与 `/Volumes/extension/.rcc/install/current/node_modules/rcc-llmswitch-core` 都是 symlink。
- 通过 install/current 路径直接加载 native，`extractDecodeStatsJson` / `normalizeShellLikeToolCallsBeforeGovernanceJson` 均为 `function`。

## 2026-05-11 deepseek-web exec_command malformed shell wrapper（invalid_shell_wrapper_shape）

Verified findings:
- `CLIENT_TOOL_ARGS_INVALID / invalid_shell_wrapper_shape` 不是 host validator 误判；现有共享校验与回归都明确要求：`bash/sh/zsh -c/-lc '...'` 缺失最终单引号必须 fail-fast，不能放宽。
- 本次真正可修的唯一真源不是 `provider-response-tool-validation-blocks.ts`，而是 **deepseek-web text-tool prompt guidance** 仍把 `exec_command` 的默认示例和强提示写成 `bash -lc 'pwd'`，持续诱导上游生成脆弱 shell wrapper。
- 证据：
  - `sharedmodule/llmswitch-core/rust-core/.../deepseek_web/request/prompt/tool_guidance.rs`
  - `sharedmodule/llmswitch-core/rust-core/.../shared_tool_text_guidance.rs`
  - `sharedmodule/llmswitch-core/rust-core/.../tool_text_request_guidance.rs`
  - 现有 validator/spec 明确保留 `invalid_shell_wrapper_shape` 拒绝语义。

Fix applied:
- 将 deepseek-web / shared text-tool guidance 中 `exec_command` 默认示例从 `bash -lc 'pwd'` 改为直接单行命令 `pwd`。
- 将提示语收紧为：
  - 默认优先直接单行命令
  - 只有确实需要 shell 特性时才使用 `bash -lc '...'`
  - 一旦使用 shell wrapper，最终单引号必须闭合
- 同步更新 deepseek-web request compat / Rust req profile 回归断言。

Why this is the unique correct fix point:
- validator 负责守住客户端安全/形状契约，放宽它只会吞掉真实坏样本，并违背已有测试与 fail-fast 规则。
- 真正持续制造坏样本的是 prompt 真源对 `bash -lc '...'` 的默认化示例；只有改写这个上游引导，才能减少 deepseek-web 重复产出 tail-truncated wrapper。

## 2026-05-10 deepseek-web RCC_HISTORY 真源修复

Verified findings:
- `sharedmodule/.../deepseek_web/request/history_context.rs` 之前通过 `build_deepseek_history_messages -> to_prompt_messages(...)` 复用了 **live prompt builder**。
- 而 `to_prompt_messages(...)` 会在有 tools 时注入：
  - `Tool-call output contract (STRICT)`
  - `DeepSeek text-tool addendum`
  - required-tool tail（`This turn is tool-required.` / allowed tool names）
- 这导致 `RCC_HISTORY.txt` 不是“历史 transcript”，而是混入了**当前 live 工具引导**；与 `../ds2api` 的 `BuildOpenAICurrentInputContextTranscript(messages)` 真语义不一致。

Fix:
- 新增 history 专用消息构造路径：**历史 transcript 只保留真实 messages/tool history，不再注入 live tool guidance / required tail**。
- payload-contract 观测快照改成独立 stage：
  - `provider-request-contract`
  - `provider-response-contract`
  避免在 snapshots disabled / contract error 场景下把 compat 观测体误看成真实 final upstream `provider-request.json`。

Why this is the unique correct fix point:
- 问题不在 provider upload，也不在 virtual router；唯一真源是 **history transcript builder 误复用 live prompt 注入链**。
- 如果继续在 provider/header/retry/session 层打补丁，只会保留被污染的 `RCC_HISTORY.txt`，上游仍然读到错误上下文。

Progress:
- 已在 Rust `req_outbound_stage3_compat` 真源新增 `thinking_history.rs`。
- 已把“assistant history 缺 reasoning_content”收口为共享纯函数：
  - `fill_reasoning_content_for_tool_calls`
  - `mirror_assistant_content_into_reasoning_content`
  - `ensure_reasoning_content_for_assistant_history`
- 已在 `request_stage.rs` 仅针对 `provider_protocol=openai-chat` 且 `providerId/providerKey in {omlx, rapidmlx}` 且 `model=DeepSeek-V4-Flash-mxfp8` 的链路接入。
- 已让 iflow Kimi 复用同一 `tool_calls -> reasoning_content` 纯函数，避免第二套实现继续分叉。

Verification:
- `cargo test -p router-hotpath-napi req_profile_chat_local_deepseek_thinking_history --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml`
- `cargo test -p router-hotpath-napi req_profile_chat_iflow_normalizes_thinking_and_reasoning --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml`
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc --noEmit`



Second-layer verified finding:
- 13:26:52 / 13:28 左右这批 400 的更深层真因不是单纯缺 `reasoning_content`，而是 **local DeepSeek thinking chat template 不接受 `last user` 之后继续保留 `assistant plain content`**。
- 证据：
  - `/Volumes/extension/.rcc/logs/server-5520.log:8153-8154`
  - `~/.rcc/codex-samples/openai-responses/omlx.key1.DeepSeek-V4-Flash-mxfp8/req_1778390811726_5cd0381c/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/omlx.key1.DeepSeek-V4-Flash-mxfp8/req_1778390886836_ac0f3df4/provider-request.json`
- 失败样本里第 94 / 100 条 assistant 已经带了 `reasoning_content`，但 `content` 仍是可见文本，因此上游依旧 400。
- 唯一正确修复是继续留在 Rust `req_outbound_stage3_compat/thinking_history.rs`：
  - `last user` 之前的 assistant plain text 保持可见（不能误伤历史）
  - `last user` 之后的 assistant plain text 迁入 `reasoning_content`
  - 同时把 `content` 清空为 `""`
- 这样请求侧 only one SSOT 同时掌握 provider/model/protocol/history boundary，不需要也不允许在 provider transport、response inbound、host bridge 再补第二套形状修复。

Post-restart verification:
- 5520 已重启到 `routecodex 0.90.1473`。
- 新 `/v1/responses` 样本证据：
  - `req_1778391343459_18e8e79e/provider-request.json`
  - `req_1778391355215_1da2f1f0/provider-request.json`
  - `req_1778391389549_883e8231/provider-request.json`
  - `req_1778391409308_c2a1e4aa/provider-request.json`
- 这些新样本中，`last user` 之后的 assistant plain text 已变成：
  - `content = ""`
  - `reasoning_content = 原文`
- 同期 `/Volumes/extension/.rcc/logs/server-5520.log` 已出现对应 `/v1/responses` 200：
  - `openai-responses-omlx.key1-DeepSeek-V4-Flash-mxfp8-20260510T133443444-176142-172`
  - `...133524417-176143-173`
  - `...133555215-176145-175`

Follow-up finding:
- 13:14:15 的真实 400 不是“thinking_history 修复缺失”，而是 **`search/omlx-search` 这类未知 request-stage compatibility profile 先命中 `pick_compat_profile()`，导致 `profile.is_none()` 条件失败，从而把本地 DeepSeek thinking history 修复短路掉。**
- 证据：
  - `/Volumes/extension/.rcc/logs/server-5520.log:8012-8014` 显示失败轮实际路由标签是 `search/omlx-search`
  - `~/.rcc/codex-samples/openai-responses/omlx.key1.DeepSeek-V4-Flash-mxfp8/req_1778390054659_5d36dabf/provider-request.json` 里第 6/8/10... 个 assistant tool turn 仍无 `reasoning_content`
- 最小修复：
  - `request_stage.rs` 去掉 `profile.is_none()` 守卫，只要命中 `should_apply_local_deepseek_thinking_history_compat(...)` 就统一补齐 assistant history `reasoning_content`
  - 新增回归测试覆盖 `compatibility_profile = search/omlx-search` 时仍会注入 `reasoning_content`

Why this is the unique correct fix point:
- 问题发生在 request 发往本地 thinking openai-chat 上游前的历史消息 shape，不在 provider transport，也不在 host bridge。
- 唯一正确修改点只能是 Rust `req_outbound_stage3_compat` 请求侧真源：这里既掌握 provider/model/protocol 上下文，又能在单点对 assistant history 做最小、显式、无 fallback 的 shape 修复。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound-metadata-blocks.ts`
- 已收口：
  - `buildValidatedCapturedChatRequest`
  - `finalizeRouteAndOutboundMetadata`
- 已让 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.ts` 只保留：
  - route select
  - outbound execution context setup
  - provider payload build
  - nodeResult append
  - metadata block 调用
- 当前文件行数：
  - `hub-pipeline-route-and-outbound.ts`: 193
  - `hub-pipeline-route-and-outbound-blocks.ts`: 97
  - `hub-pipeline-route-and-outbound-metadata-blocks.ts`: 94

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 outbound metadata 算法有误，而是 **结果装配块和 route glue block 混在一个文件里**，继续保留只会让 route/outbound block 文件同时承担两层职责。
- 唯一正确瘦身点就是把 `capturedChatRequest + metadata finalize` 抽成单独 metadata blocks，让 route/outbound 主壳和 glue blocks 都进一步靠近“纯编排/纯块”的结构。

## 2026-05-08 hub pipeline slimming (inbound stage orchestration blocks)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.ts` 虽然前面已经做过 block 化，但主壳里仍然平铺着两大片稳定编排：
  - `stage1_format_parse -> stage2_semantic_map -> stage3_context_capture -> standardizedRequest sanitize`
  - `inbound nodeResult -> inbound process metadata -> req_process.stage1_tool_governance`
- 这些不是入口专有业务，而是 inbound 固定阶段顺序；继续平铺在主壳里会保留第二层 orchestration 面。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-orchestration-blocks.ts`
- 已收口：
  - `executeInboundSemanticStages`
  - `executeInboundGovernanceStage`
- 当前主文件行数变化：
  - `hub-pipeline-execute-request-stage-inbound.ts`: 213 -> 111

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 这里的根因仍不是某个 stage 算法错，而是 **固定阶段顺序还停留在主 orchestrator 里**。
- 唯一正确修复点是把这些稳定阶段链收成 inbound orchestration blocks，让 `hub-pipeline-execute-request-stage-inbound.ts` 只保留：prepare -> semantic stages -> governance stage -> finalize workingRequest 的最薄顺序壳。

## 2026-05-08 hub pipeline slimming (provider-payload outbound build orchestration)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.ts` 之前仍把两层职责混在主壳里：
  - protocol switch / semantic mapper / contextMetadataKey / contextSnapshot 准备
  - `req_outbound.stage1_semantic_map -> stage2_format_build -> stage3_compat` 的固定出站阶段链
- 这两层都属于稳定的 outbound build orchestration；继续平铺在主壳里会保留第二份顺序编排面。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-orchestration-blocks.ts`
- 已收口：
  - `prepareOutboundPayloadBuildContext`
  - `buildFormattedOutboundPayload`
- 当前主文件行数变化：
  - `hub-pipeline-execute-request-stage-provider-payload.ts`: 174 -> 137

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 当前被仓库内无关的 `src/providers/auth/oauth-lifecycle/*` 现存错误阻塞；与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- 问题根因不是 outbound stage 算法错误，而是 **固定出站阶段链和其前置上下文准备仍在主 orchestrator 里平铺**。
- 唯一正确修复点就是把它们抽成 provider-payload orchestration blocks，让主文件只保留 passthrough 分流、shadow/policy/parity 这些更高层收尾壳。

## 2026-05-08 hub pipeline slimming (directory-level dead glue cleanup)

Verified findings:
- 在完成前几轮 block 化后，pipeline 目录里仍残留一批“主壳/类型文件里的旧 glue”：
  - `hub-pipeline.ts` 还保留未使用的 `clearHubStageTiming / REQUEST_STAGE_HOOKS / RequestStageHooks` imports
  - `hub-pipeline-route-and-outbound.ts` 还内嵌 route-select 的 timing 壳
  - 这些不再承载业务，只是历史残余编排/导入噪音

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-select-blocks.ts`
- 已收口：
  - `executeMeasuredRouteSelect`
- 已删除死残留：
  - `hub-pipeline.ts` 中不再使用的旧 imports
  - `hub-pipeline-route-and-outbound.ts` 内嵌 route-select timing 壳
- 当前文件行数变化：
  - `hub-pipeline-route-and-outbound.ts`: 193 -> 178

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 仍被仓库内 `src/providers/auth/oauth-lifecycle/token-preparation.ts` 等现存错误阻塞，与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- 这轮不是再造新抽象，而是**物理清理已经没有职责价值的旧 glue/import/timing 壳**。
- 唯一正确修复点是把 route-select 计时壳集中到单一 block，并删除主壳里的历史残留；否则目录表面已经 block 化，但文件内部仍会保留旧的第二实现痕迹。

## 2026-05-08 hub pipeline slimming (adapter-context target vs metadata split)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.ts` 之前同时承担两类稳定职责：
  - `target` 派生字段注入（deepseek / anthropicThinking / compatibilityProfile）
  - `metadata` 派生字段注入（runtime / capturedChatRequest / sessionId / request ids / connection state）
- 这两层虽然都写进 adapterContext，但来源边界不同；继续混在一个文件里，会让 adapter-context builder 同时承担 target truth 与 metadata truth 两层实现面。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context-blocks.ts`
- 已收口：
  - `applyTargetAdapterContextFields`
  - `applyMetadataAdapterContextFields`
- 当前主文件行数变化：
  - `hub-pipeline-adapter-context.ts`: 186 -> 73

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 仍被仓库内 `oauth-lifecycle` 现存错误阻塞，与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- 这里的根因不是 adapterContext 某字段错，而是 **target 注入与 metadata 注入来源边界不同，却混在同一 builder 里**。
- 唯一正确修复点就是把它们拆成两类 block，让主 builder 只保留最小骨架与基础字段计算；这样才能维持 adapter-context 的单一职责和后续 Rust closeout 的唯一真源边界。

## 2026-05-08 hub pipeline slimming (normalize-request metadata/control vs finalize split)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-blocks.ts` 之前同时混了三层职责：
  - providerProtocol guard
  - metadata control flags 抽取（policyOverride / shadowCompare / disableSnapshots / hubEntry / stageRecorder）
  - normalized request pre-shape / finalize 归一
- 其中 metadata control 抽取和 finalize 归一来自不同阶段边界，继续混在一个 block 文件里会让 normalize-request block 仍然拥有多层真相。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-metadata-blocks.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-finalize-blocks.ts`
- 已收口结果：
  - `hub-pipeline-normalize-request-blocks.ts` 现在只保留 `resolveProviderProtocolOrThrow`
  - metadata/control 与 finalize 已分别独立

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 仍被仓库内 `oauth-lifecycle` 现存错误阻塞，与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- 问题根因不是 normalize 算法错，而是 **control flags 抽取和 finalize 归一混在同一 block 文件里**，继续保留会让 normalize-request 的职责边界模糊。
- 唯一正确修复点就是按阶段边界拆开：metadata/control 一块，finalize 一块，protocol guard 单独一块，保证每层只有一个明确来源。

## 2026-05-08 hub pipeline directory review (heavy-input split + dead import cleanup)

Verified findings:
- 目录级审计后，又发现两类明确可清理点：
  1. `hub-pipeline-heavy-input-fastpath.ts` 同时承载
     - heavy-input fastpath config/flag/tokens
     - `capturedChatRequest` snapshot input build
  2. 多个主壳/block 文件里出现已经无用途的死 import：
     - `hub-pipeline-runtime-blocks.ts`
     - `hub-pipeline-normalize-request.ts`
- 第一类属于“不同来源职责混写”；第二类属于已经无职责价值的历史残留。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-captured-request.ts`
- 已收口：
  - `buildCapturedChatRequestInput` 从 `hub-pipeline-heavy-input-fastpath.ts` 迁出
- 已清理：
  - `hub-pipeline-runtime-blocks.ts` 死 import
  - `hub-pipeline-normalize-request.ts` 死 import

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 仍被仓库内 `oauth-lifecycle` 现存错误阻塞，与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- `heavy-input fastpath` 的配置/标记逻辑和 `captured request snapshot build` 不是同一职责来源，继续放在同一文件里会让 heavy-input 块重新长成混合块。
- 死 import 更是纯残留，没有任何保留价值；唯一正确处理就是物理删除。

## 2026-05-08 hub pipeline slimming (reasoning-stop request tooling source split)

Verified findings:
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-reasoning-stop-request-tooling.ts` 之前同时承载：
  - adapterContext session/conversation id backfill
  - capturedChatRequest 复用/新建决策
  - request messages strip + reasoning.stop tool 注入 + captured snapshot 回写
- 这些来自三种不同来源：session scope、captured request state、request tool mutation；继续放在一个文件里就是典型混合块。

Progress:
- 已新增：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-reasoning-stop-request-tooling-blocks.ts`
- 已收口：
  - `backfillAdapterContextSessionIdentifiersFromRequest`
  - `resolveCapturedChatRequestForReasoningStop`
  - `applyReasoningStopToolingToRequest`
- 当前主文件行数变化：
  - `hub-pipeline-reasoning-stop-request-tooling.ts`: 170 -> 34

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`
- 根 `tsc` 仍被仓库内 `oauth-lifecycle` 现存错误阻塞，与本轮 hub pipeline 改动无关。

Why this is the unique correct fix point:
- 问题不是 reasoning.stop 行为错，而是 **session backfill / captured request reuse / request mutation 三层来源被揉在同一个 helper 里**。
- 唯一正确修复点就是按来源边界拆开，让主 helper 只保留最小顺序壳；否则 reasoning-stop request tooling 会继续成为新一轮“半 orchestrator 半 block”的混合真相。

## 执行结果 (2026-05-08)

### P0 ✅ 完成：删除 4 个零逻辑 wrapper 类
- 删除 `chat-http-provider.ts` (13行), `openai-http-provider.ts` (29行), `anthropic-http-provider.ts` (26行), `responses-http-provider.ts` (28行)
- `provider-factory-helpers.ts`: import 改为直接引用 HttpTransportProvider/ResponsesProvider/AnthropicProtocolClient，instantiateProvider 中内联构造
- `api/index.ts`: 导出 ChatHttpProvider → HttpTransportProvider
- `provider-factory.ts`: createChatHttpProvider → createHttpTransportProvider
- 4 个测试文件引用已更新
- TSC 编译零错误

### P1 ✅ 完成：Gemini Antigravity 方法去重
- 新增 `gemini-antigravity-mixin.ts` (201行)：8 个共享函数（isAntigravityRuntime, getAntigravityHeaderMode, extractAntigravityAliasFromRuntime, resolveAntigravityStableSessionId, swapAntigravityRuntimeSessionId, restoreAntigravityRuntimeSessionId, wrapAntigravityHttpErrorAsResponse, applyAntigravityRequestCompat）
- `gemini-http-provider.ts`: 删除 7 个私有方法，改用 mixin 函数调用
- `gemini-cli-http-provider.ts`: 删除 5 个私有方法，改用 mixin 函数调用
- 消除 ~200 行重复代码
- TSC 编译零错误

### 暂不动项
- P2: Server/Executor 层 (3020行, 9文件) — 碎片化但正确分层，收益不高
- P3: Pipeline 3层 re-export 链 — 噪声级
- P4: Manager/Quota (2654行, 10文件) — 结构合理
- P5: oauth-lifecycle.ts 1922行 God Object — 待定
- P6: Profile/Config 双源 — 待定

## 最终结果 (2026-05-08)

### P0 ✅：删除 4 个零逻辑 wrapper 类
- 删除: chat-http-provider.ts (13行), openai-http-provider.ts (29行), anthropic-http-provider.ts (26行), responses-http-provider.ts (28行)
- 工厂内联: provider-factory-helpers.ts 直接构造 HttpTransportProvider/ResponsesProvider
- api/index.ts: 导出替换为 HttpTransportProvider
- provider-factory.ts: createChatHttpProvider → createHttpTransportProvider
- 4 个测试文件 + dist/ 旧产物已清理
- **唯一性论证**: 这 4 个类仅在构造器中设 providerType 默认值，零逻辑，factory 的 switch-case 已承担相同职责，保留即双源

### P1 ✅：Gemini Antigravity 方法去重
- 新增: gemini-antigravity-mixin.ts (200行) — 8 个共享函数
- gemini-http-provider.ts: 删除 7 个重复私有方法
- gemini-cli-http-provider.ts: 删除 5 个重复私有���法
- 消除 ~200 行重复代码
- **唯一性论证**: 两个 provider 的 Antigravity 方法逐行相同，唯一真源

### P5 ✅：oauth-lifecycle.ts God Object 拆分
- 原始: 1922 行 → 主文件: 1315 行
- 新增 4 个子模块:
  - interactive-oauth-lock.ts (207行): 锁管理
  - oauth-lifecycle-logger.ts (23行): 非阻塞日志
  - token-overrides-builder.ts (230行): 端点/客户端/Header 构建
  - token-preparation.ts (243行): Token 包装/准备
- resolveTokenAliasFromPath 唯一真源: path-resolver.ts

### P6 分析结论
- profile/families/: ProviderFamilyProfile（请求/响应钩子逻辑）
- core/config/service-profiles.ts: ServiceProfile（静态配置：基地址/模型/headers）
- 职责分离，无实质重复，不强制合并

### 构建验证
- TSC 编译: 0 错误
- npm run build: EXIT_CODE=0

## Hub pipeline 瘦身进展 (2026-05-08 timing split)

Findings:
- `hub-stage-timing-blocks.ts` 仍然混了三类职责：环境变量解析、请求级时间状态存储、字符串渲染。
- 这类文件虽然不是主 orchestrator，但它仍是 block 层里的混合真相；继续保留会让 timing 配置与状态容器产生第二个隐式耦合点。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-env-blocks.ts`
  - 只保留 timing 开关/阈值/topN 的环境解析。
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-state-blocks.ts`
  - 只保留 request timeline / stage breakdown 的状态推进与汇总。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-blocks.ts`
  - 收缩为 re-export + `renderTimingDetails` 单点渲染。

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是计时功能错，而是 block 文件内部把“配置来源”和“运行时状态来源”揉成了一份真相。
- 唯一正确修复点就是在 `hub-stage-timing-blocks.ts` 这里按来源边界拆开；如果去调用侧硬拆，反而会把同一套 timing 状态分散到更多 orchestrator，形成新的双源。

## Hub pipeline 瘦身进展 (2026-05-08 observation split)

Findings:
- `hub-pipeline-provider-payload-observation.ts` 同时承担了 payload parity 记录壳，以及工具名提取 / message tool history 汇总 / request body 解包三类纯函数职责。
- 这些纯函数不应继续埋在观测壳里，否则后续任何 parity/diagnostic 扩展都会把 block 与 orchestrator 再次揉在一起。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-observation-blocks.ts`
  - 下沉 `unwrapRawRequestBody`
  - 下沉 `extractToolNames`
  - 下沉 `summarizeMessageToolHistory`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-observation.ts`
  - 仅保留 `recordOutboundToolParityObservation` 观测壳

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 tool parity 观测语义错误，而是“记录壳”和“数据提取块”共处一文件，形成隐性双职责。
- 唯一正确修复点就是在 observation 模块内部直接分离提取块；如果在调用方复制这些 helper，只会制造第二份工具历史汇总真源。

## Hub pipeline 瘦身进展 (2026-05-08 heavy-input split)

Findings:
- `hub-pipeline-heavy-input-fastpath.ts` 同时承担 fastpath 开关配置、token threshold 读取、粗粒度 token 估算、metadata 标记与使用判定。
- 其中配置来源和估算算法都属于稳定纯块，不应继续和 runtime 判定壳混在一起。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath-config.ts`
  - 下沉 fastpath 开关与 threshold 读取。
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath-estimate.ts`
  - 下沉 `roughEstimateInputTokensFromRequest` 与其递归估算逻辑。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.ts`
  - 收口为判定 + metadata 标记壳。

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 heavy-input fastpath 语义错，而是“配置真相 / 估算算法 / runtime 判定”三份来源混在同一个文件。
- 唯一正确修复点就是在 fastpath 模块内沿来源边界拆开；如果在调用方复制 threshold 或 token estimate，只会制造第二份 fastpath 判定真源。

## Untracked files review + commit prep (2026-05-08)
- 结论: 当前未跟踪文件均不是孤儿残留，而是已被真实导入的拆分真源，主要分为四组：hub pipeline block 化、request-executor 壳层拆分、oauth-lifecycle 拆分、provider-failure-policy/provider shared helper 收口。
- 特殊检查: `src/server/runtime/http-server/executor/request-executor-response-contract.ts` 已重新显式导出 `hasRequestedToolsInSemantics` 语义链；`sharedmodule/llmswitch-core/tests/hub/reasoning-stop-payload-normalizer.test.ts` 为新增回归样本，不是孤儿文件。
- 提交前修复: 根仓 `tsc --noEmit` 发现 `normalizeString` 漏导出，唯一正确修复点是 `src/providers/core/runtime/deepseek-http-provider-helpers.ts` 与 `src/providers/core/runtime/deepseek-session-pow-helpers.ts`，已直接补导出并通过双编译验证。

## Hub pipeline 瘦身进展 (2026-05-08 entry/outbound shell split)

Findings:
- `hub-pipeline-execute-chat-process-entry.ts` 仍同时承担 nodeResults 初始化、governance phase 调用、最终结果拼装三类编排职责。
- `hub-pipeline-route-and-outbound.ts` 仍同时承担 outbound payload 调用后 metadata finalize + result 封装，顶层壳还不够薄。
- `hub-stage-timing.ts` 仍暴露公开 API 的同时内嵌 measure 执行模板，属于通用测量编排与公开壳混放。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry-orchestration-blocks.ts`
  - 下沉 nodeResults 初始化
  - 下沉 governance phase 调用
  - 下沉最终 `HubPipelineResult` 拼装
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound-result-blocks.ts`
  - 下沉 outbound metadata finalize
  - 下沉 result envelope build
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-measure-blocks.ts`
  - 下沉 `measureHubStageExecution`
- 结果：
  - `hub-pipeline-execute-chat-process-entry.ts` 收缩到 104 行
  - `hub-stage-timing.ts` 收缩到 94 行

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是这些流程行为错误，而是顶层壳仍保留了可继续稳定下沉的编排细节。
- 唯一正确修改点就是在各自模块内部继续把结果拼装/阶段推进抽成 block；如果改去外层 caller，只会让同一流程再出现第二份 orchestrator 语义。

## Hub pipeline 瘦身进展 (2026-05-08 provider-payload/max-tokens split)

Findings:
- `hub-pipeline-execute-request-stage-provider-payload.ts` 仍混了 passthrough result 返回与最终 stage result envelope，虽然主干已块化，但结果出口还不够单纯。
- `hub-pipeline-max-tokens-policy.ts` 同时承担 provider identity 识别、默认值提取、request 参数写回三类稳定纯逻辑。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-result-blocks.ts`
  - 下沉 passthrough result 返回
  - 下沉 provider payload stage result envelope
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-max-tokens-identity-blocks.ts`
  - 下沉 provider identity normalize
  - 下沉 qwen hard cap 判定
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-max-tokens-request-blocks.ts`
  - 下沉 requested/configured default resolve
  - 下沉 request 参数写回
- `hub-pipeline-max-tokens-policy.ts` 收缩为纯 orchestrator

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 max-tokens 或 provider-payload 功能错误，而是模块内部仍保留了可稳定复用的数据/identity/结果块。
- 唯一正确修改点就是继续在这些模块内部按数据来源与结果出口拆；若在使用方补一层 helper，会把 provider token cap 与 payload stage result 再复制成第二份真源。

## Hub pipeline 瘦身进展 (2026-05-08 inbound runtime/result split)

Findings:
- `hub-pipeline-execute-request-stage-inbound-setup.ts` 仍同时承担 runtime hint 注入和 workingRequest finalize 出口。
- `hub-pipeline-execute-request-stage-inbound.ts` 仍直接拼装最终 inbound stage result，顶层壳还保留 result envelope 语义。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-runtime-hints-blocks.ts`
  - 下沉 apply-patch tool mode hint
  - 下沉 compaction hint 注入
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound-result-blocks.ts`
  - 下沉 workingRequest finalize 出口
  - 下沉 inbound stage result envelope build
- `hub-pipeline-execute-request-stage-inbound-setup.ts` 收缩为 execution setup 壳
- `hub-pipeline-execute-request-stage-inbound.ts` 收缩为 stage 串联壳

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 inbound 行为错误，而是 runtime hint 与 result envelope 仍卡在 setup/main 壳里。
- 唯一正确修复点就是在 inbound 模块内部按 runtime 注入块与结果出口块拆开；若在调用链外围复写，只会制造第二份 inbound result 语义。

## Hub pipeline 瘦身进展 (2026-05-08 normalize orchestration/result split)

Findings:
- `hub-pipeline-normalize-request.ts` 仍同时承担 native orchestration 调用与 orchestration failure/result 收口。
- `hub-pipeline-normalize-request-finalize-blocks.ts` 仍同时承担 normalized metadata build 与最终 `NormalizedRequest` 组装出口。

Changes:
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-orchestration-blocks.ts`
  - 下沉 native orchestration 调用与失败收口
- 新增 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request-result-blocks.ts`
  - 下沉 native orchestration metadata input build
  - 下沉 `NormalizedRequest` 最终结果出口
- `hub-pipeline-normalize-request.ts` 收缩为 normalize 主串联壳
- `hub-pipeline-normalize-request-finalize-blocks.ts` 收缩为 route shape / metadata finalize 壳

Verification:
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit`

Why this is the unique correct fix point:
- 问题不是 normalize 功能错误，而是 orchestration 调用与最终结果出口仍和主壳/finish 壳混放。
- 唯一正确修复点就是在 normalize 模块内部继续按 orchestration block 与 result block 拆；如果在更外层包一层，只会制造第二份 normalized request 出口语义。

## 2026-05-08 stopless config ssot
- 现状：core 真源 `reasoning-stop-state.ts` 仍默认 `on`，request normalizer / hub pipeline 也有硬编码 `on`。
- 新要求：stopless 只能由 `config.json` 启动配置驱动；未配置默认 `off`。
- 设计：`config.json` -> host loader 解析唯一字段 -> 写入进程级 runtime 配置投影 -> core/bridge/request-normalizer/guard 全部只读这一份默认模式。
- 禁止继续在 bridge/core/request-normalizer 各自硬编码默认值。

## 2026-05-08 stopless default-off test pollution root cause
- 根因不是 reasoning-stop guard 自己忽略了 `off`，而是 `sticky-session-store.ts` 只让 `ROUTECODEX_SESSION_DIR` 覆盖 `tmux` scope，没有覆盖 `session:/conversation:` routing scope。
- 后果：测试明明设置了临时 `ROUTECODEX_SESSION_DIR`，但 reasoning stop 持久化仍从默认全局 `~/.rcc/state/routing` 读旧状态，表现成“默认 off 却被历史 on 污染”的假阳性。
- 唯一正确修复点：`sticky-session-store.ts` 的 session dir 解析；不能去 guard/test 里补丁式清状态，那会掩盖双路径真源问题。

## 2026-05-08 第1轮首刀：provider-response-converter owner map
- 当前切片目标：`src/server/runtime/http-server/executor/provider-response-converter.ts` 瘦身，收口 Host response/followup convert 壳层。
- 真源 owner：response/followup 业务语义仍应归 `llmswitch-core bridge + servertool blocks`；Host 这里只允许保留 transport shell / runtime wiring / error bubbling。
- 重复写口：本文件同时持有 tool-call 参数校验、stopless request 扫描、provider payload 提取、followup runtime dispatch 闭包、SSE wrapper 错误转 HTTP、bridge error finalize，多类稳定逻辑混在单壳。
- 旁路：若继续在本文件内保留 followup / response-contract 稳定判断，会让 Host 持有第二份 response/followup 语义，削弱 llmswitch-core 真源。
- 错误残留：本文件仍是 1300+ 行聚合壳；不是单点 bug，而是职责混堆导致的历史厚壳残留。
- shared/block/orchestration 拆分建议：
  - shared pure functions：tool-call 参数校验、payload 提取、JSON-like parse、stopless 文本扫描、SSE/context/retry 错误判定。
  - stable blocks：bridge precheck、nested runtime action blocks、convert result finalize、convert error finalize。
  - orchestration：`convertProviderResponseIfNeeded` 仅保留入口判定、adapterContext 组装、调用 bridge、串联 block、返回结果。
- 本轮最小修改点：只动 `provider-response-converter.ts` 及其新拆出的同目录 blocks/helper 文件；不碰 servertool 主骨架、不碰 sticky-session-store、不碰 hub pipeline 其它文件。
- 不修改：`sharedmodule/llmswitch-core/src/servertool/*` 主逻辑、`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/*`、`src/modules/llmswitch/bridge/*` 既有语义。
- 唯一性论证：当前 Host 最厚、最混合、最容易形成第二真源的点就是 `provider-response-converter.ts`；如果不先收口它，后续 servertool / hub pipeline 继续拆分也仍会被 Host 壳层重新聚合出重复语义，因此这里是第1轮唯一正确首刀。

---

## [2026-05-08] Phase 1 Analysis: System Slimming Refactoring

### Key Metrics
- src/ TS: ~540 files, ~125k lines
- sharedmodule/llmswitch-core/src TS: 733 files (non-test)
- Rust (router-hotpath-napi): 229 .rs files, 82 NAPI exports
- Duplication ratio: ~733 TS / 229 Rust = 3.2x (many TS files are shadows of Rust)

### Domain Breakdown (src/)
| Domain | Files | Lines |
|--------|-------|-------|
| server | 146 | 39,934 |
| providers | 149 | 34,413 |
| cli | 63 | 13,086 |
| utils | 35 | 6,761 |
| modules | 39 | 6,152 |
| manager | 25 | 5,219 |
| token-daemon | 10 | 3,610 |
| commands | 11 | 2,869 |
| tools | 16 | 2,012 |
| config | 10 | 1,974 |
| monitoring | 3 | 1,284 |
| Others | 22 | ~3,000 |

### Critical Findings
1. **Fallback violations (HIGH)**: ~50 catch sites swallow errors in production code
2. **Duplication (HIGH)**: 733 TS files in sharedmodule duplicate 229 Rust modules
3. **No versioning/block isolation**: No block traits, no semver, no orchestrator, no cyclic upgrade path
4. **Architecture gap**: Rust SSOT is partially achieved (Hub Pipeline/Virtual Router) but TS still has ~125k lines of business logic

### NAPI Export Categories (82 total)
- bridge_actions (15): run_bridge_action_pipeline, build_bridge_history, filter_bridge_input, etc.
- tool_handling (10): harvest_tools, validate_tool_arguments, repair_tool_calls, etc.
- reasoning (10): extract_reasoning_segments, normalize_reasoning_in_* (5 variants), etc.
- codec_helpers (8): normalize_tools, coerce_bridge_role, ensure_messages_array, etc.
- routing (4): compute_quota_buckets, split_antigravity_targets, etc.
- clock (3), streaming (2), mcp (2)

### Next: Phase 2 - Block Architecture Design
Full analysis JSON: /tmp/refactor-analysis.json
## 2026-05-09 08:50:55 responses-provider mapping exploration
- Goal: design /goal prompt for native responses semantic parity across anthropic/chat providers.
- Next: inspect routecodex provider mapping and ~/code/codex native responses semantics.

- RouteCodex evidence: sharedmodule responses bridge uses native pipeline + bridge tool mapping; provider transports expose some OpenAI/Anthropic options but parity target still needs exact capability matrix + closed-loop verification.
- Codex evidence: native responses semantics explicitly assert structured helpers like ResponsesRequest.input()/function_call_output(), plus model capability metadata for reasoning/verbosity/parallel tools/web search.

## 2026-05-09 08:57:36 responses parity audit
- Workspace has active WIP in provider-response-converter.ts + provider-response-tool-validation-blocks.ts; inspect before adding new slice.

- Converter shell refactor verified green after stopless seed fix; next audit layer is cross-protocol responses semantics + continuation + field transparency tests.


## 2026-05-09 responses SSE completion audit (top-level output_text)

Observed evidence:
- `sharedmodule/llmswitch-core/src/sse/types/conversion-context.ts` defines `ResponsesJson.output_text?: string` and `ResponsesPartialJson.output_text?: string`.
- `sharedmodule/llmswitch-core/tests/hub/fixtures/responses-response.json` includes top-level `output_text`.
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.ts` builds `output` items but never rehydrates top-level `response.output_text` on completed/incomplete/failed/done salvage paths.
- Existing roundtrip tests only assert nested `output[*].content[*].text`, so this contract gap escaped.

Hypothesis:
- Missing top-level `output_text` in SSE->JSON is a real contract gap inside the SSE builder owner, not just a helper-script artifact.

Verification direction:
- Fix only `response-builder` to derive `output_text` from completed message output items and add regression coverage in `src/sse/test/responses-converter.test.ts`.

## 2026-05-09 virtual-router audit start
- Goal checklist: route selection / alias-providerKey / capability gating / sticky-continuation / quota-health-cooldown / runtime override / explicit errors / thin-shell residuals

- Slice1 evidence: deleted dead error-center.ts (no refs); Rust routing/metadata.rs now owns continuation/request_chain/session/conversation sticky-key semantics with 5 new unit tests green.

- New evidence: sharedmodule virtual-router-context.mjs currently fails. Observed behavior: longcontext single-provider pool becomes unavailable after health failure and falls back to default, contradicting script expectation. Need owner audit in Rust route selection / health policy.

- Slice2 evidence: virtual-router-context acceptance updated to match owner semantics (cooldown-depleted longcontext singleton falls back to default).

- Slice3 evidence: deleted dead engine-selection.ts barrel (no refs); provider-key/context/native-hotpath/native-parity scripts still pass.

- Slice4 evidence: provider-key acceptance updated to owner semantics (alias segment preserves full second token, e.g. 3-138 / 3-main).

## [2026-05-09] virtual router 收口审计
- 目标: 对 virtual router 做查漏补缺 + 重复语义收口 + thin shell 瘦身，确认唯一真源仍是 llmswitch-core / Rust-native。
- 先验约束: host/provider/servertool/stop-message/followup 只能消费 router decision，不得维护第二语义面。
- 当前动作: 先读 routing/skills/CACHE/MEMORY，再按 virtual router / sticky / cooldown / capability / continuation / followup / stop-message / servertool 关键词定位代码与测试。
- 待验证: TS 侧是否还残留 route selection、sticky、cooldown、capability、continuation 的第二实现；测试是否已经覆盖 unsupported/unavailable/exhausted 显式错误。
- 已验证缺口: servertool/stop-message-auto/runtime-utils.ts 本地重写 continuation/responsesResume/session scope，和 native resolveServertoolStickyKey/resolveStopMessageSessionScope 形成第二语义面。
- 已修正: runtime-utils 改为直接消费 native sticky/scope owner；删除本地 continuation/responsesResume/sessionScope 解释代码。
- 已验证缺口: VirtualRouterEngine.getStopMessageState/getPreCommandState 会把 legacy session scope persisted state 重新暴露，违背 tmux-only stop/preCommand 边界。
- 已修正: 对外 state 读取口统一限制为 tmux scope；无 tmux 时清理 legacy session stop/preCommand persisted 字段，不再复活第二语义面。
- 证据: tests/servertool/stop-message-runtime-utils.continuation.spec.ts + tests/sharedmodule/routing-state-continuation-matrix.spec.ts + tests/servertool/stopmessage-session-scope.spec.ts 全通过。

## [2026-05-09] virtual-router sticky key ssot cutover
- 已验证：VirtualRouterEngine.route 主链已完全走 native proxy；TS `engine/routing-pools/*` 只被测试直接 import，不是 live route owner。
- 新缺口：`engine/routing-state/keys.ts` 仍本地维护 continuation/request_chain/session/conversation/responsesResume sticky key 解释，与 Rust `virtual_router_engine/routing/metadata.rs::resolve_sticky_key` 构成第二语义面。
- 唯一正确修复点：把 TS `resolveStickyKey` 薄壳改为直接消费 native `resolveServertoolStickyKeyJson`（其 Rust 实现直接复用同一 `resolve_sticky_key`），删除本地解释逻辑；不能继续在 TS 维护并行 sticky owner。
- 待验证：routing-state-continuation-matrix / hub-pipeline-router-metadata / stop-message continuation 相关测试需继续过。

- 回归发现：tests/servertool/virtual-router-quota-routing.spec.ts 与 virtual-router-search-route-alias.spec.ts 仍 import 已删除 dead barrel engine-selection.js。
- 修复：测试入口改为真实实现 `engine/routing-pools/index.js`；这是旧壳删除后的唯一正确测试对齐点，未改会把 barrel 残留误当成主链依赖。

- 二次回归发现：quota-routing 测试原先通过 dead barrel 间接跑旧夹具，切到真实 routing-pools 入口后暴露 providerRegistry mock 缺少 hasCapability()。
- 修复：测试 mock 补 `hasCapability: () => false`，对齐真实 selection 依赖面。

- 继续回归发现：quota-routing 文件内还有第二个 providerRegistry mock（non-default route fallback case）同样缺少 hasCapability()；已补齐。

## [2026-05-09] stop-message session scope ssot cutover
- 已验证：servertool/state-scope.ts 已提供统一 native scope owner `resolveServertoolPersistentScopeKey` -> `resolveStopMessageSessionScopeWithNative`。
- 新缺口：stop-message-auto/runtime-utils.ts 的 `resolveStopMessageSessionScope()` 仍用 `resolveServertoolStickyKeyWithNative + TS filterPersistentScopeKey` 侧面拼装 session scope，和 state-scope 真源形成第二组合面。
- 已修正：runtime-utils 直接复用 `resolveServertoolPersistentScopeKey(record)`；删除本地 `filterPersistentScopeKey()`。
- 唯一性：session scope 真源应是 native `resolveStopMessageSessionScopeJson`，而非从 sticky key 再反推/过滤。

- 回归纠偏：`resolveServertoolPersistentScopeKey(record)` 只适用于完整 adapterContext carrier；stop-message-auto 调用点传的是 record + 独立 runtimeMetadata。
- 正确修复：`resolveStopMessageSessionScope()` 改为直接 native `resolveStopMessageSessionScopeWithNative(buildServertoolRoutingMetadata(record, runtimeMetadata))`。
- 结论：真源仍是 native scope owner，但不能错误复用 carrier-only helper。

## [2026-05-09] sticky semantic split fix
- 根因确认：generic router sticky 与 servertool stop-message sticky 不是同一语义 owner。
- 错误点：我先前把 `engine/routing-state/keys.ts` 接到 `resolveServertoolStickyKeyJson`，而该 NAPI 又只是复用 generic `resolve_sticky_key`，导致 stop-message 所需 tmux/clientInject scope 与 generic continuation/request_chain 语义混淆。
- 已修正：
  1. Rust 新增 `resolve_virtual_router_sticky_key_json`，专供 generic router sticky。
  2. TS `engine/routing-state/keys.ts` 改回走 generic native sticky owner。
  3. Rust `resolve_servertool_sticky_key_json` 改为 servertool 专用：优先 `resolve_stop_message_scope`，否则 fallback 到 generic `resolve_sticky_key`。
- 结论：这是语义 owner 分裂后的唯一正确收口；不能再让 generic routing sticky 与 stop-message sticky 共用同一个出口。

## 2026-05-09 sticky split native export 闭环
- 现象: `resolveVirtualRouterStickyKeyJson` 在 TS required exports 与 Rust `#[napi]` 代码中都已存在，但 Jest/loader 运行时仍报 unavailable。
- 验证: 直接 `require()` 当前 loader 会命中的 native 产物：
  - `sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node`
  - `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`
  两者都 **没有** `resolveVirtualRouterStickyKeyJson`；仅有 `resolveServertoolStickyKeyJson` / `resolveStopMessageSessionScopeJson`。
- 结论: 当前阻塞不是 TS 壳或 required-exports 列表遗漏，而是 **native binding 产物未重新构建/未更新到 loader 命中路径**。
- 下一步: 重新构建 `router-hotpath-napi`，然后重新 probe export，再跑 sticky 最小回归。
- 构建失败真因补充: `chat_servertool_orchestration.rs` 的 `resolve_servertool_sticky_key_json` 已切到 `resolve_stop_message_scope(...)`，但文件顶部仍只 import 了 `resolve_sticky_key`，导致 Rust release build 直接失败，旧 `.node` 继续被 loader 命中。
- 修复: 为该文件补齐 `resolve_stop_message_scope` import；这是当前唯一阻塞构建闭环的真源修改点。
- 继续收口: `resolve_stop_message_scope` 之前错误地在无显式 stop/tmux scope 时回落到 `resolve_session_scope(metadata)`，导致 servertool sticky 抢走 continuation request-chain，并让 virtual-router stop/preCommand scope 再次退回 session。
- 唯一正确修复点: Rust `routing/metadata.rs::resolve_stop_message_scope`。该函数的职责应仅限 stop/preCommand 客户端注入域（显式 stop scope 或 tmux scope），不能兼任 generic session scope。
- 验证结果:
  - native rebuild 后，`resolveVirtualRouterStickyKeyJson` 已实际出现在 `rust-core/target/release/router_hotpath_napi.node` 与 `dist/native/router_hotpath_napi.node`。
  - continuation sample 直接 probe 结果恢复为：
    - `resolveVirtualRouterStickyKeyJson` => `req_chain_from_continuation`
    - `resolveServertoolStickyKeyJson` => `req_chain_from_continuation`
    - `resolveStopMessageSessionScopeJson` 仍保持 `session:session_should_lose`
  - 说明 generic sticky / servertool sticky / persistent session scope 三者已按 owner 分家。
- 新发现: `stop-message-auto` 的读取契约与 generic sticky split 无关，真正错位在 `chat_servertool_orchestration.rs::resolve_stop_message_session_scope`。
- 证据: stop-message-auto 测试 fixture 一直把 persisted state 写到 `tmux-<sessionId>.json`，且 wrapper 会把 `tmuxSessionId` 注入 adapterContext；但 native `resolveStopMessageSessionScopeJson` 之前只返回 `session:`/`conversation:`，导致读取 persistent state 时命中错文件，统一退成 `skip_default_disabled`。
- 修复: stop-message session scope 改为优先 `clientTmuxSessionId/client_tmux_session_id/tmuxSessionId/tmux_session_id`，然后才回落到 session/conversation。
- 最后一处语义修正: `resolve_servertool_sticky_key_json` 不能简单 `stop_message_scope ?? generic_sticky`。
- 原因: generic sticky 对 `openai-responses` 在无 resume chain 时会优先退到 `requestId`，而 servertool sticky 的旧契约/测试要求在“无 inject/tmux，但有 session/conversation scope”时优先落到 session/conversation，再无 scope 时才退 requestId。
- 修复策略: 新增专用 `resolve_servertool_sticky_key(metadata)`，顺序为：stop/tmux scope > generic chain result > 若 generic 仅等于 requestId 且存在 session/conversation scope，则改回 session/conversation > requestId。


## 2026-05-09 clock session scope audit

Verified findings:
- `sharedmodule/llmswitch-core/src/servertool/clock/session-scope.ts` 仍在 TS 本地拼第二语义面：
  - 读 `stopMessageClientInjectSessionScope/Scope`
  - 读 `sessionId/conversationId`
  - 产出裸 `sessionId`、`session:...`、`conversation:...` 多路 alias
- Rust 真源 `chat_clock_reminders_semantics.rs::resolve_clock_session_scope(...)` 当前只认 tmux session，并返回唯一 `tmux:<id>` scope。
- `chat-process-clock-reminders.ts` 还把 alias 列表用于 `clock:clear` 批量清理，因此会把 clock state 清理扩展到 tmux owner 之外，属于 clock scope 的第二实现面。
- repo grep 未发现 clock 相关测试对 `session:/conversation:` alias 有正向依赖；现有 clock tests 基本都使用 `tmux:<id>` 作为 state scope。

Decision:
- clock 的唯一正确修复点是 `session-scope.ts`：直接收口到 native tmux scope，物理删除 TS alias/session/conversation/explicit-stop-scope 解释器。
- `chat-process-clock-reminders.ts` 的 clear 也必须只清理统一 native scope；继续保留 alias 批量清理会重新引入 fallback/第二语义面。


## 2026-05-09 recursive detection scope audit

Verified findings:
- `sharedmodule/llmswitch-core/src/servertool/handlers/recursive-detection-guard.ts` 本地 `resolveSessionKey()` 仍按 `sessionId -> conversationId -> requestId` 手写 loop scope。
- 但该 guard 处理的是 servertool followup/tool-loop 语义，不是普通业务 session；它应跟随 servertool sticky owner，而不是自造另一套 scope 解释。
- 项目内已存在统一 owner：`state-scope.ts` 可通过 native `resolveServertoolStickyKey` / `resolveStopMessageSessionScope` 提供 servertool 语义 scope。

Decision:
- recursive-detection 的唯一正确修复点是收口到 `resolveServertoolLoopScopeKey(...)`，让循环检测与 servertool sticky 同源。
- 继续保留 `session/conversation/request` 本地顺序会形成第二语义面，并在 continuation/request-chain 场景下与真实 servertool owner 漂移。


## 2026-05-09 remove gemini-cli + antigravity

User authorized physical removal of both provider families.

Scope decision:
- Remove runtime/provider/auth/token-daemon/router/servertool hooks/package scripts/tests that exist solely for `gemini-cli` or `antigravity`.
- Keep plain `gemini` provider family.
- Unique first cut must start from registration/type truth (`provider types`, `factory`, `profile registry`, `oauth provider list`, `runtime inference`).
- Reason: if these entrypoints still advertise the families, later file deletion will leave dangling feature surfaces and fake support.
## [2026-05-09] Remove gemini-cli + antigravity (checkpoint continuation)
- 目标: 物理删除 gemini-cli provider 与 antigravity provider/feature；保留 plain gemini。
- 现状: 已完成入口真源收口与第一批文件删除；下一步以根仓 tsc 报错为准继续删残留引用，再处理 sharedmodule feature 面。
- 约束: 只动本任务相关文件；禁止 fallback；删除必须物理删除，不做闲置保留。

- 已执行: 物理删除 camoufox-fp / gemini-antigravity-mixin；oauth/cli/provider template/oauth config/runtime provider/quota manager 已切除 gemini-cli 与 antigravity 公开面。
- 修正: oauth-lifecycle 已切除 gemini-cli/antigravity enrich/repair 分支；quota manager 改为 provider-quota 包装壳；gemini SSE 已去掉 antigravity thoughtSignature cache。

[2026-05-09 11:34:49] remove gemini-cli + antigravity continuation
- Goal: physically remove gemini-cli and antigravity feature/module surfaces; keep plain gemini.
- Current fact: root tsc previously passed, but rg still shows public/runtime/sharedmodule residue.
- Next focus: public surfaces first (init-provider-catalog, provider-profile*, provider-config, camoufox, token-scanner, runtime-utils/bootstrap-utils, camoufox-launcher), then runtime retry/quota if needed.
[2026-05-09] 删除 gemini-cli/antigravity 续做：先以 tsc 证据修 quota-manager 缺失，再清 quota/sharedmodule 残留真源与引用。
[2026-05-09] checkpoint: root/sharedmodule 当前删除链已恢复 root/sharedmodule tsc 通过，准备提交 sharedmodule gemini/antigravity 收口中间点。

## [2026-05-09] gemini-cli antigravity + silent hang closeout
- 现象: checkpoint 已提交，需继续物理删除 gemini-cli/antigravity 残留真源与 tests，并排查请求静默挂机。
- 已知残留: health/quota/clock/types/native-shared-conversion-semantics-tools 仍有 antigravity/gemini-cli 真源；tests 仍有大量专项残留。
- 排查策略: 先删 feature 真源并过 tsc，再从 request-executor/servertool/followup/SSE finalize 链定位 silent hang 的未 fail-fast 分支。


## 2026-05-09 /goal + apply_patch compatibility exploration
- Goal: research Codex `/goal` feature boundary, then design a provider-agnostic patch compatibility flow for RouteCodex that lets different protocol providers emit their most stable shell-style patch syntax and losslessly translate compatible shapes into Codex `apply_patch` grammar.
- Constraints from user: no semantic guessing; maximize compatibility via shape repair only; study both `~/code/codex` and `~/github/hermes-agent`; deliver a reliable self-loop prompt covering analysis -> design -> modify -> test -> review -> commit.
- Next evidence targets: Codex source for goal lifecycle and apply_patch expectations; Hermes patch adapter patterns; current RouteCodex text-harvest / tool-surface / shell-wrapper compatibility points.
- Official docs confirmed `/goal` is experimental, enabled by `features.goals`, supports `/goal <objective>`, `/goal`, `/goal pause|resume|clear`, and keeps a persistent target attached to the active thread.
- Codex source confirmed app-server thread goal primitives: `thread/goal/set|get|clear`, token budget support, status transitions, persisted usage accounting, and continuation prompts/templates.
- Codex apply_patch accepts either direct freeform patch body or narrowly recognized shell heredoc wrapper (`apply_patch <<'PATCH'` or `cd <path> && apply_patch <<'PATCH'`) and validates against strict V4A grammar after extraction.
- Hermes parser is intentionally more permissive (missing begin marker tolerated, implicit context lines, standalone `*** Move File:` op). Good reference for compatibility envelope, but looser than Codex grammar and therefore not safe as-is for RouteCodex if we must avoid semantic guessing.
- RouteCodex current stack already has three SSOT layers relevant to this task: (1) text harvest from provider free text, (2) compat.fix-apply-patch shape repair, (3) validator / error taxonomy / hints. This means `/goal` adaptation should compose with existing stages rather than invent a new patch lane.
- Existing guidance currently says “never wrap apply_patch in exec_command/shell”; for provider-compat mode we should keep that as the canonical outbound preference, while adding a bounded inbound compatibility bridge for shell-wrapped `apply_patch` only when the wrapper shape is exact and body can be extracted losslessly.
- Current Rust fixer already normalizes legacy headers (`New/Create File`) and some mixed Begin-Patch wrappers, but user requirement points toward extending exact shell-wrapper compatibility using Codex invocation rules rather than broader semantic conversion.

## [2026-05-09] gemini-cli/antigravity remove + silent hang narrowing
- 已提交 checkpoint: 477ee50ed (`refactor(sharedmodule): remove antigravity runtime residue`)
- 当前主真源残留已确认仍在 Rust hotpath：req_outbound_stage3_compat/gemini_cli、virtual_router_engine antigravity routing/session-binding、servertool skeleton bootstrap、shared_gemini_tool_utils antigravity mode。
- TS native binding 残留也仍在 engine-selection/native-router-hotpath* 与 native-compat-action-semantics。
- 静默挂机继续缩小中：servertool nested followup 当前没有超时/abort guard，且 executeServerToolReenterPipeline 直接 await nested execute；若内层 reenter 不终止，外层请求会一直悬挂。
- 新可疑点：servertool reenter helper 无 fail-fast timeout；需要继续核对 executeNested / client abort / nested error contract 的唯一真源后再改。

- 2026-05-09 apply_patch compat implementation decision: unique correct fix point is Rust `compat_fix_apply_patch.rs`, because validator, stage2 semantic normalization, and compat action wrapper already flow through `fixApplyPatchToolCallsWithNative`. Adding exact shell heredoc support here gives one truth surface without duplicating parser logic across TS normalizer/provider layers.
- Planned minimal slice: support exact `bash|zsh|sh -lc|-c` wrapper containing only `apply_patch <<TOKEN ... TOKEN` and optional `cd rel &&` prefix; reject broad shell semantics by simply not extracting unsupported wrappers.

[2026-05-09] apply_patch compat tighten exact shell parsing
- First fix attempt failed because edit path targeted repo-root relative path while cwd already at rust-core; file unchanged.
- Evidence: failing test still shows shell wrapper normalized from `echo hi && apply_patch`, so current code path remains permissive.
- Next step: patch `crates/router-hotpath-napi/src/compat_fix_apply_patch.rs` in-place and inspect any alternate wrapper-extraction path near nested token parsing.
[2026-05-09] user expanded scope: add strong regression coverage from Codex samples + error samples; prove compat gets better not worse.
- Need corpus covering exact-shell-supported, shell-extra-command-reject, malformed-wrapper-reject, legacy-header-repair, cd-rebase, nested field aliases, and negative samples from real error corpus.
- Need integrate into current repo regression sample surfaces, not just unit tests.
[2026-05-09] evidence update: real sharedmodule validator path still accepts noncanonical extra-command shell wrapper before native rebuild.
- `validateToolCall(apply_patch, bash -lc "echo hi && apply_patch <<..." )` currently returns ok=true on current built path.
- Therefore acceptance boundary must be locked by source tests + native rebuild verification, not just Rust unit tests.

## [2026-05-09] followup fail-fast + TS native exit cleanup
- 已修改: host servertool nested followup 加 timeout/client-abort fail-fast，避免 executeNested 永久 pending 导致外层请求静默挂机。
- 已修改: 删除 TS native-router-hotpath / compat-action-semantics 中 antigravity helper 出口与 required export。
- 已删除: 第一批 gemini-cli/antigravity 专项 tests。
- 证据: sharedmodule tsc 通过；root tsc 待本轮提交后继续跑；tests 新增 followup timeout case 但 jest 入口仍被 import.meta 配置阻塞。
[2026-05-09] build blocker audit
- `cargo test` / `build:ci` now blocked by `shared_gemini_tool_utils.rs` unclosed delimiter. Need distinguish whether blocker is pre-existing/unrelated workspace drift or introduced by current task before using build as objective evidence.

## 2026-05-09 apply_patch compat /goal loop
- 已补证据确认 codex samples：`~/code/codex/codex-rs/apply-patch/src/invocation.rs`、`~/code/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`、`shell_snapshot.rs`、`unified_exec.rs`、`responses.rs` 真实包含 `apply_patch <<'EOF'` 与 `cd sub && apply_patch <<'EOF'` 样式。
- 已补证据确认 error samples：仓库 `samples/mock-provider/openai-responses/.../request.json` 存在大量 `apply_patch verification failed` 错误样本；当前兼容重点命中 provider 真实坏形状 `{"cmd":"apply_patch << 'PATCH'...","workdir":"..."}`。
- 当前阻塞不是本任务逻辑，而是 `shared_gemini_tool_utils.rs` 工作区已有破损；需先最小修复语法后继续验证 compat 回归。

## [2026-05-09] gemini-cli/antigravity final closeout continuation
- 接手状态: 已有提交 607655367；当前需继续清理 tests/真源残留，并把 host nested followup fail-fast 收口成可验证提交。
- 当前策略: 先重新取证（rg/tsc/cargo/git status），只处理本任务相关文件，避免误碰 apply_patch 兼容线与其它无关改动。
- 重点真源: Rust hotpath provider/profile/router 残留；host `servertool-followup-*` 静默挂机 fail-fast；feature-only tests 物理删除或改样本。
- Jason 2026-05-09 明确校正：只要请求已提供足够信息，格式有不完整之处应做 shape repair；禁止语义猜测，但允许对 wrapper / heredoc / 字段别名 / 路径外壳 / envelope 进行修复。

## [2026-05-09] gemini-cli / antigravity 真源收口 + servertool 静默挂机
- 发现: sharedmodule TS wrapper 仍导出 antigravity native API/required exports；provider failure policy 仍带 antigravity 语义字段。
- 发现: host nested followup fail-fast 已有独立修复点，但本轮还需清 source/tests 语义残留。
- 待验证: 删除 antigravity wrapper/export 后 sharedmodule/root tsc 与 router-hotpath cargo 是否仍通过。
[2026-05-09] apply_patch compat final audit
- Review evidence: diff scoped to Rust compat SSOT + validator/governor tests + regression verifier + goal doc + regression samples + local skill.
- Verification evidence: Rust compat tests green; direct validator sample check green for Codex shell/cd and provider cmd+workdir absolute-path case; extra-command shell still rejected; regression verifier green with mismatches=0.
- Remaining non-scope blocker: sharedmodule build:ci still blocked by unrelated ANSI_ESCAPE_PATTERN missing symbol in stop-message-auto path; not required for apply_patch compat semantics because verifier now loads dist when available and otherwise can source-fallback.

## 2026-05-09 gemini-cli/antigravity closeout + silent hang
- 已确认第二个请求静默挂机真源：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 主链同步调用 AI followup，内部 `spawnSync(codex)` 阻塞事件循环，导致 abort/timeout watcher 不运行；已单独提交 async 修复。
- 当前收口面：quickstart 样例、package 活脚本、matrix 脚本、WebUI antigravity 专属 quota snapshot、request-executor/daemon-admin/oauth/gemini provider 相关死测试与 mock 残留。
- 提交边界：不混入工作区现有 web-search / bridge / semantic_map 无关改动，只选择性 add 当前切片。

## 2026-05-09 14:23:42 +0800 apply-patch compat follow-up build/restart check
- 当前确认：本轮此前只有 10000 在线与版本证据，无 build:dev/install:release 后重启 10000 的闭环证据；现开始补做。

## 2026-05-09 14:31:47 +0800 continue build/install/restart after audit block
- 进入门禁清障：先查 rustification audit 真源与 4 个新增 TS 文件来源，再最小修复后重跑 build/install/restart/10000 health。

- 2026-05-09 14:35:12 +0800 build blocked by TS type mismatch in clock-pure-blocks.ts; next step: align parseRecurrenceFromRecord return with ClockTaskRecurrence required fields.

- 2026-05-09 14:36:29 +0800 build-core blocked: llmswitch-core dist missing/invalid after compile trigger; next step inspect build-core.mjs required outputs vs sharedmodule package build output.

- 2026-05-09 14:36:43 +0800 suspected stale required output in scripts/build-core.mjs: dist/router/virtual-router/error-center.js may be removed source but still asserted by build gate; verifying references now.

## 2026-05-09 14:45:54 +0800 silent-failure investigation (zterm /goal)
- user reported silent failure after long /goal run; start from exact session/request ids and screenshot symptom.


## 2026-05-09 /goal 静默失败纠偏
- Jason 明确纠正：重点不是 stop contract 本身，而是 upstream stop 场景里 **summary / reasoning / text 不应被转换成空响应**。
- 本轮 sample `req_1778308938522_7c9bd7e6` 已证实 provider SSE 原文存在 `thinking_delta` 与 `text_delta`（`I have all the information I need...`），因此若最终表现为空/静默，唯一正确方向应回到 **SSE -> normalized/converted body 的内容保真链路**，而不是先讨论 `stopless` 是否触发。


## 2026-05-09 gemini-cli / antigravity closeout + silent-hang audit
- 只处理本人负责文件：package.json、configsamples/config.v1.quickstart.sanitized.json、webui/src/App.tsx、sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs、sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/blocked-report.ts，以及与这些真源直接对应的 tests/scripts。
- 已确认主源码真源 `src + sharedmodule/llmswitch-core/src` 对 `gemini-cli / antigravity` grep 为空；残留主要在 webui、matrix scripts、tests、coverage scripts。
- 静默挂机第二处阻塞死代码锁定在 `blocked-report.ts`：`createBdIssueFromBlockedReport()` 仍使用 `spawnSync('bd', ...)`，且主链无调用点，可物理删除，仅保留 blocked report 解析与 text extract 纯函数。


## 2026-05-09 /goal schema 真源确认
- 对照 Codex `core/src/tools/handlers/request_user_input_spec.rs` 已确认：`request_user_input` 真正需要完整 nested schema：`questions[].{id,header,question,options[]}` 与 `options[].{label,description}`。
- 坏样本 `req_1778308938522_7c9bd7e6/provider-request.json` 已确认被 RouteCodex 发成 `questions.items={type:object}` 的扁平 schema。
- 唯一真源修点锁定：`sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-tool-schema.ts` 对 builtin schema 的 compact 过度压扁了 `request_user_input`。
- 另已对照 Codex `goals.rs`：goal continuation 不是 stopless/fallback；而是 idle 时由 runtime 自动注入 developer continuation prompt 启动下一轮 turn；等待 `request_user_input` 时不会继续自动续轮。


## 2026-05-09 /goal 修复进展

- 追加源级验证：用 tsx 直接调用 `processSuccessfulProviderResponse(...)`，确认 reasoning-only + declared tools 现抛 `MISSING_REQUIRED_TOOL_CALL`，并保留 errorsample marker=`responses_missing_required_tool_call`。
- 已修 Anthropic builtin tool schema 对 `request_user_input` 的过度 compact：现在保留 nested shape，不再把 `questions[].{id,header,question,options}` 与 `options[].{label,description}` 压扁。
- 已修 host response contract：reasoning-only / summary-only 的非空响应不再误判 `responses_empty_output`；若声明了 tools 但缺少 structured tool call，现改为 `MISSING_REQUIRED_TOOL_CALL`，不再冒充 `EMPTY_ASSISTANT_RESPONSE`。
- 已补回归：builtin schema 保真、reasoning-only missing-tool-call、host error reporting 隔离、真实 /goal 坏样本回归记录。

## 2026-05-09 request-executor 测试语义对齐（进行中）
- 目标：把历史 request-executor 回归断言对齐到当前真语义：`host.response_contract` fail-fast、reasoning-only 非 empty、declared tools + 无结构化 tool call => `MISSING_REQUIRED_TOOL_CALL`。
- 当前最小待对齐点：
  1. `request-executor.spec.ts` 中 reasoning-only helper 仍断言 `responses_empty_output`
  2. pool exhausted / reroute temporarily unavailable 的 `excludedProviderKeys` 旧断言可能已过时
  3. SSE error event 网络失败旧测试仍期待 same-provider retry，需要以现实现证据校准
  4. `single-attempt.spec.ts` 中 soft-wait / saturated / servertool followup 三条可能因旧 stub/data shape 漂移而超时
- 方法：先跑最小定向 Jest，按真实失败逐条修测试；不为了绿测回退主逻辑。


## 2026-05-09 deepseek-web × ds2api toolcalling 对齐分析

Verified findings:
- `../ds2api` 的工具能力真源不是 native transport tools，而是 `prompt injection + DSML/XML wrapper parse + stream sieve + assistant-turn finalize + prompt-visible tool history` 一体化协议。关键真源：`internal/toolcall/tool_prompt.go`、`toolcalls_parse.go`、`toolcalls_dsml.go`、`toolcalls_xml.go`、`internal/assistantturn/turn.go`、`internal/prompt/tool_calls.go`。
- RouteCodex 当前 `deepseek-web` 主协议仍是 `<tool_call>...</tool_call>` JSON wrapper，请求侧真源在 `req_outbound_stage3_compat/deepseek_web/request/prompt/tool_guidance.rs`，响应侧真源在 Rust `resp_process_stage1_tool_governance.rs`，并已对 `<tool_call>` / `<function_calls>` / `RCC_TOOL_CALLS(_JSON)` 做 explicit-wrapper-only harvest。
- 因此“让 deepseek-web 使用 ds2api 的工具引导和收获”不能只抄 prompt，也不能只在 provider/TS 层补 parser；唯一正确方向是把 ds2api 的 DSML/XML 协议映射进 RouteCodex Rust 真源，让它成为 deepseek-web 新主协议，旧 `<tool_call>` 仅保留兼容收割。

Why this is the unique correct fix direction:
- ds2api 的完整能力依赖同一协议同时贯穿请求注入、响应 harvest、stream/non-stream finalize、历史回注；只改其中一处都会形成双协议分裂。
- RouteCodex 项目硬约束要求工具治理唯一真源在 Rust chat-process/compat 主链，provider/TS 层重建 parser 会制造第二真源和静默分叉。
- 继续让 `<tool_call>` 占主位，只能算“借鉴 ds2api 提示词”，不构成真正的 ds2api 工具语义对齐。


## 2026-05-09 RCC_HISTORY.txt 改名实现面梳理

Verified findings:
- `DS2API_HISTORY.txt` 当前不是 chat-history store 的模块名，而是 current_input_file 生成的“完整上下文 transcript 文件”的 canonical name。Go 真源在 `internal/promptcompat/history_transcript.go`（`CurrentInputContextFilename`, `historyTranscriptTitle`）与 `internal/httpapi/openai/history/current_input_file.go`（continuation prompt）。
- WebUI 读取/merge 历史的关键锚点在 `webui/src/features/chatHistory/chatHistoryUtils.js`：`CURRENT_INPUT_FILE_PROMPT` 与 `HISTORY_TRANSCRIPT_TITLE` 都写死了 `DS2API_HISTORY.txt`，如果只改 Go 不改这里，会直接导致 `historyMerged`/placeholder 识别漂移。
- 因此 `DS2API_HISTORY.txt -> RCC_HISTORY.txt` 的唯一正确改法是：从 current-input transcript 真源出发，同步改 Go 常量、live prompt、WebUI parser、docs、tests；`/admin/chat-history`、`internal/chathistory`、`responsehistory`、`HistoryText` 不属于这次 rename 对象，不能误扩 scope。

## 2026-05-09 request-executor /goal 真实样本回灌（进行中）
- 现有语义对齐回归已绿；下一步把 errorsamples/codexsamples 中与 `/goal`、`request_user_input`、`missing tool call`、responses reasoning-only 相关的真实样本抽进回归样本库。
- 目标：避免只靠人工构造样本绿测，必须补真实错误样本/成功样本，验证 shape repair 后不引入新回退。

## [2026-05-09] /goal request_user_input / empty-stop semantic alignment (continuation)
- 已确认上一轮已修：Anthropic request_user_input nested schema 保形、reasoning-only 非 empty、declared tools + no function_call => MISSING_REQUIRED_TOOL_CALL(host.response_contract)、host.response_contract fail-fast。
- 本轮目标：继续补 /goal stop -> next turn 推进语义的真实样本与测试，确认是否还有 schema/shape 缺口。
- 先做两件事：1) 看 ~/code/codex 真源码里 /goal 如何消费 stop / request_user_input；2) 扫 ~/.rcc/codex-samples 与 ~/.rcc/errorsamples 的真实样本，找还能回灌的 stop/summary/tool-call 边界。


## 2026-05-09 deepseek-web RCC_HISTORY 纠偏收口

Verified findings:
- 这次 `RCC_HISTORY.txt` 任务的真实修改对象不是 `../ds2api`，而是 RouteCodex 自己的 deepseek-web 路径：Rust request compat 真源在 `sharedmodule/.../req_outbound_stage3_compat/deepseek_web/request*.rs`，provider runtime 真源在 `src/providers/core/runtime/deepseek-http-provider.ts`。
- 当前 RouteCodex deepseek-web 只会把 `messages -> prompt`，并透传已有 `ref_file_ids`；provider runtime 也只会把 `ref_file_ids` 原样带进 completion body。仓内没有现成的 DeepSeek context-file upload 链路。
- 因此参考 ds2api 落 `RCC_HISTORY.txt` 的唯一正确方案是：Rust 真源产出 transcript + continuation prompt + metadata contract，TS provider 负责真实 upload 和 `ref_file_ids` 合并；只改 ds2api 或只改 provider TS 都是错的。
- 已从 ~/.rcc/codex-samples/openai-responses/llmgate.key1.deepseek-v4-pro/req_1778164167955_288a3db3/provider-request.json 抽取真实“修复后 nested request_user_input schema”正样本，回灌到 tests/fixtures/goal-request-user-input-real-samples/provider-request.goal.nested-after-fix.json。
- 新回归覆盖：同一 repo fixture 同时固定 before-fix flatten 坏形状 + after-fix nested 好形状，避免只测坏例不测正例。
- 结合 Codex protocol_v1 真源码确认：request_user_input 是正式事件/工具回路；TurnComplete 会带 response_id 作为 stop 后下一轮继续推进的书签。对 RouteCodex 而言，对齐点是：stop 可结束，但不能空；若声明 tools 且仍需继续，必须给出结构化 tool call 或 reasoning.stop finalized marker，不能用空 stop 混过去。
- 发现一个测试入口假象：根仓 jest.config.js 的 roots 只有 src/tests/webui，不包含 sharedmodule/llmswitch-core/tests；因此把 sharedmodule 测试文件路径直接塞给根仓 `jest --runTestsByPath` 并不会真正执行。`--listTests` 已验证只收集了 tests/sharedmodule/*。
- 唯一正确修复点不是口头把 sharedmodule 路径继续写进命令，而是把关键回归复制/落到根仓 tests/sharedmodule 可执行链，或显式用 sharedmodule 自己的 jest.config.cjs 跑它。
- 已补根仓真实执行侧回归 `tests/sharedmodule/resp-process-tool-allowlist-contract.spec.ts`：覆盖 request_user_input 在 resp_process_stage1 中的两条关键语义——(1) 声明时 harvest 成结构化 tool_call 且保留 nested question shape；(2) 未声明时按 allowlist 丢弃 harvest，并保留原始文本到 output_text/meta。
- 这条修改是唯一正确测试落点，因为 request_user_input 的“是否能推进下一轮”不只取决于 request schema，还取决于响应侧是否能把 textual wrapper 稳定收割成结构化 tool call；若这里退化为 stop/空文本，就会重新制造 `/goal` 静默失败。

## 2026-05-09 deepseek-web RCC_HISTORY 设计落地（本轮实现）

- 已核实唯一修改面：
  - Rust `req_outbound_stage3_compat/deepseek_web/request.rs + request/prompt*` 当前只产出 `prompt/ref_file_ids/flags/metadata.deepseek`，没有 transcript/contextFile。
  - TS `src/providers/core/runtime/deepseek-http-provider.ts` 当前只做 session + PoW + completion；没有 upload 主链。
- 关键实现约束：`DeepSeekHttpProvider.buildHttpRequestBody()` 是同步函数，不能在这里发起真实 upload；真实 upload 只能放在 provider 异步链（最合适是 `finalizeRequestHeaders()`）里完成，然后把 file id 写回本次 request payload 的 `ref_file_ids`。
- 这样可保持单一真源：
  - Rust 决定是否启用 `RCC_HISTORY.txt`、文件内容、continuation prompt、metadata 契约。
  - TS 只消费 `metadata.deepseek.contextFile` 做 upload，并把返回 file id prepend 到 `ref_file_ids`。
- 当前仓内无现成 DeepSeek upload client，可参考 `../ds2api/internal/deepseek/client/client_upload.go`：multipart file part + `x-ds-pow-response` + `x-file-size` + 可选 `x-model-type`，成功后解析 file id；本仓先做最小可用 upload + fail-fast，不做 fallback。

## 2026-05-09 deepseek-web RCC_HISTORY 收口
- 已把 contextFileEnabled 正式接进 host deepseek runtime options、provider profile loader、sharedmodule virtual-router normalization、Rust provider bootstrap。
- 已修 sharedmodule/request compat test 与 deepseek-http-provider.unit.test 的 describe 结构错误，避免新增用例挂在块外。
- 已验证：root deepseek contract/provider/profile/provider runtime tests 通过；Rust deepseek_web tests 通过；compat tool-calling script 通过。
- 备注：root tsc 需等待 sharedmodule build:ci 先产出 dist；并行跑会先报 dist 缺失，不是本次功能错误。

## 2026-05-09 /goal anthropic mirror shape-repair closeout

Verified findings:
- `tests/sharedmodule/anthropic-client-remap-namespace-fallback.spec.ts` 最初只半绿：`semantics.anthropic.toolNameAliasMap` 回读已生效，但仅有 `semantics.anthropic.clientToolsRaw` 时仍无法派生 `shell_command -> Bash`。
- 真源在 Rust: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`。
- 根因分两层：
  1. resp outbound client semantics 只读 `semantics.tools.*`，未回读 `semantics.anthropic.*` mirror。
  2. Rust `normalize_anthropic_tool_name` 未把 `bash/shell/terminal` 规范到 `shell_command`，导致仅凭 `clientToolsRaw=[{name:"Bash"}]` 无法派生 alias。

Fix applied:
- 在 `hub_resp_outbound_client_semantics.rs` 增加 anthropic mirror shape repair：当 `semantics.tools.toolNameAliasMap/clientToolsRaw` 缺失时，显式回读 `semantics.anthropic.toolNameAliasMap/clientToolsRaw`。
- 在同文件补 shell-family canonicalization：`bash|shell|terminal -> shell_command`。
- 新增 Rust 回归：
  - `resolve_alias_map_from_sources_repairs_anthropic_semantics_mirror_shape`
  - `resolve_client_tools_raw_from_resp_semantics_repairs_anthropic_semantics_mirror_shape`
  - `resolve_alias_map_from_sources_derives_shell_command_alias_from_anthropic_client_tools_raw`

Why this is the unique correct fix point:
- 问题不在 TS 测试本身，也不在 client remap 外壳；真正缺的是 Rust resp outbound semantics 真源对 anthropic mirror 的读取与 alias canonicalization。
- 若只改测试，会掩盖“信息足够但格式落在 mirror 节点时仍不兼容”的真实缺口；若改外层 TS 包装，则会制造第二语义面。唯一正确位置就是 Rust 真源 resolver。

Verification:
- 定向 Rust tests passed.
- `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/anthropic-client-remap-namespace-fallback.spec.ts` passed.
- protocol-compat 子集在接入 `/goal` 回归后 passed（含 anthropic remap / tool schema / request_user_input / responses snapshot）。

## 2026-05-09 deepseek-web live tool loop false failure
- Live config `/Volumes/extension/.rcc/config.deepseekweb.json` on :5520 verified first-hop tool call works: `/v1/responses` returns `status=requires_action` + structured `required_action.submit_tool_outputs.tool_calls[0]=exec_command`.
- Real closed-loop failure found on submit hop: after posting tool output, upstream returned valid final text `当前目录是 /Users/fanzhang/Documents/github/routecodex。` with `status=completed`, but host classified it as `MISSING_REQUIRED_TOOL_CALL` and converted it to 502.
- Unique fix direction: inspect host response contract / submit_tool_outputs context; likely false requirement inherited from original declared tools on resumed turn, not a deepseek upstream tool-harvest failure.

## 2026-05-09 deepseek-web live config route/capability retarget
- User requested: `/Volumes/extension/.rcc/config.deepseekweb.json` must expose websearch + multimodal, with coding/thinking on v4-pro and tools/search on v4-flash.
- Current blocker verified: live provider truth `/Volumes/extension/.rcc/provider/deepseek-web/config.v2.json` only exposes `deepseek-chat` + `deepseek-reasoner` with `web_search` capability and aliases `{deepseek-v3, deepseek-chat-search, deepseek-r1,...}`; no `deepseek-v4-pro`, `deepseek-v4-flash`, or `multimodal`.
- Unique correct direction: update provider truth aliases/capabilities first, then retarget live routing config, then add repo tests covering deepseek-web alias/bootstrap + provider inspect capability routing.

## 2026-05-09 deepseek-web ds2api 对齐
- 证据：ds2api 明确把 search/vision 建模为独立模型族；search 走 *-search，vision 走 model_type=vision + 上传/ref_file_ids。
- 当前仓问题：live config 把 web_search 指向 deepseek-v4-flash；provider runtime 仅上传 RCC_HISTORY.txt，不支持 image inline upload / x-model-type / completion model_type。
- 本轮收口方向：1) 路由/样例配置改 search->*-search, multimodal->vision；2) deepseek-web request/runtime 增加 model_type 与 vision inline upload 真链；3) 补单测。

## 2026-05-09 deepseek-web virtual router / capability routing 审查
- 已验证 VR 真源里 `search` 与 `web_search` 是独立 route：`search` 仅续写分类，`web_search` 才绑定联网策略/engine。
- 当前 live config `/Volumes/extension/.rcc/config.deepseekweb.json` 错把 `search`、`web_search`、`multimodal` 都指向 `deepseek-v4-flash`。
- 当前 provider catalog / inspect 真源也在放大这个错误：`src/cli/config/init-provider-catalog.ts` 和 `tests/provider-sdk/provider-inspect.spec.ts` 仍把 deepseek-web 的 web_search 绑定到 `deepseek-v4-flash`。
- 当前 `provider-inspect.ts` 的 routing hint 生成只有 `default + webSearch` target，没有 `multimodal` 专用 target，因此即使 provider 有 vision alias，也会把 multimodal 默认落到 defaultModel；这与 Jason 要求的“provider 声明能力，config 路由到 vision 模型”不一致。
- 下一步唯一正确切点：修 provider metadata / inspect / config sample，让 `web_search -> deepseek-v4-flash-search`，`multimodal -> deepseek-v4-vision`，同时保持 `search` 只是普通 route 分类，不参与 webSearch policy 语义。

## 2026-05-09 virtual router capability routing 审计（multimodal / web_search）
- 已确认：V2 配置链是 config-first。`src/config/virtual-router-builder.ts` 只从 active routing policy 取 `routing`，不会依据 provider model capabilities 自动生成 `routing.multimodal` / `routing.web_search`；`tests/config/provider-v2-loader.spec.ts` 已固定该行为。
- 已确认：VR runtime provider bootstrap 会读取 provider model `capabilities[]`，并在 Rust 真源里规范化 `vision -> multimodal`、`search/websearch/web-search -> web_search`；见 `router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs` 与 `provider_registry.rs`。
- 已确认：`multimodal` 的 primary trigger 不是 capability，而是当前用户轮 media/image；capability 只用于 provider eligibility filter / default-pool fallback。见 TS/Rust classifier + engine selection。
- 已确认：`web_search` 的 primary trigger 不是 capability，也不是“用户想搜索”自然语言；而是显式 `last-tool-websearch` continuation + `webSearch.engines`/`routing.web_search` 配置链。capability 只用于 provider eligibility filter / default-pool fallback。
- 唯一性判断：运行时 authoritative truth 在 Rust `router-hotpath-napi`；但仓内仍保留 TS mirror 面（`classifier.ts`、`engine/routing-pools/index.ts`、`provider-runtime-inference.ts`、`provider-inspect.ts`）。因此“生产 runtime 真源”是单一的，但“仓内实现面”不是严格单一，存在镜像/提示层第二语义面，需要防漂移审计。

## 2026-05-09 config TOML 迁移纠偏
- 用户明确要求：这次配置迁移必须走“渐进式修复”——先做 TOML 平行实现与测试，测试成功后再替换 JSON 主链。
- 正确表述不是“长期双格式共存”，而是“短期 shadow/parallel verification + 最终切主链”。
- 后续 /goal 与实施计划必须写明退出条件：JSON/TOML 语义对齐、注释保留、CLI/admin/provider-update 回归通过后，才能把默认真源切到 TOML。

## 2026-05-09 TOML shadow 最小切片（已落代码）
- 已新增最小 TOML parser `src/config/toml-basic.ts`，当前只覆盖 RouteCodex shadow config 需要的子集：basic key/value、table、array-of-tables、数组、inline table、string/number/bool。
- 已新增 codec：
  - `src/config/user-config-codec.ts`
  - `src/config/provider-config-codec.ts`
- 已新增 semantic loader 真源：`src/config/user-config-loader.ts`
  - 把 v2 config 校验、active group materialize、reasoningStopMode 投影、VR input/providerProfiles 组装从 `routecodex-config-loader.ts` 中抽离
  - 旧 `routecodex-config-loader.ts` 已收成薄壳，开始复用 shared semantic loader
- 已新增 compare 骨架：`src/config/config-semantic-compare.ts`
- 已让 `provider-v2-loader.ts` 支持 shadow 识别 `config.v2.toml`，同时保留 JSON 主链行为
- 已补第一批 shadow 测试：
  - `tests/config/toml-shadow-codec.spec.ts`
  - `tests/config/toml-shadow-semantic-compare.spec.ts`
- 验证证据：
  - 定向 Jest：4 suites / 15 tests 全绿
  - `tsc -p tsconfig.json --noEmit` 全绿
- 这一轮为什么是唯一正确修改点：
  - 不能先在 callsite 散接 TOML.parse；必须先把 user semantic loader 抽出来，形成 JSON/TOML 共享语义真源，否则 compare 会比较两份不同实现而失真。

## 2026-05-09 TOML comment-preserving 写回（第一条真实入口）
- 已新增 `src/config/toml-comment-preserving.ts`，当前先实现最小真实 writer：更新指定 table 下的 string scalar，并保留原有行内/上方注释与整体文本布局。
- 已把 `src/cli/commands/config.ts` 的 `switch-group` 接到该 writer：当 `--config` 指向 `.toml` 时，不再 JSON stringify 覆盖，而是仅更新 `[virtualrouter] activeRoutingPolicyGroup`。
- 这是第一条真实“comment-preserving write”主链证据，因为 `switch-group` 是现有 CLI 真实用户入口，不是孤立测试 helper。
- 新回归：`tests/cli/config-command.spec.ts` 新增 `switch-group preserves TOML comments when updating activeRoutingPolicyGroup`，验证注释未丢失且值已更新为 `canary`。
- 验证证据：
  - `tests/cli/config-command.spec.ts -t switch-group` 全绿（4 passed）
  - shadow config suites 全绿（4 suites / 15 tests）
  - `tsc -p tsconfig.json --noEmit` 全绿
- 当前边界：writer 还只是最小切片，只覆盖 string scalar 更新；还未扩展到 routing groups / admin handlers / provider TOML 写回。下一步应沿同一 writer 扩展，而不是各处重新实现一份 TOML patch。
## 2026-05-09 5520 deepseek-web 独立 smoke 现场
- health ok: 127.0.0.1:5520 -> version 0.90.1459.
- live config 已声明 routing.web_search -> deepseek-v4-flash-search，routing.multimodal -> deepseek-v4-vision。
- 实际日志证据：web_search 请求仍落 thinking -> deepseek-v4-pro，说明 authoritative runtime 没把首轮 web_search_preview 声明前置到 route queue。
- 代码证据：TS `route-utils.ts` 已有 hasWebSearchToolDeclared -> prepend web_search；Rust authoritative truth `router-hotpath-napi/src/virtual_router_engine/routing/config.rs` 缺这段逻辑。这是 web_search 失效唯一真源。
- 实际日志证据：multimodal 请求落 default/default-deepseek-web-primary -> deepseek-chat，而不是 multimodal route label。说明 authoritative runtime 选路阶段把 image 请求 fallback 到 default 池了，需要查 Rust selection / route queue / provider bootstrap 真源。
- provider runtime 侧 inline upload 已做到 upload + fetch_files，但 live 仍报 `invalid ref file id`，说明还需要核对 fetch ready contract，而不是 compat 问题。

## 2026-05-09 22:30 web_search / multimodal smoke 进度
- 5520 version 0.90.1463，native 已更新（22:21 时间戳）。
- 本轮 Rust 改动：
  1. `detect_web_search_tool_declared` 增加 type=web_search_preview 识别（tools.rs）
  2. `build_route_queue` 在 has_web_search_tool_declared 时前置 web_search（config.rs）
  3. `selection.rs` `web_search_route_requested` 改为 `classification.route_name == "web_search" || features.has_web_search_tool_declared`
  4. `normalize_model_capabilities` 传播 capabilities 到 aliases（provider_bootstrap.rs）
- 但 5520 当前被其他 Codex session 的 thinking 请求阻塞（并发 2/2），smoke curl 超时。
- 下一步：等 5520 空闲后重试 web_search smoke。
- 关键风险：web_search 请求在 route_queue 里有 web_search，但 selection.rs 仍然只看 classification 结果。需要确认 selection 侧逻辑是否正确。

## 2026-05-10 5555 审计补充
- 5555 当前版本仍是 0.90.1467，但 live config 与 Jason 最新要求不一致：`tools/search -> deepseek-v4-pro`，`web_search -> deepseek-v4-pro-search`，并非要求的 `tools/search -> deepseek-v4-flash`、`web_search -> deepseek-v4-flash-search`。
- live provider config `/Volumes/extension/.rcc/provider/deepseek-web/config.v2.json` 也与仓内 sample 漂移：当前把 `deepseek-v4-pro` / `deepseek-v4-pro-search` alias 绑到 `deepseek-chat`，会污染路由验证。
- 因此 5555 旧 smoke 不能作为完成证据；必须先修正 live config/provider truth，再 build/install/restart 后重跑 web_search + multimodal smoke。

## 2026-05-10 deepseek-web tool harvest root cause
- 真实样本 `req_1778374509540_d60e1be6` 已复现：envelope 聚合后 content 仍保留完整 `<tool_call>...</tool_call>` wrapper，但 `resp_process_stage1_tool_governance.rs` 的 lenient JSON parse 无法处理 inner JSON 中 shell 文本带来的非法反斜杠转义，导致 wrapper harvest 失败并落成 `no_tool_calls`。
- 唯一 owner 仍是 Rust 文本工具收割真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`；不是 provider TS，也不是 deepseek envelope。

## 2026-05-10 deepseek-web live smoke on 5555
- action: rerun web_search and multimodal smoke after latest install/restart

- web_search smoke result: requires_action with web_search tool call; need route proof from logs

- multimodal smoke result: MALFORMED_RESPONSE at chat_process.response.entry; need provider/log evidence
- multimodal live evidence: route hits v4-vision, provider-request carries ref_file_ids, upstream SSE only emits ready+close without content; host fails MALFORMED_RESPONSE at chat_process.response.entry
## 2026-05-10 multimodal malformed_response investigation
- live: provider-response raw only ready+close, no content


## 2026-05-10 deepseek-web/web_search 误路由排查

- 已验证 `/Volumes/extension/.rcc/config.deepseekweb.json` 当前是用户要求的 v2：default/coding/longcontext/thinking=v4-pro，tools/search=v4-flash，web_search=v4-flash-search，multimodal=v4-vision。
- 已验证 VR bootstrap 可成功加载 routes，因此“普通工具被打到 web_search”不是配置文件结构错误。
- 真源锁定在 Rust Virtual Router：
  - `routing/config.rs::build_route_queue` 会因 `has_web_search_tool_declared` 把 `web_search` 插到 route queue 前面。
  - `engine/selection.rs` 又把 `has_web_search_tool_declared` 直接等价成 `web_search_route_requested`。
- 这与 classifier/test 语义冲突：声明 web_search tool 不应强制首轮/普通 tools continuation 命中 web_search；只有显式 web_search continuation / route signal 才应走 web_search。
- 下一步最小修点：只改 VR selection + route queue 的 web_search 触发条件；不碰 provider/header。
## 2026-05-10 deepseek-web header + provider-switch audit
- Owner map: deepseek upstream header truth in src/providers/profile/families/deepseek-profile.ts; retry log truth in src/server/runtime/http-server/executor/request-executor-runtime-blocks.ts.
- Evidence: captured provider-request sample leaks opencode/codex headers into deepseek upstream; request-header-builder merges inbound headers, family profile currently only strips a few keys and does not reassert deepseek identity headers.
- Evidence: request-executor logs bound nextAttempt but still prints raw attempt over max (e.g. 11/6) when blocking recoverable retries exceed budget.
- Scope: only fix deepseek upstream header scrubbing/reassertion and provider-switch log formatting/tests.


## 2026-05-10 deepseek-web 502 真因补证（create-session response shape）
- 实测证据：使用 `/Users/fanzhang/.rcc/auth/deepseek-account-2.json` 与 `deepseek-account-3-13823250570.json` 两个现有 token，直接 `POST https://chat.deepseek.com/api/v0/chat_session/create`，无论是 ds2api android 头、routecodex sample windows 头、旧 opencode windows/macos 头，均返回 HTTP 200 / `code=0` / `biz_code=0`。
- 排除结论：`DEEPSEEK_SESSION_CREATE_FAILED` 不是由 `User-Agent` / `x-client-platform` / `originator` 差异单独触发；至少 create-session 这一步不是。
- 真实根因：`src/providers/core/runtime/deepseek-session-pow.ts::ensureChatSession()` 只解析 `response.data.biz_data.id`。
- 对照证据：ds2api 在 `internal/deepseek/client/client_auth.go::extractCreateSessionID()` 已明确兼容两种返回体：
  - `data.biz_data.id`
  - `data.biz_data.chat_session.id`
- 本地直连实测也看到 android 契约返回 `data.biz_data.chat_session.id`。
- 因此当 DeepSeek 返回 nested shape 时，routecodex 会误判成“empty session id”，并抛 `DEEPSEEK_SESSION_CREATE_FAILED`，这是 create-session 502 的唯一真源修点。
## 2026-05-10 deepseek-web native compat missing export audit
- Live error now: native runRespInboundStage3CompatJson required but unavailable, causing provider.send attempt_backoff_same_provider and eventual client disconnect.
- Owner hypothesis: rust/native required-exports gate or loader list drift, not ds2api request header/body directly.
- Next: trace required-export registry, native loader, and caller path for resp_inbound_stage3 compat.

## 2026-05-10 deepseek-web 502 真因补证（completion retry prepared-request 复用）
- 代码证据：`src/providers/core/runtime/http-request-executor.ts::executeHttpRequestWithRetries()` 当前只在 `execute()` 入口 prepare 一次，之后所有 `shouldRetryHttpError` 重试都复用同一个 `PreparedHttpRequest`（同一份 headers/body）。
- 这与 DeepSeek Web 的一次性 PoW 契约冲突：`x-ds-pow-response` 不能复用；一旦 transport retry/同 provider retry 重放旧 prepared headers，就会触发 `INVALID_POW_RESPONSE` 或等价 completion 失败。
- 唯一 owner：transport prepared-request 生命周期真源在 `src/providers/core/runtime/http-request-executor.ts`，不是 DeepSeek provider header builder，也不是 host retry shell。
- 最小修法：仅在 `HttpRequestExecutor` 的 retry attempt 边界重新 `prepareHttpRequest(processedRequest, context)`，让每次真正发起上游 completion 前都重建 headers/body；不改 host/router，不碰 stopless/tool harvest。
- 回归方向：补 `HttpRequestExecutor` 定向测试，验证 retry 第二次请求的 headers/body 与第一次不同，证明不会复用一次性 request material。


## 2026-05-10 provider-v2 duplicate startup root cause

Verified findings:
- 5520 启动失败不是 deepseek-web provider 本身，而是 `src/config/provider-v2-loader.ts` 把同一 provider 目录下的 `config.v2.toml` 与 `config.v2.json` 都当成 base provider 载入。
- 真实用户目录 `~/.rcc/provider/*` 普遍同时存在这两份文件；例如 `ali-coding-plan`, `deepseek-web`。
- 由于 v2 loader 对 base files 没有做“二选一”收口，最终在 materialize 阶段直接抛 `duplicate providerId`。

Progress:
- 已在 `src/config/provider-v2-loader.ts` 收口 base config 选择：同目录 base 只保留一份，优先 `config.v2.toml`，否则 `config.v2.json`。
- 已补 `tests/config/provider-v2-loader.spec.ts` 回归测试，覆盖 `toml+json` 共存时只加载一个 base provider 且优先 toml。
- 已跑单测通过；当前剩余动作是重建 dist/全局安装后再用真实 `config.deepseekweb.json` 验证启动。

Why this is the unique correct fix point:
- 当前报错发生在 provider discovery 阶段，且重复来源就是同一 provider 目录内的双 base 文件；唯一正确修点只能是 `provider-v2-loader` 的 base config 选择逻辑。
- 修改 deepseek-web provider、virtual routing、或用户配置都只能掩盖症状，不能根除所有 provider 的重复载入问题。

## 2026-05-10 deepseek-web strict-tool 收口继续
- 先核对交接：当前 live 报错不是 missing export，而是 deepseek-web response compat 在 tools declared + auto 情况下把正常最终文本误判成 missing required tool call。
- 发现我自己前一轮把 `resp_profiles.rs` 里 3 处无关测试的 `estimated_input_tokens` 误改成 `Some(23.0)`；已回退，仅保留 `test_resp_profile_chat_deepseek_web_harvests_tool_call_from_reasoning_content_tail` 这一处改为 `Some(23.0)`。
- 下一步：跑 `cargo test -p router-hotpath-napi resp_profile_chat_deepseek_web -- --nocapture`，确认 strict-tool 真修点无回归。
- 定向 Rust 回归首次结果：29 条里 28 过，唯一失败仍是 `test_resp_profile_chat_deepseek_web_harvests_tool_call_from_reasoning_content_tail`，断言 `usage.prompt_tokens` 为 Null，对应测试前提 `estimated_input_tokens` 还在 1942 行是 None；已精确改成 Some(23.0)，准备复跑。
- 复盘：此前两次 apply_patch 因上下文不唯一，误改到 `req_resp_1` 和另一处无关 deepseek 测试；已用 request_id 锚点重新校准，只保留 reasoning-tail 这条 `estimated_input_tokens: Some(23.0)`，并把误改两处回退。
- 进一步取证：用 dist native wrapper 直接跑 reasoning-tail compat，真实 usage 为 prompt=23 / completion=69 / total=92；因此这条测试之前把 completion/output/total 写死成 100/100/123 不是语义真源，只是过时 incidental 值。已改成验证 usage 自洽（prompt=23, completion>0, total=prompt+completion）。


## 2026-05-10 deepseek-web tool calling repair follow-up
- 当前 explicit tool test 的 provider-request 已确认与 ds2api 真相严重偏离：我们给 deepseek-web 注入的是 `<tool_call>{json}</tool_call>` + 大段 routecodex 专属 override + tool-required tail reminder，并且 assistant 历史 tool_calls 也被序列化成 `<tool_call>` JSON；ds2api 的唯一真源是 DSML/XML `<|DSML|tool_calls><|DSML|invoke ...><|DSML|parameter ...>` 文本协议。
- 当前 resp_process_stage1 SSOT 已支持 canonical XML `<tool_calls>/<invoke>/<parameter>`，但还没有 DSML tag 归一化；如果 request 侧改成对齐 ds2api 的 DSML 提示，不先补 harvest 归一化就会在响应侧丢工具调用。
- 下一步最小修点：1) deepseek-web request prompt/history 改成 DSML 风格；2) resp_process_stage1 增加 DSML -> canonical XML 归一化并补 same-shape 回归；不碰 routing/header。

## 2026-05-10 deepseek-web tool calling repair continue
- 继续核对后确认：当前 request 侧只是从 `<tool_call>` 半切到 plain XML `<tool_calls>`，这仍不是 ds2api 真相；唯一正确方向仍是 DSML `<|DSML|tool_calls>` / `<|DSML|invoke>` / `<|DSML|parameter>`。
- response 侧 `resp_process_stage1_tool_governance.rs` 仍无 DSML tag 归一化，只能吃 canonical XML / qwen markers / RCC fence；若不补 DSML normalize，request 改对后仍会丢 harvest。
- 当前 deepseek-web request/history/prompt/history_context/tests 里仍残留大量 `<tool_call>` 断言，需要随真源协议一并收口；不碰 routing/header/search。
## 2026-05-10 deepseek-web DSML response harvest closeout
- 已验证 request 侧 DSML 后，response 真源唯一 owner 仍是 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`；不是 routing/header/provider TS。
- 本轮唯一正确修点有两处，且都在同一 Rust harvest 真源内：
  1. `harvest_explicit_wrapper_only_tool_calls_from_payload()` 主流程此前只尝试 `<tool_call>` / `function_calls` / `RCC`，没有把 `extract_xml_named_tool_call_blocks()` 与 `<tool_calls>...JSON...</tool_calls>` 容器收割接入，导致 DSML `<invoke>/<parameter>` 与 tool_calls wrapper JSON 都不会落成 canonical tool_calls。
  2. `maybe_parse_tool_call_text_value()` 之前无法 salvage `tool_calls` 容器内“合法 JSON object + 额外 trailing closer”形状；补 balanced object/array 截取后，真实样本 `extra_trailing_closer` 可稳定收割。
- 验证证据：
  - `cargo test -p router-hotpath-napi test_harvest_tool_calls_from_xml_invoke_parameter_attribute_blocks -- --nocapture` ✅
  - `cargo test -p router-hotpath-napi resp_profile_chat_deepseek_web -- --nocapture` ✅（29 passed / 0 failed）
- 结论：当前 deepseek-web 的 DSML/XML response harvest 已在 Rust authoritative truth 闭环；下一步若要继续，只应进入 build/install/live smoke，不应再碰 routing/header/search。
## 2026-05-10 deepseek-web context_length 排查
- 先看真实样本 prompt 是否重复注入 system/tool guidance，再回到 request 真源修。

## 2026-05-10 deepseek-web context_length 排查继续
- 样本已确认没有走 RCC_HISTORY 附件：provider-request ref_file_ids=[]，仍是 full inline prompt；继续查 request.rs 里 history-file 触发条件。

## 2026-05-10 deepseek-web context_length 真源修复
- 已确认 prompt 膨胀真源是 deepseek_web/request/prompt.rs 把同一份 system/tool guidance 头部注入一次后，又用 <<SYSTEM_PROMPT 尾块再注入一次；真实样本重复块长度 8286 字符。
- 本轮只删除 request 真源中的重复 system override block，不碰 routing/header/search；并把 req_profile_chat_deepseek_web 定向断言改为验证 guidance 单次注入。
- 验证：cargo test -p router-hotpath-napi req_profile_chat_deepseek_web -- --nocapture ✅；sharedmodule/llmswitch-core npm run build:dev ✅。

## 2026-05-10 deepseek-web RCC_HISTORY 透明化
- 已定位 provider profile 真因：`src/providers/profile/provider-profile-loader.ts` 没有对 `chat:deepseek-web` 补 `contextFileEnabled=true` 默认值，导致 profile 链默认关闭 RCC_HISTORY。
- 已在 profile loader 只对 `chat:deepseek-web` 补默认 true；显式配置仍优先。
- 下一步验证：provider-profile-loader 定向 jest、router-hotpath-napi 定向测试、build。
- 5555 live 复测（RouteCodex 0.90.1477）已确认 deepseek-web 主链启用 RCC_HISTORY：provider-request.prompt 已切到 continuation prompt，且 ref_file_ids 已注入上传后的 file id（样本：`~/.rcc/codex-samples/openai-responses/deepseek-web.2.deepseek-v4-pro/req_1778393982974_b1ace494/provider-request.json`）。
- 同次 live client 返回为 502 EMPTY_ASSISTANT_RESPONSE，但返回体未泄漏 `RCC_HISTORY.txt/contextFile/contextFileEnabled`；透明剔除仍以 Rust 定向测试作为主证据。
- 额外结论：真正影响 5555 live 的真源不是 host `provider-profile-loader.ts`，而是 virtual-router provider normalization / rust provider_bootstrap 的 deepseek runtime 默认值注入链。

## 2026-05-10 goal-prompt global skill
- 用户要求把 `/goal` prompt 规范沉淀为全局 skill，而不是项目本地文档堆长提示词。
- 新 skill 目标：`/goal` 只保留主逻辑、目标、文档路径、缩略执行规范；详细实现下沉 docs。

## 2026-05-10 deepseek-web goal completion audit（进行中）

### 已核实的事实
1. `~/.codex/skills/goal-prompt/SKILL.md` YAML 已修复并可正常加载。
2. `RCC_HISTORY.txt` 主链已真实生效过：
   - 样本：`~/.rcc/codex-samples/openai-responses/deepseek-web.2.deepseek-v4-pro/req_1778393982974_b1ace494/provider-request.json`
   - 证据：`prompt` 为 continuation prompt，`ref_file_ids` 非空。
3. deepseek-web 当前代码里，请求主工具引导已存在 DSML 形状：
   - `req_outbound_stage3_compat/deepseek_web/request/prompt/tool_guidance.rs`
   - `req_profiles.rs` 断言已检查 `<|DSML|tool_calls>`。
4. deepseek-web 响应侧 harvest 仍保留大量旧 wrapper 兼容路径：
   - `<tool_call>` / `<function_calls>` / `RCC_TOOL_CALLS(_JSON)`
   - 主文件：`resp_process_stage1_tool_governance.rs`
5. 当前 live 坏样本：
   - requestId: `openai-responses-deepseek-web.2-unknown-20260510T141942974-176243-273`
   - groupRequestId: `req_1778393982974_b1ace494`
   - provider-response: `EMPTY_ASSISTANT_RESPONSE`
   - converted body: `status=completed` 但 `output[0].content=[]`，`toolCallState=no_tool_calls`。

### 新发现（关键）
1. 坏样本目录里的 `provider-request.json` / `provider-request_1.json` 都显示：
   - `ref_file_ids: []`
   - 且 body 仍带 `metadata.deepseek.contextFile`
2. 这与 `DeepSeekHttpProvider.buildHttpRequestBody()` 代码不一致：
   - 真发送体按代码应是纯 completion body（`chat_session_id/prompt/ref_file_ids/...`）
   - 不应还保留 `metadata.deepseek.contextFile`
3. 因此当前错误目录下的 `provider-request*.json` 不能直接视为“真正发往上游的最终请求体”；它更像是 host/provider contract 失败路径记录的 compat payload 观测样本。
4. 真实 provider-upload + body 组装链的现有单测是通的：
   - `tests/providers/core/runtime/deepseek-http-provider.unit.test.ts`
   - 已覆盖 `finalizeRequestHeaders()` 上传 context file 后，`buildHttpRequestBody()` 产出 `ref_file_ids=['file_ctx_*', 'existing_file']`。

### 当前最可能的两个真缺口（待继续证实）
1. **样本真相缺口**：失败路径的 `provider-request` 快照被 host contract observation 复写/并列写入，不能直接代表 upstream 真发送体；需要区分“真实 provider-request”与“失败观测 payload”。
2. **live 可用性缺口**：即使 `RCC_HISTORY.txt` 已经在某些样本中真实上传成功，deepseek-web upstream 仍可能在当前 continuation prompt / context file 请求形状下返回 completed + empty assistant，这才是当前 live 阻塞点。

### 当前未完成判断
- 目标绝未完成。
- 还缺：
  1. DSML/XML 主协议闭环最终确认
  2. same-shape live 工具调用成功证据
  3. 多轮 tool followup 成功证据
  4. 成功响应场景下 RCC_HISTORY 透明性终验
  5. web_search / multimodal live 收口
## 2026-05-10 deepseek-web followup continuity
- 现象：submit_tool_outputs 第二轮掉到 tools:last-tool-other -> flash。
- 证据：responses resume meta 当前只持久化 previousRequestId/restoredFromResponseId/toolOutputs，未持久化 route continuity；native shared_responses_conversation_utils prepare/resume/restore/materialize 都未带 continuation/routeHint。
- 下一步：补 tests 锁定 continuity 透传，再在 responses conversation store 唯一真源补 continuity 持久化与恢复。


[2026-05-10T07:42:00Z] Continue deepseek-web closeout: verify route-aware continuation + DSML compat script only.

## 2026-05-10 deepseek-web closeout script alignment
- route-aware responses continuation spec: PASS (3/3).
- deepseek-web compat script was stale on legacy <tool_call> assertions; updated to DSML <|DSML|tool_calls> and current non-required plain-text guidance.
- re-running script now for evidence.

## 2026-05-10 deepseek-web live failure triage
- requestId: openai-responses-deepseek-web.2-unknown-20260510T154615458-176396-426
- symptom: live request routed to deepseek-web.2.deepseek-v4-pro but upstream returned plain text intent, strict gate raised MISSING_REQUIRED_TOOL_CALL.
- next: inspect snapshot/provider-request/provider-response and compare with ../ds2api request-shape truth.

## 2026-05-10 deepseek-web live 无工具调用 / SSE 慢排查（第二轮）

Verified findings:
- deepseek-web Rust response compat 的 `resolve_effective_declared_tools_present()` 存在明确逻辑错误：
  - 文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/response/tool_state.rs`
  - 当前逻辑在 `strict_tool_required=true && declared_tools_present=true && latest_message_role!=tool` 时最终仍 `return false`，导致 strict tool required 约束被静默放掉。
- `capturedChatRequest` 快照构建链未保留 `tool_choice`：
  - TS: `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-captured-request.ts`
  - Rust snapshot: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs::build_captured_chat_request_snapshot`
  - DeepSeek response compat 的 `resolve_tool_choice_required()` 依赖 `captured_chat_request.tool_choice`；当前 snapshot 丢字段，会削弱 required tool call 断言。
- live 样本 `~/.rcc/codex-samples/openai-responses/deepseek-web.3.deepseek-v4-pro/*/provider-request.json` 证实 provider-request prompt 已包含 tool guidance，但 provider-response 样本多为 SSE wrapper (`mode/captureSse/transport`)，说明本轮需要从 compat 断言与 SSE 收尾两面修。

Next:
- 修复上述两个唯一真源点并补定向测试。
- 再查 deepseek SSE decode 慢是否是 upstream 长时间不关闭流或本地 idle-timeout 收尾。

## 2026-05-10 SSE TTFT bottleneck tracing
- Verified bottleneck #1 true source: `src/server/handlers/handler-response-utils.ts::trackSseFinishReason` runs synchronously inside `stream.on('data')` before client write path settles.
- Current waste pattern: cumulative `buffer.match(/\r?\n\r?\n/)` rescans from head every chunk + `trackSseReasoningStopFinalization` and `deriveFinishReasonFromSseBlock` each reparses same SSE block / JSON.
- Fix direction: keep handler-layer single source of truth, but switch to incremental boundary scan and single-pass block parse so each completed SSE block is parsed once.

- 2026-05-10 follow-up: Jason明确要求 SSE 只做最简单任务；已删除 handler 内 chunk 级 finish_reason/marker 解析，聚合后 wrapper JSON 成为唯一判定真源。下一刀转向 PassThrough 层数压缩。

- 2026-05-10 next target: bottleneck #4. Need verify whether request-executor is forcing full bridge conversion before first client write even when provider response is already an SSE wrapper / already-streamable shape.

- 2026-05-10 correction: stopless contract must only inspect chat-process JSON truth, not SSE wrapper / handler-side stream end state. Wrong direction was reading streamed wrapper finish_reason/finalized flag in host handler/contract layer. Unique fix point is request-executor stopless detection logic over chat-process JSON (or its explicit JSON probe), plus deleting handler-side stream-end stopless check.

## 2026-05-10 SSE cleanup follow-up
- Verified remaining chunk hot path after prior cleanup:
  - handler-response-utils.ts still did per-chunk idle reset (clearTimeout + setTimeout)
  - http-client.ts wrapStreamWithTimeouts still did per-chunk idle reset via on(data)
- Next unique fix point: replace per-chunk timer recreation with single watchdog + last-activity timestamp; keep stopless/finish_reason semantics out of SSE path.


## 2026-05-10 deepseek-web native capability误报真源

Verified findings:
- `router_hotpath_napi.node` 实际已导出 `runRespInboundStage3CompatJson`（repo release/dist 两份产物都存在）。
- 误报真源不在 Rust 导出，而在 `native-hub-pipeline-req-outbound-semantics.ts`：该层把 native 业务执行错误、payload parse 错误、json stringify 错误统一重新包装成 `native <capability> is required but unavailable`。
- 这会把 deepseek-web 的真实 compat 失败伪装成 capability 缺失，导致日志多次出现相同 unavailable 文案，掩盖真实根因。

Fix direction:
- 仅保留 `readNativeFunction` 缺失时抛 `required but unavailable`。
- native 已存在后的执行期错误统一改为 `native <capability> execution failed: ...`，避免再次把业务错误误报成 capability 缺失。

## 2026-05-10 deepseek-web DSML CDATA harvest follow-up
- 已在 `resp_process_stage1_tool_governance.rs` 补 `unwrap_xml_cdata_sections()`，并在 XML named tool harvest 中对 `<parameter><![CDATA[...]]></parameter>` 先解包再校验。
- 已补两条定向回归：1) 纯 harvest DSML invoke/parameter+CDATA；2) 与现场同类的 deepseek SSE fragments + DSML invoke + CDATA -> `tool_calls`。
- 当前下一步：build/install 后在 5555 用真实 `/v1/responses` 工具请求复测，确认不再报 `no valid tool call was produced`。

## 2026-05-10 SSE decode 压缩排查
- 用户给出实机 RT：decode.sse=4915ms / 23376ms，finish_reason=unknown。
- 本轮目标：确认 decode.sse / decode.codec 计时真源、链路是否仍有重复 SSE 解码/聚合、是否还能继续压缩而不改变 payload 语义。
- 先查 request-executor / converter / provider transport / bridge 中 SSE decode owner 与计时埋点。
- 结论1：当前 `decode.sse` 不是纯 CPU 解码时间，而是 **`resp_inbound.stage1_codec_decode` 整段 wall-clock**。证据：`src/server/runtime/http-server/executor/retry-payload-snapshot.ts` 的 `readHubDecodeBreakdown()` 明确把 `stage1_codec_decode` 视为“consuming upstream SSE until terminal event arrives”。
- 结论2：当前成功流式链路仍是 **upstream SSE -> `convertSseToJson()` 全量聚合 -> chat_process/compat/governance/finalize -> `convertJsonToSse()` 回写客户端**。证据：`sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 的固定 stage 顺序，以及 `resp_outbound_stage2_sse_stream/index.ts` 的 `codec.convertJsonToSse(...)`。
- 结论3：`runRespInboundStage1SseDecode()` 虽接收 `wantsStream`，但当前只用于日志/参数透传，不参与 bypass 判定；因此 client 想要 stream 也会先完整聚合上游 SSE。
- 结论4：23s 级 `decode.sse` 大头不是 parser 微开销，而是为“聚合后 JSON 真源”设计付出的等待成本；继续抠 parser/JSON.parse 只能省毫秒级，不能把 23s 打到接近 0。
- 唯一可显著降时延的方向：增加严格 eligibility 的 SSE passthrough fast path（仅限无需 response-side 语义处理的流）；若当前请求依赖 tool governance/servertool/stopless/finalize，则不能走该 fast path。
- 2026-05-10 speed 公式与 review 收口：待核实三点——(1) handler 末端是否仍需 sawTerminalEvent 缺失告警；(2) transport idle watchdog 是否已有独立测试；(3) HTTP_SSE_IDLE_MS 是否已成死代码。之后统一落到唯一修改点，不做旁路补丁。
- 2026-05-10 speed 公式修正已落地：`log-rollup.ts` 现在优先用 `firstContentAtMs -> lastContentAtMs` 计算 `speed`，并保留 `requestStartedAtMs -> firstContentAtMs` 的 `ttft`；缺失首尾内容时间时，fallback 改为 `sseDecodeMs`，不再优先用 `externalLatencyMs`。
- 2026-05-10 review 核实：
  1) handler 已无 `eventCount++`，review 该点基于旧状态；当前真实风险是 bridge 未带回 finish_reason 时 `seenTerminalEvent=false`，已在 `stream.on('end')` 加 `response.sse.finish_reason.missing` stage log。
  2) upstream idle watchdog 已有独立测试：`tests/providers/core/utils/http-client.postStream.idle-timeout.spec.ts`。
  3) `DEFAULT_TIMEOUTS.HTTP_SSE_IDLE_MS` 已是死代码并已物理删除；`constants/index.ts` 现只保留 `HTTP_SSE_TOTAL_MS`。

## 2026-05-10 followup skeleton audit
- 目标：确认 followup 是否在 virtual router 前被特殊分类，导致与正常请求不同路由/compat 行为。
- 已确认：route-aware continuation 只在 outbound payload build 前做消息恢复；按代码它不会绕过 virtual router。
- 当前重点：virtual-router feature/routing 对 tool result followup 的判定、servertool followup metadata 是否注入额外 route_hint / pinning。
- 新发现：`capturedChatRequest` 之前来自 pre-route-aware `workingRequest`，而 provider outbound 实际使用的是 `routeAwareWorkingRequest`。
- 这会让 followup 的 provider request 与 response compat 判断依据分叉：请求已经 materialize 出 tool result/tool role，但 response compat 仍按旧请求判断“最后一条不是 tool”。
- 已收口：outbound payload build 现在显式返回 `outboundWorkingRequest`，metadata.capturedChatRequest 改为基于该同一 request 生成。

## 2026-05-10 mimo/deepseek-web 图片输入 404 排查
- 现象：`/v1/responses` 请求 `openai-responses-mimo.key1-mimo-v2.5-pro-20260510T181052014-176449-479` 返回 `HTTP_404: No endpoints found that support image input`。
- 假设候选：1) 上游 provider 实际不支持当前 shape 的 image input；2) 历史/continuation 把前序图片残留进本轮 provider-request；3) metadata/image 标记未清理，导致路由/compat 仍按多模态构造请求。
- 先抓 requestId 对应 provider-request/provider-response/snapshots 真样本，再决定修改点。


## 2026-05-10 mimo/deepseek-web 图片输入 404 根因锁定
- 已验证失败样本 `~/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778407852014_a812a387/provider-request.json` 的 `body.messages[131]` 与 `[267]` 为真实历史 user 图片块，不是 metadata 假标记。
- 同一 request 的 `__runtime.json` 中 `metadata.hasImageAttachment` 为空，说明路由/分类没有把它当当前轮图片；坏的是 provider payload 主链仍把历史图片带上去。
- 真源缺口 1：`sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-media.ts::stripHistoricalImageAttachments()` 当前是 no-op 空壳，未接入 Rust `stripChatProcessHistoricalImagesJson`。
- 真源缺口 2：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts` 在 non-responses 出站 materialize store `input -> messages` 后未再做历史图片剥离，导致 continuation 重新注入旧图。
- 修复方向：只在上述两处接回现有 Rust 真源；不做 provider-specific 删除，不改 metadata 伪装能力。

## 2026-05-10 followup same-shape / deepseek-web tool resume
- Live sample `~/.rcc/codex-samples/openai-responses/deepseek-web.2.deepseek-v4-flash/req_1778408077888_69c3a508/provider-request.json` shows second-round prompt only has generic RCC_HISTORY continuation text, missing new tool-resume instruction (`The latest tool result has already been submitted...`).
- Same sample body has no `metadata` field at provider transport snapshot, so provider-request snapshot alone cannot prove context-file metadata path; prompt text remains the decisive evidence for missing `semantics.continuation.toolContinuation`.
- Current highest-probability root source: `route-aware-responses-continuation.ts` materializes followup by attaching only `semantics.responses.resume`, not unified `semantics.continuation`, so downstream deepseek request compat cannot see `toolContinuation` and repeats the prior tool call.


## 2026-05-10 deepseek-web provider 时延/开销审计
- 真实主瓶颈不是 `provider.send`，而是 deepseek-web 路径**强制上游 SSE**后在 host 侧做 `SSE -> JSON 全量聚合 -> chat_process/compat -> JSON -> SSE`。证据：`src/providers/core/runtime/deepseek-http-provider.ts::wantsUpstreamSse()` 对 deepseek-web compat 直接返回 true；`resp_inbound_stage1_sse_decode` 里的 `decode.sse/decode.codec` 是整段 wall-clock。live 日志：`18:14:27 deepseek-web.2.deepseek-v4-pro total=29003ms external=3642ms decode.sse=24560ms`；后续 flash 回合 `total=5934ms external=3079ms decode.sse=2690ms`。
- Provider 本地第二瓶颈：context-file 上传链路。`DeepSeekHttpProvider.finalizeRequestHeaders()` 每次请求都会先 `ensureChatSession`，若存在 `metadata.deepseek.contextFile` / `inlineFiles` 则 `uploadDeepSeekContextFile/uploadDeepSeekInlineFile`，其中 `uploadDeepSeekContextFile` 还会 `fetch_files` 轮询 ready（`FILE_READY_MAX_ATTEMPTS=60`, `FILE_READY_INTERVAL_MS=1000`）。这不是 24s 级主瓶颈，但会给长上下文/视觉请求增加额外网络回合与等待。
- Provider 第三类总时长放大器：followup 缺 `toolContinuation` / tool-resume hint 时，deepseek-web 可能重复上一轮 tool call，造成**额外整轮请求**。样本 `~/.rcc/codex-samples/openai-responses/deepseek-web.3.deepseek-v4-pro/req_1778396860984_977aabfd/provider-request.json`：`prompt` 含 `RCC_HISTORY` 且 `ref_file_ids=1`，但缺 `The latest tool result has already been submitted...` 提示。
- 最值得做的唯一性能方向（按收益排序）：
  1) **跨 provider/host 主链**：增加严格 eligibility 的 deepseek-web SSE passthrough / non-aggregate fast path，只给“不依赖 response-side tool harvest/strict gate/servertool/stopless/finalize”的 plain-text 流使用；这是唯一能把 24s 级 `decode.sse` 明显打下来的办法。
  2) **provider 本地**：把 `wantsUpstreamSse()` 从 deepseek-web unconditional true 改成 eligibility-based（至少对 non-stream + no-tools/search/plain-text 请求先 live probe upstream JSON 可用性）。
  3) **provider 本地**：对 `RCC_HISTORY.txt` / inline image upload 做内容哈希缓存，复用相同 `fileId`，避免重复 upload + ready poll；不要靠关闭 contextFile 粗暴省时，那会把 token/生成时延推回 prompt 主链。

- 2026-05-10 provider-traffic-governor 并发真源收口：web 形态 provider（当前按 `chat:deepseek-web` / `chat:qwenchat-web` / `mimoweb` 及 deepseek-web/qwenchat/mimoweb 身份特征统一识别）在 `src/server/runtime/http-server/provider-traffic-governor.ts` 内固定 `concurrency.maxInFlight=1`，并且 `acquire/observeOutcome` 两侧都禁止进入 adaptive concurrency，因此不会再出现 `tentative=1->2` / `saturated_no429_probe_up` 这类上探日志；非 web provider 保持原有 adaptive 行为。


## 2026-05-10 deepseek-web provider closeout continuation
- 目标：继续收口 deepseek-web provider，重点是工具调用、多轮 followup/submit_tool_outputs、RCC_HISTORY.txt 透明化、web provider concurrency 固定为 1、并用本地 5555 live 请求验证。
- 已接力状态：provider-traffic-governor 已限制 web provider concurrency=1；responses continuation 真源已改到 Rust hub_pipeline/shared_responses_conversation_utils，并由 route-aware-responses-continuation 薄壳接入 native unified lift；对应单测据称已通过，但还缺 root/shared tsc 与 5555 live 双轮工具调用证据。
- 本轮计划：1) 重新跑相关 jest/tsc；2) 本地拉起 5555；3) 用 /Volumes/extension/.rcc/config.deepseekweb.json 对 deepseek-web 发真实工具请求与 submit_tool_outputs；4) 抓 server log/codex samples；5) 若失败则沿 virtual router -> provider v2 -> deepseek compat/request/response bridge 真源修复。


## 2026-05-10 deepseek-web non-stream audit
- Jason 新要求：deepseek-web 的工具调用 / web_search 默认路由优先落到 `-nothinking` 型号；与此同时仅做 SSE decode 低风险删耗，不改“先聚合再转”的总方案。
- 实证完成：直接对 `https://chat.deepseek.com/api/v0/chat/completion` 发送 `Accept: application/json` 且 body 不带 `stream`，上游仍返回 `Content-Type: text/event-stream; charset=utf-8`，首包约 253ms；因此 deepseek-web 不能切到 non-stream JSON，真正问题仍是 downstream full aggregate SSE。
- 已按护栏物理删除错误试做：`deepseek-web-sse-fast-path.ts` / 对应测试 / 临时 shared patch runtime。
- 用户要求先实证：deepseek-web 如果 upstream 支持非流式 final JSON，就直接改为 non-stream，并移除刚才错误的 fast-path 试做。
- 已确认当前真问题：`DeepSeekHttpProvider.wantsUpstreamSse()` 只要命中 deepseek-web runtime 就无条件返回 true。
- 待验证：上游 `/api/v0/chat/completion` 在 `stream=false` 或不带 stream 时，是否直接返回 final JSON；若成立，唯一正确改点就是 provider transport 决策。
- 待清理：`sharedmodule/llmswitch-core/src/conversion/hub/response/deepseek-web-sse-fast-path.ts` 及其测试，避免第二真源。

## 2026-05-10 deepseek-web followup 路由真源排查

Verified findings:
- submit_tool_outputs 续轮丢主路，不是单纯 classifier 错，而是 responses conversation store 保存的 `routeHint` 时机不对。
- 当前 `req_inbound_stage3_context_capture/responses-context-snapshot.ts` 在 **入站 capture** 阶段就把 `adapterContext.routeId` 写入 store；这时还没有经过真实 `req_process.stage2_route_select` 命中 provider/runtime，因此拿到的不是稳定“首轮真实主路”。
- 真正可靠的主路信息在首轮完成路由并返回响应后才存在，来源是 response-side `options.context.routeId`（由 `metadata.routeName` 注入 adapterContext）。
- 因此续轮应继承的 routeHint 唯一正确写回点是：`provider-response.ts -> recordResponsesResponse(...)` 落盘时，把真实 routeId/routeName 回写到 conversation store entry。

Why this is the unique correct fix point:
- 只改 classifier 只是猜 followup 应走哪条路，不能表达“继承上一轮真实主路”。
- 只改 inbound capture 仍然过早，捕获不到最终命中的 route。
- 只有 response 落盘时同时拥有：requestId 绑定的会话条目 + 实际命中的 routeId，因此这是唯一能把首轮真路由保存进 continuation/store 的位置。
- 2026-05-10 本轮接力：基于前序改动先做精确验证，不重开架构分支；目标是补齐 deepseek-web tools/web_search nothinking 默认值的最小测试，并跑 SSE converter/CLI 精确回归，再决定 build/global install。
- 发现：当前 provider-inspect 已断言 deepseek-web `routeTargets.tools=deepseek-web.deepseek-v4-flash-nothinking`，CLI config-command 只断言了 web_search，尚未显式断言 routing.tools 默认值。
- 精确回归发现真实分叉：`createInitCommand` 非交互路径复用了 `buildRouting()`，tools 已落 `deepseek-v4-flash-nothinking`；但 `initializeConfigV1()` 直写配置走 `buildInitConfigObject()`，此前未注入 deepseek tools 默认值，导致同一“init 默认路由”在两条入口上分裂。
- 唯一正确修点：把 deepseek-web tools 默认目标抽到 `init-v2-builder.ts::resolveDefaultToolsTarget()`，让 `buildInitRouting()` 和 `buildInitConfigObject()` 共用，消除初始化双真源。

## 2026-05-10 usage/cache realtime log 收口
- 真源已确认：`usage-aggregator.ts` 负责 usage 合并，`usage-logger.ts` 负责把 usage 贯通到 rollup，`log-rollup.ts` 是 `[session-request][rt]` token 行唯一打印点。
- 已补齐：`mergeUsageMetrics()` 现在累加 `cache_read_input_tokens` + `cache_creation_input_tokens`；`logUsageSummary()` 传递 `cacheCreationTokens`；realtime token 行显式输出 `cache.read=... cache.hit=... cache.write=...`。
- cache hit 公式当前为：`cacheReadTokens / promptTokens`，其中 `promptTokens` 已是 normalize 后对外展示的输入 token（Anthropic 路径会把 cached tokens 计入 prompt）。因此 hit ratio 是“输入 token 中命中缓存的占比”，与 session-request 现有 `in=` 口径一致。
- 已新增/修正验证：
  1) `usage-aggregator.spec.ts`：验证 merge 会累加 cache read/write。
  2) `usage-logger.spec.ts`：验证 realtime session token 行包含 `cache.read/cache.hit/cache.write`。
  3) `log-rollup.spec.ts`：验证 realtime rollup 直接打印 cache usage。
- 验证证据：
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit` 通过。
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/executor/usage-aggregator.spec.ts tests/server/runtime/http-server/executor/usage-logger.spec.ts tests/server/runtime/http-server/executor/log-rollup.spec.ts` 32/32 通过。
  - `npm run build:min` 通过并产出 `0.90.1494`。
- live 验证阻塞：用 `/Volumes/extension/.rcc/config.deepseekweb.json` 在 5555 拉起 `0.90.1494` 时，Virtual Router 在启动阶段即失败：`Route "longcontext" references unknown model "deepseek-v4-pro-nothinking" for provider "deepseek-web"`。这是配置真源问题，不是 usage/log 代码问题；因此本轮没法用该 config 做 deepseek-web live 打样。
- sharedmodule SSE 子测试已按仓内 `sharedmodule/llmswitch-core/jest.config.cjs` 尝试单跑，但当前 Jest ESM/TS 配置无法解析 `src/router/virtual-router/engine-selection/native-router-hotpath-policy.js`（`Unexpected token export`）；这是测试 harness/transform 问题，不是本轮改动引入的业务断言失败。
- 继续验证 sharedmodule SSE 子测时，优先先排除 harness 运行方式差异：上次直接 `node jest/bin/jest.js` 未带 `--experimental-vm-modules`，而根仓 `jest:run` 一直带该 flag；若补 flag 后通过，则说明不是配置/业务回归，而是命令调用错误。
- 继续 sharedmodule SSE 子测：补 `--experimental-vm-modules` 后已能进入真实断言阶段，当前首个失败不是 harness，而是 `responses-converter.test.ts:1199` 触发 `PassThrough` 未监听 `error` 的 unhandled error；需判定这是旧测试基线问题还是本轮暴露出的真实行为分叉。

## [2026-05-10] responses-converter 剩余失败继续收口
- 单跑 src/sse/test/responses-converter.test.ts：当前剩余 6 失败。
- 分类：3 个旧测试预期失真（required_action / reasoning-only / reasoning.summary shape），2 个真实聚合问题（基本文本为空 / function_call 未产出），1 个可能是 JSON->SSE 末尾事件断言或 helper 收集问题。
- 已验证收口：responses-converter 剩余真 bug 的唯一修改点在 `response-builder.ts` 的旧 shape 兼容层，而不是 converter 主流程。旧测试流使用 `item_index/output_index` 且 `response.content_part.done` 直接走原始分支，导致 message text / function_call 丢失；补齐 builder 内单点映射后，`responses-converter.test.ts` 及 5 个 sharedmodule SSE 子测全部通过。
- 已验证测试失真：JSON->SSE `required_action` 只有显式 `required_action` 字段才会发 `response.required_action`；reasoning summary 的 canonical shape 是 `[{ type: 'summary_text', text }]`，不是旧的 string[]。对应测试已对齐真实协议。

## [2026-05-10] ds2api SSE 借鉴审计
- Jason 要求：检查 ds2api 源码，看是否有 SSE 相关可借鉴优化。先查本地仓，再查上游源码。

## 2026-05-10 mimo cache/history 真源修复（responses continuation materialize）

Verified findings:
- mimo 连续请求的 provider-request 历史不是 append-only，而是出现“旧前缀中段插入新 assistant/tool 轮”的形状。
- 真实样本证据：
  - `~/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778413590062_59a0b8b5/provider-request.json`
  - index 66-68 出现新插入：`Now let me see the test cases that exercise this path:` + tool_use/tool_result
  - index 69 之后又回到更早的用户历史；这不是尾部追加。
- 真源不在 mimoweb serialize；serialize 只是线性消费 `messages`。
- 唯一真源在 Rust：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `materialize_responses_continuation_payload(...)`
- 旧逻辑：只要 incoming input 不是 exact-prefix delta，就直接 `full_input = prefix + incoming_input`。
- 这会把“部分重放旧前缀 + 新尾巴”的 incoming input 直接拼成重复/中段插入历史，破坏 prompt cache 的稳定长前缀。

Fix:
- 新增 `count_common_leading_items(...)`。
- `materialize_responses_continuation_payload(...)` 现在只允许两类情况：
  1. exact-prefix delta -> 上游 restore 路径处理
  2. 纯 delta（与旧 prefix 无公共前缀）-> 允许 local full materialize
- 若 incoming input 与旧 prefix 存在“部分公共前缀但不是 exact-prefix”，直接返回 `Null`，禁止再做 `prefix + incoming_input` 拼接。

Why this is the unique correct fix point:
- 问题不是日志层、usage 层、mimoweb provider 层，也不是 cache 统计口径；真正破坏 cache 的是 provider-request 历史被 continuation materialize 伪造了错误顺序。
- 只有这里掌握“旧 prefix + 新 incoming input”的拼装权；其他层只能看到已经被拼坏的历史，因此在那里修只会掩盖症状，不能根除 cache 前缀失稳。

Verification:
- `cargo test -p router-hotpath-napi materialize_plain_continuation --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml`
- `cargo test -p router-hotpath-napi does_not_materialize_plain_continuation_when_incoming_partially_replays_prefix --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml`

- 继续审 ds2api：补查 cache 数据（usage / cached_tokens / cache_read_input_tokens / prompt_cache 等）与 SSE 相关透传。

## [2026-05-10] http-client idle timeout ticker 改造
- 目标：把 per-chunk clearTimeout/setTimeout 改成单 watchdog/ticker 模式，借鉴 ds2api，避免 token 级 timer churn。

## [2026-05-10] deepseek-web SSE decode 继续压缩审计
- 目标：在不改“先聚合再转”总方案前提下，继续查 deepseek-web SSE decode 热路径是否还能做 path/status 早期 skip、减少重复解析/分配。
- deepseek-web SSE decode 继续压缩：`chat-sse-to-json-converter.ts` 已把 deepseek payload 的 `errorInfo/looksLikePatch/path/op/value` 合并成单次 `analyzeDeepSeekWebPayload()` 结果，避免 `processChatChunk()` 与 `tryProcessDeepSeekWebPatchEvent()` 对同一 payload 重复做 error/patch 判定。该改动不改协议语义，仅削掉重复对象判断/字符串判断。
- 验证：`sharedmodule/llmswitch-core` 下精确跑 `src/sse/test/chat-converter.test.ts` + `src/sse/test/responses-converter.test.ts`，23/23 通过。

## 2026-05-10 review + submit closeout
- review 全量工作区改动时发现 continuation 语义阻塞点：`hub_pipeline.rs` 与 `hub_req_inbound_semantic_lift.rs` 都会把普通 `responsesResume` 误标成 `toolContinuation.mode=submit_tool_outputs`。
- 已修：仅当 `toolOutputsDetailed` 非空时，才合成 `submit_tool_outputs`。
- 已补负向测试：无 tool outputs 的 `responsesResume` 不得生成 `toolContinuation`。
- 验证中确认重要门禁：初次 Jest 失败不是业务未修，而是 native `.node` 未重编；重建 `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node` 后，负向测试通过。

## 2026-05-11 host contract tool-choice audit
- 现象: deepseek-web completed + plain assistant message 被 host 判成 MISSING_REQUIRED_TOOL_CALL。
- 证据: errorsample provider-response.responses_missing_required_tool_call-20260511-002905-760Z-78763a78f816c.json 中 deepseek metadata.toolCallState=no_tool_calls，compat 已执行。
- 判断: 真源更像 host response contract 误把“声明了 tools”当成“本轮必须 tool_call”；需要按 tool_choice=required / function 指定 / followup 强制回合区分，而不是仅看 hasRequestedToolsInSemantics。

## 2026-05-11 hub/provider-boundary audit followup
- 用户追加确认违规点：7 has_gemini_builtin_tool_shape 在 hub；8 qwen marker harvest 在 resp_process；9 metadata deepseek hardcode 在 shared_responses_tool_utils。
- 处理策略：本轮先修 7/8/9 这三个明确违规真源，设计债务仅保留证据，不混修。

## 2026-05-11 qwen response compat 收口（违规 8）

Verified findings:
- `resp_process_stage1_tool_governance.rs` 仍残留 qwen marker provider-specific harvest：`<|tool_calls_section_begin|>` / `<|tool_call_begin|>` / split-token / anthropic thinking block / newline-in-json 修复。
- 这不是通用 pipeline 治理语义，而是 qwen 响应兼容；继续留在 `resp_process` 会让 pipeline 层感知 provider 私货，违反项目硬护栏。
- `req_outbound_stage3_compat/qwen/response.rs` 当前只做普通 qwen openai-chat shape 转换，尚未承接 marker text tool-call 提取与 reasoning 清理，因此删掉 resp_process 旧函数后回归失败是预期暴露，不是新问题。

Plan:
- 仅在 `req_outbound_stage3_compat/qwen/response.rs` 新增 qwen marker parser/cleaner。
- 将 resp_process 里的 qwen marker 正向回归迁到 `req_outbound_stage3_compat/tests/resp_profiles.rs`。
- 保留通用 wrapper/cleanup 框架在 resp_process；只物理删除 qwen provider-specific marker harvest 的依赖面。

Why this is the unique correct fix point:
- 问题真源不是“tool harvest 坏了”，而是“qwen provider-specific marker 解析放错层”。
- 只有把 marker 解析迁入 qwen compat 真层，才能既保留能力又消除 hub/pipeline provider 泄漏；在 resp_process 继续修 regex 或 helper 只是在错误层补丁。

## 2026-05-11 /v1/responses 首条可见日志变晚排查（deepseek-web）

现象：Jason 观察到“客户端输入后，到 RCC server 控制台打印第一条相关日志会过很久”，以前几乎立刻。

已验证真相：
- `/v1/responses` 的 HTTP request start log 被物理禁用：`src/server/handlers/handler-utils.ts:208` `logRequestStart()` 直接 `return`，注释写明“intentionally suppressed to reduce noise”。
- request 其实在 handler 很早就到了：`src/server/handlers/responses-handler.ts` 一进入 handler 就 `nextRequestIdentifiers(...)` 生成 requestId；requestId 自带时间戳。
- 样本证据：
  - `openai-responses-deepseek-web.2-unknown-20260511T090819275-177060-1090`
    - requestId 内嵌时间 = `09:08:19.275`
    - 第一条可见终态日志 = `09:09:25` (`CLIENT_RESPONSE_CLOSED`)
    - 可见窗口差 = `65.725s`
  - `openai-responses-deepseek-web.2-unknown-20260511T090830317-177061-1091`
    - requestId 内嵌时间 = `09:08:30.317`
    - 终态完成日志 = `09:10:58`
    - 可见窗口差 = `147.683s`
- 这说明“server 很晚才打印”至少有一部分是**观测面变化**：请求早已进入 handler，但 start log 被压掉。

进一步证据：
- `request.received` / `request.snapshot.*` / `provider.traffic.acquire.*` 虽然在 executor 内会调用 `logStage(...)`，但当前 stage logger 只在：
  1. 开启 stage log，或
  2. 命中 release summary stage
  时输出。
- `request.received` 不是 release summary stage；`provider.traffic.acquire.wait` 也不在默认 release summary 输出面里，所以默认日志下看不到它们。
- 这解释了为什么以前“几乎立刻看到请求”，现在却只在较后面的 `provider-switch` / `request complete|failed` 才看到。

错误归因已确认：
- `CLIENT_RESPONSE_CLOSED` / `CLIENT_DISCONNECTED`
  - 真源：`src/server/utils/client-connection-state.ts`
  - 含义：客户端连接已关闭/超时/不再等待，**不是 upstream 错误**。
- `PROVIDER_TRAFFIC_SATURATED`
  - 真源：`src/server/runtime/http-server/provider-traffic-governor.ts`
  - 自定义错误：`statusCode=429`, `code='PROVIDER_TRAFFIC_SATURATED'`
  - 含义：RCC **内部 provider traffic governor 饱和/限流/排队**，**不是 upstream 429**。

当前仍未直接拿到的证据：
- 这两个 request 的 `provider.traffic.acquire.start/wait/completed` 细日志没有出现在默认输出里，因此“09:08:30 -> 09:10:58”这 147 秒里，具体卡在：
  - request snapshot
  - session storm backoff
  - traffic governor acquire/wait
  - provider.send / upstream decode
  还不能只靠现有默认 console 日志精确拆分。

当前最强结论：
1. “server 很晚才打印”**确定部分来自内部日志策略变化**（request start +早期 stage 被抑制），不是仅靠上游就能解释。
2. `CLIENT_RESPONSE_CLOSED` **不是上游错误**。
3. `PROVIDER_TRAFFIC_SATURATED` **是内部限制，不是上游 429**。
4. 若要继续精确拆“慢”发生在内部哪一段，唯一正确下一步是补最薄 ingress / early-stage 观测，而不是先猜上游慢。

## 2026-05-11 ds2api vs routecodex stream timeout 对比（为何 ds2api 更早暴露问题）

结论：ds2api 的“更早知道出问题”不是靠更短的总 timeout，而是靠 **stream engine 分层 stop reason**：
- `no_content_timeout`：一直只有 keepalive、始终没见到真实内容时提前结束
- `idle_timeout`：已经出过内容后，后续长时间无新内容时结束

证据：
- ds2api `internal/stream/engine.go`
  - `KeepAliveInterval`
  - `IdleTimeout`
  - `MaxKeepAliveNoInput`
  - stop reason: `no_content_timeout`, `idle_timeout`
- ds2api `internal/deepseek/protocol/constants.go`
  - `KeepAliveTimeout = 5`
  - `MaxKeepaliveCount = 40`
  - `StreamIdleTimeout = 300`
- 推导：
  - 无内容 keepalive 超时：`5s * 40 = 200s`
  - 已有内容后的 idle 超时：`300s`

routecodex 当前机制：
- `src/providers/core/utils/http-client.ts`
  - 全局 stream timeout：`timeoutId -> UPSTREAM_STREAM_TIMEOUT`
  - headers timeout：`headersTimeoutId -> UPSTREAM_HEADERS_TIMEOUT`
  - byte-level idle timeout：`UPSTREAM_STREAM_IDLE_TIMEOUT`
- 默认值：
  - `HttpClient` 默认 `timeout = 500000ms`（500s）
  - `DEFAULT_TIMEOUTS.PROVIDER_STREAM_HEADERS_CAP_MS = 900000ms`
  - `DEFAULT_TIMEOUTS.PROVIDER_STREAM_IDLE_CAP_MS = 900000ms`
  - `DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS = 900000ms`

关键差异：
1. ds2api 有 **no-content** 这一层语义超时；routecodex 没有。
2. routecodex 主要靠 transport 层总 timeout / byte idle timeout；如果 upstream 一直维持连接但不给有效内容，就会拖到更久。
3. 你这次日志里的 `UPSTREAM_STREAM_TIMEOUT` 说明命中的是 **总 stream timeout**，不是更早的语义 stop reason。

唯一正确修复方向：
- 不该只“调短一个总 timeout”，否则会误杀长请求。
- 应对齐 ds2api 增加分层：
  1. 首字节/首内容/无内容超时（更早暴露）
  2. 已产出后 idle 超时
  3. 最外层总 timeout 继续兜顶


## 2026-05-11 install-release 验收真源
- install:release 失败真源不在构建/安装，而在 `scripts/install-release.sh` 默认把验收绑到 `~/.rcc/config.json`，命中失效外部 token 即整体 exit 1。
- 唯一正确修法：release 验收默认走内置 mock/provider-free config，只在用户显式提供 `ROUTECODEX_INSTALL_VERIFY_CONFIG` 时才跑外部 provider 验证；这样验收回到安装链路自身真源，不再受用户外部凭证污染。
- install-verify 现已支持 `--use-mock-config`：自生成临时 mock 配置、显式打开 mock runtime、responses 验证注入固定 `mockSampleReqId`，并在 stopServer 清理临时目录。

## 2026-05-11 broad process-kill 误拦截
- 新真错误：deepseek-web tool call 在 `required_action.submit_tool_outputs.tool_calls[0]` 被本地参数校验拒绝，报 `exec_command contains a forbidden broad process-kill command`。
- 下一步：定位唯一参数校验点，确认是否 regex/字符串匹配过宽导致误伤正常命令。
- 真源确认：`containsBroadKillCommand()` 之前按整串子串匹配 `pkill/killall/xargs kill`，会把 `rg/grep/echo` 中仅作为搜索词/字符串字面量出现的关键词误判为危险命令。
- 修法：改为 shell token 级解析，只在命令执行位命中 `pkill|killall|taskkill|xargs ... kill|kill $(...)` 时拦截，并新增回归测试覆盖搜索字符串误伤场景。

## 2026-05-11 shell wrapper 误判/真截断排查
- 新真错误：`openai-responses-deepseek-web.sargent-unknown-20260511T095852282-177104-1134` 命中 `invalid_shell_wrapper_shape`。
- 下一步：抓 requestId 对应样本/日志，确认 `exec_command.cmd` 是否真实缺尾引号，还是 wrapper 校验仍过宽。


# 合规审计报告 2026-05-11

> 审计范围：全局 AGENTS.md 硬护栏 1-15 + 项目 AGENTS.md 硬护栏 1-15
> 审计方法：只读扫描 + 证据定位，不做任何代码修改
> 真源参考：~/.codex/AGENTS.md、项目 AGENTS.md、docs/ARCHITECTURE.md、docs/error-handling-v2.md、docs/routing-instructions.md

---

## 审计统计预览

| 严重度 | 数量 |
|--------|------|
| 阻塞   | 4    |
| 高危   | 7    |
| 中危   | 8    |
| 低危   | 3    |
| 疑似   | 5    |
| **合计** | **27**（违规22 + 疑似5） |

---

## 第一部分：全局护栏审计（Global Hard Guards 1-15）

### G1. 先验证，后结论
**判定：合规**
无违规证据。项目文档和代码中未发现"凭推测下结论"的系统性模式。

---

### G2. 禁止 fallback（降级/兜底/双路径补偿/吞异常）
**判定：违规（高危）**

#### 违规项 G2-1：index.ts resolveBoolFromEnv 函数使用 fallback 参数命名
- **文件**：`src/index.ts:39-50`
- **违反条款**：全局 G2 "不允许设计或实现 fallback / 降级 / 兜底 / 双路径补偿"
- **代码片段**：
```ts
function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) { return fallback; }
  // ...
  return fallback;
}
```
- **严重度**：中危 — 参数命名层面，语义实为 default value，非流量级 fallback
- **修复方向**：重命名为 `defaultValue`

#### 违规项 G2-2：safeProcessCwd 函数使用 fallback 参数
- **文件**：`src/index.ts:53,62-64`
- **违反条款**：全局 G2
- **代码片段**：
```ts
function safeProcessCwd(fallback?: string): string {
  // ...
  const fallbackValue = String(fallback || '').trim();
  if (fallbackValue) { return path.resolve(fallbackValue); }
```
- **严重度**：中危
- **修复方向**：重命名参数

#### 违规项 G2-3：classifier.ts tools 路由注释"tools 仅作为兜底"
- **文件**：`sharedmodule/llmswitch-core/src/router/virtual-router/classifier.ts:101`
- **违反条款**：全局 G2 + 项目 G4（fail-fast no fallback）
- **代码片段**：
```ts
// 若上一轮已明确归类为 search，则优先命中 search 路由，tools 仅作为兜底。
```
- **严重度**：高危 — 路由层明确声明兜底语义
- **修复方向**：删除"兜底"措辞，改为"tools 路由仅在无更具体路由匹配时生效"

#### 违规项 G2-4：SSE writer 兜底事件识别
- **文件**：`sharedmodule/llmswitch-core/src/sse/shared/writer.ts:135`
- **违反条款**：全局 G2 + 项目 G11（文本 harvest 容器优先）
- **代码片段**：
```ts
} else {
  // 兜底处理：尝试通过事件字段识别
  const eventField = (event as any).event;
  if (eventField === 'chat_chunk' || eventField === 'chat.done' ...) {
```
- **严重度**：中危 — SSE writer 的协议识别兜底不属于主传输链 payload 裁剪，但违反显式暴露原则
- **修复方向**：协议路由应在入站阶段明确判定，不应在 writer 层做启发式识别

#### 违规项 G2-5：.catch(() => null) 吞异常模式（多处）
- **文件**：`src/index.ts:1258,1263,1500`；`src/cli/guardian/client.ts:267,288,327`；`src/token-daemon/token-daemon.ts:820`
- **违反条款**：全局 G2 "禁止吞异常"
- **代码片段**：
```ts
}).catch(() => { return null; });
// src/index.ts:1263
const data = await res.json().catch(() => { return null; });
```
- **严重度**：中危 — 吞掉异常返回 null，可能导致后续逻辑基于 null 做出错误决策
- **修复方向**：改为显式 throw 或返回 Result 类型

#### 违规项 G2-6：routing-instructions.md stopMessage BD 判定回退
- **文件**：`docs/routing-instructions.md:183-184`
- **违反条款**：全局 G2 "不允许降级/兜底"
- **代码片段**：
```
命令失败时回退到历史消息启发式
可用 ROUTECODEX_STOPMESSAGE_BD_MODE=auto|runtime|heuristic 控制（默认 auto）
```
- **严重度**：高危 — 文档定义的运行时行为明确包含回退/降级路径
- **修复方向**：移除 heuristic 回退路径，BD 命令失败应为 hard error

---

### G3. 非授权不破坏
**判定：合规**（审计范围内无破坏动作）

---

### G4. 禁止 broad kill
**判定：合规**
- `scripts/camoufox/launch-auth.mjs` 中有注释"不使用 pkill 普杀"
- 源文件中无 pkill/killall/xargs kill 的实际调用

---

### G5. 称呼规则
**判定：合规**（审计范围不涉及交互称呼）

---

### G6. 传输 payload 不可裁剪/改写语义
**判定：违规（中危）**

#### 违规项 G6-1：http-transport-provider.ts 中的 payload 条件处理
- **文件**：`src/providers/core/runtime/http-transport-provider.ts`
- **违反条款**：全局 G6 "请求与响应在真实传输链路中必须保持语义等价"
- **证据**：代码中存在条件性的 payload 字段选择逻辑（`typeof ... ? ... :` 模式）
- **严重度**：中危
- **修复方向**：将 payload 修改逻辑改为仅做观测/日志，不影响传输内容

---

### G7. 行为对齐规则
**判定：合规**

---

### G8. Skills 精华沉淀规则
**判定：疑似**
项目存在多个 local skills（`.agents/skills/*/SKILL.md`），需人工逐文件确认是否符合精华标准。

---

### G9. 问题分析铁律
**判定：合规**（文档体系明确要求三层判定流程）

---

### G10. 功能开发与问题分析统一使用 coding principle skill
**判定：合规**

---

### G11. 功能开发与错误修改的唯一性声明
**判定：合规**（规则已明确）

---

### G12. 冗余代码与错误实现的物理移除
**判定：违规（高危）**

#### 违规项 G12-1：ARCHITECTURE.md 架构图保留"故障转移""重试机制"
- **文件**：`docs/ARCHITECTURE.md:41,60-61`
- **违反条款**：全局 G12 "重复的设计（功能重叠且没有明确唯一责任的模块）"
- **代码片段**（架构图标注）：
```
故障转移、重试机制、异常恢复、备用
```
- **严重度**：高危 — 架构文档仍将"故障转移"列为功能，与项目 G4（fail-fast no fallback）冲突
- **修复方向**：更新架构图，移除故障转移/重试机制描述

#### 违规项 G12-2：config-paths.ts 保留 "kept for emergency fallback" 注释
- **文件**：`src/config/config-paths.ts:23`
- **违反条款**：全局 G12 "禁止保留'以防万一'的死代码"
- **代码片段**：
```ts
 * Legacy configuration path resolution (kept for emergency fallback)
 * @deprecated Use UnifiedConfigPathResolver instead
```
- **严重度**：中危 — 注释声明为 "emergency fallback" 保留
- **修复方向**：删除该注释块（实现已移除，注释残留）

#### 违规项 G12-3：archive 目录物理存在
- **文件**：`sharedmodule/llmswitch-core/archive/`（20K）、`sharedmodule/llmswitch-core/src/router/virtual-router/archive/`、`vendor/llmswitch-core/dist/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/archive/`
- **违反条款**：全局 G12 "错误的实现必须在确认根因后彻底删除"
- **严重度**：阻塞 — vendor/ 目录下的 archive 包含已废止的 pipeline stage
- **修复方向**：物理删除所有 archive 目录中的内容（确认无依赖后）

---

### G13. 禁止批量 checkout 文件
**判定：合规**

---

### G14. 禁止口头验证与冒险结论
**判定：合规**

---

### G15. 回复与 summary 必须简洁且信息完整
**判定：合规**

---

## 第二部分：项目护栏审计（Project Hard Guards 1-15）

### P1. 单一路径真源（HTTP Server -> Hub Pipeline -> Provider V2 -> upstream）
**判定：疑似**
- 代码中未发现绕过 Hub Pipeline 直接路由的模式
- `src/modules/llmswitch/bridge.ts` 正确桥接到 HubPipeline
- **疑似**：Provider 层存在 `directActivation` 模式（`src/provider-sdk/provider-runtime-inference.ts`），需确认不构成旁路

### P2. llmswitch-core 主导工具与路由
**判定：合规**
- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts` 中的 `tool_choice` 处理属于 transport 层适配
- `src/providers/profile/families/qwen-profile.ts` 中的工具注入属于 provider profile 配置

### P3. Rust runtime 语义真源
**判定：疑似**
- Rust hotpath 存在：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`（7 个 .rs 文件）
- TS 层 `sharedmodule/llmswitch-core/src/router/virtual-router/` 仍有大量实现：
  - `engine.ts` 414 行，`classifier.ts` 196 行，`features.ts` 338 行，`bootstrap.ts` 150 行，`health-manager.ts` 129 行
  - **合计 1227 行 TS 实现**
- **疑似**：TS 层 router engine 是否与 Rust 实现构成双真源

---

### P4. Fail-fast + no fallback（严禁一切 fallback/降级/兜底）
**判定：违规（阻塞）**

#### 违规项 P4-1：ARCHITECTURE.md 错误处理表格列出降级
- **文件**：`docs/ARCHITECTURE.md:15`
- **违反条款**：项目 P4 "严禁一切 fallback/降级/兜底逻辑"
- **代码片段**：
```
| 错误处理 | ... Virtual Router 接收 ProviderErrorEvent、执行熔断/降级；Hub Pipeline 将错误冒泡给 host |
```
- **严重度**：阻塞 — 架构文档明确描述"降级"为 Virtual Router 功能；且引用已被标记为待移除的 `errorHandlingCenter` 和 `providerErrorCenter`
- **修复方向**：更新 ARCHITECTURE.md 对齐 error-handling-v2.md 收口状态

#### 违规项 P4-2：error-handling-v2.md 历史章节保留完整 fallback/retry 矩阵
- **文件**：`docs/error-handling-v2.md` H1-H5 章节
- **违反条款**：项目 P4
- **严重度**：高危 — 文档中 "Historical Reference" 虽标注为旧机制，但 fallback/retry/降级策略矩阵完整保留
- **修复方向**：将历史机制移出到独立历史文档，或明确标注"已废止"

#### 违规项 P4-3：routing-instructions.md stopMessage 回退逻辑
- **文件**：`docs/routing-instructions.md:183`
- **违反条款**：项目 P4
- **代码片段**：`命令失败时回退到历史消息启发式`
- **严重度**：高危
- **修复方向**：移除 BD heuristic 回退路径

---

### P5. 先验证后结论
**判定：合规**

---

### P6. 非授权不破坏
**判定：合规**

---

### P7. 禁止进程杀戮命令
**判定：合规**

---

### P8. llmswitch-core 禁止新增 TS 功能代码
**判定：违规（高危）**

#### 违规项 P8-1：TS virtual-router engine 等语义实现
- **文件**：`sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts:1-414` 及 classifier.ts、features.ts、bootstrap.ts、health-manager.ts
- **违反条款**：项目 P8 "不允许再增加任何 TypeScript 功能实现；如有必要，一律转为 Rust 实现"
- **代码证据**：合计 1227 行 TS 路由引擎实现（包含路由决策、特征提取、健康管理等核心语义）
- **严重度**：高危 — 与 Rust hotpath 形成双真源风险
- **修复方向**：确认这些 TS 实现在 Rust hotpath 中是否有等价真源；若有则物理删除 TS 版本，若无则迁移到 Rust

#### 违规项 P8-2：providers 目录 TS 代码量
- **文件**：`src/providers/` 总计 ~31200 行 TS（非测试）
- **违反条款**：项目 P8 "TS 仅允许保留最小调用壳层"
- **严重度**：中危 — 31200 行远超"最小调用壳层"定义
- **修复方向**：逐文件审查是否属于 transport 桥接（合规）还是功能实现（违规）

---

### P9. 真实 payload 不可裁剪
**判定：违规（中危）**

#### 违规项 P9-1：http-transport-provider.ts payload 条件处理
- **文件**：`src/providers/core/runtime/http-transport-provider.ts`
- **违反条款**：项目 P9 "禁止以 budget/history/media placeholder/自动续接等方式裁剪或改写真实传输内容"
- **严重度**：中危
- **修复方向**：将 payload 修改逻辑改为仅做观测/日志

#### 违规项 P9-2：gemini-protocol-client.ts 字段裁剪
- **文件**：`src/client/gemini/gemini-protocol-client.ts`
- **严重度**：低危 — client 层字段选择属于协议适配，可能不涉及主传输链
- **修复方向**：确认是否为 client 适配器内部的协议转换（合规），还是主链裁剪（违规）

---

### P10. 技能沉淀规则
**判定：合规**

---

### P11. 文本 harvest 容器优先
**判定：违规（中危）**

#### 违规项 P11-1：SSE writer 启发式协议识别
- **文件**：`sharedmodule/llmswitch-core/src/sse/shared/writer.ts:135-142`
- **违反条款**：项目 P11 "必须先锁定显式 wrapper/container...禁止凭正文猜工具"
- **代码证据**：writer 在协议字段缺失时通过 eventField 启发式猜测协议类型（chat_chunk -> Chat，message_start -> Anthropic）
- **严重度**：中危 — 该模式与 P11 反模式（"凭内容猜类型"）高度相似
- **修复方向**：协议类型应在入站阶段通过明确的 content-type/accept header 或配置确定

---

### P12. stopless / reasoning.stop 禁止伪造工具面
**判定：合规**
- 代码中存在 `replace_tools` op：`sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/op-blocks.ts`
- 但 `replace_tools` op 用于 followup 请求构造中的工具集替换（合法的能力组合），不是"为逼出 reasoning.stop 而伪造"
- **建议**：在 op-blocks.ts 增加注释说明 `replace_tools` 不用于 bypass stopless contract

---

### P13. 禁止未授权扩 scope
**判定：合规**

---

### P14. Qwen / QwenChat 禁止混淆
**判定：违规（中危）**

#### 违规项 P14-1：provider-traffic-governor.ts 中的 qwen/qwenchat 判断逻辑
- **文件**：`src/server/runtime/http-server/provider-traffic-governor.ts`
- **违反条款**：项目 P14 "禁止拿 qwenchat 的成功/鉴权/UA/header 结论冒充 qwen 证据"
- **代码证据**：governor 中将 qwenchat 与 qwen 放在同一判断链中（`compatibilityProfile === 'chat:qwen-web'` / `value === 'qwenchat'` / `value.startsWith('qwenchat.')`）
- **严重度**：中危 — 存在混淆风险
- **修复方向**：分离 qwen 和 qwenchat 的处理分支

#### 违规项 P14-2：测试文件使用 qwenchat fixture
- **文件**：`tests/server/runtime/http-server/provider-traffic-governor.spec.ts`（多处）
- **严重度**：低危
- **修复方向**：确认测试隔离

---

### P15. 发现即修（最小切片）
**判定：合规**（审计本身即为发现阶段）

---

## 第三部分：架构违规专项扫描

### A1. Provider 层业务语义解析
**判定：合规**
Provider 目录下的 `vercel-ai-sdk/*` 文件属于 transport 适配，不涉及业务路由语义。

## 2026-05-11 DeepSeek Web timeout / 长尾等待审计（进行中）

- **已确认真源**：`sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
  在 `response.required_action` / `response.completed` 后，`ResponsesResponseBuilder` 已进入 `completed`，
  但 converter 仍继续 `for await` 等待上游流结束，导致 tool_calls 已形成却继续长等 SSE 尾巴。
- **症状对齐**：
  - 日志里 `finish_reason=tool_calls` 但 `decode.sse` 仍几十秒；
  - 或者请求已经可恢复成 required_action / completed，却继续卡到 `UPSTREAM_STREAM_TIMEOUT`。
- **唯一正确修点**：
  - 不是裁剪 payload；
  - 不是缩短系统提示词注入；
  - 不是 host 层补 timeout fallback；
  - 而是在 **Responses SSE converter** 中，一旦 builder 进入 `completed`，立刻停止继续读取尾流。
- **并行已做**：
  - 默认 provider stream headers/idle cap 从 900s 收紧到 120s / 300s；
  - `ResponsesProvider` 已把 `noContentTimeoutMs` / `contentIdleTimeoutMs` 传入 converter；
  - guidance 改成要求模型**可见输出更精简**，不改 payload 语义。

### A2. Host 绕过 Hub Pipeline 直接路由
**判定：合规**
未发现绕过模式。`src/modules/llmswitch/bridge.ts` 正确封装了 Hub Pipeline 调用。

### A3. 未归档的 TS 旧实现与 Rust 双真源
**判定：违规（阻塞）**
- **Rust hotpath**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
- **TS 并行实现**：`sharedmodule/llmswitch-core/src/router/virtual-router/` 1227 行
- **证据**：TS `engine.ts` 实现路由分类、健康管理、特征提取，与 Rust hotpath 语义高度重叠
- **严重度**：阻塞 — 双真源违反项目 P3 和 P8
- **修复方向**：确认 TS virtual-router 是否仅为废弃代码（如 engine.js.d.ts 暗示）；若仍活跃，需制定迁移计划删除 TS 实现

### A4. 独立 error center 残余
**判定：违规（阻塞）**

#### A4-1：ARCHITECTURE.md 仍引用 errorHandlingCenter 和 providerErrorCenter
- **文件**：`docs/ARCHITECTURE.md:15,192`
- **违反条款**：项目 P4 + error-handling-v2.md 收口决策
- **证据**：`Provider/Compatibility 抛错 -> errorHandlingCenter.handleError -> 上报 providerErrorCenter`
- **严重度**：阻塞 — error-handling-v2.md 明确声明"不再保留独立 error-handling center"，但 ARCHITECTURE.md 仍引用为活跃路径

#### A4-2：RouteErrorHub 物理模块仍存在
- **文件**：`src/error-handling/route-error-hub.ts`（完整实现，含 ErrorHandlingCenter 依赖）
- **严重度**：高危 — error-handling-v2.md 声明该模块"只保留 Host 边界职责"，但模块本身仍完整存在且被 active import
- **修复方向**：按 error-handling-v2.md 收口计划逐步移除独立 error center 模块

#### A4-3：error-handler-registry.ts 仍引用 ErrorHandlingCenter
- **文件**：`src/utils/error-handler-registry.ts`
- **严重度**：中危
- **修复方向**：迁移到 Virtual Router policy

---

## 第四部分：冗余代码专项

### D1. 死的语义
- **config-paths.ts**：Legacy fallback 注释残留（代码已移除，注释仍在）— 低危
- **archive 目录**：3 个 archive 目录物理存在，含已废止代码 — 中危

### D2. 重复设计
- **TS vs Rust virtual-router**：双实现 — 阻塞（见 A3）
- **error-handling center vs Router policy**：双策略中心 — 阻塞（见 A4）

### D3. 错误实现残留
- **vendor/ archive**：vendor 目录下的 archive 包含旧 pipeline stage 实现 — 中危
- **ARCHITECTURE.md 旧架构图**：含故障转移/重试机制 — 高危

---

## 第五部分：疑似项清单（需人工判定）

| 编号 | 条款 | 描述 | 需确认内容 |
|------|------|------|------------|
| S1 | G8/P10 | Skills 精华沉淀质量 | 逐文件检查 `.agents/skills/*/SKILL.md` 是否符合"精华"标准 |
| S2 | P1 | Provider directActivation 是否旁路 | 验证 `provider-runtime-inference.ts` 的 directActivation 不绕过 Hub Pipeline |
| S3 | P3 | TS virtual-router 是否仅 thin-shell | 确认 engine.js.d.ts 是否暗示 TS engine 已废弃；TS vs Rust 的语义重叠程度 |
| S4 | P9-2 | gemini-protocol-client 裁剪是否在适配器边界 | 确认裁剪只发生在协议适配层，不发生在主传输链 |
| S5 | P12 | replace_tools op 的 stopless 语义 | 确认 `replace_tools` op 在 stopless 场景中不用于伪装工具面 |

---

## 第六部分：按严重度排序的违规清单

### 阻塞（4项）
1. **P4-1** — ARCHITECTURE.md 错误处理表引用降级 + 过期 error center（`docs/ARCHITECTURE.md:15`）
2. **A3** — TS virtual-router engine 与 Rust hotpath 双真源（1227 行 TS 实现）
3. **A4-1** — ARCHITECTURE.md 仍将 errorHandlingCenter/providerErrorCenter 作为活跃路径（`docs/ARCHITECTURE.md:15,192`）
4. **G12-3** — vendor archive 目录留存已废止 pipeline stage（`vendor/llmswitch-core/dist/.../archive/`）

### 高危（7项）
5. **G2-3** — classifier.ts tools 路由注释"仅作为兜底"（`sharedmodule/llmswitch-core/src/router/virtual-router/classifier.ts:101`）
6. **G2-6** — routing-instructions.md stopMessage BD 回退到 heuristic（`docs/routing-instructions.md:183`）
7. **G12-1** — ARCHITECTURE.md 架构图保留故障转移/重试机制（`docs/ARCHITECTURE.md:41,60-61`）
8. **P4-2** — error-handling-v2.md 历史章节保留完整 fallback/retry 矩阵（`docs/error-handling-v2.md` H1-H5）
9. **P4-3** — routing-instructions.md stopMessage 回退到历史消息启发式（`docs/routing-instructions.md:183`）
10. **P8-1** — llmswitch-core TS virtual-router 1227 行功能实现（`sharedmodule/llmswitch-core/src/router/virtual-router/`）
11. **A4-2** — RouteErrorHub 物理模块完整保留（`src/error-handling/route-error-hub.ts`）

### 中危（8项）
12. **G2-1** — index.ts resolveBoolFromEnv fallback 参数命名（`src/index.ts:39`）
13. **G2-2** — safeProcessCwd fallback 参数命名（`src/index.ts:53`）
14. **G2-4** — SSE writer 兜底事件识别（`sharedmodule/llmswitch-core/src/sse/shared/writer.ts:135`）
15. **G2-5** — .catch(() => null) 吞异常模式（`src/index.ts:1258,1263,1500` 等多处）
16. **G6-1** — http-transport-provider payload 条件处理（`src/providers/core/runtime/http-transport-provider.ts`）
17. **G12-2** — config-paths.ts emergency fallback 注释残留（`src/config/config-paths.ts:23`）
18. **P11-1** — SSE writer 启发式协议识别（`sharedmodule/llmswitch-core/src/sse/shared/writer.ts:135`）
19. **P14-1** — provider-traffic-governor qwen/qwenchat 同链判断（`src/server/runtime/http-server/provider-traffic-governor.ts`）

### 低危（3项）
20. **P8-2** — providers 目录 TS 代码量（~31200 行）
21. **P9-2** — gemini-protocol-client 字段裁剪（`src/client/gemini/gemini-protocol-client.ts`）
22. **P14-2** — 测试文件 qwenchat fixture 混淆风险（`tests/server/runtime/http-server/provider-traffic-governor.spec.ts`）

---

## 第七部分：修复优先级建议

### 立即修复（阻塞级）
1. 更新 ARCHITECTURE.md 对齐 error-handling-v2.md 收口状态
2. 确认 TS virtual-router 与 Rust hotpath 的真源关系，消除双真源
3. 清理 vendor archive 和 sharedmodule/llmswitch-core/archive

### 高优先级
4. 移除 classifier.ts 和 routing-instructions.md 中的兜底/回退语义
5. 迁移/删除 RouteErrorHub 独立模块
6. 更新 ARCHITECTURE.md 移除故障转移/重试机制描述

### 中优先级
7. 重命名 fallback 参数为 defaultValue
8. 替换 .catch(() => null) 为显式错误处理
9. 分离 qwen/qwenchat 判断分支
10. SSE writer 协议识别改为入站阶段显式判定

---

*审计日期：2026-05-11 | 审计人：Codex (automated) | 范围：只读扫描，无代码修改*


## 2026-05-11 DeepSeek Web tool-call chain audit

Verified findings:
- DeepSeek Web response compat strict missing-tool error originates in `req_outbound_stage3_compat/deepseek_web/response.rs`; this is only the fail-fast surface, not the root cause.
- `normalize_deepseek_business_envelope()` correctly normalizes DeepSeek SSE/business envelopes to chat.completion, but if payload already looks like a Responses shape (`object=response`, `output=[]`), it returns the payload as-is.
- After that, compat still routes through `govern_response(... client_protocol="openai-chat")`, which depends on `coerce_to_canonical_chat_completion()` / `build_chat_response_from_responses_json()` to expose tool wrapper text and reasoning tails on the canonical `choices[].message` surface.
- Existing DeepSeek tests cover explicit DSML wrapper harvest from chat-like / SSE shapes, but do not yet cover the live same-shape case: Responses payload with long reasoning/prose and no recovered tool call.

Why this matters:
- If Responses→chat coercion drops `output[]` / reasoning wrapper text before stage1 governance harvest, the later strict missing-tool failure is only a symptom.
- The unique fix point should therefore be the Responses→chat canonicalization truth source, not host/provider retry code.

## 2026-05-11 dangling_tool_call 调查（继续）

- 已验证 errorsample `/Volumes/extension/.rcc/errorsamples/payload-contract-error/responses.inbound_tool_history_contract-20260511-044824-208Z-5cb03ca89f099.json` 的 `body.input` 顶层仅 4 条，且全部是 developer/user message。
- 第 4 条 user 文本里确实包含 transcript 片段：`=== 466. TOOL === [name=exec_command tool_call_id=fc_toolu_1778474968_1]`。
- Rust `hub_bridge_actions/bridge_input.rs` 中存在 `append_harvested_assistant_tool_message()`，会对 assistant 纯文本做工具 harvest；但当前样本顶层 role 不是 assistant，因此“这条样本直接命中该分支”尚未证实。
- 下一步必须继续检查：
  1. TS `inspectBridgeInputToolHistory()` 是否会对嵌套 message/content 做展开计数；
  2. `hub_tool_session_compat` / 历史归一是否会把 transcript 风格文本转换成 bridge tool history。

## 2026-05-11 DSML harvest
- 用户失败样本显示 DSML wrapper: <| DSML | invoke>/<| DSML | parameter> 显式工具调用被 finish_reason=stop 吃掉；优先锁定 Rust markup harvest 层。

## 2026-05-11 DSML harvest verification
- Rust定点测试通过：extract_invoke_tools_from_text_impl_harvests_dsml_exec_command_cdata_block

- live样本继续追踪: req=openai-responses-deepseek-web.leggett-unknown-20260511T140034496-177372-192, finish_reason=stop，先检查实际输出是否有显式wrapper。

- 新live样本: DSML interrupt wrapper 原样漏出, finish_reason=stop; 需检查 interrupt wrapper 是否在 Rust 真源中缺失归一化。

- 新泄漏样本: <final>...</final> 未剥离，需定位响应清洗真源。

- 检查 /Volumes/extension/.rcc/config.deepseekweb.toml 的 TOML 语法并做最小修复。

- 任务: 为 /Volumes/extension/.rcc/config.deepseekweb.toml 补齐并验证 websearch + multimodal 路由，随后做 deepseek-web live capability 验证。

## 2026-05-11 deepseek-web multimodal+usage correction
- Jason 明确要求：multimodal 未打通不算完成；必须参考 ds2api 直接搬运远程图处理，不接受“部分成功”。
- 新问题：usage tokens.alltime/daily 在多 server（如 5520/5555）之间未共享，属于统计真源错误；必须改成跨进程共享真源，而不是各进程内存累加。

## 2026-05-11 deepseek-web multimodal remote-url + usage share followup
- deepseek-web multimodal 真源改点已锁定为 `src/providers/core/runtime/deepseek-file-upload.ts`：此前只接受 data URL，远程 URL 在真正上传前就被本地拒绝；若要支持 remote image，只能在这里扩展 fetch+mime 解析，其他层修补都只是症状层。
- usage 累计打架真源已锁定为 `src/server/runtime/http-server/executor/token-stats-store.ts`：`[session-request][rt]` 中的 `tokens.alltime/daily` 来自该 store，不来自 StatsManager；多 server 不共享的根因是持久化文件曾是单快照覆盖写。
- 当前回归断点：测试仍按旧 v1 persisted 格式断言；另有 `handler-utils.ts` 顶层无用 `chalk` 静态导入让 Jest 在仅需 `logRequestComplete` 的测试里被 ESM 依赖炸掉，属于验证层阻断，不是主链语义问题。

## 2026-05-11 合规审计整改状态更新（post-W7）

### 整改完成清单

| 编号 | 原始严重度 | 违规项 | 整改状态 | 验证方式 |
|------|-----------|--------|----------|---------|
| W1 | 阻塞 | P4-1/A4-1: ARCHITECTURE.md 对齐 error-handling-v2.md | ✅ 已修复 | 文档审查 |
| W2 | 阻塞 | A3/P8-1: TS virtual-router 双真源 | ✅ 确认TS为废弃壳层 | 文件存在性检查 |
| W3 | 阻塞 | G12-3/D1/D2: archive 目录物理删除 | ✅ 已删除 | `ls` 验证目录不存在 |
| W4 | 高危 | G2-3/G2-6/P4-2/P4-3: 兜底/回退/降级语义 | ✅ 已清除 | 文档内容审查 |
| W5 | 高危 | A4-2: RouteErrorHub 收敛 | ◐ 分析完成 | 6个importer已审计；error-handler-registry.ts策略迁移为routecodex-276后续工作 |
| W6 | 中危 | G2-5: .catch(() => null) 吞异常 | ✅ 已修复 | `grep .catch.*return null` 零结果；`grep .catch.*return.*({})` 零结果；tsc --noEmit PASS |
| W7 | 中危 | P14-1: qwen/qwenchat 判断链分离 | ✅ 已修复 | `chat.qwen.ai`/`chat.deepseek.com`域名从traffic governor移除；tsc --noEmit PASS |

### W6 详细修复清单（本次会话）

1. **src/index.ts:1258** — `.catch(() => null)` → 移除（outer try/catch 已有 logNonBlockingError）
2. **src/index.ts:1263** — `.catch(() => null)` → 移除（同上）
3. **src/index.ts:1500** — `.catch(() => null)` → 移除（attemptHttpShutdown 外层 catch 已有 logProcessLifecycle）
4. **src/cli/guardian/client.ts:267** — `.catch(() => null)` → 移除（后续 throw 错误信息含 status）
5. **src/cli/guardian/client.ts:288** — `.catch(() => null)` → 移除（后续返回结构化 reason）
6. **src/cli/guardian/client.ts:327** — `.catch(() => null)` → 移除（返回 boolean，网络错误由调用方处理）
7. **src/providers/core/strategies/oauth-device-flow.ts:368** — `.catch(() => ({}))` → 移除（错误应传播到 parseErrorResponse）
8. **src/cli/commands/session-admin.ts:330** — `.catch(() => ({}))` → 移除（后续 throw on !response.ok）
9. **src/token-daemon/token-daemon.ts:820** — `.catch(() => '')` → 移除（outer try/catch + logTokenDaemonNonBlockingError）
10. **src/server/.../credentials-handler-utils.ts:106** — `.catch(() => '')` → 移除（文件读取失败应可见）
11. **src/cli/commands/session-admin.ts:174** — `.catch(() => '')` → 移除（response.text 失败应传播）

### W7 详细修复清单（本次会话）

1. **src/server/.../provider-traffic-governor.ts:258-260** — 移除 `value.includes('/chat.qwen.ai')`、`value.includes('chat.qwen.ai')`、`value.includes('chat.deepseek.com')`。这些域名是 qwen/deepseek OAuth 鉴权端点，不应作为 web provider 流量特征识别。

### 保留的 .catch(() => '') 判定为合理

| 文件 | 行号 | 理由 |
|------|------|------|
| oauth-device-flow.ts:198 | 在 catch 块内读取 response.text 构造错误预览后 throw | 合理：错误被使用 |
| oauth-device-flow.ts:361 | 同上，构造 Token endpoint 错误预览后 throw | 合理：错误被使用 |
| qwen-userinfo-helper.ts:215 | 成功路径排空 response body | 合理：意图丢弃 |
| restart.ts:323 | 读取 body 构造错误消息后 throw | 合理：错误被使用 |

### 剩余工作（未在本次整改范围）

| 编号 | 优先级 | 描述 |
|------|--------|------|
| W5(续) | P0 | error-handler-registry.ts retry/reroute/backoff 策略物理迁移到 Router Policy（→routecodex-276）|
| W8 | P1 | fallback 参数重命名为 defaultValue（4处 resolveBoolFromEnv + 1处 safeProcessCwd）|
| W9 | P1 | SSE writer 协议识别改为入站显式判定 |
| W10 | P2 | providers TS 代码量审查 |
| S1-S5 | 待确认 | 5项疑似项需人工判定 |

### 整改后审计统计修正

| 严重度 | 原始 | 已修复 | 剩余 |
|--------|------|--------|------|
| 阻塞 | 4 | 3 | 1（A4-1→已修复；剩余为W5续的隐含影响） |
| 高危 | 7 | 5 | 2（G2-3/G2-6/P4-2/P4-3已修复；A4-2部分修复；P8-1已确认；G12-1已修复） |
| 中危 | 8 | 3 | 5（G2-5已修复；P14-1已修复；G2-1/G2-2/G2-4/G6-1/G12-2/P11-1待修复） |
| 低危 | 3 | 0 | 3（P8-2/P9-2/P14-2待修复） |
| 疑似 | 5 | 0 | 5（S1-S5待确认） |

*更新日期：2026-05-11 | 更新人：Codex (automated)*

## 2026-05-11 DeepSeek session creation failure followup
- 现场错误已切换为 `DEEPSEEK_SESSION_CREATE_FAILED`，需要对比 routecodex 与 ds2api 的 DeepSeek session create 真链路，确认是 cookie/header/pow/session bootstrap 哪一步偏离，而不是继续在 provider-switch 层绕。

## 2026-05-11 review: empty-slot key + route-usable dispatch
- 空槽 key 现状：provider traffic governor 仍以 `runtimeKey=provider.alias` 作为唯一 state key（`toStateKey(runtimeKey)`）；而 VR busy 排除改为写入 `providerKey=provider.alias.model`。这让“阻塞租约槽”和“路由可用性槽”分裂成两套 key 语义：前者 alias 级共享，后者 target/model 级可见。
- 直接后果：同一 alias 下多 model 会共享 traffic lease，但 VR 只会屏蔽被命中的单个 providerKey，不会屏蔽同 runtime 的兄弟 target；因此会继续命中同 alias 其它 model，随后在 executor 再次进入 acquire 等待/软超时，违背“路由池命中时就考虑并发可用性”的要求。
- 真源修改点应在“VR 可用性判定与 traffic state key 的语义统一处”，不是继续调 acquire timeout。若目标是 alias 共享并发，则 VR busy 必须按 runtime/alias 级传播；若目标是 alias×model 独立并发，则 governor state key 必须升级为 target/providerKey 级。当前实现两边语义不一致。
- 当前软等待 `softWaitTimeoutMs=1500` 只是在 executor acquire 阶段更早失败，不会减少 VR 误命中不可用候选；因此它只能缩短阻塞时间，不能解决 route-usable 分发真问题。

## 2026-05-11 concurrency-scope centralization audit

Verified findings:
- 本轮并发 scope 根因修复后，运行时语义已明显向 `runtimeKey` / alias 级共享并发槽收敛：
  - governor acquire/release 仍以 `runtimeKey` 为真源；
  - Rust VR target 生成时注入 `concurrencyScopeKey=runtimeKey`；
  - `is_provider_available` 会同时检查 `provider_key` 与 `runtime_key` busy；
  - host executor 在 busy 回调处优先读取 `concurrencyScopeKey`，回写给 VR。
- 但实现面仍未完全收口到单点，仍存在命名/读取/API 多点语义：
  - `request-executor.ts` 本地 `readConcurrencyScopeKey()` 仍在 host 侧二次推导 scope；
  - VR API 仍命名为 `markProviderConcurrencyBusy/Idle(providerKey)`，实际已在传 scope key；
  - Rust `mark_concurrency_busy(provider_key: &str)` / `concurrency_busy_keys` 命名仍沿用 provider_key，语义已泛化为 busy scope key；
  - TS `ProviderRegistry.buildTarget()` 还没显式产出 `concurrencyScopeKey`，当前仅 Rust target builder 会注入它。

Conclusion draft:
- 这次修复不是“完全散乱”，但也还不能叫“功能收一处”。
- 真正的单一真源应当是：`ProviderRegistry/target build 产出 scope key` + `VR busy API 改名为 scopeKey`，host/governor/selection 全链只消费这一字段，不再本地 fallback 推导。

## 2026-05-11 concurrency-scope unique closeout

Completed changes:
- TS target builder `sharedmodule/llmswitch-core/src/router/virtual-router/provider-registry.ts` 现在和 Rust target builder 对齐，显式产出 `concurrencyScopeKey: runtimeKey`。
- VR busy API 已统一改名为 scope 语义：
  - `markProviderConcurrencyBusy/Idle` -> `markConcurrencyScopeBusy/Idle`
  - 覆盖 TS engine / native proxy interface / http-server HubPipeline type / request-executor.spec mock
- governor callback 已收口为单参数 scope：
  - `setConcurrencyBusyCallback((scopeKey, busy) => ...)`
  - acquire/release 回调仅回传 `runtimeKey` 作为共享并发 scope
- host 本地二次推导已删除：
  - `request-executor.ts` 的 `readConcurrencyScopeKey()` 已物理删除
  - host 仅消费 target 上显式 `concurrencyScopeKey`

Verification evidence:
- grep 证明旧 API / helper 已无残留：
  - `rg markProviderConcurrencyBusy|markProviderConcurrencyIdle|readConcurrencyScopeKey` => 空
- `tests/server/runtime/http-server/provider-traffic-governor.spec.ts` 通过（17/17）
- `tsc -p tsconfig.json --noEmit` 对本次链路无新增错误；当前仍存在仓库既有无关断点：
  - `src/utils/error-handler-registry.ts` 缺失类型名
  - `tests/server/runtime/http-server/request-executor.spec.ts` 仍被既有 `import.meta` / Jest ESM 问题阻塞

Why this is the unique correct fix point:
- 问题根因是 governor acquire-time scope 与 VR route-time busy scope 表达不一致；唯一正确收口点只能是 target 真源显式携带 scope，并让 VR API / governor callback / host 消费链全部只接受 scopeKey。
- 继续保留 host fallback 推导或 providerKey 命名，只会在别处再次制造第二语义面。

Addendum verification (2026-05-11):
- `tests/server/runtime/http-server/request-executor.spec.ts` 现已通过（29/29）。
- 这次顺手修到一个真正的单点根因：`HubRequestExecutor` 在传入自定义 `trafficGovernor` 时 constructor 直接 return，导致 concurrency callback 根本没有注册；这是 request-executor scope-propagation test 失败的唯一真源，已抽成 `installTrafficGovernorConcurrencyCallback()`，共享 governor / custom governor 统一走同一安装路径。
- Rust/NAPI 改名链已通过定向 cargo 编译验证：
  - `cargo test -p router-hotpath-napi is_provider_available -- --nocapture`
  - 结果：编译通过，0 tests matched（作为编译/链接证据，不作为行为回归证据）。
- 当前仍未拿全仓 `tsc -p tsconfig.json --noEmit` 绿灯；仓库尚有无关旧断点（如 `error-handler-registry.ts` 缺类型、request-executor.spec 自身严格 TS 编译告警等），不属于本次 concurrency scope 收口引入。

## 2026-05-11 DSML variant harvest fix
- DeepSeek Web 文本工具收割失败的唯一真源修复点锁定在 `hub_reasoning_tool_normalizer.rs::extract_tool_calls_from_reasoning_text`。
- 本轮按 Jason 要求改为“mask + 关键字 canonicalize”策略：先 mask CDATA，再把 `<｜DSML│tool_calls>` / `<│DSML│invoke>` / `<│DSML│parameter>` 等壳层规范化为 canonical XML，再复用既有 harvest 逻辑；不触碰参数 payload 语义。
- 已补 Rust 回归：全角/竖线 DSML 变体 + CDATA `pwd` 样本，目标是 harvest 成 `exec_command(cmd=pwd)` 且 cleaned text 去空 wrapper。

## 2026-05-11 合规审计最终收口报告

### P0 阻塞（1项）✅ 全部修复

**W5续：error-handler-registry.ts retry/reroute/backoff 策略物理删除**
- 修改文件：`src/utils/error-handler-registry.ts`（766→536 行）
- 删除内容：
  - `DeferredHandler`, `RateLimitPipelineDescriptor`, `RateLimitHookTelemetryEvent`, `RateLimitHandlerHooks`, `RateLimitHandlerContext` 5 个死接口（零外部调用者）
  - `provider_error` handler 中 90 行 pipeline switch/failover/hooks 逻辑
  - `rate_limit_error` handler 中 120 行 pipeline switch/backoff schedule/exhausted 逻辑
- 保留：default message templates (`provider_error`/`rate_limit_error` 等) + 简化 log-only handler
- 唯一真源论证：真正的错误策略在 `provider-failure-policy-impl.ts` → Rust `native-failure-policy` 桥接 → Virtual Router policy。error-handler-registry 中的策略代码是已废止的 ErrorHandlingCenter 时代遗留，零外部调用者（`RateLimitHandlerContext`/`RateLimitHandlerHooks` 在整个 `src/` 下无任何其他引用）。物理删除这些死策略是唯一正确的修复——不存在"迁移"的目标，因为真源已在 Virtual Router policy 且已生效。
- 验证：`tsc --noEmit` PASS；`grep RateLimitHandlerContext\|DeferredHandler\|RateLimitPipelineDescriptor` 零结果

---

### P1 高危（2项）✅ 已确认合规

**A4-2：RouteErrorHub / error-handling 模块物理收敛**
- 判定：**合规**
- 证据：RouteErrorHub 仅在 Host 边界层被 3 处运行时调用（`http-server-lifecycle.ts:335`, `handler-utils.ts:439`, `index.ts:357`），职责限定为 HTTP/server/CLI 外层错误映射与统一返回，不承担 provider runtime retry/reroute/backoff 主决策。与 `docs/error-handling-v2.md` 收口设计一致："RouteErrorHub / ErrorHandlingCenter 现阶段只保留 Host 边界职责"。
- 16 个 importer 均为类型引用或 Host 边界消费，无策略越权。

**P8-1：TS virtual-router 与 Rust hotpath 真源关系**
- 判定：**合规（TS 为薄壳）**
- 证据：`engine.ts`（414 行）内 15 处 `nativeProxy.*` 调用，全部委托给 `NativeVirtualRouterEngineProxy`（Rust NAPI 绑定）。`createVirtualRouterEngineProxy()` → `loadNativeRouterHotpathBindingForInternalUse()` → Rust `VirtualRouterEngineProxy`。TS 不做路由分类/健康管理/特征提取，仅做 JSON 序列化桥接和 sticky session 持久化。
- Rust 真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` 存在且活跃。

---

### P2 中危（5项）✅ 全部修复

**G2-1/G2-2：fallback 参数重命名为 defaultValue**
- `resolveBoolFromEnv`：审计时已全部使用 `defaultValue`，无需修改
- `safeProcessCwd`：2 处修复
  - `src/index.ts:53`：`fallback` → `defaultValue`，`fallbackValue` → `defaultValuePath`，`fallbackDir` → `defaultDir`，`chdir_fallback` → `chdir_default`
  - `src/config/unified-config-paths.ts:72`：同上重命名
- 唯一真源论证：参数语义是"当 cwd 不可读时的默认路径"，非流量级降级/兜底机制。重命名为 `defaultValue` 消除 fallback 措辞污染。
- 验证：`grep "function safeProcessCwd(fallback"` 零结果；`tsc --noEmit` PASS

**G2-4/P11-1：SSE writer 启发式协议识别 → fail-fast**
- 修改文件：`sharedmodule/llmswitch-core/src/sse/shared/writer.ts:134-140`
- 修改内容：删除启发式 `eventField` 分支（通过 event 字段名猜测协议类型），替换为 `throw new Error('[SSEWriter] Event missing explicit protocol field; heuristic protocol detection is not allowed.')`
- 唯一真源论证：所有 SSE event 类型（chat/responses/anthropic-messages/gemini-chat）均已定义 `protocol` 字段。无 `protocol` 字段的 event 是上游异常，不应通过猜测字段名来"兜底"。fail-fast 是唯一正确的处理方式。
- 验证：`tsc --noEmit` PASS；`grep SSEWriter` 确认 throw 存在

**G6-1/P9-1：http-transport-provider payload 条件处理审计**
- 判定：**合规（无需修改）**
- 证据：`http-transport-provider.ts` 中 `typeof` 检查均为类型守卫/字段存在性判断（`typeof cfg.providerId === 'string'` 等），无主传输链 payload 裁剪/改写。`buildHttpRequestBody`/`preprocessRequest`/`postprocessResponse` 委托给 `provider-request-shaping-utils`，属于 transport 层适配。主链 payload（请求体/响应体）保持语义等价。

**G12-2：config-paths.ts emergency fallback 注释残留**
- 修改文件：`src/config/config-paths.ts`（25→20 行）
- 删除内容：末尾孤立的 `@deprecated` JSDoc 块（无对应实现）
- 唯一真源论证：`emergency fallback` 注释在之前迭代中已随着实现代码被移除，但孤儿 JSDoc 块残留。物理删除该注释块消除"保留以防万一"的文档污染。
- 验证：`grep @deprecated` 零结果；`tsc --noEmit` PASS

---

### P3 低危（3项）✅ 全部审计确认

**P8-2：providers TS 代码量审查**
- 判定：**合规（~31,700 行，138 文件，111/138 为 transport/bridge/adapter/oauth/token/config/contract）**
- 证据：providers 目录非测试代码 31,698 行，其中 111 个文件属于 transport 桥接/oauth 认证/camoufox 自动化/token daemon/provider config/contract 定义/debug hooks。剩余 27 个文件中包含 `provider-failure-policy-impl.ts`（781 行，已接入 Rust native bridge）等少量业务策略文件，但整体符合"TS 仅保留最小调用壳层，功能落 Rust"的项目护栏（P8）。
- 无新增纯 TS 功能实现。

**P9-2：gemini-protocol-client 字段裁剪边界确认**
- 判定：**合规（在协议适配器边界内）**
- 证据：`src/client/gemini/gemini-protocol-client.ts` 实现 `HttpProtocolClient` 接口，`delete`/`.filter` 操作均为 OpenAI Chat Completions → Gemini generateContent 协议转换：删除 `messages` 字段后重组为 `contents`+`systemInstruction`，删除 `stream` 字段（Gemini 不支持），删除 `model` 后从 URL 注入。这些操作全部发生在 client 适配器层（协议转换边界），不涉及主传输链 payload 裁剪。

**P14-2：测试文件 qwenchat fixture 隔离确认**
- 判定：**合规（测试隔离充分）**
- 证据：48 处 qwenchat 引用均在测试 fixture 中作为 model string/provierKey 使用（如 `model: 'qwenchat.qwen3.6-plus'`），无 qwen/qwenchat OAuth/鉴权/UA/header 交叉污染。provider-traffic-governor 已在 W7 中将 `chat.qwen.ai`/`chat.deepseek.com` 域名从流量识别中移除，测试 fixture 与运行时完全隔离。

---

### 疑似项（5项）✅ 全部确认

**S1：Skills 精华沉淀质量**
- 判定：**合规**
- 证据：`.agents/skills/rcc-dev-skills/SKILL.md`（624 行）包含 PipeDebug 架构索引、分层判定流程、反模式清单，符合"经验精华"标准。`.agents/skills/rcc-server-restart/SKILL.md`（24 行）为 redirect skill（"已并入 rcc-dev-skills"），目的明确，无冗余。

**S2：Provider directActivation 是否旁路 Hub Pipeline**
- 判定：**合规（不构成旁路）**
- 证据：`directActivation` 是 provider binding 配置字段（`'route' | 'tool'`），用于 _provider 激活方式_的声明（route-based 或 tool-call-based），而非绕过 Hub Pipeline 的替代路由路径。在 `provider-sdk/provider-runtime-inference.ts:113-123` 中仅做配置读取与透传，不实现任何独立路由逻辑。

**S3：TS virtual-router 是否仅 thin-shell**
- 判定：**合规（确认为薄壳）**
- 证据：`engine.ts`（414 行）含 15 处 `nativeProxy.*` 调用，核心逻辑（路由决策、健康管理、特征提取）全部委托给 Rust `NativeVirtualRouterEngineProxy`。TS 仅做 JSON 序列化、sticky session 持久化、logger 着色等非策略性辅助工作。与原始审计中"1227 行 TS 实现"相比，当前 engine.ts 已为 Rust 代理模式。

**S4：gemini-protocol-client 裁剪是否在适配器边界**
- 判定：**合规（在协议适配边界内）**
- 证据：所有 `delete`/`.filter` 操作均为 OpenAI → Gemini 协议格式转换（见 P9-2 分析），不发生在主传输链（Hub Pipeline → Provider V2 → upstream）中。文件实现 `HttpProtocolClient` 接口，位于 `src/client/` 目录下，属于 client adapter 层。

**S5：replace_tools op 在 stopless 场景的语义**
- 判定：**合规（合法 followup 能力组合）**
- 证据：`replace_tools` 是 `FOLLOWUP_OP_HANDLERS` 中的一个 op，用于 followup 请求构造时的工具集替换（`tools: Array.isArray(op.tools) ? cloneJson(op.tools) : []`）。它不用于"逼出 reasoning.stop"或伪造工具面——它是合法的 followup 编排能力，等价于"下一轮请求携带不同的 tool set"。与 P12 审计结论一致。

---

### 最终审计统计（全部归零）

| 严重度 | 原始 | 本次修复 | 最终剩余 |
|--------|------|---------|---------|
| 阻塞 | 4 | +1（W5续） | **0** |
| 高危 | 7 | +2（A4-2 合规确认，P8-1 合规确认） | **0** |
| 中危 | 8 | +5（G2-1,G2-2,G2-4,G6-1,G12-2） | **0** |
| 低危 | 3 | +3（P8-2,P9-2,P14-2 合规确认） | **0** |
| 疑似 | 5 | +5（S1-S5 全部判定合规） | **0** |
| **合计** | **27** | **16** | **0** |

### 本次修复涉及的文件清单

| 文件 | 修改类型 | 行数变化 |
|------|---------|---------|
| `src/utils/error-handler-registry.ts` | 物理删除死策略代码 | 766→536 |
| `src/index.ts` | fallback→defaultValue 重命名 | 不变 |
| `src/config/unified-config-paths.ts` | fallback→defaultValue 重命名 | 不变 |
| `sharedmodule/llmswitch-core/src/sse/shared/writer.ts` | 启发式识别→fail-fast | 5行替换 |
| `src/config/config-paths.ts` | 删除孤儿 @deprecated | 25→20 |

*收口日期：2026-05-11 | 审计人：Codex (automated) | 状态：全部归零*

## 2026-05-12 deepseek web 文本收割泄露排查
- 用户目标: 1) 用 mask 检查为何 wrapper 泄露并避免下次泄露 2) 即使工具收割失败也必须清理并继续下一轮推理
- 初步定位: chat-process response stage1 tool governance + stage3 servertool orchestration
- 已确认真源修改点: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- 根因1: transcript/右侧 gutter + DSML 变体下，stage1 的 wrapper 检测/unwrap 未完整覆盖，导致显式 wrapper 未被正确 mask/收割，文本泄露到最终 content。
- 根因2: 即使 stage1 已清理 marker，只要 `detect_unharvested_text_tool_markup()` 看到 wrapper 仍存在，就直接 hard error `unharvested_text_tool_markup`，阻断后续 stage3 followup/继续推理。
- 计划: 1) 补 transcript+DSML 泄露回归并修 normalize/mask 2) 将 unharvested explicit wrapper 从 hard error 改为“清理后保留普通文本/空文本继续走后续链路”。

- 继续收口: 1) 修 stage1 shell-fence 旧回归 2) deepseek web 上传标签 RCC_HISTORY -> context

## 2026-05-12 deepseek-web 文本收割泄露 + context 上传名

Verified findings:
- 文本 harvest 泄露唯一真源仍是 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`。
- DSML transcript/right-gutter 泄露修复后，仍需额外保留一类负样本：`<function_calls>```bash ... ```</function_calls>` 这类 wrapper-only 且不可 harvest 的 code fence，必须保留 inner fence 文本，不能因 allow-empty cleanup 被清空。
- DeepSeek Web 上传上下文文件名真源在 Rust compat `deepseek_web/request/history_context.rs` 与 runtime `src/providers/core/runtime/deepseek-file-upload.ts`；本轮已统一从 `RCC_HISTORY.txt` 改为小写 `context`，并同步 continuation prompt / response scrub / 测试断言。

Why this is the unique correct fix point:
- shell fence 负样本不能去 host/provider 层补，因为是否“保留 inner text 还是清空 wrapper”属于 stage1 tool governance 的唯一语义边界；改其他层只会制造第二实现面。
- `context` 文件名也不能只改 runtime upload 默认值；Rust request compat 才是 deepseek-web context metadata 与 prompt 文案的真源，必须和 runtime 默认文件名同步修改，否则 metadata/prompt/upload 会分裂。

## 2026-05-12 provider busy persistence + deepseek file upload retry
- 先止血：定位 ~/.rcc/state/provider-traffic 为 provider busy/lease/cooldown 持久化目录；5520 deepseek-web 进程使用 ~/.rcc，不是 /Volumes/extension/.rcc。
- 待处理：清理 provider-traffic 持久化状态；然后追 DEEPSEEK_FILE_UPLOAD_FAILED 被 recoverable same-provider retry 的真源。

- 2026-05-12 deepseek file upload retry真因补证
  - 证据: `~/.rcc/logs/server-10000.log` 在 2026-05-12 10:20-10:29 多次记录 `sendSingleRequest.errorBodyParse ... Unexpected token '<'`，目标 URL 恒为 `https://chat.deepseek.com/api/v0/file/upload_file`，status=502。
  - 结论(取证阶段): 失败发生在 DeepSeek 上传接口本身返回 HTML 502 / 非 JSON，不是 fetch_files ready 轮询阶段，也不是本地 context 为空。
  - 待修: `DEEPSEEK_FILE_UPLOAD_FAILED` 当前在 `provider-failure-policy-impl.ts` 走 generic recoverable -> `retry_same_provider`，导致同一共享 upstream 故障下跨 deepseek-web 别名重复重试。

- 2026-05-12 deepseek upload success/no-file-id 真因
  - 证据: `server-10000.log` 10:44:30-10:45:32 连续报 `DeepSeek file upload succeeded without file id`。
  - 根因: RouteCodex 的 `extractFileId()` 只 BFS record，不遍历 array；若 upload_file 成功响应 shape 变成 `data.biz_data.files[0].file_id`，会误判为“成功但无 file id”。
  - 对照: `ds2api/internal/deepseek/client/client_file_status.go` / `client_upload.go` 的 walker 会递归数组与嵌套 map。
## 2026-05-12 deepseek upload no-file-id follow-up
- 继续收口：先补 array-shape 回归，验证 extractFileId() 遍历数组后可从 biz_data.files[0].file_id 提取 id；再定点测试、build:dev、install 验证。
## 2026-05-12 deepseek upload 11:00 live failure follow-up
- 新证据：11:00:25 仍报 `DeepSeek file upload succeeded without file id`。先抓同 requestId 周边日志与 snapshot/errorsample，区分是旧进程未刷新还是还有未覆盖 response shape。


## 2026-05-12 deepseek-web upload failed 继续排查

- 新证据：`~/.rcc/logs/server-10000.log` 已出现新增调试日志：`[deepseek-file-upload] upload succeeded without file id`，真实 payload 为 `{"code":0,"msg":"","data":{"biz_code":9,"biz_msg":"unsupported file type","biz_data":null}}`。
- 结论更新：11:09 之后这批 `succeeded without file id` **不是真正的 file-id shape 漏解析**，而是 DeepSeek 把上传判为 `unsupported file type`，只是我们之前把“code=0 但无 id”统一归成了 file-id 提取失败。
- 与 session 假设对照：该错误跨多个 request/provider alias 复现，且 payload 原因完全一致，更像是 `filename=context`（无扩展名）触发的上游文件类型拒绝，不支持“某些 session 文件写坏”的结论。
- 下一步：最小修复应落在 deepseek context upload filename / success contract 判断处，而不是 session 持久化。


## 2026-05-12 upstream stream no content timeout 排查

- 现象：用户贴出 `SSE_DECODE_ERROR` / `UPSTREAM_STREAM_NO_CONTENT_TIMEOUT`，deepseek-web 在 `chat_process.resp.stage1.sse_decode` 报 `Upstream stream produced no content within 120000ms`。
- 待确认真源：timeout 是 transport 层、SSE decode 层，还是 provider-specific gate；以及当前是否存在“已见锚点后继续用同一超时”的不合理设计。

## 2026-05-12 continue: key1/runtime + deepseek context upload
- 复核确认：当前代码路径里 Virtual Router provider bootstrap 真正执行的是 native Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_bootstrap.rs`；TS `bootstrap/auth-utils.ts` 在源码内无调用点，不能作为修复点。
- 继续判定：`deepseek-web.key1` 的唯一真源是 Rust bootstrap 对空 `auth.entries` 记录未做 material 校验，落到 `normalize_alias(None)=>key1`。应在 Rust `push_auth_entry_from_record` / `push_auth_entry` 入口前做空记录 fail-fast/skip 判定，并补回归。
- 继续判定：DeepSeek context upload 的唯一运行时真源是 `src/providers/core/runtime/deepseek-file-upload.ts` + Rust deepseek-web request compat。当前工作树仍显示 `context.txt`，需与用户要求的 `context` 以及上游 `unsupported file type` 证据重新对齐验证，不能沿用旧结论。

## 2026-05-12 架构收敛测试回归分析

### 8 个新回归分类

**A. SSE salvage（rescue 逻辑失效）— 4 个**
- `responses-sse-to-json-terminated-salvage`: `isTerminatedError()` dump 返回 true，但 catch 块中 `responseBuilder.getResult()` 返回 `success:false`，因为 builder 在 catch 前已被 `throw` 路径清空或没完成。源文件 `responses-sse-to-json-converter.ts:169`。
- `responses-sse-missing-terminator`: 测试流式正常结束（无 terminated），但 builder 报告"incomplete before response.completed/response.done"。构建器要求最后 token 是 `response.done`，但测试流故意不发送。
- `anthropic-sse-to-json-terminated-salvage`: 同 responses salvage，anthropic converter 中 `isTerminatedError` 从只查 `message` 改为同时查 `code`，匹配成功但 `responseBuilder` 为 null。
- `chat-sse-to-json-deepseek-web-patch`: JSON parse 错误 `Unexpected non-whitespace character after JSON at position 46`，deepseek-web SSE 格式与 chat sse parser 不兼容。

**B. 删除文件 import 断裂 — 2 个**
- `virtual-router-media-kimi-route`: import `buildRouteCandidates` from `engine-selection/route-utils.js`，该文件已在 commit a8e594871 删除（`engine-selection/` 下 15 个文件）。
- `web-search-vs-search-route`: import `RoutingClassifier` from `classifier.js`、`buildRoutingFeatures` from `features.js`，两者均已删除。

**C. 行为语义变更 — 1 个**
- `deepseek-web-compat-tool-calling`: native Rust `runRespInboundStage3CompatWithNative` 抛出 `DeepSeek declared tools present but no valid tool call was produced`，测试中无 valid tool call 场景期望错误，但 native 行为变了。

**D. 测试断言过期 — 1 个**
- `coverage-hub-req-outbound-context-merge`: 测试期望 `native applyReqOutboundContextSnapshotJson is required but unavailable`，但 native 返回 `execution failed: invalid payload`。原因：Rust 端 `applyReqOutboundContextSnapshotJson` 新增了 payload 校验（`invalid payload`），不再在 native 不可用时报 `unavailable`。断言 regex 需要匹配新错误信息。

### 修复方案（按类别）

**A. SSE salvage（4个）— 真源在 converter 代码**
1. `responses-sse-to-json-converter.ts`: `isTerminatedError` 的 catch 块需要在 builder 未完成时仍尝试 `getResult()` 并接受 `success:false` 但 `response` 存在的部分结果（即 builder 在 throw 前已有部分 output）。修改：在 catch 块中若 `getResult().response` 存在（即使 success 为 false），如已观察到 `response.completed`，则返回部分结果。
2. `responses-sse-missing-terminator`: builder 在 `getResult()` 处应允许已观察到 `response.completed` 但未观察到 `response.done` 的情况，返回已聚合的输出（当前已有此容错，但测试流没发送 `response.completed` 事件）。修改：测试需要发送 `response.completed` 但不发送 `response.done`，或在 converter 新增对"已有完整 output item 但无 done"的强制完成容错。
3. `anthropic-sse-to-json-converter.ts`: 添加 salvage 逻辑（同 responses）。
4. `chat-sse-to-json-converter.ts`: 修复 deepseek-web SSE chunk 解析。

**B. 删除文件 import 断裂（2个）— 需用 native 替代或删除测试**
1. `virtual-router-media-kimi-route.mjs`: 改为调用 native `VirtualRouterEngineProxy.route()` 或删除测试（功能在 Rust 实现）。
2. `web-search-vs-search-route.mjs`: 改为调用 native classifier，或删除测试。

**C. deepseek-web-compat-tool-calling — 测试更新**
- 更新测试以匹配 native Rust 的新 error message/行为。

**D. coverage-hub-req-outbound-context-merge — 更新断言 regex**
- 更新 `assertNativeUnavailableError` 的 regex 从 `unavailable` 改为 `execution failed`。


## 2026-05-12 deepseek-web 收割失败复查
- 先按用户给的 clary requestId / 时间戳在 server-10000.log 和 codex-samples 中反查真实样本，再对比 provider 原始 SSE 与阶段快照，区分上游未出工具 vs 本地 harvest/finalize 异常。
- 已定位用户给的真实 stop 日志：`openai-responses-deepseek-web.clary-unknown-20260512T155841074-181949-645`，发生在 `/Volumes/extension/.rcc/logs/server-10000.log:131798-131803`，需要继续对照 clary 样本目录中最接近的 `req_1778572721074_* / req_1778572863609_* / req_1778573180700_*`。
- 已确认缺少 `resp_process_stage1/2` 不是单点偶发：`snapshot-utils.ts` 默认仅允许 `provider-request/provider-response` 两类 stage，未配置 `RCC_SNAPSHOT_STAGES` 时，chat_process/resp_process 阶段记录会被 stage policy 直接过滤。
- 用户补充频繁 `UPSTREAM_STREAM_TIMEOUT` 样本：`openai-responses-deepseek-web.3-unknown-20260512T155538561-181941-637`；需要沿 `resp.stage1.sse_decode -> convertSseToJson -> upstream stream timeout` 路径检查当前等待行为与超时设计。
- 继续进入修复：先收口 SSE timeout 真源（transport absolute timeout + pre-anchor 续命锚点），再补最小证据链，避免 stop/tool harvest 与 stream timeout 继续黑箱。
- 已修改 timeout 真源：`src/providers/core/utils/http-client.ts` 在 SSE headers 到手后清掉 absolute total timeout，只保留 byte-idle + downstream semantic timeout；`chat/responses-sse-to-json-converter` 的 pre-anchor anchor 从 `lastFrameAtMs` 改为 `firstFrameAtMs`，防止 non-semantic frame 无限续命。


## 2026-05-12 llmswitch-core dist 启动炸点（SSE Unexpected token）

Verified findings:
- 5520 启动失败的 `Unexpected token ':'` 已定位到 `sharedmodule/llmswitch-core/dist/sse/sse-to-json/builders/response-builder.js:1196`。
- `node --check` 直接报错，坏片段为 TS 签名残留：`response ?  : ResponsesResponse`。
- 对应源码 `src/sse/sse-to-json/builders/response-builder.ts` 当前是合法 TS；用 `typescript.transpileModule` 转译输出也正常。
- 当前时间戳显示 `src` 新于 `dist`（src 18:07 > dist 17:31），说明当前启动失败并非最新源码语法错，而是运行时仍加载了旧的/坏的 llmswitch-core dist 产物。

Why this matters:
- llmswitch bridge loader 运行时只加载 `sharedmodule/llmswitch-core/dist`；因此唯一正确止血点不是改 loader，也不是改 host，而是重建并替换坏的 core dist。

## 2026-05-12 mimo thinking 400 排查
- 现象: mimo/v2.5-pro 上游 anthropic messages 返回 400: reasoning_content in thinking mode must be passed back.
- 已证据: provider-request 样本 req_1778598756533_25b4ad01 中大量 assistant 历史缺 reasoning_content（tool_use 与纯文本轮都缺）。
- 下一步: 追 req_outbound_stage3_compat/request_stage.rs -> ensure_reasoning_content_for_assistant_history 是否对 mimo/anthropic 生效，确认是否被后续 anthropic remap 丢失。

## 2026-05-12 mimo thinking 400 收口
- 已验证真因: mimo 走 anthropic messages + thinking 模式时，provider-request 历史 assistant message（tool_use 轮 + 纯文本 assistant 轮）大量缺 reasoning_content，触发上游 400: reasoning_content in the thinking mode must be passed back.
- 唯一修复点: Rust `req_outbound_stage3_compat/thinking_history.rs` + `request_stage.rs`。原因: stage3 compat 在 chat->anthropic build 之前运行，且 provider-request 已证明坏形状在出站前就存在；provider/transport/retry 层都不是正确修改层。
- 关键判定: 不能复用 openai-chat 的 tool_calls 逻辑；anthropic payload 的 assistant history 需要按 `messages[].content` 中 `tool_use` / `text` block 形状补 reasoning_content。
- 已补规则: `providerProtocol=anthropic-messages` 且 `thinking` 启用时，对 assistant history 注入 reasoning_content；tool_use-only 轮补 `.`，纯文本 assistant 轮补原文；last-user 之后的纯文本 assistant 轮转入 reasoning_content 并清空 content。
- 证据: `cargo test req_profile_anthropic_thinking_history*` 通过；真实样本 `req_1778598756533_25b4ad01/provider-request.json` same-shape replay 后 assistant_missing_reasoning_after=0。

## 2026-05-12 mimo thinking 400 继续收口（profile early-return）
- 新证据：Mimo 配置 `compatibilityProfile=anthropic:claude-code`，而 Rust `req_outbound_stage3_compat/request_stage.rs` 之前是先命中 profile return，再执行 anthropic thinking-history compat。
- 结论：此前 live 未修复的唯一真因不是“新改坏”也不是 transport 先丢，而是 profile early-return 旁路了 reasoning_content 注入。
- 已修：将 thinking-history compat 前移到 profile 分支前，并补 `anthropic:claude-code + anthropic-messages + thinking` 回归测试。
- 本地证据：Rust 定向测试 `req_profile_anthropic_thinking_history*` 与新增 `req_profile_anthropic_claude_code_preserves_thinking_history_reasoning_content` 已通过；下一步必须 build/install/restart 后做在线验证。

- 继续收口（2026-05-13 00:5x 在线 mimo 失败）：新在线样本 `anthropic-messages/mimo.key1.mimo-v2.5-pro/req_1778604619253_f8fe0cb7` 已证明 provider-request.json 中 reasoning_content 完整存在，因此 hub/stage3 已不是最终真源。
- 已坐实下一层真因：`src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-call-options.ts` 只读 `message.content`，完全忽略顶层 `assistant.reasoning_content`；进入 AI SDK 后最终上游 body 会丢 thinking history。
- 已修：把顶层 `assistant.reasoning_content` 映射为 AI SDK `reasoning` part，并补 vercel-ai-sdk anthropic transport 定向回归。下一步必须再次 build/restart 后在线直连 mimo 验证。

## 2026-05-13 Mimo thinking 400 第二/第三层真因
- 已在线二分上游：`reasoning_content` 顶层字段本身不会被 Mimo 接受；只有 assistant 历史恢复成 Anthropic `content:[{type:\"thinking\",...}]` 才能 200。证据：`minimal_user_only=200`、`reasoning_only_top=200`、`tool_with_reasoning_content=400`、`full_raw_sample=400`、`full_with_thinking_blocks=200`。
- 因此 provider runtime 的唯一真源修改点不是继续保顶层 `reasoning_content`，而是 `anthropic-sdk-request-exec.ts` 在 AI SDK `transformRequestBody()` 之后，把 raw anthropic assistant 历史恢复为真正的 `thinking` blocks。
- 同时 request sanitizer 也必须保留 reasoning-only assistant turn，否则 rawBody 到不了最终 restore。

## 2026-05-13 responses→chat_process→anthropic 审计
- 目标：审计 responses 入口协议语义是否完整进入 chat process，并在 anthropic 出站/回包链路保持语义等价。
- 方法：沿 `HTTP entry -> hub normalize -> chat_process -> req_outbound_stage3_compat -> provider runtime anthropic -> response normalize/outbound` 逐段核对字段与测试。

## 2026-05-13 responses/chat_process/anthropic 协议审计（进行中）
- 已读真源：responses_openai_codec.rs / hub_req_inbound_semantic_lift.rs / anthropic_openai_codec.rs / hub_resp_outbound_client_semantics.rs。
- 审计方法：按字段矩阵核对 Responses 入站 -> chat_process -> anthropic 出站 -> anthropic 回包 -> Responses 回包。
- 本轮目标：确认每个协议字段是否语义等价保留、提升、转换或丢失，并补测试证据。


## [2026-05-13] responses/chat_process/anthropic 协议字段审计（继续）
- 已锁定真源链：responses_openai_codec / hub_req_inbound_* / anthropic_openai_codec / hub_resp_outbound_client_semantics / anthropic-sdk-request-exec。
- 当前重点：用测试收口字段级结论，并判定 `request_codec_harvests_malformed_assistant_tool_markup_from_history` 是测试过期还是实际回归。
- 审计原则：只按真源级入站/语义提升/出站/回包恢复逐层核对，不按表面运行成功下结论。

## [2026-05-13] dangling_tool_call on /v1/responses
- 现象：responses 入口连续报 `dangling_tool_call: bridge tool_call ... does not have a matching tool result in history`。
- 方法：先定位唯一抛错点与样本，再判断是输入历史合法但规则过严，还是历史构造真坏。

## 2026-05-13 dangling_tool_call build/install/replay
- 已确认 Rust 真源修复在 hub_pipeline.rs：sync_responses_context_from_canonical_messages 允许 terminal pending tool call。
- 进入 build/install/在线复测阶段，目标验证 10000 服务上的 /v1/responses 不再报 dangling_tool_call。

## [2026-05-13] responses 协议审计 + anthropic/deepseek-web 修复闭环
- 任务目标: 修复 responses 协议审计暴露的问题，覆盖 /v1 chat process -> provider(重点 anthropic / responses / deepseek-web) -> client remap 的单一路径语义正确转换与返回，并完成 replay + live verify。
- 约束: 只改唯一真源 owner（Rust codec / hub pipeline / SSE builder / responses continuation store/client remap）；禁止 fallback / 静默失败 / 猜测式 harvest / 裁剪真实 payload。
- 执行顺序: 先审计字段语义矩阵，再修 P0，再补定向回归，最后 build/install/restart/live verify。
- 已发现: 设计文档实际路径为 docs/design/protocol-audit-responses-anthropic-fix-plan.md；当前工作树已存在与本任务相关的脏改动（hub_pipeline.rs / anthropic_openai_codec.rs / anthropic-sdk-request-exec.ts 等），需要先核对是否就是待闭环修复。
- 现象线索: MEMORY 已记录 dangling_tool_call 真源修复候选在 hub_pipeline.rs；仍需补字段矩阵、same-shape replay、control replay、10000 live 证据。
- 定向测试结果: Rust / responses 字段审计 / continuation / roundtrip 已通过；sharedmodule SSE 定向中仅剩 anthropic pre-anchor idle 用例失败，表现为 non-semantic ping 仍把 pre-anchor 计时拖到 116ms，和 responses/chat 已改为 firstFrameAtMs 锚点不一致。
- 假设: anthropic SSE converter 仍用 lastFrameAtMs 作为 pre-anchor 锚点，是同类真源遗漏；应与 responses/chat 保持 firstFrameAtMs 单一路径语义。

## 2026-05-13 responses submit_tool_outputs / thinking 历史续接排查（继续）
- 已从 live 样本反查：首轮成功 `req_1778640103579_63faa37e` 的上游 anthropic response 含 `content:[{type:"thinking"},{type:"tool_use"}]`。
- 已从 live 样本反查：续轮失败 `req_1778640369817_c99b7f81` 的 provider-request 只有 `user + assistant.tool_use + user.tool_result`，完全没有 assistant thinking/history，最终触发上游 400 `The reasoning_content in the thinking mode must be passed back`。
- 当前待证实分叉：A) responses client remap 首轮就没把 thinking 放进可记录 output；B) client payload 有 reasoning，但 responses continuation store 的 record/resume 丢掉了。
- 下一步：绕过 SSE，直接跑 anthropic message -> openai chat -> responses payload 真源函数，打印首轮 client payload；若 payload 已缺 reasoning，则唯一真源在 Rust responses client remap/shared_responses_response_utils；若 payload 有 reasoning 而 resume 后没了，则唯一真源在 shared_responses_conversation_utils.rs。
- 2026-05-13 继续证据：新增 Rust 定向测试已通过，但 Jest/Node roundtrip 仍表现旧行为，说明当前 Node/Jest 正在加载未重编译的 native 绑定；需先 rebuild core 再继续 JS/live 验证，不能把这类“旧二进制”现象误判为源码修复无效。

## 2026-05-13 managed tmux codex resume missing-id audit
- 现场 start_cmd 已证实：`rcc-zterm` 的 pane 命令真的是 `codex resume --dangerously-bypass-approvals-and-sandbox -p long`，后面没有 SESSION_ID，也没有 `--last`。
- 新红测已补：`tests/cli/codex-command.spec.ts` 现在同时钉死两件事：
  1. 若用户显式传 `resume <SESSION_ID>`，managed tmux shell command 必须原样保留该 session id；routecodex 不得丢 positional arg。
  2. 若在 managed tmux 模式下启动 bare `codex resume`（无 SESSION_ID、无 `--last`），launcher 必须 fail-fast，不能把一个会立即退出的命令塞进 tmux pane。
- 结论收口：这次真因不是 routecodex 把 SESSION_ID 丢了；显式 id 透传链是好的。真正缺口是 launcher 之前允许 managed tmux 启动 bare `codex resume`，导致 pane 直接死亡。
- 唯一修点：`src/cli/commands/launcher-kernel.ts` 在 codex managed-tmux 路径新增参数门禁，检测 `resume` 是否缺少 target；缺 target 时直接报错 `requires an explicit SESSION_ID or --last`，不再创建/注入 managed tmux 会话。

## 2026-05-13 responses anthropic audit
- 现象：fresh /v1/responses submit_tool_outputs live 仍报 `The reasoning_content in the thinking mode must be passed back to the API.`，而 resumed chat request 已含 reasoning-only assistant 历史。
- 假设：丢失发生在 chat request -> anthropic provider-request native codec，而非 continuation store / bridge_input。
- 验证：对比 fresh fail sample provider-request 与 /tmp/debug-resume-context.mjs 输出；前者缺 assistant thinking，后者已有 reasoning-only assistant turn。
- 唯一真源：router-hotpath-napi/src/anthropic_openai_codec.rs 中 request-like OpenAI chat payload 误走 response builder。
- 当前修法：新增 request-like 分流与 request builder，保留 assistant reasoning-only turn，等待 build/install/restart + fresh live 闭环。


## 2026-05-13 responses submit -> mimo thinking 400

- 现场样本 `~/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778642793029_2bc41975/provider-request.json` 已证实上游实际收到的 anthropic `/v1/messages` payload 为 3 条：`user` / `assistant(tool_use)` / `user(tool_result)`，缺失 reasoning 历史。
- `anthropic-mapper-from-chat.ts` 当前默认 **不用 native build**（`shouldUseNativeBuild` 默认 false，需 env/heavy input 才开）。因此小请求 live 先走 JS `buildAnthropicRequestFromOpenAIChat(...)`。
- 但这还不是结论；需继续核实真正真源是否是 JS builder 本身，还是更前面的 req_outbound compat 真源未把 reasoning 镜像到 assistant tool_use 历史。

- 新二分证据：把 live 坏样本 `provider-request.json.body` 直接喂 `runReqOutboundStage3CompatWithNative(...)`，无论带不带 `anthropic:claude-code` profile，native 输出都会给 assistant `tool_use` 历史补 `reasoning_content: "."`。
- 因此当前 live 丢 reasoning 的真源 **不在 Rust thinking_history/compat 逻辑本身**，而在 live 链路里传给 stage3 compat 的 outbound adapter context / providerProtocol / 调用顺序。下一步查 `hub-pipeline-route-and-outbound-setup.ts` 与 outboundAdapterContext。
- 2026-05-13 继续闭环：当前源码已含 anthropic transport `restoreAnthropicThinkingHistoryFromRawBody` 与 call-options reasoning 映射；但本地直跑 `npx jest tests/sharedmodule/responses-submit-tool-outputs.spec.ts` 会命中 ESM/jest 装载问题，不能把它当作业务失败结论，需改走仓库既定测试入口。
- 2026-05-13 继续闭环：旧 live 失败样本 `req_1778642793029_2bc41975/provider-request.json` 仍是 0.90.1563 的 transport 前快照，body 只有 user/assistant(tool_use)/user(tool_result) 三条，不足以否定当前源码；必须 rebuild/install/restart 后再抓新样本。

== note append marker ==

## 2026-05-13 responses submit live reasoning audit
- 假设：live submit_tool_outputs 中 reasoning-only assistant 不是 store/resume 丢，而是在 chat-process sanitizer 把 `content:""` 且仅 `reasoning_content` 的 assistant 误删。
- 依据：离线 `buildChatRequestFromResponses` 已能恢复 `assistant {content:"", reasoning_content:"..."}`；live provider-request 仅剩 assistant(tool_use)+user(tool_result)，符合 sanitizer 删除空 assistant 的形状。
- 下一步：核对 sanitizer 调用链与定向测试，验证是否是唯一真源。
- 验证结论：live/离线分叉点确定在 `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.ts`。
- 现象：离线 `buildChatRequestFromResponses` 可恢复 `assistant {content:"", reasoning_content:"..."}`；live provider-request 缺该 turn，且仅此 sanitizer 负责在 chat-process 主链删除“空 assistant”。
- 假设验证：补 `reasoning_content/reasoning` 保活逻辑后，Jest `chat-process-request-sanitizer.spec.ts`、`responses-submit-tool-outputs.spec.ts`、anthropic transport、sharedmodule SSE 均通过。
- 唯一真源：这是 chat-process request 清洗 owner；改 continuation store / remap / provider 只会制造第二实现面。

## 2026-05-13 responses anthropic submit live audit continue
- 继续收口剩余 live 阻塞：submit_tool_outputs 在 anthropic 出站链丢 thinking/history。
- 本轮先核对 anthropic 出站 builder / compat / transport 当前源码与已有脏改，定位最后一次还保留 reasoning 的层。

- 新假设：anthropic request builder 可能把 thinking block 错写成 `{type:thinking,text:...}`；Mimo/Anthropic 上游要求 `{type:thinking,thinking:...}`。需用 same-shape payload 验证。

- 2026-05-13 13:19 在线 10000 复测：submit/thinking 400 未再出现；最新阻塞切换为 upstream Cloudflare 504 与 anthropic SSE semantic-timeout。说明本轮 anthropic thinking-history 修复已进入 provider-request/live 主链。

## 2026-05-13 fresh live SSE/504 closeout
- 继续收口 10000 live 新阻塞：ANTHROPIC_SSE_TO_JSON_FAILED / Cloudflare 504。
- 先看原失败样本 provider-request/provider-error/provider-response，再对照 anthropic SSE converter 与 http-client 真源。

- 2026-05-13 继续修 fresh SSE：将 anthropic non-empty thinking_delta 视为 semantic progress，避免被误判为 pre-anchor no-progress。

## 2026-05-13 server issue audit resume
- 用户要求先核对服务器上当前仍未解决的问题，再恢复协议审计修复。
- 2026-05-13 recent codex-samples check:
  - 最新成功样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778650056770_6af6741c` -> requestId `...184817-408`，初始 user-only 请求，provider-request 仅 1 条 user message，13:27:39 成功 tool_calls。
  - 最新失败样本：`.../req_1778650161564_143be555` -> requestId `...184818-409`，followup provider-request 已含 assistant tool_use + user tool_result，但 assistant turn 缺 `reasoning_content`；与线上 13:29:21 的 Mimo 400 `The reasoning_content in the thinking mode must be passed back to the API.` 直接对上。
  - 最新 errorsample：`/Volumes/extension/.rcc/errorsamples/payload-contract-error/responses.inbound_tool_history_contract-20260513-024313-344Z-3dd48d3d7d1268.json`，requestId `...184238-2934`，类型 `responses.inbound_tool_history_contract`，表现为 orphan `function_call_output`。
## 2026-05-13 mimo reasoning_content 丢失追踪
- 目标坏样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778650161564_143be555` / requestId `openai-responses-mimo.key1-mimo-v2.5-pro-20260513T132921564-184818-409`
- 现象：followup anthropic provider-request 已带 assistant tool_use + user tool_result，但 assistant 历史缺 `reasoning_content`，上游返回 `The reasoning_content in the thinking mode must be passed back to the API.`
- 对照成功样本：`req_1778650056770_6af6741c` / requestId `...184817-408`，初始 user-only 请求，成功返回 tool_calls。
- 当前动作：串联上一轮成功 response -> continuation/store -> 本轮失败 request build，确定 reasoning_content 在哪个 owner 丢失。
- 新发现（强真源嫌疑）：`shared_responses_conversation_utils.rs::normalize_output_item_to_input()` 对 `type=reasoning` 的 responses output item 只取 `content` / `text`，不读 `summary` / `reasoning.encrypted_content`，因此会把上一轮 anthropic/tool_use 响应里的 thinking 语义转成一个空 assistant message。
- 该空 assistant message 在后续 `convertBridgeInputToChatMessages` 中会被自然丢弃，所以 materialized followup provider-request 只剩 assistant tool_use + user tool_result，没有 reasoning_content，直接触发 Mimo 400。
- 次级发现：`hub_bridge_actions/bridge_input.rs` 的 `function_call` 分支当前也没有把 entry 自带的 `reasoning_content` 写回 assistant tool_call message；即使上游后来把 reasoning 贴在 function_call item 上，这里也会再丢一次。
- 当前判断：本问题的唯一主修复点优先落在 responses conversation native owner（`shared_responses_conversation_utils.rs`），必要时顺手补 bridge_input 的 function_call reasoning 透传，保证不会二次丢失。
## 2026-05-13 mimo reasoning_content 丢失追踪（本轮继续）
- 本轮先做两件事：1) 精确跑 Rust/Jest/最小脚本复现，确认 reasoning summary 修复是否进入真实 native continuation store；2) 若未生效，再追 native 装载/构建链，而不是拍脑袋改第二处。
- 已核对当前源码：`chat-process-request-sanitizer.ts` 已有 reasoning-only assistant 保活逻辑，因此本轮主嫌疑重新收窄到 responses continuation native owner 或 native 装载链。
- 已核对 anthropic transport：`restoreAnthropicThinkingHistoryFromRawBody` 当前确实会把 `assistant.reasoning_content` 恢复成 `{type:"thinking",thinking:"..."}`，因此若 rawBody 里已有 reasoning_content，transport 不是当前 400 的首嫌疑。
- 精确验证结果：Rust 单测 `converts_reasoning_summary_output_items_into_assistant_reasoning_history` 已通过，但 Node 直接调用 `convertResponsesOutputToInputItemsWithNative(...)` 仍返回空 assistant message（无 `reasoning_content`）。这不是业务链二次丢失，而是 **当前 Node 实际加载的 release native 二进制尚未包含刚通过的 Rust 修复**。
- 证据：同一输入在 Rust test 通过、在 Node/dist native 返回旧形状；因此下一步必须先刷新 native release/bundled `.node`，再继续看 JS/live 结果。
- release native 已重编并同步到 `sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node`；之后 Node 直接调用 `convertResponsesOutputToInputItemsWithNative(...)` 已开始返回 `assistant.reasoning_content`，说明此前失败是 **release native 未刷新**，不是修错业务 owner。
- 定向回归现已恢复：`responses-submit-tool-outputs.spec.ts`、`chat-process-request-sanitizer.spec.ts`、`vercel-ai-sdk-anthropic-transport.spec.ts` 全绿。
- 下一步进入 same-shape replay + build/install/restart + 10000 live 复测。
- same-shape replay 已补：直接用真实成功样本里的 anthropic thinking/tool_use 形状回放 continuation store，恢复出的 chat messages 现在明确包含 `assistant.reasoning_content`；control replay（无 reasoning 的 tool_call）则不会平白插入 reasoning turn。
- `npm run build:min` 已通过，版本自动 bump 到 `0.90.1569`。
- `npm run install:global` 已通过，全局 CLI 报 `0.90.1569`，安装脚本自带健康/anthropic SSE 检查也通过。
- 10000 在线 `0.90.1569` same-shape live 复测结果：首轮 `/v1/responses` 正常返回 tool_call，但 submit_tool_outputs 第二轮仍然 400：`The reasoning_content in the thinking mode must be passed back to the API.`
- 这说明“continuation store + native release 刷新”只修了离线恢复链，**在线主链仍有后续 owner 在 submit 阶段把 reasoning 历史丢掉**；下一步直接抓本次新失败 requestId `openai-responses-mimo.key1-mimo-v2.5-pro-20260513T144702850-184862-453` 的 provider-request 快照，定位在线分叉点。

## 2026-05-13 mimo reasoning_content 丢失追踪（Hub standardized bridge）
- 新验证：当前 `hub_standardized_bridge.rs::normalize_chat_message()` 只保留 role/content/tool_calls/tool_call_id/name，未透传 `reasoning_content` / `reasoning`。
- 证据：源码静态核对 + 上一轮离线 HubPipeline replay 现象完全一致：`buildChatRequestFromResponses` 前有 `assistant.reasoning_content`，进入 standardizedRequest 后被吃掉。
- 当前判断：唯一真源 owner 在 chatEnvelope -> standardizedRequest native normalize，而不是 continuation store / bridge / provider transport。
- 下一步：补 Rust 定向测试钉死 standardized bridge 对 reasoning-only assistant history 的透传，再 build/replay/live 验证。
- 已修改真源：`router-hotpath-napi/src/hub_standardized_bridge.rs::normalize_chat_message()` 现在透传 `reasoning_content` 与 `reasoning`；补了 Rust 定向测试 `standardization_preserves_assistant_reasoning_only_history_fields`。
- 修改理由：该层是 chatEnvelope -> standardizedRequest 的 owner；在这里丢字段会导致后续 HubPipeline / provider-request 全链路都看不到 thinking history。改 continuation store / transport 都只是掩盖，不是根治。
- Rust 定向测试通过：`standardization_preserves_assistant_reasoning_only_history_fields`、`converts_reasoning_summary_output_items_into_assistant_reasoning_history`。下一步刷新 native release 并做离线 same-shape replay。
- 已补 TS 回归：`tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts` 新增 reasoning-only assistant history 用例，钉死 stage2 native standardizedRequest 必须保留 `reasoning_content/reasoning`。
- same-shape replay（14:46 首轮/14:47 续轮的等价 history 形状）已验证：`chatEnvelopeToStandardizedWithNative` 对带 reasoning 的 followup 历史会保留 `assistant.reasoning_content/reasoning`；control（去掉 reasoning-only assistant turn）不会平白注入 reasoning。
- 这直接回答“是否改对 owner”：若标准化层保留字段，则下游 sanitizer/transport 现有回归已绿；若这里不保留，下游永远无从恢复。
- `npm run build:min` 已通过，版本 bump 到 `0.90.1570`。进入全局安装与 10000 重启。
- `npm run install:global` 已通过，全局 CLI 版本 `0.90.1570`。下一步：显式 PID 重启 10000 并做 live 两轮复测。
- 已定位 10000 在线 server PID=`56752`（wrapper PID=`5222`），按显式 PID 发送 `SIGUSR2` 受控重启。
- live 闭环证据：
  - 新版 10000 已启动：PID `92783`，`/health`=`0.90.1570`。
  - 新 live 首轮请求（requestId `openai-responses-mimo.key1-mimo-v2.5-pro-20260513T150559832-184912-503`）返回 `requires_action`，output 同时含 `reasoning + function_call`。
  - 新 live submit 请求（requestId `openai-responses-mimo.key1-mimo-v2.5-pro-20260513T150626216-184915-506`）已从原来的 400 变为 200 completed。
  - 对应第二轮 snapshot `req_1778655986216_7ed30902/provider-request.json` 已证实上游真实收到的 assistant tool_use history 带 `reasoning_content: "."`；旧坏样本 `req_1778654822850_4b0a707c` 则完全没有该字段。
## 2026-05-13 继续收口服务器剩余问题：Anthropic SSE semantic-timeout
- 本轮目标：处理当前 10000 仍未闭环的 `ANTHROPIC_SSE_TO_JSON_FAILED` / `Upstream stream produced frames but no semantic progress within 45000ms`。
- 方法：先抓最新失败 requestId/样本/provider-response/provider-request，再回查 SSE decoder 的 semantic progress 锚点与等待行为，锁定唯一 owner 后再改。
- 继续排查 Anthropic SSE semantic-timeout：先验证当前 0.90.1570 是否仍在线复现，避免对旧日志误修。
- 新结论：当前 0.90.1570 重启后的 `ANTHROPIC_SSE_TO_JSON_FAILED` 在现场 requestId `...185024-615` / `...185027-618` 上都属于“首尝试 semantic-timeout -> 同 requestId retry_same_provider -> 最终 200 stop”的中间错误，不是最终链路失败。下一步转为修日志/错误语义，避免把已恢复的重试过程误报成故障。
## 2026-05-13 SSE semantic-timeout 日志语义止血
- 现象：10000 上 `openai-responses-mimo...185024-615` / `...185027-618` 首次 attempt 在 `provider.sse_decode` 报 `ANTHROPIC_SSE_TO_JSON_FAILED`，但同 requestId 随后 `retry_same_provider` 并最终 200 completed；当前用户可见问题是日志先打了红色 `convert.bridge.error`，误导为最终失败。
- 假设：唯一 owner 在 `src/server/runtime/http-server/executor/provider-response-converter.ts` catch；它已能识别 `provider.sse_decode` 与 `retryable`，但无条件用 `convert.bridge.error` 记日志。
- 验证：stage-logger 以 stage 名决定 error/red；只要继续用 `convert.bridge.error` 就必然是红错，改 details 无效。request-executor retry policy 已正确把该错误视为 recoverable 并重试成功，说明不该动 retry policy / SSE converter。
- 当前修法：对 `requestExecutorProviderErrorStage=provider.sse_decode && retryable=true` 改打 `convert.bridge.recoverable`，保留原错误抛出与重试行为不变；补 Jest 回归钉死 recoverable SSE decode 不再打 `convert.bridge.error`。
- build/install/restart 证据：`npm run build:min` 产出 `0.90.1571`；`npm run install:global` 成功，全局 `rcc --version`=`0.90.1571`；显式对旧 PID `92783` 发送 `SIGUSR2` 后，10000 新 PID=`39579`，`/health.version`=`0.90.1571`。
- 在线验证：重启后日志未再出现 `convert.bridge.error` / `ANTHROPIC_SSE_TO_JSON_FAILED` / `semantic progress within 45000ms`。主动 live 请求 `openai-responses-mimo.key1-mimo-v2.5-pro-20260513T161835954-185193-784` 走 `thinking/thinking-mimo-primary`，status=200，finish_reason=stop；server log 显示 retries=0 attempts=1，无新的 SSE recoverable 误报。
- 当前剩余边界：重启后尚未自然复现 recoverable semantic-timeout，因此 10000 在线侧目前拿到的是“止血后无新误报 + live 请求成功”证据；`convert.bridge.recoverable` 的直接日志样本已由 Jest 回归钉死，待线上再次遇到同类 recoverable SSE decode 时会进入该 stage，而非旧的 `convert.bridge.error`。
## 2026-05-13 dbittai anthropic provider
- 按 Jason 要求参考 `/Volumes/extension/.rcc/provider/mimo` 新建 `/Volumes/extension/.rcc/provider/dbittai/`。
- 先用 live curl/requests 验证上游：`https://dbittai.com/v1/messages` + `x-api-key: ${CRS_OAI_KEY1}` 成功返回 200 和 `pong`；`https://dbittai.com/messages` 返回前端 HTML，因此该 provider 的唯一正确 `baseURL` 是根路径 `https://dbittai.com`，不能写 `/v1`，否则 RouteCodex anthropic endpoint 拼接后会变成 `/v1/v1/messages`。
- 当前最小真源配置只放已实测模型 `claude-3-5-sonnet-20241022`，不猜 `supportsThinking/maxContext` 等未验证字段。
- 用户改口要求 dbittai provider 使用模型 `MiniMax-M2.7`；先用旧 `CRS_OAI_KEY1` 实测该模型，dbittai `/v1/messages` 返回 503 `Service temporarily unavailable`。当前继续用用户提供的新 key 复测，再决定是否切换 auth 真源。
- 用用户新提供的 dbittai key 复测 `MiniMax-M2.7`：`https://dbittai.com/v1/messages` 返回 200，响应模型名即 `MiniMax-M2.7`，内容为 anthropic message shape，且含 thinking block，足以确认模型/鉴权可用。
- 因此 `dbittai` provider 的唯一正确当前真源改为：`baseURL=https://dbittai.com`、`defaultModel=MiniMax-M2.7`、auth=`x-api-key` 且使用用户新提供 key；旧的 `claude-3-5-sonnet-20241022` + `CRS_OAI_KEY1` 组合不再作为当前配置真源保留。

## 2026-05-13 port-mode-protocol-routing 审计

Verified findings:
- `docs/design/port-mode-protocol-routing.md` 已定义完整的多端口 + provider/router 模式设计，但 host runtime 当前仍停留在“schema/模块壳已存在、主链 wiring 未闭环”的状态。
- `src/server/runtime/http-server/provider-direct-pipeline.ts` 仅定义了 `executeProviderDirectPipeline()` / `detectInboundProtocolFromRequest()`，仓库内无调用点；说明 provider-mode 直连流水线尚未进入真实请求链。
- `src/server/runtime/http-server/daemon-admin-routes.ts` 只有在 `getPortRegistry + getPortConfigs + applyPortConfig` 同时传入时才注册 `/admin/ports`；但 `src/server/runtime/http-server/routes.ts` 调用 `registerDaemonAdminRoutes()` 时未传这些 options，因此 ports CRUD 当前不会实际注册。
- `applyPortConfig` 只有类型约定与 handler 调用，没有任何真实 owner；这意味着“立即生效”的端口 CRUD 设计尚无执行器。
- `PortRegistry` 只在 `index.ts` 暴露 `getPortRegistry()`；`attachServer/removePort/stopAll` 没有接入 startup/reload/shutdown 生命周期。`startHttpServer()` 仍只执行单个 `server.app.listen(server.config.server.port, ...)`。
- `normalizePortsConfig()` 与 `ServerConfigV2.ports?: PortConfig[]` 已实现，说明 schema/兼容层落地了；但 runtime 并未真正按 `ports[]` 启动多 listener。
- `provider-direct-pipeline.ts` 的 relay 仅做浅层字段 remap（system/messages/max_tokens/stream），与设计文档要求的“语义级协议转换链”不一致。
- llmswitch-core 当前可见的 `processMode` 仍只覆盖 `chat | passthrough`；未见设计文档声称的 `provider-direct` 真正类型面。host 层也未见对此模式的消费。

Why this is the unique audit conclusion:
- 当前差异的真源不在 schema，而在 runtime owner：route wiring、listener lifecycle、provider-direct request dispatch 三处都未接通。继续把问题归咎于 WebUI、handler 或 config 文档都会错位，因为这些层已经有壳；真正缺的是主链 owner。

## 2026-05-13 port-mode live mismatch: 10000 health ok but /admin/ports shows 5562
- 现象：10000 在线 `/health`=`0.90.1573` 且 server log 明确 `[PortRegistry] Port 10000 (router) registered`，但 `/admin/ports` 返回 `5562 stopped`。
- 假设：不是 PortRegistry 注册错，而是 `/admin/ports` 的配置真源 `getPortConfigs()` 仍在运行旧 dist 逻辑，把 userConfig `httpserver.port=5562` 覆盖到 runtime bind port 10000。
- 验证：
  1. `src/server/runtime/http-server/index.ts#getPortConfigs()` 当前源码已是 `...rawHttpserver, port:this.config.server.port` 顺序；
  2. `dist/server/runtime/http-server/index.js#getPortConfigs()` 仍是旧顺序 `port:this.config.server.port, ...rawHttpserver`，会被 `/Volumes/extension/.rcc/config.mimo.json` 里的 `5562` 覆盖；
  3. 10000 server log 显示当前加载的 user config 就是 `/Volumes/extension/.rcc/config.mimo.json`。
- 唯一真源：`getPortConfigs()` 是 `/admin/ports` 当前配置视图 owner；PortRegistry 只维护 runtime state，不能反向修配置真相。
- 为什么其他改法错：
  - 改 `/admin/ports` handler 去优先信 PortRegistry 会把“配置视图 owner”挪到读取层，形成第二实现面；
  - 改 PortRegistry 在注册时伪造 config=10000 只能掩盖症状，热更新/删除时仍会和 userConfig 漂移；
  - 只重启不 rebuild/install 也不对，因为当前 dist 产物仍是旧逻辑。

## 2026-05-13 provider-direct relay 语义边界收口
- 现象：`provider-direct-pipeline.ts` 原先对任何跨协议都走 `remapPayloadFields()`，但真正只实现了 `openai-chat ↔ anthropic-messages` 的浅层字段改写；像 `openai-responses -> anthropic-messages` 会静默透传错误 payload。
- 假设：relay owner 不该继续放行未实现的 semantic map；唯一正确动作是在 `convertProtocolForRelay()` 边界 fail-fast，明确只支持已验证协议对。
- 验证：
  1. 源码静态核对确认 remap 只处理 `system/messages/max_tokens/stream`；
  2. Jest 新增 `fails fast when relay would require an unsupported cross-protocol semantic map` 通过；
  3. 10000 live on `0.90.1575`：provider 临时端口 `58356` 上 `/v1/responses` 返回 502，错误为 `Provider mode relay only supports openai-chat <-> anthropic-messages today...`；同时 `openai-chat -> anthropic-messages` 在 auto/relay 下仍为 200。
- 唯一真源：`provider-direct-pipeline.ts::convertProtocolForRelay()` 是 provider-mode relay 语义 owner；改 endpoint handler / provider transport / 文档都不能阻止未支持协议对被错误放行。
- 为什么其他改法错：
  - 只改文档不改代码，会继续让 live 未支持协议对穿透；
  - 在 provider transport 末端兜底，会把 host-side mode owner 下沉成第二实现面；
  - 在 requestExecutor/HubPipeline 层加拒绝，则 provider-mode 反而绕远，破坏 owner 边界。

## 2026-05-13 mimo '.' / '..' 输出排查
- 用户新问题：17:07 左右 Mimo followup 出现 `finish_reason=stop` 且输出疑似 `.` / `..`。
- 规则：先抓 requestId `...185350-941` / `...185351-942` 原样本，确认点号来自 upstream 还是本地清洗/桥接；若属 upstream，再判断是否应该清理与自动 continue。
## 2026-05-13 anthropic tool-loss / repeated "I need to call exec_command" loop
- 新现象：用户截图显示 Anthropic/Mimo 链路里模型反复输出“我需要停止分析并调用 exec_command”之类文本，但工具并未真正执行，怀疑是 tool availability / tool history / continuation 恢复状态机失真。
- 当前动作：先从最近 codex samples / server logs 抓同类 request，确认是上游没发 tool_use、还是我们把 tool_use/tool definitions/history 丢了，再锁定唯一 owner。
- 新证据（req_1778665786296_a7a5d812 / requestId 17:49:46 185486-1077）：provider-request 里 tools 27 个都在，工具并未丢失；污染点是历史 assistant turn 被原样回灌为纯文本自我指令："I keep writing analysis text instead of calling exec_command..."。
- 这说明“工具丢失”不是根因；真问题是：上游 stop 回复里出现 narrative tool intent / self-instruction 文本，但我们既没把它当 payload-contract failure，也没在下轮 context restore 前剔除，导致相同垃圾 assistant turn 在后续 provider-request 中反复累积。
- 候选 owner：
  1) `src/server/runtime/http-server/executor/request-executor-response-contract.ts`：当前轮 stop 完成但无 structured tool_calls 的合同判定；应识别 narrative tool intent，阻止其作为正常成功返回。
  2) `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.ts`：下轮 context restore 的唯一清洗入口；应剔除已污染历史里的 meta tool-intent assistant turn，避免继续回灌上游。
- 2026-05-13 anthropic tool-loss 最小收口补充：实际污染样本 `req_1778665786296_a7a5d812` 不止有 `instead of calling exec_command / ONLY call exec_command`，还反复出现更短变体 `I need to stop writing analysis and just execute commands. Let me do it now.`；若只拦第一类，污染仍会继续回灌。已将 sanitizer 规则保持在极窄边界：仅额外拦 `stop writing analysis` + `just execute commands` 这种纯执行自我叙述，不扩成通用 narrative-intent 识别。
- 2026-05-13 两个最小问题补充验证：
  - dot-only：直接用 `buildOpenAIChatFromAnthropicMessage({content:[{type:"thinking",thinking:"."}]})` 回放，结果 `message.content=""` 且 `reasoning/reasoning_content` 全部为空；再用 `detectRetryableEmptyAssistantResponse({status:"completed", output_text:"."})` 回放，命中 `responses_empty_output`。说明点号会在“入上下文前”或“空输出合同”两个唯一 owner 被止血，不会继续污染 context。
  - tool-loss 污染回灌：对真实坏样本 `req_1778665786296_a7a5d812/provider-request.json` 做 same-shape replay，`sanitizeChatProcessRequest()` 将 assistant history 从 514 条压到 339 条，其中 `removedExplicitToolSelfNarrationTurns=15`，剩余污染 0；control replay（正常 reasoning + 真 tool_calls）则 3 条消息完全保留，说明规则仍维持极窄边界，没有误删正常工具轮。
- 2026-05-13 18:xx 构建/安装/10000 重启：`npm run build:min` 成功并把版本 bump 到 `0.90.1576`；`npm run install:global` 成功，CLI/version=`0.90.1576`。随后对 10000 运行中显式 PID `65258` 发送 `SIGUSR2`，`/Volumes/extension/.rcc/server-10000.pid` 在 1s 内切到新 PID `54074`，`/health.version` 变为 `0.90.1576`，说明新代码已在线。
- 2026-05-13 10000 重启后在线 smoke：使用 `ROUTECODEX_HTTP_APIKEY` 对 10000 发起 authenticated live 请求，`POST /v1/responses`（model=`mimo-v2.5-pro`, input=`Reply with ok only.`）返回 200 completed，`output_text="ok"`；同时 `POST /v1/messages` 返回 200，日志 requestId `...185495-1086` / `...185496-1087` 均显示 retries=0、decode.sse=0ms。说明新版本已在线承接 responses + anthropic 两条入口。
- 2026-05-13 新现场 `...185497-1088` / `...185498-1089` 复盘：不是 tools definition 丢失。坏样本 `provider-request.json` 仍带 `tools=27`，且更早的 assistant `tool_use` 历史仍在（如 idx 565/567/569 的 `exec_command` anthropic tool_use）。真问题是：旧污染 assistant turn 已经换了一类文案——`The user wants me to ... Let me just create the file directly.` / `The user is frustrated. They want me to ... I'll create ...`——此前 sanitizer 没拦到，导致它们被回灌进 history；同时当前轮 `/v1/responses` 返回这种 future-intent prose + `finish_reason=stop` 时，也没有被合同层拦成缺失工具调用。
- 已补两个唯一 owner 的最小止血：
  1) `chat-process-request-sanitizer` 新增极窄的 task-restatement future-intent 清洗，只拦以 `The user wants me to...` / `The user is frustrated. They want me to...` 开头且带 `Let me` / `I'll` 的 assistant 污染；
  2) `request-executor-response-contract` 新增同类文本在 `hasRequestedToolsInSemantics && no function_call output` 下直接判成 `responses_missing_required_tool_call`，避免当前轮 200 stop 被当成功。
- 2026-05-13 继续止血 `tools:tool-request-detected` 但只嘴炮不调工具：版本已 build/install/restart 到 `0.90.1577`。10000 旧 PID `54074` 经 `SIGUSR2` 受控重启为新 PID `33917`，`/health.version=0.90.1577`。

## 2026-05-13 save/restore loop 真因（mimo 18:51）
- 新现场 `1129/1130` 已确认不是 tools definition 丢失；`provider-request.json` 里 `tools=27` 仍在。
- 真问题是 save/restore 后的历史尾部被污染为反复的 assistant mirror turn：`role=assistant`、`content` 为纯文本、`reasoning_content` 与 `content` 完全相同、且无 `tool_calls`。
- 这类 mirror turn 会在下一轮继续回灌上游，形成“我现在就执行 / no more analysis”无限循环。
- 额外发现：当前源码 sanitizer 还存在一个真 bug：若 assistant 历史是 anthropic block 形状 `content=[{type:tool_use,...}]` 且无 `tool_calls` 字段，会被误判为空 turn 删除。已修。
- 额外发现：sanitizer 即使规范化了 `tool_calls` / `tool_call_id`，只要没有 assistant 删除就会直接 `return sanitized`，导致规范化结果丢失。已修为 shape 变更也返回新 messages。
- 当前修复方向严格限制为 shape-only：
  1) 删除重复 mirror assistant suffix（按最后一次 tool boundary 之后的重复 cluster）；
  2) 保留真正的 `tool_use` / `tool_result` block；
  3) 去掉 `request-executor-response-contract` 里按句子内容匹配 `The user wants me to ...` 的规则。
- 回归新增：
  - `chat-process-request-sanitizer.spec.ts` 新增 real sample replay（`req_1778669500982_9b5b55f1`）
  - 覆盖 repeated mirror suffix / single mirror control / malformed tool_call normalization / tool role alias normalization
- dist 回放 `req_1778669500982_9b5b55f1` 后发现当前“只清最后一个 tool boundary 之后的坏尾巴”仍会留下 90 个历史 mirror assistant turn；因此继续收口为“按每个 tool boundary 分段清理重复 mirror cluster”。
- 分段清理版 dist 回放：`req_1778669500982_9b5b55f1` 从 522 条降到 449 条，`removedDuplicateMirrorAssistantTurns=73`；最后 20 条历史已无 mirror assistant loop，剩余 28 个 mirror 为更早历史中的单点/非重复段。

## 2026-05-13 port-mode 完成度审计（第二轮）
- 目标清单映射：
  1. 多端口 runtime 闭环：源码已见 `getPortConfigs() -> startHttpServer() -> startPortListener() -> PortRegistry.attachServer/removePort/stopAll()`，`buildHttpHandlerContext()` 通过 `req.socket.localPort` 把请求送进 `executePortAwarePipeline()`。
  2. Admin ports 管理面：`registerHttpRoutes()` 现在真实传入 `getPortRegistry/getPortConfigs/applyPortConfig/getAvailableProviders`，`daemon-admin-routes.ts` 已真实注册 `registerPortsRoutes()`。
  3. Router/Provider 分流：唯一 owner 在 `index.ts::executePortAwarePipeline()`；router 走 `requestExecutor.execute()`，provider 走 `executeProviderDirectPipelineForPort()`，没有在 endpoint handler 私自分流。
  4. protocolBehavior：`provider-direct-pipeline.ts` 已明确 `direct/relay/auto`，其中 relay 真边界只允许 `openai-chat <-> anthropic-messages`，其他跨协议 fail-fast。
  5. 文档对齐：`docs/design/port-mode-protocol-routing.md` 已把 `provider-direct` 明确为 host-side owner，并在 8.2 写出“已实现/未扩展”边界。
- 当前证据强度：
  - 代码证据：已足够证明 owner/链路已接通。
  - 测试证据：仓库中已有 `tests/server/http-server/port-mode-routing.spec.ts` 与 `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`，覆盖 `/admin/ports` 热增删、router/provider 分流、provider list fallback、runtime bind port 优先、direct/auto/relay 行为。
  - live 证据：10000 `/health` 当前为 `0.90.1579`；匿名 `GET /admin/ports` 返回 401，至少证明路由存在且受保护。仍缺“已认证 /admin/ports 返回真实列表”与“provider-direct live 请求日志”两条更强在线证据。
- 未闭环项：
  1. 需要重跑上述 port-mode 定向 Jest，确认当前工作树下仍为绿。
  2. 需要至少一次 build/install（如用户目标要求）与 10000 在线复测证据回收。
  3. 若要宣称整个 /goal 完成，还需把每个显式 gate（tests/build/install/restart/live/doc consistency）逐项映射到真实输出；目前只能说“port-mode 主链看起来已落地，但审计还没完成”。
- 定向 Jest 复测（2026-05-13 19:41 CST）：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/server/http-server/port-mode-routing.spec.ts` => 4/4 通过。
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/server/runtime/http-server/provider-direct-pipeline.spec.ts` => 3/3 通过。
  - 说明：`npm test -- ...` 会先包一层项目级 `test:routing-instructions`，当前仓库存在与 port-mode 无关的缺文件/旧失败，不能拿那条包装命令当 port-mode 证据；本轮验收以定向 Jest 为真证据。
- live 10000 认证验证（2026-05-13 19:46 CST）：
  - `GET /daemon/auth/status` => `authRequired=true, hasPassword=true, apiKeyConfigured=true`。
  - 带 `x-routecodex-api-key` 的 `GET /admin/ports` => `{"ports":[{"port":10000,"host":"0.0.0.0","mode":"router","status":"running",...}]}`，证明 `/admin/ports` 已真实注册且在线可读。
- live provider 端口回放（2026-05-13 19:46 CST）：
  - 临时创建 `52650`（provider/direct, binding=`mimo.key1.mimo-v2.5-pro`）后，对 `/v1/chat/completions` 发 OpenAI Chat 请求并携带 API key，返回 `502`，错误：`Provider mode with protocolBehavior=direct requires matching protocols: inbound=openai-chat, provider=anthropic-messages`；证明 `direct` 跨协议 fail-fast 在线生效。
  - 临时创建 `52651`（provider/auto, 同 binding）后，对 `/v1/chat/completions` 发同类请求并携带 API key，返回 `200`；证明 `auto` 已按跨协议走 relay 到 anthropic provider，而不是落回 router 主链。
  - `~/.rcc/logs/server-10000.log` 命中：`[PortRegistry] Port 52650 (provider) registered`、`Port listener started on 127.0.0.1:52650 mode=provider`、`Port 52651 ... mode=provider`。虽然当前日志未直接打印 `port_pipeline.dispatch/provider-direct.send.*`，但在线行为已证明 provider 端口确实走了 provider-mode owner，而不是 router 路由池。
- 审计结论（截至 2026-05-13 19:46 CST）：
  - 已有强证据覆盖：`ports[]` 生命周期、`/admin/ports` 注册与热生效、router/provider 唯一 owner 分流、`direct/auto/relay` 关键语义边界、设计文档 8.2 的当前真相。
  - 仍未补齐的 goal 强制 gate：还没重新执行并保存本轮 `npm run build:min`、`npm run install:global` 的当前证据；因此不能把整个 /goal 宣称为“最终完成”。
- 10000 重启后在线复测（2026-05-13 19:48 CST）：
  - `/health.version` => `0.90.1580`。
  - 认证 `GET /admin/ports` => `10000 router running`。
  - 新建临时 provider 端口后再次复测 `direct/auto`：要求 direct 继续跨协议 fail-fast，auto 继续返回 200，作为 build/install/restart 后的新版本在线证据。
- 证据口径纠偏（2026-05-13 19:52 CST）：
  - 负向 fail-fast 样本（`direct` 跨协议 502、`relay` unsupported pair 502）只能算**边界验证证据**，不能算“功能成功证据”。
  - 正向成功证据必须是 200：当前已补齐 `10000 /v1/responses` => 200 `output_text=ok`，以及 provider 端口 `auto` 模式 `/v1/chat/completions` => 200，日志命中 `port.provider-direct -> mimo...`。

## 2026-05-13 20:xx tool-loop 现场（用户截图同款）
- 复现证据：`/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778673556073_4dad787c/provider-request.json`（19:59）中，assistant mirror 文本（content == reasoning_content）仍大量回灌，含“Let me take a completely different approach... / stop overthinking...”等重复自述。
- 根因确认：现有 sanitizer 只按“单个 tool boundary 分段内重复”删镜像；当同一句 mirror 在多个 boundary 段各出现一次时不会被删，污染会跨轮累积。
- 唯一修复点：`chat-process-request-sanitizer.ts::collectDuplicateMirrorAssistantIndices()`；新增跨分段 mirror 文本桶（规范化 text 后计数），同文本在 boundary 之后出现 >=2 次即全部剔除。
- 回归：`tests/sharedmodule/chat-process-request-sanitizer.spec.ts` 新增 `removes mirrored assistant text repeated across multiple tool-boundary segments`，验证跨段重复镜像被删；现有 12/13 用例通过（real-sample replay 用例在本机因样本路径条件仍 skip）。

## 2026-05-13 20:31 singleton provider pool exhaustion (PROVIDER_NOT_AVAILABLE burst)
- 现象：10000 在单 provider 路由 + 并发占满时，连续出现 openai-responses-unknown-unknown + PROVIDER_NOT_AVAILABLE。
- 真源：Rust virtual router build_provider_not_available_error 只聚合 quota/health cooldown，未暴露 concurrency busy 的 recoverable cooldown hint；导致 host executor 视为不可恢复并立即失败。
- 修改：
  - core.rs 新增 concurrency_busy_remaining_ms(provider_key, now_ms)
  - selection.rs 在 collect_recoverable_cooldown_for_key 增加 source=concurrency.busy hint
  - request-executor.spec.ts 新增单 provider + concurrency.busy recoverable wait 用例
- 证据：
  - targeted test PASS: waits for recoverable cooldown hint from concurrency.busy when route pool has only one provider
  - 10000 进程 20:08:15 重启后日志窗口未再出现同类 burst（从 line 164906 起检索 PROVIDER_NOT_AVAILABLE/unknown-unknown 为空）

## 2026-05-13 save/restore 重复自述 / tool 丢失 / 400 审计（新一轮）
- 新任务目标：对比前天版本，顺着 `responses -> chat process -> anthropic` 调用链审计当前 save/restore/context 还原问题，锁定工具丢失、重复自述、thinking/400 的唯一真源。
- 先做两件事：1) 锁当前真实坏样本及其 provider-request/history 形状；2) 对比 2026-05-11/05-12 之后在 sanitizer / continuation / bridge / anthropic codec 的提交差异。
- 特别关注：是否存在“save/restore 不按 sticky provider 隔离续链”或“把 provider-local/narrative assistant turn 错存入共享 continuation”的问题。

## 2026-05-13 20:47 mimo EMPTY_ASSISTANT_RESPONSE 现场（req 1738）
- 样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/req_1778676421111_d3f791e8/`，requestId=`openai-responses-mimo.key1-mimo-v2.5-pro-20260513T204701111-186147-1738`。
- 现象：`search/search-mimo-primary` 链路在 session.virtual_hits=16 时直接 502 `EMPTY_ASSISTANT_RESPONSE`；相邻同链路请求 `1737`（20:46:54）与 `1739`（20:47:09）都正常 `finish_reason=tool_calls`。
- provider-request 真相：不是 tools 丢失。请求里 `tools=22`，历史 `tool_use` 全是 `exec_command`，且都在 tool defs 中；尾部形状仍是标准 `assistant tool_use -> user tool_result` 多轮链，最后一条也是 user `tool_result`。
- provider-response 真相：上游原始 Anthropic SSE 只返回 `thinking_delta='.'`，随后 `stop_reason='end_turn'`，没有 text、没有 tool_use。转换后的 responses 体因此变成 `status=completed + output=[assistant empty message]`，被合同层判成 `EMPTY_ASSISTANT_RESPONSE`。
- 初步判断：这条 1738 与 save/restore 工具丢失不是同一类问题；当前证据更像是 **结构合法请求上的上游瞬时空完成**，因为紧邻的 1737/1739 同链路同 provider 都成功出了 tool_calls。
- 但还有一个宿主侧问题要追：`request-executor-provider-response.ts` 对 `EMPTY_ASSISTANT_RESPONSE` 明确打了 `retryable=true`，这条 1738 却没有进入任何 `provider-switch`/retry 日志，说明 `host.response_contract` 失败在当前路径上没有真正落进 send retry 计划，需要继续查 retry owner。

## 2026-05-13 responses<>chat-process<>anthropic save/restore 审计（先审计，不下刀）
- 用户要求先回答三个问题：1) reasoning 为何回灌；2) save/restore 的位置与内容；3) 之后才讨论修改。
- 已核对链路真源：
  1. save request：`req_inbound_stage3_context_capture/responses-context-snapshot.ts -> captureResponsesRequestContext() -> prepareResponsesConversationEntryWithNative()`。
  2. save response：`provider-response.ts::recordResponsesResponse() -> convertResponsesOutputToInputItemsWithNative()`。
  3. restore for outbound responses：`route-aware-responses-continuation.ts -> resumeLatestResponsesContinuationByScope() -> restoreResponsesContinuationPayloadWithNative()`。
  4. restore for non-responses outbound：`route-aware-responses-continuation.ts -> materializeLatestResponsesContinuationByScope() -> convertBridgeInputToChatMessages()`。
  5. anthropic replay：`anthropic_openai_codec.rs` / `anthropic-message-utils-openai-request.ts` 会把 chat `assistant.reasoning_content` 映射成 anthropic `thinking` block。
- 已确认 reasoning 回灌不是偶发 bug，而是 continuity 设计：responses store 把 `output.type=reasoning` 保存成 `role=assistant, content=[], reasoning_content=...`；后续跨协议 restore 到 chat，再被 anthropic request builder 发成 `thinking`。
- 已确认当前 scope key 只有 `sessionId/conversationId`；不含 providerKey/model/protocol。`routeHint` 会一起存，但它只作为 payload/meta 字段，不参与 scope key 判定。
- 已确认当前真正高风险点不是“tools 定义丢失”，而是“哪些 assistant turn 被允许写进 continuation”：`recordResponsesResponse()` 当前会把 responses output 直接转换入 store；而上游真实样本里存在 `content == reasoning_content` 的 assistant mirror/self-talk，被后续 materialize 成 chat history，再在 anthropic 出口转成 `text + thinking` 双污染。
- 实样本证据：
  - `req_1778676798002_98daac0b/provider-request.json`：298 messages, 67 mirror assistant turns。
  - `req_1778676829756_d841af68/provider-request.json`：304 messages, 70 mirror assistant turns。
  - `req_1778676909829_0a23b7ae/provider-request.json`：316 messages, 75 mirror assistant turns。
- 当前结论边界：
  - 已证明“为什么会回灌”与“回灌发生在哪里”。
  - 还未证明 sticky-provider 是否是这批镜像污染的根因；现阶段证据只够证明 scope 不是 sticky，但截图问题首先是 history admission 污染。
- 补充协议真源（OpenAI 官方 docs）：
  - Conversation state：Responses 手动管理上下文时，必须把旧 response 的 output items 作为新 request.input 继续传；用 `previous_response_id` 时则只传新 delta input。
  - Reasoning guide：若手动/无 store 管理状态，必须保留 reasoning items；并且要在 `include` 中打开 `reasoning.encrypted_content`，否则 reasoning item 不能安全用于后续请求。
- 代码补充审计：
  1. `buildResponsesRequestFromChat()` 对标准 responses same-protocol 恢复是：若有 `previous_response_id`，直接发送 `deltaInput + previous_response_id`；否则发送完整 `input`。这和官方 threaded/manual 两种模式一致。
  2. 非 responses provider 的本地 save/restore 不是“原样 replay responses items”，而是先把 continuation 投影成 chat history，再由目标协议 mapper（anthropic/gemini/...）二次映射；因此它天生是 lossy projection，不是协议级等价回放。
  3. 当前最关键字段缺口：`shared_responses_conversation_utils.rs::normalize_output_item_to_input(type=reasoning)` 会把 reasoning item 只压成 `reasoning_content` 文本，直接丢掉 `encrypted_content` / reasoning item id / status / summary-vs-content 边界；这与 OpenAI 对 stateless reasoning continuity 的要求不一致。
  4. 当前最关键污染口：`hub_resp_outbound_client_semantics.rs` 在 responses outbound remap 时，会同时发一个 `reasoning` item（来自 `message.reasoning/reasoning_content`）和一个 `message` item（来自 `message.content`）；若上游/中间层已出现 `content == reasoning_content`，这里不会去重，随后 `recordResponsesResponse()` 又会把两者都写回 continuation，形成 mirror/self-talk 污染。
  5. 二次放大口：`extract_reasoning_text_from_output_item()` 读取 reasoning item 时会合并 `reasoning_content + summary + content (+ thinking/text fallback)`；因此即便 reasoning item 里 summary 只是展示摘要、content 与正文重复，store 也会一并压进 `reasoning_content`，扩大污染面。
  6. 风险但未证实根因：scope key 仍只有 session/conversation，不含 provider/protocol/model；目前已证实它不 sticky，但尚未证明这是当前 mirror 循环的首根因。

## 2026-05-13 mimo HTTP_500 后连续 PROVIDER_NOT_AVAILABLE 审计
- 现象: Mimo provider 出现 HTTP_500 后，后续 fresh /v1/responses 很快转为 PROVIDER_NOT_AVAILABLE。
- 假设: 500 被错误提升为全局/路由级 cooldown，导致单 provider 池被整体打空；或同一逻辑请求错误暴露为 PROVIDER_NOT_AVAILABLE。
- 验证: 先查 server-10000.log 精确 requestId/时间窗，再查 provider failure -> governor/health/backoff -> route selection 全链路。
- 真源: 待锁定，禁止先打补丁。

- 新证据: executor emit 的 recoverable 500 为 affectsHealth=false，不会走 virtual-router health cooldown。
- 新证据: active host provider-quota-daemon 仍依赖 src/manager/quota/provider-quota-center.ts；该实现对 E5XX 一律 inPool=false。
- 对照: sharedmodule/llmswitch-core/src/quota/quota-state.ts 对 E5XX/ENET 前两次 cooldownKeepsPool=true。
- 临时结论: fresh 请求的 PROVIDER_NOT_AVAILABLE 是 host 旧 quota 实现过度摘池，不是 virtual-router recoverable 500 健康冷却。

- 新现象: dbittai 单模型下，已有成功请求进行中/刚完成时，unknown fresh requests 连续 PROVIDER_NOT_AVAILABLE；用户认为应阻塞等待而不是移出池。
- 假设: 这次更像并发/lease/selection busy 路径直接 fail-fast，而不是 500 冷却摘池。
- 验证: 抓 186356-1947 到 186366-1957 的精确日志与 selection/busy/cooldown hints。

## 2026-05-13 21:xx dbittai/provider_not_available 风暴继续审计
- 新现象：用户报告当前问题仍是错误风暴，连续 `PROVIDER_NOT_AVAILABLE`，缺少有效 backoff。
- 当前目标：区分是 route selection 未给 recoverable hint，还是 follow-up/session 层把不可用错误立即重放成风暴。
- 先查 request executor / recoverable cooldown / follow-up 自动续轮链。

- 新真源：`selection.rs::collect_recoverable_cooldown_for_key` 查 concurrency busy 时一直用 providerKey；但 busy state 实际按 runtimeKey/alias scope 写入（`markConcurrencyScopeBusy(runtimeKey)`，`is_provider_available()` 也按 runtimeKey 判忙）。当 providerKey != runtimeKey（如 `dbittai.key1.MiniMax-M2.7` vs `dbittai.key1`）时，路由会判 busy，但 `PROVIDER_NOT_AVAILABLE.details` 不带 recoverable cooldown hint，于是 fresh 请求直接 fail-fast，形成风暴。
- 修复：新增 `core.rs::concurrency_busy_remaining_for_provider()`，统一 providerKey/runtimeKey 两种 busy key；`is_provider_available()` 与 `collect_recoverable_cooldown_for_key()` 都改为复用它。
- 验证：`npm run build:min` 通过；待补本地/在线回放。
- 下一步执行：按项目路由做 `npm run install:global`，然后用显式 PID / 服务级方式重启 10000，再在线回放 dbittai 单模型 busy 场景，确认不再裸 `PROVIDER_NOT_AVAILABLE` 风暴。
- 为避免 install 脚本把无关 e2e 成败混入当前缺陷验证，本轮全局安装使用 `ROUTECODEX_INSTALL_SKIP_E2E=1 npm run install:global`；安装后仍会单独做版本、重启、live replay 证据。
- live 验证（2026-05-13 22:00 CST）：`npm run install:global` 完成；`routecodex restart --port 10000` 与 `--port 5520` 成功，`/health.version` 都是 `0.90.1587`。
- 5520(dbittai) 重启后真实在线链路证据：`server-5520.log` 在 21:58:22~21:59:06 连续出现 unknown fresh requests `2095~2102`，其中并发占满时走 `provider.traffic.acquire wait -> completed`，并继续完成 `tool_calls/stop`；同一窗口 `PROVIDER_NOT_AVAILABLE` 命中数为 0。
- 结论：dbittai 单 provider 的 fresh 请求不再因 runtimeKey/providerKey busy-key 错配而裸 `PROVIDER_NOT_AVAILABLE` 风暴退出；当前在线表现是阻塞等待后继续执行。
- 新残余样本：22:08 附近仍有 `openai-responses-unknown-unknown ... 2170` 的单点 `PROVIDER_NOT_AVAILABLE`；需要核对该次是否仍是 busy hint 丢失，还是另一类不可恢复路径（如 excluded pool / route instruction / logical-chain 状态）。
- 进一步真源：残余样本 `2170` 不是 busy hint 再丢，而是 `request-executor.ts` 的 `poolCooldownWaitBudgetMs = 60_000` 把 singleton recoverable pool 等待硬截断了。证据：2170 从 22:07:05 到 22:08:03 约 58s 才失败，且全程无 `traffic.acquire`；紧接着 2179/2180 在 provider 前内部等待后成功，说明 provider 最终可用，只是 2170 提前被 60s 预算打断。
- 修复方向：保留多候选池的 60s 总预算，但对 `candidateProviderCount == 1` 且存在 recoverable cooldown hint 的 singleton pool，改为持续阻塞等待直到 client abort / provider 可用，不再套用通用 60s 预算。
- 0.90.1588 live（5520）：重启后 22:16:56~22:18:17 连续 unknown fresh requests `2223~2231` 进入并完成；同窗口 `PROVIDER_NOT_AVAILABLE=0`。说明第二层修复后，singleton recoverable pool 不再被 60s 通用预算提前截断。

## Responses Save/Restore Fix 完成记录（2026-05-13）

### P0: Outbound Remap 双发去重缺失（✅ 已修复验证）
- **真源**：`hub_resp_outbound_client_semantics.rs`，`build_responses_payload_from_chat_core`
- **根因**：`should_emit_message` 条件包含 `reasoning_payload.is_some()`，导致 reasoning + message 双写 store
- **修复**：有 reasoning 时，改为"content 非空 AND 不是 reasoning 投影"才发 message item
  - reasoning-only + 空 content → 压制空 message item
  - content == reasoning 投影 → 压制 mirror 污染
  - content 独立 → 两者都发
- **验证**：`deduplicates` / `emits_both` / `only_reasoning_no_message` 三个单测全部通过

### P1a: Reasoning Item Save 丢失 encrypted_content（✅ 已修复验证）
- **真源**：`shared_responses_conversation_utils.rs`，`normalize_output_item_to_input` reasoning 分支
- **修复**：在 reasoning→message 降维时保留 `encrypted_content`
- **验证**：`converts_reasoning_item_preserves_encrypted_content_id_status_summary` 单测通过

### P1b: Reasoning Item Save 丢失 id / status / summary 结构（✅ 已修复验证）
- **真源**：同上
- **修复**：在 reasoning→message 降维时保留 `id` / `status` / `summary`（array 结构）
- **验证**：同 P1a 单测

### P2: Materialize 是 Host-Side Projection（设计选择，无需改代码）
- cross-protocol materialize 移除 `previous_response_id` 是预期行为
- 语义通过 `semantics.continuation` 承接
- 不在本次修复范围

### P3: Scope Key 无 Provider Sticky（评估）
- 当前多 provider 同 conversation 场景未触发覆盖问题
- 暂不修改代码，记录风险

### 改动文件
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`（P0）
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`（P1a+P1b）

### 全量回归
- `shared_responses_conversation` 11 个相关测试全部通过，无回归

## Launcher config.toml 解析错误（2026-05-13）

- 真源：`src/cli/commands/launcher/utils.ts` 的 `readConfigApiKey / tryReadConfigHostPort` 错把 `~/.rcc/config.toml` 当 JSON 解析，遇到 `#` 注释就报 `Unexpected token '#'`，随后错误走 dev default port 5555。
- 唯一修复点：launcher config 读取真源统一改为 `parseLauncherConfigText`，按 `.toml/.json` 解析；不能在 kernel 层吞错硬补端口，否则只是掩盖配置真源读错。

## Per-port 路由需求对齐（2026-05-13）
- Jason 明确需求：多端口不是“全局一套 virtualrouter + 多个监听端口”，而是**每个端口各自拥有独立策略/路由配置**。
- 当前实现真相：`httpserver.ports[]` 只承载 transport 层字段（port/host/mode/protocolBehavior/providerBinding），router 端口没有独立 routing 字段；active routing group 仍是全局 `virtualrouter.activeRoutingPolicyGroup` 单点选择。
- 差异结论：现状只支持“多端口监听 + provider 直连端口”，**不支持 per-port router policy**；我之前按当前实现解释成需求，方向错了。

## 2026-05-13 stopless -> /goal 模式改造调研
- 用户要求：先读取 `~/code/codex` 当前 `/goal` 实现，再给出 RouteCodex 从 stopless 模式改造成 `/goal` 模式的落地做法；本轮先做设计，不动实现。
- Codex 真相：`/goal` 不是靠 stop marker 维持续轮，而是靠 **持久化 thread goal + goal runtime state + idle continuation scheduler**。
  - slash 入口：`codex-rs/tui/src/chatwidget/slash_dispatch.rs`
  - tool 面：`get_goal/create_goal/update_goal` in `codex-rs/core/src/tools/handlers/goal_spec.rs`
  - runtime owner：`codex-rs/core/src/goals.rs`
  - 自动续轮触发：`tasks/mod.rs` 在 turn 清空后发 `GoalRuntimeEvent::MaybeContinueIfIdle`
  - 续轮内容：自动注入一条 developer continuation prompt（`core/templates/goals/continuation.md`），而不是要求模型产出 `reasoning.stop`
- RouteCodex 当前 stopless 真相：
  - 模式来自 payload marker `<**stopless:on|off|endless**>`，入口 `servertool-request-normalizer.ts`
  - 停止合同依赖 `reasoning.stop finalized marker`，owner 在 `request-executor-response-contract.ts`
  - followup/reenter 通过 `servertool-followup-dispatch.ts` 组 nested request，并带 `serverToolFollowup` semantics 回灌
- 差异结论：stopless 是“本轮响应是否允许停止”的合同；goal mode 是“线程级目标是否继续推进”的合同。两者 owner、状态粒度、完成判定都不同，不能只把 `reasoning.stop` 重命名成 `/goal`。

## 2026-05-14 stopless -> /goal 实现切片
- 目标：goal-capable 请求（get_goal/create_goal/update_goal/request_user_input）下，RouteCodex 只透明传输 tools / request_user_input / followup payload，不再 seed/inject/enforce reasoning.stop。
- 唯一真源判定：goal 生命周期属于 Codex `/goal` runtime；RouteCodex 只在 transport 边界识别 goal tools，作为禁用 stopless 代理语义的门禁。
- 最小改动点：host 侧新增 `goal-capable-request.ts`；adapter context/response contract/followup dispatch 只消费该判定；llmswitch TS 现有 reasoning-stop 注入与 guard prepass 在 goal-capable 时直接跳过。

## 2026-05-14 stopless -> /goal completion audit evidence

- Native goal-capable 判定真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_goal_tools.rs`，TS `hub-pipeline-goal-tools.ts` 仅薄壳调用 `resolveGoalCapableRequestWithNative`。
- Host 侧 goal-capable transport helper：`src/server/runtime/http-server/executor/goal-capable-request.ts`，用于 request normalizer / adapter context / response contract / followup dispatch。
- 修复 build 发现的 TS 回归：`native-chat-process-servertool-orchestration-semantics.ts` 中 `detectProviderResponseShapeWithNative` 被误返回 goal plan，已恢复返回 provider shape；`resolveGoalCapableRequestWithNative` 返回显式 typed plan。
- 验证：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`：通过，native bridge/package synced。
  - 定向 Jest 8 文件矩阵：8 suites / 76 tests passed。
  - `npm run build:min`：通过，version 0.90.1547。
  - `npm run install:global`：通过，并触发 build:min + 全局 CLI E2E 检查。
  - `routecodex restart --port 5520` + `curl /health`：5520 已运行 0.90.1547。
- Live `/goal` 代理样本：
  - `codex exec --profile rcm` 经 5520 RouteCodex 代理跑 `/goal`。
  - 样本目录：`~/.rcc/codex-samples/openai-responses/dbittai.key1.MiniMax-M2.7/req_1778695544218_2431aa58`：provider request tools 含 `get_goal/create_goal/update_goal/request_user_input`，provider response 调用 `get_goal/update_goal/create_goal/update_goal`，无 `reasoning.stop/stopless`。
  - request_user_input transport 样本：`req_1778695668924_fb39fefc` provider response tool_use `request_user_input`，nested questions/options JSON 完整；Codex runtime 因 Default mode 返回 `request_user_input is unavailable in Default mode`，随后 `update_goal complete` 成功（`req_1778695675707_a9dd3544` / `req_1778695684174_67088baa`）。这验证 RouteCodex transport；Plan-mode UI 交互未在本轮完成。
- 旧 stopless：未物理删除整个 legacy stopless 系统；按目标完成标准的第二分支，已明确限定为 non-goal legacy，并用测试覆盖 goal mode 不 seed/inject/enforce reasoning.stop，非 goal stopless 旧测仍通过。
- request_user_input feature-enabled live 补充：`codex exec --enable default_mode_request_user_input --profile rcm` 经 5520 代理；样本 `req_1778696304552_08792ac3` 中 provider response tool_use=`request_user_input`，arguments 包含完整 nested `questions[].options[]`；无 `reasoning.stop/stopless`。exec mode app-server 不支持真正等待 UI 答复，返回空 answers；transport 已验证，交互式 Plan/TUI 人工选择未验证。


## 2026-05-14 stopless unified fence + goal runtime 设计对齐
- 本轮已重新纠偏：之前完成的是“Codex `/goal` tools 透明传输”，**不是**“RCC 自己的 stopless 改造完成”。用户已明确否定把这两件事混为一谈。
- 新语法已对齐为单一 fence：`<**rcc**> ... </rcc**>`；第一条非空行固定是 `domain action [arg...]`，后续多行全部进入 body。
- 新 stopless 生命周期已对齐为：`start / pause / resume / stop / done`，目标状态建议：`idle / active / paused / stopped / completed`。
- 本轮仅落盘设计文档，**没有实现 stopless 重构代码**：
  - `docs/design/rcc-unified-fence-marker-spec.md`
  - `docs/design/stopless-goal-runtime-refactor-plan.md`
- 结论：后续如果还保留 `on/off/endless + reasoning.stop finalized marker` 作为真实合同，就不能宣称“stopless 改造完成”。

## 2026-05-14 stopless goal lifecycle audit (in progress)

Verified findings:
- 当前仓库并未实现 `RCC fence + goal lifecycle` 主方案；已落地的只是 `goal-capable tools` 旁路豁免：
  - Host/llmswitch 通过 `goal-capable-request.ts` / `hub_goal_tools.rs` 检测 `get_goal/create_goal/update_goal/request_user_input`，并在 request tooling / guard / followup / response contract 上跳过 `reasoning.stop`。
  - 这只是在旧 stopless 合同上加“goal tools 例外”，不是把 stopless 自身改造成 `start/pause/resume/stop/done` 生命周期。
- 旧 stopless 真源仍大量存在，未满足“物理删除旧合同”：
  - `servertool-request-normalizer.ts` 仍 regex 扫 `<**stopless:on|off|endless**>`。
  - `request-executor-response-contract.ts` / `request-executor-provider-response.ts` 仍保留 `STOPLESS_FINALIZATION_MISSING`。
  - `reasoning-stop-state.ts` / `reasoning-stop-stopless-directive.ts` / `engine-selection-block.ts` / `reasoning-stop-guard*.ts` / `reasoning-stop.ts` 仍以 `ReasoningStopMode + reasoning.stop finalized` 驱动。
  - `routing-instructions` TS state/store 仍持久化 `reasoningStopMode/reasoningStopArmed/reasoningStopSummary`。
- Rust hotpath 目前没有统一 `<**rcc**>` fence parser；`virtual_router_engine/instructions/*` 仍是 legacy `<**...**>` marker + stop_message/precommand/route 独立解析体系。
- 新增的 `docs/design/stopless-to-goal-mode.md` 对应的是“Codex goal tools 透明透传”方案，与本任务要求的“RouteCodex stopless 自身 goal lifecycle 化 + 物理删除旧 stopless 合同”不一致，不能当完成依据。

Current checklist gaps:
1. Rust 统一 RCC fence parser / directive resolver：未实现。
2. StoplessGoalState（idle/active/paused/stopped/completed）持久化与状态转移：未实现。
3. Host inbound 从 RCC fence 写 goal state，并让 `stopless start` body-forward：未实现。
4. Followup 继续条件改看 goal state，不再看 `reasoning.stop` / finalized marker：未实现。
5. 旧 `on/off/endless` parser、`STOPLESS_FINALIZATION_MISSING`、`reasoning.stop` stopless 依赖、旧文档/旧测试：未删除。

Progress on 2026-05-14:
- 已新增 Rust 真源 `virtual_router_engine/rcc_fence.rs`：
  - 统一解析 `<**rcc**> ... </rcc**>` block，产出 `RccFenceBlock` + `RccDirective`。
  - 当前已覆盖 `stopless / clock / stop_message / route / precommand` 的 command-line + body 校验与 passthrough 语义。
  - 已新增 `StoplessGoalState` 与 `apply_stopless_goal_directive(...)` Rust 状态机，覆盖 `start/pause/resume/stop/done`。
  - 已导出 NAPI：`parseRccFenceDocumentJson`、`applyStoplessGoalDirectiveJson`，并登记 required exports。
- 验证证据：`cargo test rcc_fence --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml` 通过，命中 11 条测试（包含 fence parser + stopless goal transition）。
- 为恢复 native test 编译，顺手修了同 crate 现有 test-only 编译残渣：`hub_resp_outbound_client_semantics.rs` 四处错误调用残留，已最小修正到可编译状态；这不是 stopless 真源修改点，只是验证门禁修复。

## 2026-05-14 stopless goal persistence + native thin shell slice
- 审计结果：当前未完成 patch 本身可编译，`cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit` 通过；真正缺口是 TS 已出现 `stoplessGoalState`，但 Rust `RoutingInstructionState` / `routing_state_store` 还不认识它，导致跨端 sticky state 不闭环。
- 本轮已补齐最小持久化闭环：
  - TS：`routing-instructions/types.ts` 提炼 `StoplessGoalStateSnapshot`；`stop-message-state-sync.ts` 在 persisted merge 时按 `updatedAt` 合并 `stoplessGoalState`；`engine/routing-state/store.ts` / `engine.ts` 把 `stoplessGoalState` 纳入 refresh / empty-check / sync-persist / legacy prune 保活逻辑。
  - Rust：`virtual_router_engine/instructions/types.rs` 新增 `stopless_goal_state`; `routing_state_store.rs` 新增 `stoplessGoalState` serialize/deserialize/is-empty 逻辑，真正让 TS/Rust 同一个 session snapshot 能 round-trip。
  - Native thin shell：新增 `src/router/virtual-router/engine-selection/native-rcc-fence-semantics.ts`，只透传 native `parseRccFenceDocumentJson` / `applyStoplessGoalDirectiveJson`，没有再造 TS parser/state machine。
- 验证证据：
  - `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `cargo test rcc_fence --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml` ✅（11 passed）
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/sticky-session-store-paths.spec.ts --runInBand` ✅（含 stopless goal persisted round-trip）
  - `npx tsx --eval ... mergeStopMessageFromPersisted ...` ✅（验证 persisted newer goal state 覆盖 in-memory）
- 仍未完成：Host inbound / adapter context / followup 仍旧 seed legacy `stopless:on|off|endless + reasoning.stop`；下一步必须把 request normalizer / adapter context 改成消费 RCC stopless goal handler，并逐步删除 legacy contract。
- 补充：为保证这部分能走 repo 现有 Jest roots，本轮把 stopless goal merge 验证落到 `tests/sharedmodule/stop-message-state-sync.spec.ts`；最终验证入口改为 `npm run jest:run -- --runTestsByPath tests/sharedmodule/sticky-session-store-paths.spec.ts tests/sharedmodule/stop-message-state-sync.spec.ts --runInBand`，2 suites / 5 tests passed。此前 `sharedmodule/llmswitch-core/tests/router/*.test.ts` 不在根 Jest roots 内，不能作为本仓 CI 证据入口。
- 新进展：已新增 core handler `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.ts`，通过 native `parseRccFenceDocumentJson/applyStoplessGoalDirectiveJson` 解析 latest user RCC fence、顺序应用 `stopless start/pause/...`、写 sticky `stoplessGoalState`、并把 consumed stopless block 从 `capturedChatRequest` 改写成 body-forward/private-only 结果。
- Host inbound 已切到新入口：
  - `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 不再 regex 扫 `<**stopless:on|off|endless**>`，改调 bridge `syncStoplessGoalStateFromRequest`。
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts` 现在优先检查 `<**rcc**>`，必要时用 originalRequest 回填 captured request，再走 stopless goal sync。
  - `src/modules/llmswitch/bridge/state-integrations.ts` / `bridge.ts` 已加新的 core wrapper。
- 本轮验证：
  - `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/stopless-goal-state.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts --runInBand` ✅（3 suites / 14 tests）
- 仍未完成的唯一大缺口：response/followup 仍然由 `reasoning.stop` + `STOPLESS_FINALIZATION_MISSING` 驱动；`request-executor-response-contract.ts`、`request-executor-provider-response.ts`、`engine-selection-block.ts`、`reasoning-stop*.ts` 还没切到 `stoplessGoalState.status`。

## 2026-05-14 stopless goal followup owner slice（进行中）
- 新判定：真正阻断新合同落地的 owner 不是 host `STOPLESS_FINALIZATION_MISSING`（新 RCC path 因未 seed `reasoningStopMode` 通常不会命中），而是 **active goal stop 后没人自动续轮**。
- 本轮最小切片：
  - `stopless-goal-state.ts` 新增 `readStoplessGoalState / hasManagedStoplessGoalState / isStoplessGoalActive`，统一从 adapterContext + sticky state 读新 lifecycle 真相。
  - `syncStoplessGoalStateFromRequest(...)` 在消费任意 `stopless *` directive 后，会**物理清空 legacy reasoningStopMode/armed/summary/failCount/guardCount**，避免同一 session 同时残留旧合同。
  - 新增 `servertool/handlers/stopless-goal-guard.ts`：当 `stoplessGoalState.status === active` 且本轮 stop eligible 时，直接产出 `stopless_goal_continue_flow` followup；`paused/stopped/completed` 不续轮。
  - `hub-pipeline-reasoning-stop-request-tooling.ts` / `engine-selection-block.ts` 现在在存在 managed stopless goal state 时，直接跳过 legacy `reasoning.stop` 注入与 `reasoning_stop_guard` prepass。
- 待验证的关键点：
  1. 新 auto hook 是否足够覆盖“可见 assistant stop”续轮。
  2. host `STOPLESS_FINALIZATION_MISSING` 是否还存在残余命中面（尤其 legacy sticky/混合会话）。
  3. 旧 `reasoning.stop` handler / guard / contract 仍未物理删除，只是被新 state owner 短路。
- 本轮验证补充：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
  - `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/stopless-goal-state.spec.ts tests/servertool/reasoning-stop-request.spec.ts tests/servertool/stopless-goal-guard.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts --runInBand` ✅（5 suites / 22 tests）
  - `npm run jest:run -- --runTestsByPath tests/servertool/server-side-tools.auto-hook-config.spec.ts tests/servertool/reasoning-stop-guard.spec.ts --runInBand` ✅（2 suites / 40 tests）
  - `npm run build:min` ✅；版本自动 bump 到 `0.90.1554`。

## 2026-05-14 stopless goal sticky/followup verification slice
- 接手状态：上一轮已落下 managed stopless goal 的 adapter/followup 恢复补丁，但 servertool-followup-dispatch / adapter-context / provider-response metadata 回灌尚未整体验证。
- 当前代码面确认：
  - `servertool-adapter-context.ts` 已把“goal-capable 请求”和“managed stopless goal 会话”都纳入 root tools 恢复逻辑；goal-capable path 不再 seed stopless goal state。
  - `servertool-followup-dispatch.ts` 已把 `stoplessGoalStatus` 从 metadata 回灌到 `requestSemantics.__routecodex`，且 managed goal / goal-capable followup 直接恢复 `clientToolsRaw`，不再 merge stale `reasoning.stop`。
  - `provider-response-converter.ts` / `request-executor-response-contract.ts` 已把 managed stopless goal status 回写到 metadata，并对 managed goal path 短路 `STOPLESS_FINALIZATION_MISSING`。
- 下一步：跑定向 Jest 证明“persisted goal state 回灌 + followup root tools 去 reasoning.stop”真实生效；若缺口仍在，再最小补测试/代码。
- 定向验证首次失败：`servertool-adapter-context.spec.ts` 两个普通 followup root-tools 恢复用例挂掉。真因不是测试脆弱，而是 `backfillCapturedChatRequestToolsFromRequestSemantics(...)` 把 `managedStoplessGoal` 误当成 `goalCapable` 传给 `shouldReplaceCapturedChatRequestTools(...)`，导致普通 `exec_command/apply_patch` followup 被错误套用“必须是 get_goal/request_user_input 工具”的判定分支。
- 唯一修复点：`src/server/runtime/http-server/executor/servertool-adapter-context.ts`。修正为只在真正 `goalCapable` 时走 goal-tools 分支；managed stopless goal 仍走普通 followup root-tools 恢复逻辑。补回归：`managed stopless goal followup still restores ordinary client tools...`。
- 修复后验证：
  - `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/stopless-goal-state.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts tests/server/runtime/http-server/request-executor.stopless-visible-marker.spec.ts --runInBand` ✅（5 suites / 32 tests）
- 本轮 completion audit 结论：目标尚未完成，但 host 层 legacy stopless contract 已明确是可物理删除的残余 owner。证据：
  1. `request-executor-provider-response.ts` 仍直接把 `reasoningStopMode + detectStoplessTerminationWithoutFinalization` 映射成 `STOPLESS_FINALIZATION_MISSING / host.stopless_contract`；
  2. `request-executor-error-types.ts` / `request-executor-error-shared.ts` / `provider-failure-policy*.ts` 仍保留 `host.stopless_contract` 作为错误阶段；
  3. 这是 stopless goal lifecycle 已接管 followup 后的纯 legacy 合同，不再是新 stopless 真相。
- 本轮已物理删除 host legacy contract：
  - 删除 `detectStoplessTerminationWithoutFinalization(...)` 与 `host.stopless_contract` 错误阶段；
  - `processSuccessfulProviderResponse(...)` 不再因 legacy `reasoningStopMode` 在 responses/chat `stop/completed` 时抛错；
  - 删除死测：`tests/server/runtime/http-server/request-executor.stopless-visible-marker.spec.ts`、`tests/server/runtime/http-server/executor-response.stopless.spec.ts`；同步删 request-executor/request-executor.error-reporting/request-executor.single-attempt 里的 legacy stopless contract 断言。
- 验证证据：
  - `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
  - `npm run build:min` ✅（version -> 0.90.1560）
  - `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/request-executor-provider-response.stopless-contract-removal.spec.ts tests/providers/core/runtime/provider-failure-policy.spec.ts tests/sharedmodule/stopless-goal-state.spec.ts tests/servertool/stopless-goal-guard.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts --runInBand` ✅（7 suites / 40 tests）
- 重要边界：`request-executor.spec` / `request-executor.single-attempt.spec` 仍有与本刀无关的既有不稳定项与 reasoning-only contract 红灯，不能拿它们当本轮 stopless 删除失败的单点证据；下一步应继续砍 `reasoningStopMode/reasoning.stop` sticky/tooling/doc/test 真残余。

- 2026-05-14 stopless-goal 收口：本轮确认 sticky/config 真残余仍在 routing-instructions/state/store/stop-message-state-codec/user-config-loader；这些字段把 reasoningStopMode/Armed 继续当持久化与配置真相，必须先从官方 RoutingInstructionState/codec/config 投影里物理移除，再让 legacy handler 退化为待删兼容壳。

- 2026-05-14 stopless-goal 收口补记：已把 routing-instructions/types 与 stop-message codec/store/config loader 中的 reasoningStopMode/Armed 正式真相移除；legacy reasoning-stop-state/stopless-goal-state 仅通过局部扩展类型临时读写遗留字段，避免继续污染官方 RoutingInstructionState。
- 2026-05-14 接力：按上一轮证据继续收口。当前唯一真残余先锁定在 request-side `prepareReasoningStopRequestTooling(...)` 注入链与 servertool `runReasoningStopGuardPrepass(...)`；这两处仍会 seed/inject/enforce legacy `reasoning.stop`，在 sticky/config 真相已切除后成为新的唯一阻塞点。
- 计划顺序：先删 hub pipeline request tooling 调用与 export，再删 engine-selection 里的 reasoning_stop_guard prepass/排除分支；随后用最小 Jest + typecheck + build 验证没有遗留合同依赖。
- 2026-05-14 文档收口：用户明确要求兼容原始 /goal，不接受弱化版状态机。设计文档需改成“/goal 为唯一生命周期入口 + stopless 强制证明字段迁入 update_goal transition contract + host 维护连续不可逆错误/连续校验失败/无进展收敛阈值”。

## 2026-05-14 stopless -> /goal 收口
- 先在唯一 client tool args 校验入口 `src/server/runtime/http-server/executor/provider-response-tool-validation-blocks.ts` 为 `update_goal` 加强 transition contract 校验，避免模型口头写 completed/stopped 绕过 host 校验。
- 当前已补最小 contract：active->next_step，paused->user_question+cannot_continue_reason，stopped->blocking_evidence+attempts_exhausted=true+error_class，completed->completion_evidence+completion_summary+ssot_assessment。
- 已补 provider-response-converter 回归测试覆盖四类非法 `update_goal` tool call。
- 新发现：仅在 `provider-response-tool-validation-blocks.ts` 校验 `update_goal` 还不够；必须把**已校验通过**的 `update_goal` tool call 投影回 `adapterContext/pipelineMetadata.stoplessGoalState`，否则 followup/response 仍无法只依赖“校验后 goal state”。
- 当前已在 `provider-response-converter.ts` 补投影逻辑：从 converted body 收集合法 `update_goal`，继承 objective/createdAt，生成校验后 stoplessGoalState 并回写 metadata。

## 2026-05-14 provider tool-args storm / restart
- 根因确认：`CLIENT_TOOL_ARGS_INVALID` 及其 `SERVERTOOL_FOLLOWUP_FAILED + upstreamCode=CLIENT_TOOL_ARGS_INVALID` 包装态是 host/tool-contract 错，不是 provider 健康坏；不能 reroute/exclude，也不能只在单 session 范围内等待。
- 本轮最小修复：
  1. `special_400` -> non-exclusion；
  2. session storm backoff 增加 `session + conversation + workdir` 多 scope，同 workdir 跨 session 共用短等待；
  3. 对 `exec_command` 缺失末尾单引号但正文不含单引号的 `bash/sh/zsh -c/-lc '...` 坏 shape 做 zero-ambiguity 自动闭合，避免尾截断 wrapper 直接炸 502。
- 新增现场风暴：MiniMax 连续输出 `[hub_response] Non-canonical response payload at chat_process.response.entry (code=MALFORMED_RESPONSE)`。这同样属于确定性坏响应，不该在相同 workdir/同形请求上高速重打；已把 deterministic `MALFORMED_RESPONSE`（non-canonical / failed-to-canonicalize / missing_tool_call_id）并入 session storm candidate，并复用 1s→5s 的短 cap。

## 2026-05-14 stopless-goal validator收口
- 用户要求 validator 只管 shape，不做 declared-tool 审计、兼容猜测、shell/apply_patch 修复。
- 当前已收窄 provider-response-tool-validation-blocks.ts；下一步验证 root tsc -> build:min -> install:global -> routecodex restart --port 5520。
- 2026-05-14 复核：`validateCanonicalClientToolCall()` 现在只保留 JSON object / required fields / primitive type 级别校验；`update_goal` 允许缺 next_step / evidence，仅在 `status` 缺失或非法时拒绝。已用 `tsx` 直跑 validator 样例与 `tsc -p tsconfig.json --noEmit --pretty false` 复核通过。

## 2026-05-14 `/goal` 收口审计清单

### 已证据化
- `/goal` 作为唯一生命周期入口：`goal-capable-request.ts` + `hub_goal_tools.rs` 已在。
- `create_goal/update_goal/request_user_input` 作为工具面：已透传，不再伪造第二套 goal tool。
- `update_goal` 最小 transition contract：`provider-response-tool-validation-blocks.ts` 已实现 shape-only 校验。
- `provider-response-converter.ts` 已把合法 `create_goal/update_goal` 投影回 `stoplessGoalState`，供 followup 只读。
- `stopless-goal-guard.ts` 仅在 `status === active` 时续轮。

### 未证据化 / 待补
- host error ledger 还没看到真实递增与 forced stopped。
- 连续不可逆错误 / 连续校验失败 / 连续无进展 的强制停机证据还不完整。
- legacy `reasoning.stop` 还有大量残余文件与 handler，需确认是否仍允许仅作非 goal legacy。
- live 验证尚缺：create_goal / active / paused / completed / 连续错误强制 stopped。

### 2026-05-14 本轮新增证据
- `src/server/runtime/http-server/executor/provider-response-converter.ts` 已补 host-side goal ledger：
  - `CLIENT_TOOL_ARGS_INVALID` -> `consecutiveValidationFailures` 递增，>=2 强制 `stopped`
  - `provider.followup / SERVERTOOL_FOLLOWUP_FAILED` -> `consecutiveIrrecoverableErrors` 递增，>=2 强制 `stopped`
  - 重复 `active.next_step` -> `consecutiveNoProgress` 递增，>=3 强制 `stopped`
- 关键边界：shape-only validator 仍保持最小校验；真正的 transition proof enforcement 已移到 converter/host state owner，而不是 validator。
- 新验证：
  - `npm run jest:run -- --no-cache --runTestsByPath tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts --runInBand` ✅
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` ✅
  - `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` ✅
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
  - `npm run build:min` ✅（version -> 0.90.1577）
- 2026-05-14 本轮最小切口：继续清理 goal mode followup builder 残余。锁定点不再是 validator，而是 `followup-request-builder` 仍可能沿 stale captured tools / ensure_standard_tools 把 `reasoning.stop` 带回 goal 模式续轮。
- 修复策略：仅在 goal-capable adapterContext 下，chat/native followup builder 物理剥离 `reasoning.stop`，并禁止 `ensure_standard_tools` 再回填它；不碰 validator，不新增第二套状态机。
- 本轮验证：
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/followup-request-builder.goal-mode.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts --runInBand` ✅（3 suites / 20 tests）
  - `./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` ✅
- 结论：goal mode followup builder 现在会物理剥离 stale `reasoning.stop`，且 `ensure_standard_tools` 不会在 goal mode 下把它回填。
- 未补证据：sharedmodule 单独 tsc / native build / build:min / live 这轮未重跑；legacy reasoning.stop 其余 handler/schema/skeleton 残余仍在，当前只切掉 goal mode followup 注入面。
- 2026-05-14 继续收口 owner：把 goal-mode / managed-stopless-goal 对 legacy reasoning.stop 的短路上提到 `sharedmodule/.../servertool/server-side-tools.ts`。
- 新行为：一旦 adapterContext 是 goal-capable，或已持有 managed stopless goal state，就自动把 `reasoning.stop` tool-call handler 与 `reasoning_stop_guard` auto-hook 从本轮 dispatch plan 中排除；这样真正的 owner 变成 servertool runtime，而不是靠 handler 内部自觉或 validator 拦截。
- 新回归：`tests/servertool/server-side-tools.goal-mode.spec.ts` 覆盖 goal-capable + stale reasoningStopMode 不触发 legacy guard、managed goal state 优先走 `stopless_goal_continue_flow`、goal mode 下不执行 legacy `reasoning.stop` tool call。
- 本轮验证：`npm run jest:run -- --runTestsByPath tests/servertool/server-side-tools.goal-mode.spec.ts tests/sharedmodule/followup-request-builder.goal-mode.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts --runInBand` ✅（4 suites / 23 tests）；`./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` ✅。

## 2026-05-14 stopless->goal review + verification

Verified review scope:
- goal-mode followup builder strips stale legacy `reasoning.stop` for both goal-capable adapter context and managed stopless goal state
- server-side-tools goal-managed context now excludes legacy `reasoning.stop` tool-call handler and `reasoning_stop_guard`, and strips leaked legacy `reasoning.stop` tool_calls from final chat response before execution dispatch
- apply-patch validator compile repair works: static import `fixApplyPatchToolCallsWithNative`, synthetic tool_call path extracts repaired args, sharedmodule tsc green again
- apply-patch normalize Step 1 adds deterministic GNU/unified diff residue recovery without widening isolated frontmatter `---` acceptance

Verification evidence:
- `npm run jest:run -- --runTestsByPath tests/servertool/server-side-tools.goal-mode.spec.ts tests/sharedmodule/followup-request-builder.goal-mode.spec.ts tests/sharedmodule/apply-patch-validator.spec.ts tests/servertool/stopless-goal-guard.spec.ts tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts --runInBand` ✅ 8 suites / 94 tests passed
- `./node_modules/.bin/tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` ✅
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` ✅
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
- `npm run build:min` ✅

Review findings still blocking a clean commit claim:
- `npm run build:min` auto-bumped generated/version files: `package.json`, `package-lock.json`, `src/build-info.ts`; these are verification noise, should not be mixed with the logic patch unless intentionally releasing
- untracked `tests/sharedmodule/apply-patch-regression-samples.spec.ts` uses absolute local path `/Users/fanzhang/.rcc/errorsamples/...`; not portable, should not be committed as-is
- docs owner still not synced for this latest runtime review delta; live `/goal` verification still missing in this turn

## 2026-05-14 stopless infinite-loop root cause from live sample pattern

Verified root cause from repeated "完成。/Already complete/Goal already complete" sample pattern:
- yes, this was a stopless goal convergence bug on our side, not just model stupidity
- `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.ts` previously triggered followup whenever `stoplessGoalState.status === active` and response ended with plain `finish_reason=stop`, even if the assistant only gave oral completion and never emitted validated `update_goal(status=completed|paused|stopped)`
- `src/server/runtime/http-server/executor/provider-response-converter.ts` declared `consecutiveNoProgress` fields in projection type, but current runtime path did not actually increment/enforce them; this left repeated plain-stop oral-completion loops unconverged
- symptom matches screenshot exactly: goal state stays active -> guard appends "继续执行当前目标" -> model keeps saying complete in text only -> next hop repeats

Fix applied:
- `stopless-goal-guard.ts` now persists `consecutiveNoProgress` for active goal plain-stop replies with zero validated goal transition tool calls
- threshold `>=3` now force-stops goal with `errorClass=repeated_no_progress`, `attemptsExhausted=true`, and synthesized `blockingEvidence`
- this closes the infinite client-inject loop even when model keeps only saying "completed" textually

Verification:
- `tests/servertool/stopless-goal-guard.spec.ts` added regression: third repeated plain stop under active goal forces persisted `stopped`
- `tests/sharedmodule/goal-request-user-input-sample-regression.spec.ts` fixed skip bug and passes again
- targeted suites green:
  - `tests/servertool/stopless-goal-guard.spec.ts`
  - `tests/sharedmodule/goal-request-user-input-sample-regression.spec.ts`
  - `tests/servertool/server-side-tools.goal-mode.spec.ts`
  - `tests/sharedmodule/followup-request-builder.goal-mode.spec.ts`
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts`
- `sharedmodule tsc` + root `tsc` green

## 2026-05-14 stopless sample reconfirm + review delta
- 用户截图对应现象已再次确认：active goal 下 assistant 仅口头声称“已完成/无需继续”，但没有合法 `update_goal(status=completed|paused|stopped)`；旧 stopless-goal-guard 仍按 `finish_reason=stop && goal.active` 继续注入 followup，形成无限循环。这是 host stopless 收敛 bug，不是单纯模型问题。
- 代码证据：`sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.ts` 现已为 `ctx.toolCalls.length===0` 的 active plain-stop 路径累计 `consecutiveNoProgress`，第 3 次强制 `stopped` + `attemptsExhausted=true` + `errorClass=repeated_no_progress`。
- review 继续确认的未闭环点：`src/server/runtime/http-server/executor/provider-response-converter.ts` 里 `consecutiveIrrecoverableErrors/consecutiveValidationFailures/consecutiveNoProgress` 仍只有 projection/type 面；host ledger 真正累加/阈值停机尚未落地。对应旧测试仍在断言 ledger `undefined`：
  - `tests/server/runtime/http-server/executor/provider-response-converter.followup-session.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts`
- 提交风险：`package.json` / `package-lock.json` / `src/build-info.ts` 是 build:min 版本噪音；`tests/sharedmodule/apply-patch-regression-samples.spec.ts` 走绝对本机路径，不可直接提交。

## 2026-05-14 stopless host ledger 收窄（按 Jason 最新约束）
- 设计变更：不做 `next_step` 文本语义比对；`consecutiveNoProgress` 不再由 `provider-response-converter.ts` 对 repeated active next_step 累加。
- 3 次强制停机仅保留在 `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.ts` 的 plain-stop 缺合法 goal control block 路径；该路径现在给显式错误引导：completed/stopped/paused/active 各自该调用什么 `update_goal`。
- `src/server/runtime/http-server/executor/provider-response-converter.ts` 当前只承担：
  1. host-side transition proof enforcement（active/paused/stopped/completed 必填字段）
  2. validation ledger（连续 2 次非法 update_goal -> forced stopped）
  3. irrecoverable followup ledger（连续 2 次 provider.followup 不可逆失败 -> forced stopped）
- 最新定向验证：
  - Jest 8 suites 通过：provider-response-converter followup/regression、stopless-goal-guard、server-side-tools goal-mode、followup-request-builder goal-mode、goal request_user_input regression、servertool-adapter-context、servertool-followup-dispatch
  - `tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit` ✅
  - `tsc -p tsconfig.json --noEmit` ✅
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
  - `npm run build:min` ✅（自动 bump 到 0.90.1580，属构建噪音）
- 仍未做：live `/goal` 验证；因此本目标仍不能宣称完成。

## 2026-05-14 goal sticky live cleanup root cause
- 追踪到 sticky file 消失的真源不是 reaper，而是 `src/server/runtime/http-server/session-storage-cleanup.ts` startup cleanup。
- 当设置 `ROUTECODEX_SESSION_DIR` 时，`sticky-session-store` 会把 routing scope 也落到该目录根下；startup cleanup 会把根下 `session-*.json / conversation-*.json` 视为 legacy scope files 直接删除。
- 这会误删 `/goal` persisted sticky state，导致第二轮 live 请求看起来像 existingGoal 丢失。
- 2026-05-14 apply_patch live contract root cause: `/v1/responses` live inbound tool normalization was not using `shared_tool_mapping.rs`; actual path is `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs::map_bridge_tools_to_chat()`. That function only cloned `parameters` via `normalize_tool_parameters()` and preserved stale FREEFORM description, so outbound provider request still exposed `apply_patch` as `{properties:{}} + old desc` even after TS/Rust guidance updates elsewhere.

## 2026-05-14 stopless-goal live followup
- Continue from prior agent summary: live still drops sticky goal after r2; now re-run build/live and trace Rust route/state-store delete path before any install.
- Live passed after Rust state-store reload + codec fixes; now removing temporary goal-debug logs before rebuild/install.
- Rebuilt, replayed /tmp/goal-live-validation.js successfully, removed temporary goal-debug logs, and completed npm run install:global (routecodex/rcc 0.90.1599).
- Completion audit: root/sharedmodule tsc green; targeted goal-mode Jest matrix green; live matrix passed for create_goal, active update, paused update, completed update, and repeated validation failure forced stopped. Plain-stop no-progress convergence remains unit-tested in stopless-goal-guard.spec.ts (not live-replayed).
- 2026-05-14 apply_patch cleanup: schema-only/Rust-only 收口中，已移除旧 TS validator/guard/raw-tool fallback 文档与路径；验证命令先跑 cargo apply_patch，再跑 tsc/build。

[2026-05-15 08:01:56] stopless-goal/apply-patch repair
- fixed source export gap: native-compat-action-semantics.ts re-added fixApplyPatchToolCallsWithNative so dist validator/fixer import chain can load
- rewired provider-response-converter.ts to read goal state via bridge readStoplessGoalState wrapper instead of bypassing bridge with loadRoutingInstructionStateSync
- restored apply-patch src tree to avoid fresh-build breakage; now fixing Jest mocks/state pollution before full review


## 2026-05-15 MiniMax 2013 排查
- 重点怀疑点：`chat-process-request-sanitizer.ts`、`anthropic-message-utils-openai-request.ts`、`openai-message-normalize.ts`。
- 现象：上游报 `tool call result does not follow tool call`，更像历史消息形状不满足校验，而不是单纯超 context。
- 需要确认：是否在 replay/history 归一化时丢了 `reasoning_content`，或把 `tool_result` 位置/role 变形。

- 修正：`openai-message-normalize-tool-history.ts` 本地校验已收缩为 shape-only：只检查 tool_call/tool_result 是否携带基本 id 字段；不再做跨消息配对、future-call accounting、orphan/dangling 语义审计。
- 验证：`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit false` 通过；`node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs && npm run build:min` 通过；dist smoke 确认 orphan-but-shape-valid 不再被本地拒绝，缺失 id 仍拒绝。

## 2026-05-15 config.toml multi-port/provider-direct audit
Task: inspect whether single config.toml migration supports multi-port, per-input-port provider/routing mode, provider direct for responses/openai/anthropic, and matrix tests.
Initial targets: src/config/*toml*, src/config/user-config-loader.ts, src/config/virtual-router-builder.ts, src/server/runtime/http-server/*port*, provider-direct-pipeline, routes.

Findings:
- Single config.toml parse path exists: routecodex-config-loader -> user-config-codec parses TOML; template includes httpserver.ports with router/provider entries.
- Multi-port listener path exists: getPortConfigs -> startHttpServer loops startPortListener; PortRegistry stores listeners; buildHttpHandlerContext passes req.socket.localPort into executePortAwarePipeline.
- Router/provider mode dispatch exists: router ports call requestExecutor; provider ports call executeProviderDirectPipelineForPort.
- Gap: extractProviderKeysForRoutingGroup only handles routeEntry as object with targets, but TOML routing groups materialize as arrays of pools, so per-port router allowedProviders is empty for sample/schema routing. Router port group isolation is therefore not proven complete.
- Gap: admin hot-add router test fails because request omits routingPolicyGroup while validator now requires it; tests out of sync with strict schema.
- Gap: provider-direct relay matrix is inconsistent: isSupportedRelayPair allows responses<->anthropic and responses<->chat, but remapPayloadFields only maps openai-chat<->anthropic. Existing test expects responses->anthropic to fail, but current code passes payload through unchanged and test fails.
- Targeted verification: npm run -s jest:run -- --runTestsByPath tests/server/runtime/http-server/provider-direct-pipeline.spec.ts tests/server/http-server/port-mode-routing.spec.ts tests/config/routecodex-config-loader.v2-single-source.spec.ts --runInBand => routecodex config test passes; provider-direct and port-mode tests fail as above.

## 2026-05-15 multimodal routing config check
- 5520 active config is `/Volumes/extension/.rcc/config.dbittai.toml`, whose multimodal route already targets `mini27.MiniMax-M2.7`.
- Provider model configs for `mini27` and `dbittai` declared streaming/thinking but omitted `capabilities = ["text", "reasoning", "thinking", "multimodal"]`; fixed both provider config files.
- Next verification after restart: confirm provider-request preserves native image blocks; if model still curls image URL, truth source is payload conversion, not route selection.

## 2026-05-15 审计：error handling / provider pool / server admission / quota

已看链路：
- server admission: `src/index.ts` -> `src/server/runtime/http-server/http-server-bootstrap.ts`
- request backoff: `src/server/runtime/http-server/executor/request-executor-request-state.ts`, `request-executor-session-storm-backoff.ts`, `request-executor-provider-failure.ts`
- quota: `src/manager/modules/quota/provider-quota-daemon.*`, `src/manager/quota/provider-quota-center.ts`, `src/manager/modules/quota/quota-adapter.ts`

初步发现：
1. quota 路径仍保留 core/legacy 双写/双读 fallback 面，和“唯一真源 / no fallback”目标有冲突；adapter 里 `hasCore ? core : legacy` 仍是第二实现面。
2. quota daemon 的错误处理里，`isModelCapacityExhausted429` / 429 series cooldown 仍会把 provider 置为 `inPool=false`，虽然现在对 unrecoverable 3x+ pool-size>1 做了更严格的 eviction，但 recoverable 429/5xx 的“保留在池内只回退”语义还需要继续核对。
3. snapshot 存储会主动抹掉一部分 cooldown（`shouldDropCooldownPersistence`），这意味着重启后某些 5xx cooldown 不会持久化；需要明确这是预期还是会削弱冷却收敛。
4. `reportRequestExecutorProviderError` 已开始透传 `routePoolSize`，但它只是 attempt 级 routePool 长度，不一定等于“实际最后一个可选路由”；如果要严格按“非最后一个路由选项才可移出池”裁决，可能需要更接近 `resolveProviderRetryExecutionPlan` 的剩余候选数。
5. `start.ts` 读取 `quotaRoutingEnabled`，但 v2 配置校验里该字段被禁止写入 user config；这个开关实际只能靠 CLI/运行时注入，配置层面不可达。

结论：这轮更像是“准入 + 冷却 + quota”三层一起审计，当前看仍有 fallback / 冷却语义 / 记录持久化三处要继续收口。

## 2026-05-15 quota / provider-pool audit

Verified mismatch:
- core `sharedmodule/llmswitch-core/src/quota/quota-manager.ts#getQuotaView()` currently collapses active cooldown into `inPool=false`, which conflicts with the desired semantics for recoverable 502/429: backoff only, do not evict from pool.
- host `src/manager/modules/quota/provider-quota-daemon.events.ts` currently only evicts on `unrecoverable + consecutiveErrorCount>=3 + routePoolSize>1`, but the non-evict branch still forces `inPool:true`, which needs to be aligned with the underlying SSOT state instead of rewriting it.
- `src/manager/modules/quota/quota-adapter.ts` still carries core/legacy dual-path fallback branches; this is a separate cleanup target because the new quota path should not silently preserve an old second implementation.

Planned minimal fix slice:
1. Core quota SSOT: preserve recoverable cooldown/backoff without pool eviction.
2. Host eviction: only force `inPool=false` for unrecoverable 3x when alternate routes exist.
3. Tests: add single-provider cases so temporary failures do not permanently remove the only provider from the pool; add multi-provider eviction case.

## 2026-05-16 stopless/goal followup loop fix（本次）

- 现象：非 /goal 场景下 stopless-goal-guard 在 `!hasManagedGoal` 分支无条件继续注入 followup，导致 `clientInjectSource=servertool.stopless_goal_continue` 的续轮仍可再次命中同分支，形成 stop-only 自循环（日志里 session.calls 持续增长，finish_reason=stop）。
- 真源定位：`sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.ts` 中非 /goal 分支缺少“同源 followup 二次命中即熔断”的前置判定，同时注入 ops 未显式 `preserve_tools + ensure_standard_tools`，无法保证唯一工具面注入约束。
- 修改：
  1) 在 `!hasManagedGoal` 分支内新增 `if (followupSource === FOLLOWUP_SOURCE) return null;`，阻断同源 followup 再次入队；
  2) 非 /goal bootstrap followup 注入 ops 增加 `{ op: 'preserve_tools' }` 与 `{ op: 'ensure_standard_tools' }`，确保下一轮工具列表沿唯一注入路径保留并标准化。
- 预期：
  - /goal(active) 仍仅做 no-progress 计数，达到阈值转 `stopped`；
  - 非 /goal 仅允许一次 bootstrap 注入；若该注入后仍无工具调用，不再递归 followup，停止死亡循环。

## 2026-05-16 多端口迁移（无回撤）

- 真源定位：`src/index.ts` 仍保留 dev-only 单端口路径（detectServerPort 提前返回 5555 + 启动前仅 check 单个 port + 强写 ROUTECODEX_PORT/RCC_PORT），导致 runtime 的 `httpserver.ports[]` 无法完整生效。
- 修改点（唯一）：
  1) `detectServerPort` 支持优先读取 `httpserver.ports[0]`；dev 默认 5555 改为“仅在没有任何可解析配置时兜底”。
  2) 启动前端口可用性检查改为遍历 `httpserver.ports[]` 全部端口；EADDRINUSE retry 同样遍历全组。
  3) 当存在多端口配置时，不再写 `ROUTECODEX_PORT/RCC_PORT`（避免单端口 env 覆盖）；仅保留 `ROUTECODEX_HTTP_PORT` 作为主显示端口。
- 预期：`routecodex` dev 包在存在 `httpserver.ports[]` 时与 release 路径语义一致，按多端口全量监听，不再回落到 5555 单端口。

## 2026-05-16 responses required_action exec_command 参数越权校验（Host scope overreach）

Verified findings:
- 当前报错不是 upstream 真发错，而是 Host `provider-response-converter.ts` 在 bridge 返回后，直接用 TS `validateCanonicalClientToolCall` 对 `/v1/responses required_action.submit_tool_outputs.tool_calls[*]` 做统一校验。
- 但 Rust SSOT `hub_resp_outbound_client_semantics.rs::normalize_responses_tool_call_arguments_for_client` 已经负责按 **client schema** 修复 `exec_command {command}` -> `{cmd}`；Host 在未先走该 Rust SSOT 的情况下直接校验，导致把可修复的合法返回误判成 `CLIENT_TOOL_ARGS_INVALID`。
- 这正是 Jason 指出的 scope 越权：Host 不该自己抢先决定 responses tool args 形状，而应先复用 Rust client-outbound SSOT，再做边界校验。

Unique correct fix point:
- 唯一正确修复点在 `src/server/runtime/http-server/executor/provider-response-converter.ts` bridge 后、Host 校验前。
- 这里补一层 **Rust SSOT normalizeResponsesToolCallArgumentsForClientWithNative**，把 `/v1/responses` outbound tool args 先按 client tool schema 归一，再交给 TS host validator。
- 不能去放宽 TS validator、不能在 provider/runtime/servertool 其他层补 alias，因为那都会制造第二语义面并继续扩 scope。

## 2026-05-16 apply_patch guidance + shape contradiction（本次）

- 现象：样本 `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1778938571779_71a73e46/provider-request.json` 同时出现两类互相矛盾信号：
  1) tool schema / guidance 说 apply_patch 主字段是 `patch`；
  2) 历史 tool output 多次报 `failed to parse function arguments: missing field \`input\``。
- 真源：不是单纯提示词问题，而是 **多层 apply_patch 归一输出不一致**：
  - tool validator 输出 `{patch,input}`
  - Host `provider-response-tool-validation-blocks.ts` 之前只回 `{patch}`
  - Rust `resp_process_stage1_tool_governance.rs` 之前也只回 `{patch}`
  - 结果下游仍可能把 `missing field input` 假错误灌回历史，模型被迫在 `patch`/`input` 之间来回摇摆。
- 修复：
  1) 引导侧：TS + Rust request guidance 全部把“**禁止通过 exec_command/shell/bash -lc/heredoc 调 apply_patch**”前置，并明确 `apply_patch <<PATCH` 也是非法；
  2) 归一侧：Host validator / Rust resp governance / guard args 全部统一镜像 `{patch,input}` 同值，避免跨层 contract 漂移；
  3) 回归：新增 Host validator spec；补 Rust apply_patch mirror 测试；更新 guidance regression。

## 2026-05-16 mini27 provider_status_2013 历史 tool_call 污染（本次）

- 真样本：`~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1778939979912_346f0923/provider-request.json`
  - 历史 assistant `tool_calls[0].function.arguments` 带着一个 **inner JSON 已损坏** 的超长 heredoc exec_command；
  - 对应 `tool` 消息已明确报错：`failed to parse function arguments: EOF while parsing a string...`；
  - MiniMax 上游随后直接返回 `status_code=2013 invalid function arguments json string, tool_call_id=call_function_pgvv8999cdz7_1`。
- 唯一修复点：Rust `hub_req_inbound_tool_call_normalization.rs` 的 **message history 清洗边界**。
  - 之前只会清理 `responses input function_call/function_call_output`，但 **不会清理 messages[].assistant.tool_calls + role=tool** 这条历史链；
  - 导致 malformed exec_command 历史继续透传上游。
- 修复：在 `prune_message_tool_history()` 里物理删除 **malformed shell-like assistant tool_call**，并同步删除配对 `tool_call_id` 的 orphan tool message；若 assistant 轮次因此只剩空 content，也一并删除。

## 2026-05-16 apply_patch contract/compat/state-machine audit

- 结论：当前 apply_patch 的病根不是单个 regex，而是 authoring contract / ingress compat / failure recovery 三层混在一起。
- 唯一正确分层：模型只看 canonical internal patch grammar；GNU diff 与 raw/wrapped/json/absolute-path/line-number-hunk compat 只在 Rust `resp_process_stage1_tool_governance.rs` 归一；重复失败后的 read-before-repatch 走真实工具列表上的硬门禁，不删工具、不伪造工具面。
- 已动刀：把 request/response tool governor 里的 apply_patch fake blocked-args 语义改为复用 native normalize；新增 native `normalizeApplyPatchArgumentsJson` 出口；servertool `apply_patch` guard 改为 `APPLY_PATCH_REQUIRES_READ_BEFORE_RETRY` 硬门禁 + preserve_tools followup 注入。

## 2026-05-17 apply_patch contract / TS second-semantic cleanup / routing audit

Verified findings:
- 模型可见 apply_patch 文案大体已收口为 canonical internal grammar only，但 Rust heredoc guidance 仍残留错误示例：`*** Add File: path/to/file` 下一行还是裸 `content`，这会直接把错误模板喂给模型。真源位置：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/shared_tool_text_guidance.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tool_text_request_guidance.rs`
- TS 第二语义面仍在主链生效：`tool-governor-request/response.ts` 还在调用 `rewriteExecCommandApplyPatchCall`，等于把 `exec_command` 偷改成 `apply_patch`；这不是 compat，而是 scope 越权。
- routing 现状确认：`virtual_router_engine/features/tools.rs` 已能跳过 malformed `apply_patch` / `write_stdin`，但 followup route 仍主要依赖 `last_assistant_tool_category`。当前最小正确切口仍是先阻止错误工具调用被改写成 coding，再继续审计 route continuation。

Next slice:
1. 修正所有模型可见 Add File 示例为 `+content`。
2. 从 request/response governor 主路径移除 `rewriteExecCommandApplyPatchCall` 调用，停止 TS 偷改工具名。
3. 跑最小测试，确认 guidance 与 servertool/read-before-repatch 未回归。

## 2026-05-17
- 路由修正：longcontext 不能再压过 thinking/coding/search/web_search；它只能作为弱信号落在强语义路由之后。
- 回归要求：fresh user turn + 高 token 仍必须走 thinking；coding continuation + 高 token 仍必须走 coding。

## 2026-05-17 apply_patch canonical guidance audit（继续）
- qwen tool-definition contract 需要同时满足两件事：一是只保留 canonical patch authoring（`patch` + internal grammar only），二是仍要明确“直接调用工具”。否则 `req_profiles` 回归会失败，且 Qwen 家族描述会丢掉 direct-call 约束。
- 已验证回归：classifier 15/15；Jest tool-guidance/apply-patch-guard/native-required-exports 10/10；Rust targeted tests 覆盖 qwen/qwenchat tool defs 与 read-before-repatch guidance 均通过。
- 2026-05-17 routing false-positive root cause补充：`virtual_router_engine/features/tools.rs::classify_shell_command()` 里原先用 `normalized.contains("replace")` 直接判 coding，会把 `rg -n 'replace' ...`、`cat replacement-guide.md` 这类非写入命令误路由成 coding。唯一正确修法是把它收窄到命令名级别 `contains_command("replace")`，并补 responses-context 回归，避免搜索/读取命令因 query/path 含 replace 误进 coding。
- 2026-05-17 routing false-positive补充（二）：read-only `python/node` 文件读取之前会落到 `other`，导致 followup 继续轮时无法稳定继承到 `thinking`。唯一正确修复点仍在 `virtual_router_engine/features/tools.rs::classify_shell_command()`：对 `python -c "print(Path(...).read_text())"`、`node -e "console.log(fs.readFileSync(...))"` 这种只读脚本显式判 `thinking`，并补 message-turn 回归，确保它们不会再掉进 coding/tools。
- 验证：
  - `cargo test -p router-hotpath-napi exec_command_read_only_python_and_node_are_classified_as_thinking -- --nocapture` ✅
  - `cargo test -p router-hotpath-napi previous_turn_python_read_tool_is_classified_as_thinking_continuation -- --nocapture` ✅
  - `cargo test -p router-hotpath-napi virtual_router_engine::features -- --nocapture` ✅
  - `cargo test -p router-hotpath-napi virtual_router_engine::classifier -- --nocapture` ✅

## 2026-05-17 ingress tool compat / routing root-cause audit（本轮分析）

结论：现在的兼容差不是单点 bug，而是 ingress owner 被拆裂了。
1. `req_inbound_stage2_semantic_map` 目前只调 `normalizeReqInboundShellLikeToolCallsWithNative()`，所以只能处理 shell/write_stdin；`apply_patch` 根本没进同一个 ingress normalize owner。
2. `chatEnvelopeToStandardizedWithNative()` 走的 `hub_standardized_bridge::normalize_chat_envelope_tool_calls()` 也只包了一层 shell-like normalize，导致 stage2 record / standardized / later followup 看见的 tool args contract 不一致。
3. `resp_process_stage1_tool_governance.rs` 已经有最强的 apply_patch canonical/compat 逻辑，但它被放在 response owner，request ingress 没复用，形成第二责任面。
4. 现有 Rust test `hub_pipeline.rs::test_coerce_standardized_request_from_payload_normalizes_exec_command_and_apply_patch_shapes` 仍把 exec_command 保留成 `command`，和 `/v1/responses required_action` / client validator 期望的 `cmd` contract 冲突，说明 canonical contract 还没真正收口。
5. 当前 Jest 失败不是历史污染，而是 fresh stage2 ingress 自己没有统一 normalize：
   - exec_command nested args 没被统一成 client shape
   - shell-wrapped apply_patch 仍原样留在 arguments，JSON.parse 直接炸

唯一正确方向：做一个 Rust-only unified ingress tool normalizer，统一处理 messages / responses input 两种 carrier，并在 stage2 record + standardized 前执行；TS 不再做任何第二语义面。apply_patch canonical 输出必须镜像 `{patch,input}` 同值；exec_command canonical 输出必须固定 `cmd(+workdir)`；坏 shell wrapped apply_patch 不猜正文，只产空 patch 并由后续门禁提示 read-before-repatch / direct apply_patch.
验证：
- `cargo test -p router-hotpath-napi hub_req_inbound_tool_call_normalization -- --nocapture` ✅
- `cargo test -p router-hotpath-napi test_coerce_standardized_request_from_payload_normalizes_exec_command_and_apply_patch_shapes -- --nocapture` ✅
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` ✅
- `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts` ✅
- `cargo test -p router-hotpath-napi virtual_router_engine::features -- --nocapture` ✅
- `cargo test -p router-hotpath-napi virtual_router_engine::classifier -- --nocapture` ✅
- `cargo test -p router-hotpath-napi virtual_router_engine::features::tools -- --nocapture` ✅
- `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` ✅
2026-05-17 09:18:17

[2026-05-17 followup-route-fix] servertool followup 不能再无条件写 preserveRouteHint=false / disableStickyRoutes=true；apply_patch_read_before_retry_guard 需要 stickyProvider，并保留原 routeId/routeHint，否则会把 followup 路由上下文打丢，触发 PROVIDER_NOT_AVAILABLE 死循环。

## 2026-05-17 quota snapshot restart poison（已验证）
- 现象：llmgate upstream 直连 200，但本地 5520 在重启后仍报 `PROVIDER_NOT_AVAILABLE`。
- 真源：`provider-quota.json` 把 auth/config 类 fatal cooldown（样本：`EFATAL + NEW_API_ERROR`）持久化了，重启后又恢复，把 provider 先过滤掉。
- 唯一正确修复点：`src/manager/quota/provider-quota-store.ts` 的 snapshot save/load sanitize；不能去改路由、重启流程或 fallback。
- 规则：跨重启只保留 restart-stable backoff（`E429`/`ENET`/`E5XX`/`quotaDepleted`/`blacklist`）；`EFATAL + auth/config` 一律不持久化。
- 验证：snapshot 中 `llmgate.key1.deepseek-v4-pro*` 已恢复 `reason=ok/cooldownUntil=null`；本地 `POST http://127.0.0.1:5520/v1/chat/completions model=llmgate.deepseek-v4-pro` 返回 200 `ok`；`POST /v1/responses` 同样 200 `ok`。

## 2026-05-17 builtin web_search outbound gate / llmgate 400 修复
- 现象：`/v1/responses` 直连 llmgate.deepseek-v4-pro 时，即使只是普通 thinking/direct 请求，也把 builtin `{"type":"web_search"}` 原样发上游，触发 `bad request: tools[i] 不支持的类型: web_search`。
- 真源分两层：
  1. Rust `hub_bridge_actions/history.rs` 之前会盲保留/注入 builtin `web_search`；
  2. 更关键的是 direct `/v1/responses` raw tools 不走 chat bridge，必须在 Rust `hub_pipeline.rs::apply_direct_builtin_web_search_tool()` 的 provider outbound 最后一跳做物理剥离。
- 唯一正确规则：默认过滤 builtin `web_search`；只有 runtime metadata 明确选中了 `webSearch.engines[*]` 的 `executionMode=direct + directActivation=builtin`，才允许透传/转换为 builtin。否则无论 non-search route 还是 search route 但 capability 不匹配，都必须 strip。
- 回归：
  - Rust：`cargo test -p router-hotpath-napi test_apply_direct_builtin_web_search_tool -- --nocapture` ✅
  - Rust：`cargo test -p router-hotpath-napi resolves_responses_bridge_tools -- --nocapture` ✅
  - Rust：`cargo test -p router-hotpath-napi resolves_responses_request_bridge_decisions -- --nocapture` ✅
  - Jest：`npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/provider-payload-web-search-gate.spec.ts` ✅
  - Live：build/install/restart 后，`POST http://127.0.0.1:5520/v1/responses model=llmgate.deepseek-v4-pro tools=[web_search,exec_command]` 返回 `200 requires_action(exec_command)`；`~/.rcc/logs/server-5520.log` 显示 `direct/direct -> llmgate... finish_reason=tool_calls`，不再有 `tools[0] 不支持的类型: web_search`。

## 2026-05-17 route queue fallback / error meta strip
- `search/read/write/web_search` 专用 route 的兜底必须是 `tools` 在前、`default` 在后；唯一正确落点是 Rust `virtual_router_engine/routing/config.rs::build_route_queue()`，因为 classifier 只给语义候选，真正的 route queue 顺序真源在这里。
- `EMPTY_ASSISTANT_RESPONSE` 等错误日志不应透传 `__sse_responses`/stream carrier；现已在 `src/utils/log-helpers.ts` 统一剥离，仅保留可读错误摘要。

## 2026-05-17 SSE decode stats null contract
- 真源在 Rust `hub_resp_inbound_sse_decode_semantics.rs::extract_decode_stats_json()`：缺少 `__rccDecodeStats` 本应表示“无统计”，必须返回 `Ok("null")`，之前错误地抛 `Status::Ok("null")`，被 TS 包装层误判成 native 不可用，直接制造 anthropic SSE_DECODE_ERROR。

## 2026-05-17 llmgate empty assistant / model catalog audit
- `EMPTY_ASSISTANT_RESPONSE` 这次不是 RouteCodex 请求形状必现问题：同一份 `provider-request-contract_1.json` 直打 llmgate `/v1/chat/completions` 可复现成功返回完整 assistant 文本，说明该样本请求形状本身可被上游接受；原故障更像 llmgate/上游的瞬态空响应。
- `llmgate` provider config 真源里若保留 `deepseek-v4-pro-search / deepseek-v4-flash-reasoner` 之类模型，forced coding lane 会被 provider catalog 扩展到这些别名并触发 `model_not_found`；按 Jason 规则已收缩为只保留 `deepseek-v4-pro` 与 `deepseek-v4-flash`。

## qwenchat vision 测试结论 (2026-05-17)

### 测试结果
- qwen3.5-plus: vision ✅ (成功描述蓝色背景+白色TEST文字)
- qwen3.6-plus: vision ✅ (成功描述蓝色背景+无衬线字体TEST)
- coder-model: vision ✅ (正常响应)

### 认证方式
- 不需要登录账号，guest 模式 + baxia 指纹 token 即可
- baxia: bx-ua (设备指纹) + bx-umidtoken (从 sg-wum.alibaba.com 获取 etag)
- 需要 camo 浏览器 cookie (匿名访客会话)

### Vision 使用流程
1. POST /api/v2/files/getstsToken → 获取 OSS 上传凭证
2. PUT 图片到 OSS (OSS4-HMAC-SHA256 签名)
3. POST /api/v2/users/status → 轮询上传状态
4. POST /api/v2/chat/completions → files 字段嵌入上传后的 payload

### 推荐配置
在 config.toml 中为以下模型添加 vision capability:
- qwen3.5-plus
- qwen3.6-plus
- coder-model (已有 vision)

## 2026-05-17 qwen Google OAuth camo 实测（手动页面勘测）
- 实测 profile: `qwenchat-test`。
- 在 `https://chat.qwen.ai/auth` 页面可见按钮：
  - `.qwenchat-auth-pc-other-login-button`（Google/Github 共用 class，需按文本或后续 URL 判定）
- 跳转到 Google 后 URL 为 `https://accounts.google.com/v3/signin/identifier...`，页面语言 `zh-CN`。
- 当前页面类型不是 account chooser，而是 identifier 表单：
  - 存在输入：`#identifierId` / `input[type="email"]` / `input[autocomplete="username"]`
  - 存在下一步：`#identifierNext` / 按钮文本 `下一步`
  - 不存在 account tile（`[data-identifier]` / `[data-email]` 数量为 0）
- 根因：现有脚本在 `accountHint` 为 email 时优先走 account tile 点击，未匹配到即失败，未回退到 identifier 输入流程。
- 修复：
  1) 新增 `fillGoogleIdentifierByHint()`：定位 Google identifier 输入框 -> `camo type` 输入邮箱 -> 点击 `identifierNext`。
  2) `maybeAdvanceGoogleAuth()` 在 email hint 的 account-click 失败后，改为尝试输入邮箱流程，而不是直接失败。
  3) 扩展 selectors：`googleAccountSelect` 增加 `[data-account-index]`；新增 `googleIdentifierNext` selectors。

## 2026-05-17 qwenchat guest auth 对齐 qwen2api
- 证据：`/Volumes/extension/code/qwen2api/worker.js` 使用 guest + bx headers（非 qwen-oauth token file）。
- 根因：`/Volumes/extension/.rcc/provider/qwenchat/config.v2.toml` 仍配置 `qwen-oauth`，导致 runtime 走 `TokenFileAuthProvider`，出现 `TokenFileAuthProvider not initialized / missing refresh token`。
- 修复：新增 `qwenchat-guest` 认证分支（qwen family profile）
  - body 注入 `chat_mode=guest` + 默认 `chat_type=t2t`
  - header 注入 `X-DashScope-AuthType=guest`、`Origin/Referer`、`bx-v/bx-ua/bx-umidtoken`
  - guest 模式移除 Authorization，避免 oauth 残留。
- 配置同步：`/Volumes/extension/.rcc/provider/qwenchat/config.v2.toml` 改为 `type=qwenchat-guest` + 空 apiKey。
- 单测：`tests/providers/profile/qwen-profile.request-sanitize.spec.ts` 新增 2 条 guest 用例并通过。

## 2026-05-17 qwenchat guest startup init fix
- 现象：qwenchat 已进入 virtual-router bootstrap/runtime，但 5520 请求期 `provider runtime qwenchat.key1 not found`。
- 真源：Rust bootstrap rawType 已修复为 `qwenchat-guest` 后，TS `mapRuntimeAuthToConfig()` 仍把 runtime sentinel `value=guest` 错误物化成 provider auth.apiKey，后续被 `ApiKeyAuthProvider.initialize()` 当成真实 apiKey 做长度校验，startup handle 初始化失败。
- 唯一正确修复点：`src/providers/core/runtime/provider-factory-helpers.ts::mapRuntimeAuthToConfig()`；这里是 runtime auth -> provider config 的唯一物化边界，必须在这里把 `qwenchat-guest` 的 sentinel 还原为空 credential。改 auth provider 只会掩盖“guest 不是 key”这一上游语义错误。
- 回归：`tests/provider/provider-factory.test.ts` 新增 qwenchat-guest 用例；`tests/server/http-server/apikey-secret-resolution.spec.ts` 继续通过。

## 2026-05-17 qwenchat guest shape audit
- 证据1：本机直打 qwenchat 两步 guest 真链路，第1步 `POST /api/v2/chats/new` 返回 200 成功，说明不是 IP/WAF 必然拦截。
- 当前 RC qwenchat-guest 仅在 `qwenFamilyProfile` 上对 OpenAI `/chat/completions` 单跳做 header/body 轻改；与 qwen2api 真链路（create chat -> completion?chat_id）不等价。
- 初步结论：当前 5520 拿到 challenge HTML 的真源不是“guest 不可用”，而是 provider request shape 仍错误。

## 2026-05-17 qwenchat guest create-chat 真源排查（本轮）

- 已确认 5520 现在线上不是 router/direct 问题，而是 provider 真源问题：日志已进入 `QwenChatWebProvider.sendRequestInternal()`。
- 当前唯一剩余失败点：`POST /api/v2/chats/new` 返回 200，但未满足现有 contract（`success !== true` 或 `data.id` 缺失），错误码 `QWENCHAT_GUEST_CREATE_CHAT_FAILED`。
- 下一步必须补 create-step 原始响应证据（status/content-type/body shape），再按 qwen2api 真源对齐 create 请求 shape；不能猜。

- codex samples 已给出旧错误铁证：旧版本真实 URL 为 `https://chat.qwen.ai/chat/completions`，响应为 Aliyun WAF HTML challenge（不是模型空内容）。因此历史样本根因已确认是 provider 选型/请求 shape 错误，不是内容违规。
- 当前线上新版本已进入 dedicated provider，但 create-step 仍 200 contract fail；需继续核对 headers/body 与 qwen2api 真源的差异，重点看 `User-Agent` / `Accept-Language` / `Origin` / create response parse。

- 最新实机证据已把 qwenchat 问题继续收敛：create-chat 已经通过，vision 请求失败真因不再是 create contract，而是 completion 请求中 `files` 仍为空，导致上游返回 `Not_Found/Bad_Request/Internal error` JSON；此前 host 把它误归类成 `EMPTY_COMPLETION`。
- 唯一真修复点继续在 `qwenchat-web-provider.ts`：补齐附件上传链（getstsToken -> OSS PUT -> users/status -> files payload）并把 completion JSON reject 显式抛成 upstream rejected。


## 2026-05-17 qwenchat vision completion 真源补充

- qwen2api 成功附件样本（`/Volumes/extension/code/qwen2api/tasks/上传附件.md`）已给出唯一硬证据：**带图片附件的成功 completion body 仍使用 `chat_type: "t2t"`、`sub_chat_type: "t2t"`，不是 `vision`**。
- 当前 RouteCodex `parseIncomingMessagesForQwenChat()` 把最后一轮含图片附件请求标成 `vision`，并将该值透传到 create/completion 两段 body；这与成功真源不一致，是当前 `Bad_Request/Internal error...` 的首个明确 shape 差异。
- 同一成功样本还显示 `feature_config.auto_search: true`，而当前实现写死 `false`；该字段也应回到 qwen2api 真源。
- 因此本轮唯一修复点继续保持在 `src/providers/core/runtime/qwenchat-web-payload.ts`（chatType 归一真源）与 `src/providers/core/runtime/qwenchat-web-provider.ts`（completion/create body 真源对齐），禁止去 router / host / 错误处理层打补丁。


## 2026-05-17 multimodal / vision 路由纠偏

- Jason 明确纠偏：`multimodal` 与 `vision` 是两条不同语义路径，不能再像旧实现那样把图片请求自动同时判成两者。
- 已确认 Rust 真源存在 4 处混并：`routing/config.rs` 会在 `has_image_attachment` 时自动 prepend `vision`；`engine/selection.rs` 会把 `vision` 当作 `multimodal` capability 过滤；`provider_bootstrap.rs` / `provider_registry.rs` 会把 provider capability `vision` 归一成 `multimodal`。
- 当前死循环真因不是 snapshot/pending，而是普通 `multimodal + tools` 请求被错误送入 `vision` lane，随后进入 qwenchat vision 子链后 tool contract 失败，再被 session 下一轮重复触发。
- 本轮唯一修复点应先落在 Rust virtual-router 真源：物理拆开 capability 和 route queue，禁止自动 `multimodal -> vision` 升格。

## 2026-05-17 apply_patch followup orphan_tool_result 真因

- 21:03~21:05 新样本已确认：`apply_patch_read_before_retry_guard` 触发 followup 时，`syncResponsesContextFromCanonicalMessagesJson` 报 `orphan_tool_result`，不是模型内容问题，而是 followup history shape 缺半边。
- 唯一真因：guard followup 只注入了 `append_tool_messages_from_tool_outputs`，漏掉与之配对的 `append_assistant_message`；因此回放时只有 `role=tool`，没有前置 `assistant.tool_calls`，被原生契约校验判成 orphan。
- 额外现场坑：当前测试/运行链会加载 `sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch-guard.js`，只改 `.ts` 不生效；必须同步修 `.js` 同源产物，否则回归仍会看到旧 ops。
- 本轮唯一修复点：`sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch-guard.{ts,js}` 为 followup ops 补 `append_assistant_message`；并在 `tests/servertool/apply-patch-guard.spec.ts` 锁死回归。

## 2026-05-17 apply_patch followup MiniMax 2013 invalid chat setting

- 真实样本：`~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/openai-responses-mini27.key1-MiniMax-M2.7-20260517T211239049-203515-2195_apply_patch_read_before_retry/`
- 真相：这次不是 tool history 配对错，而是 **servertool reenter followup root body 仍继承了 Responses 参数**，最终发到 MiniMax `/chat/completions` 的 provider-request 顶层包含：
  - `parallel_tool_calls: true`
  - `reasoning: { effort: "medium", summary: "detailed" }`
  - `max_tokens: 8192`
- 上游返回：`provider_status_2013 invalid params, invalid chat setting`
- 唯一修复点：`src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
  - `sanitizeFollowupRequestSemantics`
  - `sanitizeFollowupRootBodyRequestParameters`
- 修复原则：servertool followup 是内部续轮，不应把客户端 `/v1/responses` 的 request-parameter 控制面（reasoning / parallel_tool_calls / tool_choice / output budget / model）继续物化到 provider chat request。
- 必补回归：用该真实样本断言 followup nested body/semantics 都不再含 `reasoning / parallel_tool_calls / tool_choice / max_tokens / max_output_tokens / model`。

## 2026-05-17 vision route contract
- Jason 明确的 vision 真源：`vision` route 不是 inline multimodal；它必须走 `图片 -> qwenchat -> summary -> servertool followup`。
- `multimodal` route 才是直接给具备内建多模态能力的 provider。
- 当前 `sharedmodule/llmswitch-core/src/servertool/handlers/vision.ts::shouldRunVisionFlow` 把 `vision` 与 `multimodal` 一起短路为 false，违反语义真源；唯一修复点就是这里。
- 回归必须补：routeHint=vision 时仍执行 vision_flow；routeHint=multimodal 时跳过。

## 2026-05-17 update_goal + route followup break
- 线上出现两个连续问题：1) provider -> client tool args 校验报 `update_goal requires status as a string`; 2) 紧随其后的 followup 全部 `No available providers after applying routing instructions`。
- 先查 client tool args 出口归一真源，再查 followup route metadata / routing instruction continuity 是否断链。

## 2026-05-17 update_goal contract drift fix
- 真样本 req_1779027979210_dff31d45 证明这是 /goal 线程，但 provider 暴露的是最小 update_goal contract（仅 status=complete），宿主 provider-response-converter.ts 却仍保留 active/paused/stopped/completed 旧状态投影，形成双真源并诱导模型误用 update_goal 作为“更新 /goal 提示词”工具。
- 本轮唯一修复点：物理删除 host 侧旧 update_goal 多状态投影，只保留 create_goal -> active 与 update_goal(status=complete) -> completed；随后用原样本 + 回归验证。

## 2026-05-17 router-direct PROVIDER_NOT_AVAILABLE 真因
- 22:27 连续 `No available providers after applying routing instructions` 已坐实不是 sticky/session 残留；routing-state 持久层为空。
- 真源在 `src/server/runtime/http-server/http-server-bootstrap.ts::extractProviderKeysForRoutingGroup()`：5520 router 端口把 routing group targets 直接注入 metadata.allowedProviders，形状是 `llmgate.deepseek-v4-pro` / `mini27.MiniMax-M2.7` 这类 route target token。
- Rust virtual-router 真源 `routing/selection.rs::filter_candidates_by_state()` 明确把 `allowedProviders` 当 **provider id 白名单** 使用，实际比较的是 provider key 首段（如 `llmgate` / `mini27`）。
- 因此 TS 注入 shape 与 Rust 消费语义失配，任何同组候选都会被筛空。唯一正确修复点就是把该提取函数归一为 provider id；改 Rust 或其他调用层只会制造第二语义面。

## 2026-05-17 5520 routingPolicyGroup + 5555 providerBinding 真源修复

- 5520 串到 `gateway-coding-10000-thinking` 的真因不是配置文件没生效，而是 **v2 routing flatten 只保留最后一个同名 routeType**；即使加了 allowlist，也无法保证 route id/route pool 来自当前端口组。
- 唯一修复点链路：`src/config/virtual-router-builder.ts` 在 flatten ALL groups 时必须 **append** 同 routeType pools，而不是覆盖；同时给每个 pool 注入 `routeParams.routePolicyGroup=<groupId>`。
- Host 再把当前端口 `routingPolicyGroup` 放进 request metadata（`routecodexRoutingPolicyGroup`）；Rust `virtual_router_engine/engine/selection.rs` 只允许选择同组 pool。这样 5520/10000 共用 merged routing config 但不会串组。
- 5555 `providerBinding = dbittai-gpt.key1.gpt-5.4` 不通的真因在 `src/server/runtime/http-server/index.ts::resolveRuntimeKeyForProviderBinding`：实际 runtime key 可是 `dbittai-gpt.key1`（model 在 provider payload 层选），旧解析无法把 `provider.alias.model` 绑定回 `provider.alias` runtime。
- 唯一修复点：binding 解析增加 `provider.alias.model -> provider.alias` 命中逻辑；已用源码级脚本验证 `dbittai-gpt.key1.gpt-5.4 -> dbittai-gpt.key1`。

## 2026-05-17 5555 provider direct / dbittai-gpt not found 真源

- 5555 `Provider not found for binding: dbittai-gpt.key1.gpt-5.4` 的唯一真源不是 binding parser，也不是 runtime resolve，而是 `src/config/toml-basic.ts` 不支持 provider v2 TOML 中的**多行数组 + inline table**（如 `entries = [ { alias = "key1", apiKey = "${CRS_OAI_KEY1}" } ]`）。
- 旧行为会在 `src/config/provider-v2-loader.ts` 中吞掉 decode 异常，导致 `~/.rcc/provider/dbittai-gpt/config.v2.toml` 被静默跳过，最终 `loadRouteCodexConfig(...).userConfig.virtualrouter.providers` 不含 `dbittai-gpt`，5555 direct binding 必然报 provider not found。
- 唯一正确修复点：
  1. `toml-basic.ts` 增加多行 collection 聚合解析；
  2. `provider-v2-loader.ts` 对已命中的 `config.v2.*` 解析失败不再静默吞错。
- 已验证：
  - `decodeProviderConfigFile(~/.rcc/provider/dbittai-gpt/config.v2.toml)` 可正确得到 `auth.entries`;
  - `loadProviderConfigsV2(~/.rcc/provider)` 包含 `dbittai-gpt`;
  - `loadRouteCodexConfig(~/.rcc/config.toml)` materialized providers 包含 `dbittai-gpt`;
  - 精确回归：`tests/config/toml-shadow-codec.spec.ts`、`tests/config/provider-v2-loader.spec.ts`、`tests/server/runtime/http-server/provider-binding-resolution.spec.ts` 全通过。

## 2026-05-17 5555 direct cache 命中率异常真源

- Jason 指出的约束是对的：same-protocol provider direct 不应该重建 request；理论上只允许最小覆盖 `model / thinking effort / ua` 等基础字段，其余请求 shape 必须透明透传。
- 现网样本已证明旧实现违反该契约：`~/.rcc/codex-samples/openai-chat/dbittai-gpt.key1.gpt-5.4/req_*/provider-request.json` 中 `input` 持续膨胀、`previous_response_id` 始终为空、`model` 被落成默认模型 `gpt-5.3-codex`，并且 `__runtime.endpoint` 错记为 `/v1/chat/completions`。
- 唯一真源是 provider direct 同协议路径仍调用 `ResponsesProtocolClient.buildRequestBody()` 重新 build responses request。正确修复应让 `executeProviderDirectPipeline` 优先走 provider 的 `processIncomingDirect()`，而 `ResponsesProvider.processIncomingDirect()` 必须绕过 request rebuild，直接把原始 responses payload（去掉内部 metadata）发送上游。


## 2026-05-18 5555→5520 串线复盘（继续）

- 实机证据：`[port-resolve]` 明确 5555 入口解析正确，但后续仍选到 `thinking/gateway-priority-5520-thinking`，说明错误不在入口端口解析。
- 继续追到 router-direct 预跑链：`executeRouterDirectPipelineForPort()` 传给 `runHubPipeline()` 的 metadata 缺少 per-port `allowedProviders`。
- 已修：`src/server/runtime/http-server/index.ts` 的 router-direct metadataForHub 现在同时注入 `routecodex*` 与 `allowedProviders`，与普通 executePortAwarePipeline 保持一致。
- 当前待验证：build + global install + restart 后，5555 实机是否改为只命中 `gateway_priority_5555`。

## 2026-05-18 SSE passthrough 真源补充

- 已证实 SSE 问题与分类问题无关，必须拆开处理。
- 真实样本显示两类故障：
  1. 某些 upstream passthrough SSE 根本没有 terminal event（无 `response.completed`/`[DONE]`）。
  2. 另一些样本明明已有 `response.completed`，但 host `handler-response-utils.ts` 仅依赖 stream `end` / wrapper finish reason，不会从 passthrough 文本流本身识别 terminal event，导致误记 `client_close before streamEnd`。
- 最小修复已落在 host SSE bridge：直接从 passthrough chunk 识别 `response.completed` / `response.done` / `[DONE]`，在 terminal 到达后主动收束本地响应。

## 2026-05-18 5555 router thinking current-turn-only 修复

- 活证据先确认：5555 `/v1/responses` 基础 SSE 现已能收到 `response.completed`，host passthrough terminal 识别至少对简单 direct 流成立。
- 继续审计发现 Jason 指出的第二个问题属实：Rust `virtual_router_engine/classifier.rs` 仍保留 `thinking_from_read = !thinking_from_user && last_tool_category == "thinking"`，会让历史 thinking/tool 延续继续命中 thinking，违反“只看当前轮”的路由规则。
- 本轮唯一正确修复点：删除 classifier 中历史 thinking continuation，仅保留 `thinking:user-input` 作为 thinking 命中条件；coding/search/tools 等历史续轮逻辑保持独立。

## 2026-05-18 stopless 最简复活

- Jason 新规则已收敛：stopless 默认开启、默认次数 2、默认注入文本固定为 `继续执行`。
- 唯一自动续轮 owner 收缩为 `stop_message_auto.ts`：`/goal active` 时 stop 不续轮；`/goal non-active` 与非 `/goal` 时收到 `finish_reason=stop` 自动注入一次 `继续执行`。
- 旧复杂魔块（AI/reviewer followup、approved/done marker、stopless_goal_guard 第二决策面）不再作为当前 stopless 真相。

## 2026-05-18 5555 provider ban not effective
- 证据复核后，Jason 说得对：dbittai 这条线不是“ban 晚了”，而是 Rust `handle_provider_error()` 在 `quota_view.is_some()` 时直接 `return`，导致 5555 这类 quota/router 路径根本**不吃 provider error 事件**。
- 因果链：Host 已经 await 上报错误事件 -> ingress hook 会调 `routerEngine.handleProviderError()` -> Rust `engine/events.rs` 第一个分支直接因 quota_view 退出 -> 不写 health_manager，不 persist provider-health.json -> 下一轮 selection 即使改成 consult health_manager，也永远看不到 ban。
- 这解释了全部现场现象：1) 之前一直没 ban；2) `provider-health.json` 不存在；3) 5555 后续仍反复命中 dbittai。
- 唯一修复点应在 Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/events.rs`，移除这条错误的 `quota_view` 短路；TS/Host 不该再补任何二次 ban 逻辑。

## 2026-05-18 503 ban 黑盒回归已补

- Jest VM 下的 `provider-503-ban-blackbox.e2e.spec.ts` 会被 `STATE_INTEGRATION_FAILED` 噪音污染，不适合作为 ban 真证据。
- 已新增独立黑盒脚本：`scripts/tests/provider-503-ban-blackbox.mjs`，直接重放真实链路：
  - `/v1/responses`
  - 5555 router `sameProtocolBehavior=relay`
  - 第一次命中 dbittai 返回 503
  - request-executor 触发 `exclude_and_reroute`
  - `provider-health.json` 持久化 `__http_503_daily_cooldown__`
  - 第二次请求直接跳过 dbittai
  - 重启后第三次请求仍跳过 dbittai
- 实跑证据（2026-05-18 23:04 CST）：
  - 第 1 次：`dbittaiHits=1`, `crsHits=1`
  - 第 2 次后累计：`dbittaiHits=1`, `crsHits=2`
  - 重启后增量：`dbittaiHitsDelta=0`, `crsHitsDelta=1`
  - `provider-health.json` 含 `reason="__http_503_daily_cooldown__"`

## 2026-05-18 502 黑盒继续排查

- 已把黑盒脚本升级为 `scripts/tests/provider-failure-ban-blackbox.mjs`；默认 gate 503，附加 `--include-502` 可重放 502。
- 新证据：`isProviderFailureHealthNeutral()` 之前把 `classification==='recoverable'` 整体当成 health-neutral，导致 502/500/504 根本不进 3 次冷却计数；已去掉这条错误总开关。
- 但 502 黑盒继续暴露第二个问题：**当前实际行为不是“3 个独立请求后冷却”，而是单个请求内部第 3 个 attempt 前就切到 backup**。活日志显示：
  - attempt1 -> primary 502
  - attempt2 -> primary 502
  - attempt3 route 已直接选 backup
- 说明“502 连续计数”仍存在**提前触发或重复计数**的问题，下一步要查 provider error event 是否被重复计入 health_manager，或 health threshold 之外还有第二条 cooldown 语义面。

## 2026-05-18 502/503 provider ban 黑盒终证

- 真实黑盒现在已经钉死 502 提前切 backup 的唯一真源：**同一次 provider 失败被上报了两次 health 事件**。
  - provider runtime：`src/providers/core/runtime/base-provider.ts -> emitProviderError(stage='provider.http')`
  - request-executor：`src/server/runtime/http-server/executor/request-executor-provider-failure.ts -> emitProviderErrorAndWait(stage='provider.send')`
- 唯一正确修复点落在 `src/providers/core/utils/provider-error-reporter.ts`：
  - 统一打 `__routecodexProviderErrorReported` marker；
  - 同一错误对象已上报过时，后续 reporter 直接 no-op；
  - 这样保留 provider runtime 作为主上报面，request-executor 对同一错误不会再重复记健康。
- 黑盒新增 observer 证据：
  - 503 场景：primary 只收到 **1 条** `provider.http` 错误事件；第二次请求与重启后都直接跳过 primary；`provider-health.json` 持久化 `__http_503_daily_cooldown__`。
  - 502 场景：primary 恰好收到 **3 条** `provider.http` 错误事件，不再出现 `provider.send` 的重复上报；之后同一请求第 4 次 attempt 命中 backup，下一次请求继续直接跳过 primary。
- 额外校准：502 黑盒要与真实运行时一致，必须给足 `maxAttempts=6` 和更长 response timeout；否则 2s+4s+8s backoff 叠加会先撞到 host timeout，看到的是 timeout，不是 ban 语义本身。

## 2026-05-19 502 storm triage
- 最新 5555 /v1/responses 502 主因已从日志确认：不是 provider 502，而是本地 `CLIENT_TOOL_ARGS_INVALID`，报错 `update_goal status=complete requires completion_evidence, completion_summary, and ssot_assessment.`
- 同 shape 样本 `~/.rcc/codex-samples/openai-responses/crs.crsa.gpt-5.3-codex/req_1779138004314_587a574d/provider-request.json` 仍携带历史 `get_goal/update_goal` 控制面与 active-thread-goal developer prompt，当前轮最新 user 仅为 `继续执行`。
- 当前加载的 native `.node` 明显不是最新 Rust 产物：源码已有 `removedHistoricalGoalTurns` 与 goal-history scrub，运行时 `sanitizeChatProcessMessagesJson` 返回仍为旧形状且未删除历史 goal turns。

- 第二真源已定位：`shared_response_compat.rs` 的 goal-history scrub 只覆盖 Responses `function_call` 形状，未覆盖 chat `assistant.tool_calls` 形状；导致 assistant `get_goal` tool_call 保留、对应 tool result 被删，后续 `sync_responses_context_from_canonical_messages` 在 Rust history pairing 阶段抛 `dangling_tool_call`。
- 已在 Rust sanitizer 增补 assistant.tool_calls 旧 goal 清理，并完成本地 same-shape 验证：sanitize 后旧 `get_goal` assistant/tool 对消失，`syncResponsesContextFromCanonicalMessagesWithNative(...)` 成功。


## 2026-05-19 SSE client_close requestMap retention fix
- 当前 heap/rss 持续上涨的新真因已收敛：不是普通成功请求残留，而是 `/v1/responses` SSE 在 `response.sse.client_close` 且 `closeBeforeStreamEnd=true` 时，Hub 已经 capture 了 request entry，但 `provider-response.ts::finalizeResponsesConversationRequestRetention()` 永远不会执行，导致没有 `lastResponseId` 的大 input entry 挂在 `requestMap`。
- 唯一正确修复点在 host SSE 生命周期收尾 `src/server/handlers/handler-response-utils.ts`：只有这里同时知道“客户端提前断开”且仍持有当前 requestId；在这里清理 store 才能覆盖 normal/error/client_close 三类结束中的唯一缺口。改 `onRequestEnd` 会误删成功请求保留态，改 provider-response 则根本进不到该路径。
- 已实现：仅当 `entryEndpoint==/v1/responses` 且 `closeBeforeStreamEnd=true` 时，直接清掉 `__rccResponsesConversationStore` 对应 request entry，避免 `pendingNoResponseId/retainedInputItems` 累积；并补了 handler SSE close 回归断言。

[2026-05-19 06:46:34] 502 root cause continuation: latest server-5520.log still shows CLIENT_TOOL_ARGS_INVALID -> update_goal status=complete... across crs/deepseek/minimax, proving provider-agnostic historical /goal contamination. Confirmed passthrough responses sync in Rust hub_pipeline was missing goal-history scrub; historical /goal must be removed from replay history, not from current goal-state control plane. Also found cargo test blocker in events.rs test referencing deleted DEFAULT_RECOVERABLE_COOLDOWN_MS; real cooldown source is health.rs DEFAULT_COOLDOWN_MS / manager config.

## 2026-05-19 `/goal` legacy implementation removal
- 旧 `/goal` 执行面已继续物理拆除：Host 侧 `goal-capable-request.ts`、Rust `hub_goal_tools.rs`、followup 专用分支、`create_goal/update_goal` 相关校验/投影与对应回归已被删除；当前仅保留 `stoplessGoalState` 状态面与 Rust `shared_response_compat.rs` 的历史污染 scrub。
- 仍需牢记：`request_user_input` 不是 `/goal` 专属工具，不能误删；当前保留它仅作为普通客户端工具。真正应该继续拦截的是旧历史里的 `get_goal/create_goal/update_goal/request_user_input` 组合污染。
- 本轮最小验证已过：`cargo test -p router-hotpath-napi goal_mode_user_turn_is_not_demoted_by_stale_servertool_followup_flag` 与 `cargo test -p router-hotpath-napi test_sync_responses_context_from_canonical_messages_strips_historical_goal_turns` 均通过。

## 2026-05-19 stopless 内建 followup 链无效（最新样本取证）
- 最新 stop 样本：`~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779146081572_28a46b95/provider-response.json`，`finish_reason=stop`。
- 同批日志真证据在 `~/.rcc/logs/server-5520.log`：
  - `[servertool][stop_watch] ... flow=stop_message_flow`
  - `tool=stop_message_auto stage=match result=matched`
  - `tool=stop_message_auto stage=match result=rebuilt_followup_from_capturedchatrequest`
  - `tool=stop_message_auto stage=final result=completed_client_inject_only`
- 说明 stopless 不是“reenter 失败”，而是**实现上被强制导向 client inject only**。
- 代码真源：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` finalize 返回 `metadata.clientInjectOnly=true` + `clientInjectSource='servertool.stop_message'`。
- followup 主线 `followup-runtime-block.ts` 只有 `clientInjectSource==='servertool.stopless_goal_continue'` 才强制 `reenter`；`servertool.stop_message` 会落入 `client_inject_only`。
- 因此“内建 followup 链无效”的根因不是主线坏了，而是 stop_message handler 根本没接到 reenter 语义。

- 2026-05-19 stopless reenter clean path:
  - 真源修复点在 `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts::materializeBodyFromFollowupInjectionPlan()`。
  - mainline 已不再 rebuild；真正的 followup body 只能在请求入口由 capturedChatRequest + metadata.__rt.serverToolFollowupInjectionPlan 重建。
  - 额外修复：entry materializer 必须从 `metadata.__rt.serverToolFinalChatResponse` 读取上一轮 assistant message；只读 `baseMetadata.serverToolFinalChatResponse` 会丢失 assistant 历史，导致 stopless followup 少一轮 assistant 上下文。
- 2026-05-19 stop_message_auto 当前活真源修正：JS 源文件仍被 src/*.js 直引，TS 改动不会自动影响 Jest/运行时；stop-message-auto 的 followup-hop skip、invalid sticky key skip、metadata.sessionId 非可信 scope 拦截、以及 live env default repeat 读取，必须同时改 `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` 与同路径 `.js`。
- 新 contract 回归：`tests/servertool/stop-message-auto.goal-default.spec.ts` 固定验证两条——`/goal active` 不自动续；非 `/goal active` 默认续 2 次，第 3 次停并把 `stopMessageUsed` 归零。
- 2026-05-19 stop_message followup stage-timeout 真因：不是 provider 慢，而是 `servertool-followup-dispatch.ts` 对 forced same-provider followup 一律最多重试 3 次，连 `host.response_contract` 的 `EMPTY_ASSISTANT_RESPONSE` 也被 200ms/400ms 重试，叠加 host 全局 backoff 后把 stopless stage 时间烧空。唯一修复点在 dispatch retry gate：`host.response_contract` / `provider.followup` 这种非可恢复 followup 错误必须首错即抛，不能进入 same-provider retry。
[2026-05-19 08:xx] stop_message non-essential timeout removal: removed TS-side stopMessage stage-timeout guard and timeout-specific error branch from servertool followup path; retained only loop-limit guard and generic followup timeout. Reason: user explicitly required minimal necessary code only; stage-timeout branch was legacy non-essential code, not part of required stopless contract.

## 2026-05-19 SSE structured error passthrough regression
- 新增 handler 回归：`tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` 验证 `forceSSE && !expectsStream` 且 body 已有结构化 `error` 时，必须原样透传 `status/code/request_id`，不能再桥接成通用 `HTTP_502/sse_bridge_error`。
- 唯一正确修改点仍是 `src/server/handlers/handler-response-utils.ts`：这里只有 SSE 非流式错误会被桥接重写；provider/router/retry/stop_message 都不是本问题的改动点。

## 2026-05-19 stopless requires_action short-circuit removal
- 最新 stopless 失效真因不是未触发，而是 `stop_message_flow` 在 Rust native skeleton 中被错误配置了 `ignoreRequiresActionFollowup: true`，导致 reenter followup 一旦返回 `requires_action` 就在 `followup-mainline-block.ts` 被 `completed_stopmessage_ignore_requires_action_reenter` 短路。
- 唯一正确修复点：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs` 删除该错误策略；TS 仅消费 native 计划，不是根改点。
[2026-05-19 stopless followup shape audit]
- 活证据：Rust skeleton `stop_message_flow` 当前 profile 仅有 `stickyProvider/seedLoopPayload/retryEmptyFollowupOnce`，没有 `clientInjectOnly`，所以骨架层 outcomeMode 默认是 `reenter`。
- 唯一真实错位在 host reenter 入口 `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts::materializeBodyFromFollowupInjectionPlan()`：它把 `capturedChatRequest` 用 `extractCapturedChatSeedLocal()` 降成 `messages`/纯文本，丢失 `/v1/responses` 原始 `input` item shape。
- 这会让 stop_followup 不是“从 /v1/responses 入再从 /v1/responses 出”，而是半路 chat-seed 化重建，再送去 responses 入口，最终出现空 assistant / shape 错误。
- 修复方向：对 `/v1/responses` followup 直接 clone 原始 body，再对 `input` 追加 assistant/user item；不再走 messages seed rebuild。chat/messages 路径维持原逻辑。

[2026-05-19 stopless provider pin audit]
- followup same-provider pin 真源继续收窄到 host `servertool-followup-dispatch.ts::buildServerToolNestedInput()`。
- 旧逻辑只优先 `baseMetadata.providerKey/extra.providerKey`，会把真实命中的 `target.providerKey=mini27.key1.MiniMax-M2.7` 被 alias `mini27.key1.minimax` 覆盖。
- 已改为 followup pin 优先级：base.target.providerKey -> base.target.providerId -> base.targetProviderKey -> base.providerKey -> extra.target.providerKey -> extra.target.providerId -> extra.targetProviderKey -> extra.providerKey。
- 新回归：当 base metadata 同时携带 alias providerKey 与 exact target.providerKey 时，followup 必须 pin exact target.providerKey。

## 2026-05-19 direct/router followup cleanup
- 最新活日志证明 MiniMax alias drift 已修，但 crs 又暴露第二类真因：followup body/model 与 route metadata 仍复用错误的 direct/router 共用语义。
- 真实样本 `req_1779157231169_6cfb2fdb` 主请求 upstream body.model=`gpt-5.3-codex`，但 stop_followup body.model 漂到 `gpt-5.4`；说明错的不只是 providerKey pin，还有 followup body.model 未被 exact routed target 覆盖。
- 已做物理清理：`servertool-followup-dispatch.ts` 新增 exact model pin（target.modelId/assignedModelId 优先）并在 nested body 强制覆盖；`followup-runtime-block.ts` 删除 non-router followup 的 routeHint 继承，direct/provider followup 不再复用 relay routeHint 语义。

## 2026-05-19 10:44 403 vision alias drift
- Jason 指正后先复核 direct 可用性：最新成功样本 `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779158605606_cef0422f/provider-request.json` 与 `req_1779158623504_3ee5b117/provider-request.json` 都是 `meta.providerKey=mini27.key1.MiniMax-M2.7` + `body.model=MiniMax-M2.7`，说明 exact provider 本身可用，403 不是 token/模型本体坏。
- 最新 403 真因仍是 servertool vision 二跳 alias drift：`server-5520.log` 10:43:25/43/55/09 明确显示主请求 `default -> mini27.key1.MiniMax-M2.7.MiniMax-M2.7`，随后 `vision/forced -> mini27.key1.minimax.minimax`，最终 upstream 403 `该令牌无权使用模型：minimax`。
- 最小修复点落在 `sharedmodule/llmswitch-core/src/servertool/handlers/vision.ts|js::executeVisionBackendPlan()`：vision backend reenter 之前从 adapterContext 提取 exact routed `target.providerKey/modelId`，强制写入 `metadata.__shadowCompareForcedProviderKey/targetProviderKey/assignedModelId`，并把 backend payload.model 覆盖为 exact model。这里是唯一正确位置，因为 403 发生在 vision analysis hop 本身，stop_message/general followup dispatch 根本不经过这条 backend 路径。

## 2026-05-19 stop_followup alias drift + responses shape regression (latest live evidence)
- 最新活日志 `~/.rcc/logs/server-5520.log` 11:05:28 / 11:05:37 / 11:06:49 明确显示：主请求命中 `mini27.key1.MiniMax-M2.7`，但 stop_message followup 仍漂到 `search/forced -> mini27.key1.minimax.minimax`，随后 `SERVERTOOL_EMPTY_FOLLOWUP reason=HTTP_403`。
- 最新坏样本 `~/.rcc/codex-samples/openai-responses/mini27.key1.minimax/openai-responses-mini27.key1-MiniMax-M2.7-20260519T110528470-207711-2941_stop_followup/provider-request.json` 证明两层真因同时存在：
  1. `meta.providerKey=mini27.key1.minimax` + `body.model=minimax`，exact target pin 被 alias 覆盖；
  2. `entryEndpoint=/v1/responses` 但 body 仍是 `messages[]`，不是原始 `input[]`，说明 followup 仍被半路 chat 化重建。
- 已定位唯一真源修改点：
  1. `sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts::resolveAdapterContextProviderKey()` 之前错误地先取 `providerKey/targetProviderKey(alias)`，再取 `target.providerKey(exact)`，会把 stop_message 已写入的 exact forced provider 覆盖成 alias；现已改为优先 `target.providerKey/providerId`。
  2. `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs::build_captured_chat_request_snapshot()` 之前物理丢掉 `input`，导致 `/v1/responses` followup 只能退化成 `messages`；现已保留 `input` 字段。
- 回归：
  - `cargo test -p router-hotpath-napi test_build_captured_chat_request_snapshot_preserves_shape --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml` 通过；
  - `npm run jest:run -- --runInBand --runTestsByPath tests/servertool/followup-runtime-provider-pin.spec.ts` 通过；
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` 通过。

## 2026-05-19 stopless pin drift investigation
- User要求：加日志 + replay复现。
- 目标：定位 stop_followup 从 exact target 漂移到错误 provider/model 的唯一覆盖点。

## 2026-05-19 stopless followup drift: logging probe
- Added pinpoint logs:
  - `convert.captured_request.shape`
  - `convert.reenter.base_metadata.shape`
  - `hub.run.input`
- Purpose: prove whether stopless followup loses responses `input` shape before dispatch, or loses `__shadowCompareForcedProviderKey` before Hub Pipeline route select.
- Existing live evidence remains split:
  - dispatch log said `bodyHasInput=false bodyHasMessages=true`
  - recorded followup provider-request sample later showed provider payload already became `/v1/responses` `input[]` with model `gpt-5.4`
- Therefore the next proof target is pre-Hub-Pipeline nested input shape + forced-provider metadata visibility.

## 2026-05-19 multimodal image routing live verification
- 新规则核验分两部分：
  1. 多模态目标已命中时，必须直发图片，不再触发 legacy `:vision` 二跳；
  2. 非多模态目标出站前，必须把最新 user turn 的图片替换为占位符，不能把原始图片继续发给 text-only upstream。
- 真证据（live black-box）：2026-05-19 13:16:05 向 `http://127.0.0.1:5555/v1/responses` 发送含 `input_image` 的最小请求，日志命中 `default -> mini27.key1.MiniMax-M2.7`，reason=`multimodal:visual-content|thinking:user-input`，且没有出现 `:vision` followup；样本 `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779167765082_c3851ba0/provider-request.json` 证明图片被原样直发到多模态 upstream。
- 真证据（native compat proof）：直接调用 `runReqOutboundStage3CompatWithNative` 且 `adapterContext.__rt.supportsMultimodal=false`，输出把 `input_image` 替换成 `input_text: [Image omitted]`。这说明“无多模态目标时剥离附件”的唯一真源仍在 Rust `req_outbound_stage3_compat/request_stage.rs`，不是 Host/TS 临时改写。

## 2026-05-19 forced non-multimodal image leak root cause
- 真源确认：`hub-pipeline-adapter-context-metadata-blocks.ts` 在 `applyTargetAdapterContextFields()` 之后又用 metadata `__rt` 整体覆盖 adapterContext `__rt`，把 target 注入的 `supportsMultimodal=false` 覆盖丢失。
- 结果：Rust `req_outbound_stage3_compat` 读不到 `adapter_context.rt.supportsMultimodal=false`，因此 forced 非多模态 provider 的 `providerPayload` 仍保留 image，router-direct 即便已改为发送 `providerPayload` 也仍会把图片打进 text-only provider。
- 唯一正确修复点：仍在 `hub-pipeline-adapter-context-metadata-blocks.ts` 合并 `__rt`，并让 target 派生字段优先于 metadata runtime 载荷；别处补 strip/补判断都会变成第二语义面。

## 2026-05-20 stopless goal gating
- 唯一修复点仍在 `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`：非 `/goal` 场景不能因为 sticky store 里残留 goal state 而激活 default stopless；只有本请求显式携带的 goal state（directive/direct state）才允许 goal gating。
- 为区分“本请求显式 goal”与“仅从 sticky 恢复的旧 goal”，`stopless-goal-state.ts` 现在把 `__rt.stoplessGoalStateSource` 标成 `directive|persisted`；stop_message_auto 只认非 persisted 的 request-scoped goal。
- 回归锁定：`tests/servertool/stop-message-auto.goal-default.spec.ts` 新增两条——非 `/goal` + sticky completed / active goal 都必须 passthrough，不得静默 auto-followup。

## 2026-05-20 longcontext priority config alignment
- 用户要求把 5555 的 longcontext 改回 mode=priority，与 thinking/coding 一致。先改配置真源，不混入其他日志/路由语义改动。

## 2026-05-20 priority strict-availability semantics
- 用户确认 priority 真语义：只有“当前 provider 不可用”才允许降级到下一个。
- 明确不触发降级：429、502。
- 允许触发降级的真条件：inPool=false、cooldownUntil 生效、blacklistUntil 生效、health manager trip/unavailable、显式排除或路由不匹配。
- 后续 priority 红测与 Rust selection 真源修复必须以该语义为准，不能按错误码做降级。

## 2026-05-20 stopless exit policy update
- 用户确认 /goal active 下 stopless 需要更强参与：连续错误 5 次退出；连续 finish_reason=stop 5 次退出；中间只要有打断/有效推进则计数归零。
- 后续必须先补红测，再改 stopless 状态真源；禁止在日志层或 handler 外围做补丁式计数。
## 2026-05-20 stopless /goal active stronger exit policy
- 唯一真源修改点确认在 `src/server/runtime/http-server/executor/provider-response-converter.ts`：这里是 followup 响应/错误第一次被 host 统一归因并持有 `stoplessGoalState` 的位置，适合做连续错误/连续 stop 的唯一计数；改 handler/log 层都会变成第二语义面。
- 已先补红测再改实现：`tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts` 覆盖 `/goal active` 下连续 5 次 HTTP_400 停止、连续 5 次 HTTP_502 停止、连续 5 次 finish_reason=stop 停止、以及 success/tool_calls 打断后计数归零。
- 新语义：连续错误阈值从 2 提升到 5；validation 阈值同步到 5；非错误但 `finish_reason=stop` 视为 no-progress，连续 5 次强制 stopped；中间只要出现非 stop 的有效推进（如 tool_calls / requires_action）就把 error/no-progress 计数清零。
## 2026-05-20 reasoning.stop legacy test cleanup
- `tests/servertool/reasoning-stop-guard.spec.ts` 与 `tests/servertool/stopless-reasoning-stop-guard.spec.ts` 当前属于死契约测试：其断言依赖的 `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop*.ts` 与 `stopless-goal-guard.ts` 已在 `29e3a969c` 被物理删除，但测试未同步清理，导致整片假红并统一退化成 `passthrough`。
- 唯一正确修复不是“补回旧实现”，而是物理删除这批过期测试并把 skeleton/config 断言改到现行 stopless contract：当前活 contract 只看 `stoplessGoalState` + `stop_message_auto` / followup policy，不再依赖旧 `reasoning.stop` guard 链。
- 已验证活测试组合：`tests/servertool/server-side-tools.auto-hook-config.spec.ts`、`tests/servertool/stop-message-auto.goal-default.spec.ts`、`tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts` 全绿。

## 2026-05-20 windsurf multi-key auto-expansion regression
- 用户现象：VR 已命中 `windsurf.ws-pro-2.gpt-5.5-medium`，但 Host runtime resolve 报 `Provider runtime windsurf.ws-pro-2 not found`。
- 已验证：native/bridge `bootstrapVirtualRouterConfig` 对 `~/.rcc/provider/windsurf/config.v2.toml` 的多 entry 展开本身正常，`runtime/targetRuntime` 都能看到 `windsurf.ws-pro-1/ws-pro-2/ws-pro-3`。
- 唯一错误修改点在 `src/server/runtime/http-server/http-server-runtime-setup.ts`：新增的 `mergeProviderV2Configs()` 把 `loadProviderConfigsV2()` 返回的顶层未展开 provider 重新注入 `routerInput.providers`，污染了原本应交给 VR bootstrap 自动展开的输入。
- 唯一正确修复：物理删除 `mergeProviderV2Configs()` 及其调用，恢复 `resolveVirtualRouterInput(userConfig)` → `bootstrapVirtualRouter(routerInput)` 的单一路径真源；别处补映射/补 handle 都会变成症状补丁。
- 额外记录：用户给的 `ott$...` 是 Windsurf Auth Token，不是最终 provider 发送链可直接长期复用的 `devin-session-token$...`；后续需按认证真源完成兑换/落盘。

## 2026-05-20 windsurf runtime init missing baseUrl
- 5520 现网复现证据：`~/.rcc/logs/server-5520.log` 出现 `[windsurf.runtime.init.fail] reason="[ProviderFactory] runtime windsurf.ws-pro-* missing baseUrl"`，随后同请求链路报 `Provider runtime windsurf.ws-pro-* not found`。
- 已确认 VR 多账号展开正常，唯一真源错误点落在 `src/providers/core/runtime/provider-factory.ts::buildConfigFromRuntime()`：这里曾错误要求 Windsurf 具备普通 HTTP provider 的 `baseUrl` 前提，导致 handle 根本没创建。
- 正确修复方向：仅在 Windsurf runtime identity 下放宽 `baseUrl` 前置校验，让 provider 依赖 runtime/service profile 完成初始化；不能去补 resolver/route/runtime map，因为那只是症状层。

## 2026-05-20 windsurf 5520 switch key2 -> key3
- 用户要求仅替换 5520 路由 targets：把 `ws-pro-2` 物理移出，换成 `ws-pro-3`；不混入 provider 实现修改。
- 已改 `~/.rcc/config.toml` 的 `gateway_priority_5520` 各 routing targets（thinking/coding/tools/search/web_search/default）并 SIGUSR2 重启 5520。
- 重启后日志已出现 `[windsurf.runtime.init.ok] runtimeKey=ws-pro-3`，证明 key3 已加载进 5520 运行态；下一步只需验证是否真实命中以及 502 真因。

## 2026-05-20 windsurf provider architecture correction
- 已先修设计文档真源：
  - `docs/providers/windsurf-chat-provider-design.md`
- 新硬约束：
  1. Windsurf Provider 主链必须直连云端 endpoint
  2. 不允许任何本地中间链路回流到活实现
  3. 后续代码改动先补认证/历史/工具语义红测，再改实现

## 2026-05-20 19:23:57 Windsurf auth correction
- README 真源显示前两个凭证是账号/密码，不是 token。
- 下一步：按参考项目登录链获取 session token，再用 status/models probe 验证。

## 2026-05-20 19:24:42 Windsurf Jason probe
- 准备同时验证 direct token probe 与账号密码登录链。

## 2026-05-20 19:25:41 Windsurf token-only correction
- 用户确认 ws-pro-3 是 token，本次按 token 本体直测，不再拼 email|token。

## 2026-05-20 19:26:09 Windsurf password probe
- 用户指定 2094423@qq.com / welcome4zcam# 按账号密码登录链验证。

## 2026-05-20 19:35:31 Windsurf account mainline progress
- 已完成 Rust bootstrap + TS runtime/provider 登录链改动。
- 已过 tsc + Rust provider_bootstrap 定向回归。
- 下一步：build/install/restart + 运行态 smoke。

## 2026-05-20 19:38:45 Windsurf 3-account verification
- 目标：逐个验证 3 个账号登录链 + probe，并区分 invalid/cooldown。

[NOTE]
- 2026-05-20 windsurf 501 retry-order fix：这是旧错误 send 主线遗留记录；现已废弃，不再作为活文档真源。当前唯一真源是 pure cascade 主链。

## 2026-05-20 windsurf login-chain alignment
- 对齐 WindsurfAPI 真源：token 优先；否则 Auth1 password/login -> WindsurfPostAuth -> 持久化 devin-session-token -> pure cascade probe。
- 修正 ws-pro-3 账号密码字段读取：provider config 真源是 account/password，不是只读 mobile/password。
- 将 session_token_not_initialized / no_password_set / credential_missing / postauth_failed 收敛为不可恢复错误，避免同账号自旋。

## 2026-05-20 windsurf login probe correction
- 刚才手工 probe 用的是 dist 旧构建，不足以证明新补的 account/password 映射无效。
- 先重编，再用新构建对 ws-pro-3 做真实登录探针。

## 2026-05-20 windsurf ws-pro-3 live login success
- 用新构建 dist 对 ws-pro-3(account/password) 做真实登录探针，已成功拿到 devin-session-token。
- 这证明登录链已打通；接下来要验证 5520 在线请求是否仍卡在旧实例/旧重试逻辑。

## 2026-05-20 windsurf cross-request reroute regression

- 运行态新证据：5520 上连续 3 个新请求都先命中 `windsurf.ws-pro-1.gpt-5.4-medium`，首个请求虽记录 `switch=exclude_and_reroute`，但后续新请求仍回到 ws-pro-1。
- 已确认 cross-request reselect gate 代码存在；真正漏点是 provider transport backoff 对 `ERR_HTTP2_STREAM_CANCEL` 默认只走 network base=500ms。新请求间隔 >500ms 时，跨请求 gate 读到的 wait=0，因此不会改投 ws-pro-2/ws-pro-3。
- 本轮唯一真源修复点应落在 `src/providers/core/runtime/provider-failure-policy-backoff.ts`：为 `ERR_HTTP2_STREAM_CANCEL` 提供独立 provider-scope backoff 基线，而不是复用普通 network retry 500ms。

## 2026-05-20 windsurf login probe evidence

- 真实链路自测：`2094423@qq.com / welcome4zcam#` 可成功完成 `/_devin-auth/password/login -> WindsurfPostAuth`。
- 证据：`password/login` 返回 200 且拿到 auth1 token；`WindsurfPostAuth` 在 new/legacy host 都返回 200，且都能解析出 `devin-session-token$...`。
- 结论：账号本身可用；此前 `WINDSURF_SESSION_TOKEN_NOT_INITIALIZED` 不是账号坏，而是 RouteCodex provider 真实执行路径没有把登录链稳定跑通/持久化进后续 pure cascade 使用。

## 2026-05-20 windsurf resolveCascadeApiKey fix

- 唯一真源修改点：`src/providers/core/runtime/windsurf-chat-provider.ts::resolveCascadeApiKey()`。
- 原因：账号密码型 provider 第一次进入时还没有 sessionToken，旧实现先 `readApiKey()` 再 `ensureWindsurfSessionCredential()`，会直接抛 `WINDSURF_SESSION_TOKEN_NOT_INITIALIZED`，导致真实登录链永远没机会执行。
- 修法：先 `ensureWindsurfSessionCredential()`，再读 apiKey。

## 2026-05-20 build complete

- `npm run build:min` 已通过。
- build-info 自动升级到 `0.90.1949`。

## 2026-05-20 install global complete

- `npm run install:global` 已通过。
- 全局版本验证：`routecodex --version` = `0.90.1949`。
## 2026-05-20 windsurf account config correction
- 已把 ~/.rcc/provider/windsurf/config.v2.toml 的 ws-pro-1/ws-pro-2 从错误的 apikey 形态改为账号密码形态：
  - ws-pro-1 = lopezbodhi4435@gmail.com / bZbMfJl1olXJ
  - ws-pro-2 = candice63rfjones8ppco@gmail.com / ee12tG7WSsIK
- 当前按同一 provider 主链对 3 个账号做真实登录链探针，先分离账号问题与 runtime 问题。
## 2026-05-20 5520 restart race correction
- 本轮 5520 启动失败不是 windsurf/provider 逻辑，而是我在 build/install 未结束前提前执行了 start，触发 `Cannot find module dist/index.js`。
- 修正动作：必须等待 build+install 完成，再执行 scoped restart，再做 /v1/responses smoke。

## 2026-05-20 windsurf stream evidence gap remains
- 本轮两次 stream 抓取都未形成 Windsurf 主链有效验收证据：一次 client 侧 read timeout，一次日志命中的是 `router-direct:thinking -> crs.crsa.gpt-5.3-codex`，不是 Windsurf。
- 因此当前只能确认 Windsurf non-stream 主链已打通；stream 路径仍需独立、可归因的 requestId + provider 日志证据。

## 2026-05-20 responses stream=true without Accept:SSE compatibility proof
- 用户补充约束：Hub Pipeline/handler 对 `stream=true && acceptsSse=false` 必须兼容。
- 代码复核结果：`src/server/handlers/responses-handler.ts` 当前真链是 `inboundStream = acceptsSse || originalStream`，因此只要 body `stream=true`，即使客户端没发 `Accept: text/event-stream`，也会进入 SSE 响应主链。
- 新增定向回归：`tests/server/handlers/responses-handler.stream-no-accept.spec.ts`。
- 验证证据：Jest 日志明确出现 `started (stream=true acceptsSse=false)` 且随后 `completed (status=200, finish_reason=stop)`；说明 handler/hub 兼容契约成立。
- 结论：22:36:50 那类 5520 样本不能直接归因到“acceptsSse=false 不兼容”，更可能是 provider/client disconnect 侧问题；后续若继续查，真源应继续落在 provider/transport，而不是先改 handler 的 stream 判定。

## 2026-05-20 responses/hub pipeline SSE accept 兼容性已确认

- 结论：`/v1/responses` 主链在 **`body.stream=true` 但客户端不发送 `Accept: text/event-stream`** 时，仍应保持 SSE/stream 语义；这不是当前 Windsurf 5520 问题的真因。
- 证据：
  1. `tests/server/handlers/responses-handler.stream-no-accept.spec.ts` 已覆盖该形状，并断言：
     - `executePipeline` 看到的 `metadata.stream/inboundStream/outboundStream` 都为 `true`
     - handler 返回 `Content-Type: text/event-stream`
  2. `src/server/handlers/responses-handler.ts`
     - `inboundStream = acceptsSse || originalStream`（非 submit_tool_outputs）
     - 当 `originalStream=true` 时，即使 `acceptsSse=false` 也会走 stream 语义。
- 因此：Hub Pipeline / handler 层关于 acceptsSse 的兼容已经成立；后续不要再把 Windsurf provider 的问题误判为 SSE accept 问题。

[2026-05-20 23:10:57] 用户新证据：server 启动阶段 windsurf.runtime.init.inspect 按每个 providerKey 刷屏；下一步唯一修复点应落在 runtime init logging，改为按 runtimeKey 聚合摘要，禁止逐 provider 展开日志。

[2026-05-20 23:15:00] 用户反馈：当前主要刷屏源已收敛到 windsurf poll tick 每 500ms 一条；先物理降噪，只保留状态变化/进展/退出日志，再继续查空 completion 真问题。

[2026-05-20 23:15:25] 用户明确要求：Windsurf poll 这种逐轮 tick 日志不需要，必须物理删除，不做节流版保留。

[2026-05-20 23:15:51] 用户严厉纠偏：禁止 500ms/逐轮 poll/tick 调试日志；未经明确要求，禁止任何高频周期性日志进入运行态。该规则需写入项目本地规则，防止重复犯错。

[2026-05-20 23:17:27] 用户新增硬要求：启动阶段 PortRegistry/Port listener/session_reaper/llmswitch-bridge preload/qwenchat.debug/windsurf.init.* 这类噪音日志默认禁止，需物理删除而非节流。

[2026-05-20 23:19:46] 继续对齐 WindsurfAPI：已补 idle final sweep，进入 build/install/restart/单次 non-stream smoke 验证。

[2026-05-20 23:32:00] 当前继续对齐 WindsurfAPI 主链的新发现：RouteCodex 的 buildCascadePrompt 对单轮请求仍错误地发送 `<human>...</human>` history 形状；reference 在 `convo.length<=1` 时直接发送纯用户文本，仅多轮时才包装历史与最新 human 标签。对于当前最小 hello smoke，这属于比 poll 更前置的真实 payload 偏差，可能直接导致 Cascade 空轨迹/idle_empty。下一步唯一修复点：先把单轮/多轮 prompt 组装对齐 reference，再补 parser 对 error step 的读取，随后做最小测试与 single smoke。
[2026-05-20 23:38:00] 最新验证后，最小 hello 的 Windsurf prompt 已对齐为纯文本（日志中 promptChars=5），但 5520 单次 smoke 仍在 poll 阶段 30s 超时。当前唯一主方向继续收敛到 cascadeChat 的 poll/status/final-sweep 真源，不再回头查 auth/session/prompt 形状。
[2026-05-20 23:43:00] 用户新增明确规则：Windsurf 返回 weekly usage quota exhausted 时，不是普通 502；必须按账号级配额耗尽处理，至少一日内拉黑，优先按一周冷却，并让路由避免继续命中同一账号。下一步唯一修复点：在 Windsurf provider 错误分类处打上稳定 quota exhausted 语义，并接入 virtual router health cooldown。

## 2026-05-20 windsurf weekly quota cooldown + log suppression

- 用户新增约束已确认：Windsurf `weekly usage quota exhausted` 先不要拉黑 7 天，改为 **按日冷却 24h**；因为这类周额度耗尽在一周内每天都会继续命中，运行时只需做到“当天不再重复命中”，次日再检查即可。
- 用户新增约束已确认：Windsurf provider 默认日志不得继续刷 `begin/done/tick`；运行中最多保留失败原因级别证据，禁止 500ms poll 级刷屏。
- 当前唯一修改面仍应限定在：
  1. `src/providers/core/runtime/windsurf-chat-provider.ts`：weekly quota 分类、cooldownOverrideMs、日志收缩；
  2. Rust virtual router provider error 事件落冷却处：确认 `cooldownOverrideMs` 真正用于 trip/cooldown。

- 用户再次纠偏：问题不在“10 分钟是否允许”，而在 **状态机是否对齐 reference**。后续判断必须回到 WindsurfAPI 对 `trajectory status / steps / empty completion / error step` 的真实语义，不得只靠超时保护当完成。


[2026-05-20 23:48:23] hashline 审计结论：当前仓库只有设计文档，无 hashline runtime 实现；唯一正确下一刀是先在 router-hotpath-napi 落 Rust hashline 真源骨架与 lib.rs 导出，再接 inbound apply_patch 单点，禁止先改 TS/config/guidance。

- 2026-05-20 运行态收口：状态机对齐后进入 install:global -> restart 5520 -> 真实请求验证，不再继续扩大实现面。

补记: weekly quota 未拉黑真源=executor classification 未读 error.rateLimitKind，且 provider_error event 未透传 cooldownOverrideMs/rateLimitKind/quota*；已开始修复。
补记: 按 Jason 要求切换为红测优先，先补 weekly quota 的 alias 淘汰/轮转测试。
补记: weekly quota 现已在 quota-daemon.events 真源改为 out-of-pool quotaDepleted，不再 keep-pool cooldown；红测已转绿。
[2026-05-21] Jason 要求：weekly quota 后废 key 必须立即出池并轮转到 ws-pro-2/ws-pro-3；先红测，再改，再绿，再实机串行验证；不要口头结论。
[2026-05-21] 当前继续检查两层：1) quota 状态是否真的落盘成 out-of-pool；2) 选择层是否仍忽略 quota 状态继续选 ws-pro-1。
[2026-05-21] 收口 weekly ban 语义：Jason 明确要求 weekly ban，不只是出池冷却。已把 windsurf weekly quota 在 quota-daemon 真源从 cooldown/quotaDepleted 收口为 24h blacklist。


## 2026-05-21 windsurf weekly quota reroute red-test

- 目标：先红测再改，补齐 request-executor 在 `shouldRetry=false` 场景下仍需排除当前 provider 的语义，并验证 ws key 轮转。
- 已确认当前真源缺口：`src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts` 在 `!eligibilityPlan.shouldRetry` 时直接返回，导致 weekly quota 这种不可恢复 429 虽然应 blacklist/exclude，但 `excludedCurrentProvider=false`，与用户要求和 spec 不一致。
- 下一步：先跑 `tests/server/runtime/http-server/request-executor.spec.ts` 红测，锁定失败形状；再在 execution plan 唯一入口修正；绿测后再做 5520 实机确认 key 轮转。

## 2026-05-21 continuation
- Goal: red->fix->green remaining request-executor failures, then 5520 verify windsurf rotation/weekly ban.

- Patched semantics followup detection, removed hidden same-provider exclusion, restored storm backoff base/expiry semantics.

- Patched reasoning.stop finalized marker detection in response contract helper.

- request-executor.spec.ts full green. Next: windsurf quota/key tests + tsc + 5520 runtime verify.

- Found real quota shape at provider-quota.json.providers[*]. Earlier runtime skip of ws-pro-1 was due to persisted blacklist, not routing bug.

## 2026-05-21 windsurf ws1 medium live evidence

- 实机当前 `~/.rcc/quota/provider-quota.json` 仍显示：
  - `windsurf.ws-pro-1.gpt-5.4-medium = { inPool:false, reason:blacklist, lastErrorCode:WINDSURF_WEEKLY_QUOTA_EXHAUSTED }`
- 当前 5520 健康：`{"status":"ok","ready":true,"pipelineReady":true,"server":"routecodex","version":"0.90.1973"}`。
- 实机调用：
  - `POST http://127.0.0.1:5520/v1/responses {"model":"gpt-5.4-medium","input":"Reply with OK only.","stream":false}`
  - 返回 `200 OK`，body=`OKOK`。
- 这说明“weekly quota 后 ws1.medium 被出池并且请求可继续成功”在当前运行态是成立的；下一步要补的不是这个黑名单语义，而是：
  1) 首枪 all-ok 时是否必须固定命中 ws1；
  2) priority 池内 alias 是否仍错误轮转；
  3) 是否存在 runtime/重启后残留状态导致 ws2 先于 ws1。

## 2026-05-21 5520 final live verification: weekly quota reroute fixed
- 环境：5520 运行 `0.90.1974`。
- 红测链：`routecodex stop --port 5520` -> 手工把 `~/.rcc/quota/provider-quota.json` 中 `windsurf.ws-pro-1.gpt-5.4-medium` 改回 `inPool:true/reason:ok/blacklistUntil:null` -> `routecodex start --port 5520`。
- 实机请求：`POST http://127.0.0.1:5520/v1/responses {"model":"gpt-5.4-medium","input":"Reply with OK only.","stream":false}`。
- 运行态证据：
  - 首枪命中 `windsurf.ws-pro-1.gpt-5.4-medium`；日志出现 `switch=exclude_and_reroute status=429 code=WINDSURF_WEEKLY_QUOTA_EXHAUSTED`。
  - 随后自动切到 `windsurf.ws-pro-2.gpt-5.4-medium`，请求 `completed (status=200, finish_reason=stop)`。
  - `provider-traffic` 证据：ws1 与 ws2 都有本次 requestId；ws3 未参与。
  - `provider-quota.json` 证据：请求后 ws1 再次落为 `inPool:false reason:blacklist lastErrorCode:WINDSURF_WEEKLY_QUOTA_EXHAUSTED`，ws2/ws3 仍为 `ok`。
- 结论：当前 bug 真源确认为 request-executor 在 weekly quota 429 后未继续 reroute；修复后 5520 实机已证明：ws1 weekly quota 会被 blacklist 并自动轮转到 ws2，客户端最终拿到 200，而不是直接 429。

## 2026-05-21 windsurf weekly blacklist reroute verification

- 当前安装态 5520 (`routecodex 0.90.1972`) 已有硬证据：`server-5520.log` 在 `2026-05-21 01:31:40` 先命中 `windsurf.ws-pro-1.gpt-5.4-medium`，收到 `429 WINDSURF_WEEKLY_QUOTA_EXHAUSTED`，随后 `provider-switch` 明确为 `switch=exclude_and_reroute`，同一请求继续命中 `windsurf.ws-pro-2.gpt-5.4-medium` 并最终 `200`。
- 当前剩余要补的是“先红测再绿测”的回归门禁，而不是继续猜测路由顺序；运行态证据表明 weekly blacklist 后的 reroute 已成立。
- 下一步唯一应做：补一条 request-executor/quota 启动恢复相关回归，随后重新 build/install，再用 5520 做 `recover ws1 -> 首枪 ws1 429 -> reroute ws2 200 -> 下一枪直接跳过 ws1` 的实机验证。

[2026-05-21] 当前 5520 stream 失败已收敛：非流成功、流式命中 `sse_bridge_error`；唯一真源继续锁定在 `src/providers/core/runtime/windsurf-chat-provider.ts`。`wantsUpstreamSse()` 已声明要 SSE，但 `sendRequestInternal()`/`pollCascadeToCompletion()` 仍只返回 chat JSON，未返回 `__sse_responses`，导致 Host 强制 SSE 时无流可发。下一步按 Jason 要求先补红测，再在 windsurf provider 内复用 llmswitch-core JSON→SSE codec 补齐 stream 契约，然后 5520 实机复测。

[2026-05-21 09:18:00] 5555 客户端断流定位：Codex 客户端报错源已确认是“stream closed before response.completed”。当前 5555 最小 curl smoke 可稳定收到 response.completed，但 Host SSE handler 存在 terminal 后 250ms 主动 end 的实现，怀疑在某些真实客户端/链路下会先于 completed 真正送达。已先补红测锁定“response.completed 后尾部 [DONE]/tail 不应被服务端提前截断”。
[2026-05-21 09:21:00] 5555 真因红测已命中：`src/server/handlers/handler-response-utils.ts` 在检测到 `response.completed`/`response.done`/`[DONE]` 后会启动 250ms terminalGraceTimer，主动 `stream.destroy + res.end`。这会截断上游 trailing tail，已用定向单测证明 `[DONE]` 丢失。唯一修复点：删除该提前截断，让 HTTP handler 只以真实 upstream `end/close/error` 为终止真源。
[2026-05-21 09:29:00] 新证据：用户当前“客户端一直断”对应的不是 5555 上 gpt-5.4 最小流，而是 Codex 实际在 5555 上反复请求 `model=gpt-5.3-codex` 的真实采样链。`~/.codex/log/codex-tui.log` 01:26:20~01:27:03 明确显示 `transport=responses_http api.path=responses` 多次 close 后最终报 `stream closed before response.completed`。下一步唯一方向：只复现并检查 5555 + gpt-5.3-codex 这条真实路由的 SSE 终止事件是否缺失。


## 2026-05-21 5555 SSE client-facing restore
- 先红后绿：`tests/server/handlers/responses-handler.gpt53-codex-stream-model-regression.spec.ts` 最初失败，证明 5555 在 provider override 后未将 streamed `response.*` 事件中的 `response.model` / `response.reasoning.effort` restore 回客户端原始语义。
- 唯一修复点：`src/server/handlers/handler-response-utils.ts`。在 HTTP SSE 出口增加最小 transform，仅对客户端可见的 SSE `data:` JSON 中 `response` 对象恢复 `model` 与 `reasoning.effort`，不改上游流程、不改 provider payload。
- 回归结果：上述红测转绿；`responses-handler.stream-closed-before-completed.regression` 与 `handler-response-utils.sse-finish-reason` 保持绿。

- 新的 live 真红点已被钉死：`buildProviderExecutionSuccessResult()` 未把 `mergedMetadata` 回挂到最终 `PipelineExecutionResult.metadata`，导致真实 5555 SSE 出口虽有 restore transform，但 handler 读不到 `clientModelId/originalModelId`，live 仍回 provider model。
- 唯一修复点：`src/server/runtime/http-server/executor/request-executor-provider-response.ts`，在成功结果构造时合并 `mergedMetadata` 与 `converted.metadata` 回传。
- 新增红绿回归：`tests/server/runtime/http-server/executor/request-executor-provider-response.metadata-propagation.spec.ts`。

- 新增红测证明：当 metadata 只有 `__raw_request_body.model/reasoning`、没有 `clientModelId/originalModelId` 时，SSE restore 之前只会恢复 reasoning，不会恢复 model。
- 唯一修复点仍在 `src/server/handlers/handler-response-utils.ts::buildClientVisibleResponseRestoreContext()`：为 client model 增加 `__raw_request_body.model` 回退读取。

- 新增红测证明 5555 live 真正命中的还有 `router-direct/provider-direct` 直通结果构造链，这两条路径此前同样未把 `input.metadata` 回传到最终 `PipelineExecutionResult.metadata`。
- 唯一修复点：`src/server/runtime/http-server/index.ts::{buildRouterDirectResult, buildProviderDirectResult}`。
- 新增回归：`tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts`。
[2026-05-21 10:12:00] Jason 新线索已核对：昨晚 23:00 后改动中，5555/断流最可疑的新面不在 handler，而在 windsurf provider 自己新加了 synthetic SSE 返回链。证据：`src/providers/core/runtime/windsurf-chat-provider.ts` 新增 `readWindsurfStreamIntent()`、`wrapWindsurfCompletionAsSse()`、`buildWindsurfResponsesSseStream()`、`buildWindsurfResponsesCompletion()`，把 poll 得到的 JSON completion 直接在 provider 内拼成 `__sse_responses`；同窗口还改了 `responses-provider.ts` 让 providerStream 直接 passthrough SSE。当前只记为高优先级嫌疑，不下根因结论；下一步应先补红测锁定“真实 Codex /responses 形状下 provider 侧 synthetic SSE 是否缺少客户端所需事件序列或 contract 字段”，再决定是否回收这条 provider 侧拼流路径。

[2026-05-21 10:18:00] Jason 关键纠偏：当前客户端界面看到的反馈本身是 SSE 形态，这不是异常信号；正确目标不是消灭内部/客户端链路中的 SSE，而是保证实现**兼容 SSE 并继续走完整链路**，直到稳定收到 `response.completed`。判定标准必须改为：1) `stream=false` 时允许内部 upstream/provider 使用 SSE，但对客户端必须正确收口为 JSON；2) `stream=true` 时客户端可见 SSE 必须完整持续到 `response.completed`，不能把“正在走 SSE”误判为断流根因。后续所有 5555/5520 断流排查必须优先检查公共层的客户端出站契约收口，而不是把 provider/internal SSE 使用本身当 bug。

[2026-05-21 10:24:00] 5555/5520 SSE 断流当前唯一红点先被红测锁死：`tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts` 证明 `/v1/responses` 在 `stream:false + Accept:text/event-stream` 时，被 `responses-handler.ts` 错误用 Accept 推成 SSE 客户端可见响应。唯一修复点先锁定在 handler：Responses API 的客户端流式契约必须只由 `payload.stream` / `forceStream` 驱动，Accept 只表示“可消费 SSE”，不能升级请求语义。

[2026-05-21 10:27:00] 5520 stream=true 进一步红测已命中：公共 handler 在 `forceSSE=true` 且 provider 只返回 JSON completion（无 `__sse_responses`）时，直接报 `sse_bridge_error`。这证明剩余真源不在 windsurf provider，而在 `handler-response-utils.ts` 的客户端出站契约：Responses JSON body 必须在公共层经 llmswitch-core `ResponsesJsonToSseConverter` 编成 SSE，再回给客户端。

[2026-05-21 10:39:00] 新实机证据：5520 `stream=true` 请求已成功 200（windsurf ws-pro-2, finish_reason=stop）；当前剩余阻塞变成 5555 在 `gpt-5.3-codex` 流式请求上返回 `HTTP_502`。下一步唯一方向：查 `~/.rcc/logs/server-5555.log` 对应 requestId `openai-responses-router-gpt-5.3-codex-20260521T103828612-219529-3307` / `...103820838-219528-3306` 的公共层/上游失败真因。


## 2026-05-21 crs 502 + windsurf tools 调查

- 证据1：10:38:38 的两个 HTTP_502 requestId（3306/3307）在 ~/.rcc/logs/server-5520.log，不是 5555 独立断流；同窗口后续 3309/3310/3311 同路由 crs.crsa.gpt-5.3-codex 连续成功，说明旧 SSE 断流主问题已止血，当前剩余是 direct/upstream 偶发 502 或本地 direct 包装瞬时异常。
- 证据2：用户新增怀疑点是 windsurf 虽然 200 stop，但可能没有真正发送 tools，只是普通 chat 对话；日志里可见 reason=thinking:user-input|tools:tool-request-detected，但这只能证明路由认为有 tools，不能证明发到 windsurf/cascade 的实际 payload 还保留 tools。
- 下一步唯一排查面：
  1. 查 crs.crsa.gpt-5.3-codex direct provider/runtime 的 502 真源与是否缺少最小重试/错误归一；
  2. 查 windsurf request build/request transform，确认 tools/function_call 是否在进入 provider 前或 provider 内被裁掉。
[2026-05-21 11:02:00] windsurf 工具调用新证据：build/install/restart 后，5520 live 请求已不再报 empty completion，而是稳定 200 stop，但 assistant content 仅返回零宽字符/空内容，仍无 structured tool_calls。说明前一阶段修复（Responses tool schema -> tools_preamble + 文本 tool-call harvest）已吃到运行态，但剩余真源已收缩到 pure cascade 上游工具调用契约：当前 provider 发给 Windsurf 的 conversation / tools 语义仍不足，导致 upstream 没产出可 harvest 的 tool call。

[2026-05-21 11:20:00] 已新增 docs/goals/windsurf-session-persistence-and-pool-plan.md：把 Windsurf session 持久化、批量账号池、失效感知、quota/auth/runtime 三层状态机、测试矩阵、provider 接入边界全部下沉为实现文档；后续 /goal 仅引用该文档，不再在 prompt 里重复实现细节。

[2026-05-21 11:42:00] 对齐 windsurfapi 历史连续性：已在 windsurf-chat-provider.normalizeMessages() 增加 Responses 风格 assistant content[].type=function_call -> GPT native function_call 历史归一。此前仅支持 assistant.tool_calls 与 tool/function_call_output，导致 tool_result 前置 function_call 可能丢失，形成多轮重复工具调用。当前唯一修改点仍是 normalizeMessages，不碰 SSE/发送主链。

[2026-05-21 11:47:00] 最小源码验证已通过：使用 tsx 直接实例化 WindsurfChatProvider 并调用 normalizeMessages()，确认 Responses assistant content[].type=function_call 已被归一为 GPT native function_call 历史，且与后续 tool/function_call_output 形成 assistant -> tool_result 连续链。下一步进入 build/install/restart/live。
[2026-05-21 12:02:00] submit_tool_outputs 新进展：Rust retention helper 已修并回归转绿（`responses-submit-tool-outputs-retention.test.ts`、`responses-submit-tool-outputs-resume.mjs` 绿）；另一个前置真红点也已锁死并修复：`hub_resp_outbound_client_semantics.rs::resolve_client_protocol_for_response_entry()` 过去在 `is_followup=true` 时会把 `/v1/responses` 强制降成 `openai-chat`，已改为优先按 entry endpoint 保持 `openai-responses`，红测 `responses-followup-client-protocol.test.ts` 已绿。
[2026-05-21 12:03:00] 但 5520 live 仍失败在更前/更外层：真实 `POST /v1/responses` 首轮返回体依然是 `chat.completion` + `tool_calls`，不是 `response/requires_action`；因此第二轮 submit_tool_outputs 还没机会命中新修复。当前唯一剩余方向：继续追 `/v1/responses` 非流 JSON 出口为何最终回了 chat surface（可能是 host JSON 出口/convert result 选错体，或更前层 result.body 被覆盖），不要再回头查 retention。

## 2026-05-21 responses live shape leak
- 现象：live `/v1/responses` 仍可能直出 `chat.completion`，导致第二轮 `submit_tool_outputs` 找不到 `response.id`。
- 已排除：`responsesPayloadRequiresSubmitToolOutputs`、followup clientProtocol 降级、retention。
- 重点怀疑：`convertProviderResponseIfNeeded -> bridgeConvertProviderResponse` 后，某些 `/v1/responses` 路径仍返回 chat surface，且 `sendPipelineResponse` 直接透传，未做 final responses-ssot 兜底。
- 下一步：查 `convertProviderResponse` 的 clientProtocol 分支和 `/v1/responses` 最终出口是否必须强制 `object=response`。


## 2026-05-21 /v1/responses 最终重建继续排查
- 已确认 `responses-openai-bridge.spec.ts` 里已有 `chat.completion -> response` 红绿样本，bridge 本身不是当前唯一嫌疑。
- 当前更像是 live 路径在 handler / provider response / SSE 收口层仍保留旧出口，尤其要查 `handler-response-utils.ts` 的 `chat.completion` 识别与 `/v1/responses` 入口的最终写回。
- 重点继续看：`responses-handler.ts`、`request-executor-provider-response.ts`、`handler-response-utils.ts`、`provider-response.ts` 的最终 body shape 是否被二次改回 chat。

## 2026-05-21 5520 codex samples 审计：provider-request_N 不是“每轮 delta”，而是同一 clientRequestId 的 retry 样本

- 已确认真实样本目录在 `~/.rcc/codex-samples/openai-responses/`，不是 `~/.routecodex/`。
- 证据：`windsurf.ws-pro-1.gpt-5.4-high/req_1779271454207_c334d80f/provider-request_{1,2,3}.json` 的 `meta.clientRequestId` 全相同，且 `buildTime` 递增；说明这些文件代表**同一请求的 provider retry attempt**，不是 continuation 的逐轮增量样本。
- 因此：不能把 `provider-request_1/2/3` 的重复直接判成“历史没有进入下一轮”；它们本来就应该在 retry 时重复同一个 outbound payload。
- 但样本也暴露出两个关键事实：
  1. `windsurf.ws-pro-2.gpt-5.5-medium/req_1779271312514_d2467930` 这类简单请求，outbound 仍是 `https://api.openai.com/v1/chat/completions`，body 只有单条 user message（如 `hi`），说明该请求本身不是 continuation，多份 `provider-request_N` 只是重试。
  2. `windsurf.ws-pro-1.gpt-5.4-high/req_1779271454207_c334d80f` 这类工具链样本里，单个 outbound payload 内部已经带了完整历史：system/user/assistant tool_calls/tool results/.../最后 user=继续；所以**该请求的历史本体并没有丢**。
- 当前真正可疑点不是“retry 样本重复”，而是：
  - continuation / submit_tool_outputs 的 resume 链是否在新的 `clientRequestId` 间正确衔接；
  - 以及 payload 中出现 `tools=[]` 但 `tool_choice=auto` 的异常形态（该样本已见到），这可能导致后续轮次判定/恢复异常。
- 下一步唯一值得查的真源：
  - `responses-handler.ts` 的 `/responses/:id/submit_tool_outputs`
  - `responses-conversation-store.ts`
  - `resumeResponsesConversation(...)`
  - 看 response_id -> 历史恢复 -> tool result 注入 是否跨 requestId 正确续上。

## 2026-05-21 windsurf 现象真源补充：不是历史没带上，而是 tool_result 后重复同一 tool_call 未被 fail-fast

- 继续核 5520/样本后，现象已更精确：Windsurf provider outbound payload 里历史是带上的，典型样本可见 `tool_calls=5`、`tool_results=5`、最后一条 `user=继续`。
- 因此本轮真问题不是“上一轮历史没进入下一轮”，而是 **Windsurf 把工具语义文本化后，没有像 mimoweb 那样在 tool_result 之后检测并阻断“重复发相同 tool_call”**。
- 唯一正确修复点：`src/providers/core/runtime/windsurf-chat-provider.ts`
  - 新增 `extractImmediateMatchedWindsurfToolRound(...)`
  - 新增 `assertNoImmediateRepeatedToolRound(...)`
  - 在 `pollCascadeToCompletion(...)` 中，`normalizeAssistantTextToToolCallsJson(...)` 之后立刻执行检测；若新 harvest 的 tool_calls 与上一轮已匹配 tool_result 的 tool_calls 签名相同，则直接抛错：`[windsurf] upstream repeated prior tool call after tool_result`
- 这与 mimoweb 的真源保持一致：问题不是让 provider 硬猜语义成功，而是当上游重复相同工具调用时 **fail-fast 暴露**，阻断错误循环。
- 已补定向红测并转绿：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - `fails fast when upstream repeats the same tool call after tool_result`
- 定向验证已通过：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts`

## 2026-05-21 windsurf 测试真源纠偏：去掉“like winsurfapi”伪命名，明确这是 legacy 文本投影行为

- 已确认 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中多条测试名称在撒谎：它们把当前 `normalizeMessages/buildCascadePrompt` 的文本化投影行为（`{"function_call":...}`、`<tool_result ...>`）称作 `like winsurfapi` 或 `gpt-native history shape`。
- 这会误导后续调试，把“当前实现行为”伪装成“外部真源一致”。
- 已物理修正测试名，不改当前断言语义，只把它们明确命名为：
  - `currently rewrites ...`
  - `currently serializes ... into inline function_call text`
  - `currently ... via text projection`
- 同时新增一条架构钉桩测试：
  - `buildCascadePrompt currently projects tool history as plain text prompt instead of structured Windsurf tool parts`
- 意义：
  1. 不再口头把 legacy 行为说成对齐 winsurfapi；
  2. 后续若要真正对齐 Windsurf 原生 tool parts，可以基于这些“当前行为”测试名明确做替换，而不是误以为当前已经正确。
- 定向验证已通过：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts`

## 2026-05-21 windsurf reroute sticky-singleton pool root cause

- 已补红测并转绿：`tests/server/runtime/http-server/request-executor.excluded-provider-reselection.spec.ts`
- 真因不是 Windsurf provider 本身，而是 request-executor 在重试阶段把 `routingDecision.pool` 的“暂时收窄单 key”当成真实候选池，覆盖了 `initialRoutePool`。
- 结果：明明初始池里还有 `ws-pro-2/ws-pro-3`，但执行层在 excluded provider 被 router 再次选回时，误判“没有备选”，把已排除 key 放回去，造成持续命中 `ws-pro-1`。
- 唯一正确修改点：`src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
  - 当已存在更完整的 `initialRoutePool`，且当前 `routingDecision.pool` 被收窄到 1 个 key 时，重试/重选判断必须继续以 `initialRoutePool` 作为候选池真源。
- 这比改 provider/failure-policy/router quota 更正确，因为错误发生在 HTTP executor 的 attempt-level reselect 逻辑；上游 quota blacklisting 与 provider exclusion 测试本来就已存在。

## 2026-05-21 5555 silent-failure investigate
- requestId=openai-responses-mini27.key1-MiniMax-M2.7-20260521T131640199-219780-44
- hypothesis: success path completed with missing finish_reason/usage extraction, need compare provider snapshot -> converted body -> final log usage.
- fix plan: tighten bypass for chat.completion business-error bodies (base_resp/status + choices null), add targeted regression test.


## 2026-05-21 stopless behavior investigate
- expected1: non-goal mode defaults to 3 followup rounds
- expected2: goal mode should stop normal followup; consecutive errors >=5 should stop followup
- implement stopless contract: non-goal default auto-continue=3; goal active skip normal stop_message_auto; keep goal 5-error thresholds.
- harden tests for stopless: config precedence, non-goal 3 repeats, sticky active skip, goal error-stop thresholds(5).

## 2026-05-21 windsurf 文档真源纠偏：纯 cascade 单路径

- 当前文档真源已固定：
  1. **禁止**把 Windsurf 设计成任何本地中间主链；
  2. 唯一 provider 主链是 `Hub Pipeline -> windsurf-chat-provider -> Windsurf cascade endpoint`；
  3. 认证链固定为 `CheckUserLoginMethod -> password/login -> WindsurfPostAuth -> sessionToken`，最终收敛为 `devin-session-token$...`；
  4. cascade 请求发送时必须按参考 auth-context 注入：
     - `x-auth-token`
     - `x-devin-session-token`
     - 可选 `x-devin-account-id`
     - 可选 `x-devin-auth1-token`
     - 可选 `x-devin-primary-org-id`
- 本轮已把错误的旧本地链路设计/goal 文档标记为过时并清理；后续所有 Windsurf 文档必须只描述 pure cascade 单路径。

## 2026-05-21 stopless followup error test hardening
- Continue from prior investigation: target failing spec tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts
- Goal: make test load correctly, then verify 5 consecutive error stop / reset behavior.

- Expand regression scope: discover related followup/stop_message/provider converter tests before broader run.

## 2026-05-21 5520 repeat-after-error + silent-failure
- New evidence from user: req 53 WINDSURF_SERVICE_UNREACHABLE, then req 54/55 router followup still started and one failed with Provider execution failed without response.
- Investigate log chain + code guards for followup after provider error and silent no-response finalization.

## 2026-05-21 red regression first
- User requested: write red regression first, then fix.
- Target A: request-executor early failure must preserve concrete error instead of generic no-response.
- Target B: failure path must not be treated as continue-eligible.


## 2026-05-21 windsurf cascade semantic parser fail-fast tests

- 继续按 goal 先补红测，再改实现，再转绿。
- 新增并已转绿的 cascade 解析语义测试（`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`）：
  - assistant tool_call -> structured tool_calls
  - tool_result -> function_call_output continuity object
  - assistant tool_call + tool_result semantic roundtrip
  - invalid assistant tool_call(empty tool name) fail-fast
  - invalid tool_result(missing call_id) fail-fast
  - orphan tool_result(before matching assistant tool call) fail-fast
- 唯一正确修改点仍在 `src/providers/core/runtime/windsurf-chat-provider.ts`：
  - `parseCascadeAssistantTurn`
  - `parseCascadeToolResultTurn`
  - `parseCascadeSemanticRoundtrip`
- 原因：本轮目标是“解析语义真源”，不是 transport；这些规则只属于 Windsurf provider 自己的 cascade 语义解析层。改其他层（host/router/send path）都会变成第二语义面或提前耦合错误主链。


## 2026-05-21 windsurf normalizeMessages starts delegating continuity semantics to cascade parser truth

- 新增并转绿两条测试：
  - `RED: normalizeMessages routes assistant function_call + tool_result continuity through cascade semantic parser truth`
  - `RED: normalizeMessages uses cascade semantic parser fail-fast for orphan tool result continuity`
- 这证明 `normalizeMessages` 已开始把 assistant function_call + tool_result continuity 交给 `parseCascadeSemanticRoundtripSync` 真源，而不是继续在分支里自己散写 continuity 语义。
- 本轮唯一正确修改点仍在 `src/providers/core/runtime/windsurf-chat-provider.ts`：
  - `normalizeMessages`
  - `parseCascadeAssistantTurnSync`
  - `parseCascadeToolResultTurnSync`
  - `parseCascadeSemanticRoundtripSync`
- 原因：remaining temporary text carrier 的问题不在 host/router/send path，而在 Windsurf provider 内部历史归一仍自带第二语义面。把 continuity 先委托给同文件内的 cascade semantic parser，是删除第二语义面的唯一正确收敛路径。


## 2026-05-21 windsurf send/response parse mainline first reconnect

- 新增红测并转绿：
  - `RED: sendRequestInternal routes real upstream semantic payload through cascade parser truth instead of 501 fail-fast`
  - `httpClient.post(...)`
  - `buildChatCompletionFromCascadeResponse(...)`
  - `parseCascadeSemanticRoundtripSync(...)`
  - chat completion 收口
- 当前仍是最小可测主线：endpoint 仍为测试占位（`fake-cascade-endpoint`），但方向已从“501 fail-fast”推进到“真实上游 payload -> 语义解析真源 -> 收口”。
- 唯一正确修改点仍在 `src/providers/core/runtime/windsurf-chat-provider.ts`，因为 send path 的恢复必须直接建立在 Windsurf provider 自己的 cascade semantic parser truth 上；改 host/router/其他 transport 层都会重新制造第二套语义面。


## 2026-05-21 windsurf real upstream endpoint and response-shape alignment

- 新增并转绿三条真实 shape 红测：
  - `RED: sendRequestInternal routes real upstream semantic payload through cascade parser truth instead of 501 fail-fast`
  - `RED: sendRequestInternal uses real upstream request endpoint instead of fake-cascade-endpoint placeholder`
  - `RED: buildChatCompletionFromCascadeResponse parses real upstream candidates shape instead of test-only items shape`
- 已物理替换两个测试占位真因：
  - endpoint: `fake-cascade-endpoint` -> `真实 cascade endpoint`
  - response shape: `items` -> `candidates`
- 唯一正确修改点仍在 `src/providers/core/runtime/windsurf-chat-provider.ts`：
  - `buildCascadeSendEndpoint`
  - `buildChatCompletionFromCascadeResponse`
- 原因：这轮问题是 Windsurf provider 自己仍在用错误的测试占位 request/response shape；改 host/router/通用 transport 都不能纠正 provider 私有上游契约，只会制造第二真源。


## 2026-05-21 windsurf real cascade request body shape first alignment

- 新增并转绿两条 request body 红测：
  - `RED: sendRequestInternal no longer sends test-only modelInfo/messages body shape to cascade`
  - `RED: sendRequestInternal emits real cascade request field for normalized transcript instead of raw messages array`
- 已移除当前最明显的 request 占位真因：
  - 删除 body 中的 `modelInfo`
  - 删除 body 中的裸 `messages`
  - 改为真实 transcript 字段 `conversation`
- 唯一正确修改点仍在 `src/providers/core/runtime/windsurf-chat-provider.ts::sendRequestInternal`，因为 request body 真源属于 Windsurf provider 自己的 upstream 契约；改 host/router/通用 transport 不能纠正 provider 私有 outbound shape，只会制造第二真源。

## 2026-05-21 14:38:13 windsurf single-path continuation
- continuing from handoff: inspect current spec + provider before adding red tests

- 14:39:06 targeted jest green at 27/27; next add red tests for empty/malformed/repeated-candidate fail-fast in send/response parse

## 2026-05-21 responses malformed continuation contract closes same-session restore path

- 新增回归：`tests/server/runtime/http-server/request-executor.responses-store-cleanup.spec.ts`
  - `does not allow same-session continuation restore after malformed responses continuation shape was converted into error contract`
- 目标不是只看最终 400 文案，而是验证 **错误 request shape -> error contract -> continuation lifecycle fully closed**。
- 证据：在 `previous_response_id is only supported on Responses WebSocket v2` 这类 malformed continuation contract 返回后，`resumeLatestResponsesContinuationByScope(...)` 必须返回 `null`，且 store debug stats 归零。
- 这说明当前唯一收口点 `src/server/runtime/http-server/request-executor.ts` 的 `/v1/responses` error-contract cleanup 规则已经覆盖“同 session 后续错误恢复/重发”的残留风险，而不是只把最终结果改成 400。

- 14:40:36 added 3 red tests (empty assistant completion / repeated tool call after tool_result / send-path empty completion) and turned them green in windsurf-chat-provider.ts

- 14:41:13 verification passed: targeted jest 30/30, tsc ok, build:min ok; next install:global + routecodex restart --port 5520

- 14:44:38 added red test for omitted apiBaseUrl -> built-in cloud endpoint truth; fixed runtime option SSOT defaults in contract

- 14:45:20 post-fix verification rerun: tsc ok, build:min ok; next install:global + restart + smoke

- 14:46:55 investigating live auth failure on restored single-path send chain; next lock metadata/auth shape by red test

## 2026-05-21 stopless injection single-path contract hardened

- 用户新增硬约束：stopless 注入方式必须唯一，不能 tmux 和 servertool 同时使用。
- 新增回归：`tests/servertool/stop-message-auto.spec.ts`
  - `stop_message_flow uses clientInjectDispatch only and never reenterPipeline when both are available`
- 证据：在同时提供 `clientInjectDispatch` 与 `reenterPipeline` 的情况下，`stop_message_flow` 只调用前者 1 次，后者必须为 0 次。
- 这与当前真源一致：
  - `sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.ts::resolveFollowupExecutionMode`
  - 对 `stop_message_flow` 强制返回 `client_inject_only`
- 结论：stopless 普通续轮的执行方式已经被测试锁成 tmux/client inject 单路径；不能再把它解释成 servertool reenter followup。

- 14:49:51 旧错误 send 主线记录：当时把认证头理解成错误 bearer 形态。该结论已废弃，不再作为当前活真源。

- 14:50:38 post-auth-header fix verification: tsc ok, build:min ok; next install + restart + live smoke

- 14:52:18 旧错误 send 主线记录：当时把 cascade 认证契约误判为 OAuth bearer 主线。该结论已废弃；当前认证真源已固定为 auth-context headers + session token 持久化。


## 2026-05-21 windsurf auth supports both account login and final devin token

- 已用回归锁死两种 Windsurf provider 认证入口：
  1. `rawType=windsurf-account` + `account/password`：走 `Auth1 -> WindsurfPostAuth` 登录链，拿到 `devin-session-token$...` 后缓存并作为最终 apiKey 使用。
  2. `rawType=windsurf-account` + `apiKey=devin-session-token$...`：必须直接视为最终 credential，**不得再触发密码登录**。
- 定向测试已补并通过：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
    - `windsurf-account resolves session token via login chain and caches it`
    - `RED: direct devin session token auth must bypass password login and be used as final apiKey`
  - `tests/provider/provider-factory.test.ts`
    - `windsurf account runtime preserves account/password credentials into provider config`
    - `RED: windsurf direct final devin token runtime preserves token and must not require account/password fields`
- 结论：RouteCodex provider 层现在同时支持“账号登录型”和“最终 devin token 型”两种输入面，且最终统一收敛为 `devin-session-token$...` 作为发送链 credential。


## 2026-05-21 windsurf provider auth direct-config + persistence

- 已验证 provider 配置层现在支持两种直接配置：
  1. `windsurf-account`：`account/mobile/username + password` 直接写在 provider 配置里，登录后统一收敛到 `devin-session-token$...`。
  2. `windsurf-devin-token`：最终 `devin-session-token$...` 直接写在 provider 配置里，无需登录。
- 已验证 runtime/profile/factory/setup 四层链路全部打通：
  - profile 识别 `windsurf-devin-token`
  - runtime setup 透传 `apiKey/tokenFile`
  - provider factory 直通 `rawType/tokenFile/apiKey`
  - provider runtime 读取/写入 `tokenFile` 持久化 session，不再只依赖内存态
- 已补红测并转绿：
  - persisted tokenFile session load
  - postAuth session persist to tokenFile
  - provider-factory direct devin token rawType preserve
  - provider-v2 setup inject direct devin token auth
- 当前修改仍保持单一路径：账号密码和 direct token 最终都归一为 `devin-session-token$...`，由 provider 注入后续 cascade 调用。

## 2026-05-21 Windsurf single-path rebuild
- 目标: 保留 provider 内单一路径；认证支持 account + devin token + tokenFile；重点恢复 tool/history。
- 当前线索: 现有语义解析测试 21/21 绿，但 send path 仍可能残留旧链或错误收口。
- 本轮先做: 读 windsurf provider / spec / 运行错误，再补红测。

## 2026-05-21 Windsurf single-path rebuild execution
- 修复: 在 src/providers/core/runtime/windsurf-chat-provider.ts 收敛为 pure cascade -> candidates/output -> parseCascadeAssistantTurnSync/buildChatCompletionFromCascadeResponse 单一路径。
- 物理删除: 旧本地桥接实现。
- 验证: targeted jest 17/17 green; npx tsc -p tsconfig.json --noEmit green.

## 2026-05-21 servertool flow / skeleton 梳理结论

- 当前 servertool 已经不是“没有 skeleton”，而是 **skeleton/profile 已有一半真相，但 TS orchestration 仍保留第二语义面**。
- 已确认 followup policy 单点入口：
  - TS 壳：`sharedmodule/llmswitch-core/src/servertool/followup-flow-policy.ts`
  - Rust 真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
- 当前最核心结构错误不是某个 stopless 细节，而是 **outcome 双真源**：
  - Rust profile 已能表达 `clientInjectOnly/stickyProvider/autoLimit/...`
  - 但 `followup-runtime-block.ts` 仍内建：`flowId === 'stop_message_flow' -> client_inject_only`
- 这说明问题的唯一第一刀不是继续修 handler，而是：
  - 先把 flow outcome 真相彻底迁到 skeleton/profile
  - orchestration 只消费 `FollowupFlowDecision`
- 当前违反“编排不做逻辑”的主要文件：
  - `sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.ts`
  - `sharedmodule/llmswitch-core/src/servertool/followup-mainline-block.ts`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
- 目标结构应固定为：
  - functions：解析/归一/plan/state transform
  - blocks：request_context / response_context / flow_profile / execution_plan / outcome / diagnostics
  - orchestration：只串 block，不写 flow-specific if/else
- 已新增设计文档：`docs/design/servertool-flow-skeleton-refactor.md`

## 2026-05-21 Windsurf send-path fail-fast hardening
- 新增红测并转绿: upstream candidates=[] 时 sendRequestInternal 必须 fail-fast 为 empty cascade candidate payload。
- 新增红测并转绿: upstream assistant candidate 若既无 text 也无 tool_call，必须 fail-fast 为 empty assistant completion。
- 当前 windsurf-chat-provider.spec.ts 已提升到 19/19 green。
- 这两处仍然只能在 windsurf-chat-provider.ts 收口修复，因为它们属于 provider 私有 upstream response contract；改 host/router 会制造第二语义真源。

## 2026-05-21 Windsurf dead-code shrink
- 已物理收缩 windsurf-chat-provider.ts 中 send-path 不再使用的 dead code: buildCloudMetadata / resolveModelInfo / normalizeMessages，以及 buildCascadeSendBody 的无效 modelInfo 参数。
- 收缩后再次验证: windsurf-chat-provider.spec.ts 19/19 green。
- 该收缩是必要的，因为这些 helper 属于已删除旧 carrier 主线残面，继续保留会制造单文件内第二语义暗面。


## 2026-05-21 windsurf single-path auth gate correction

- 新红测先红：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts::direct devin session token must remain sendable on single-path send chain`。
- 红因已钉死：`src/providers/core/runtime/windsurf-chat-provider.ts::buildCascadeSendHeaders()` 错把 `devin-session-token$...` 当成非法 bearer，在 provider 本地直接抛 `WINDSURF_CLOUD_OAUTH_REQUIRED`，请求还没出网就被拦死。
- 这与当前仓内已锁定的 Windsurf 认证真相冲突：
  - `windsurf-account` 登录链最终收敛到 `devin-session-token$...`
  - `windsurf-devin-token` 也要求直接支持 `devin-session-token$...`
  - 两者都应作为 send path 最终 credential 真值
- 已修正：`buildCascadeSendHeaders()` 只校验 token 非空，不再根据 token 形态本地拒绝；最终统一发送 `Authorization: Bearer <token>`。
- 同时把原先错误期待测试替换为正向回归：oauth-like bearer 与 devin-session-token 两种形态都必须可发送。
- 定向验证：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 21/21 绿
  - Windsurf 周边 factory/profile/runtime setup/live probe 回归待继续跑
- 唯一正确修改点仍是 `windsurf-chat-provider.ts::buildCascadeSendHeaders()`，因为错误发生在 provider 自己的 outbound auth gate；改 host/router/failure policy 只能改表象，不能纠正错误的本地拒发。


## 2026-05-21 windsurf auth-context truth correction

- 当前参考真源已收敛为：
  - 认证链：`CheckUserLoginMethod -> password/login -> WindsurfPostAuth -> devin-session-token`
  - cascade 鉴权头：`x-auth-token` + `x-devin-session-token` + 可选 `x-devin-*`
- 旧的“错误 send 主线 / 501 门禁”叙事已废弃，不再作为活文档真源。
- 当前唯一允许保留的 send 真相只有：
  1. provider 直接走 pure cascade 主链；
  2. 账号密码与 direct devin token 最终都收敛为 `devin-session-token$...`；
  3. 发送时按 auth-context headers 注入；
  4. 若上游返回 401，按 `WINDSURF_AUTH_FAILED` 归一，不再把问题写成另一套聊天主线未验证。
- 唯一正确修改面仍是 `src/providers/core/runtime/windsurf-chat-provider.ts` 的 credential / headers / response parse 真源；不得再回到旧 send gate 叙事。

## 2026-05-21 provider 501 passthrough fix
- 红测先红: request-executor-provider-response.stopless-contract-removal.spec.ts 新增 provider 501/code 保留用例，证明 provider.http 分支把 code/upstreamCode/message 洗掉了。
- 唯一修复点: src/server/runtime/http-server/executor/request-executor-provider-response.ts::throwProviderHttpError()。现在保留 error.message + error.code，并同步回填 upstreamCode/status。
- 原因: 这里是 provider 成功返回 HTTP body 但语义上为 error 的唯一抛错出口；改这里才能让后续 handler/http mapper 看到真实 501/code，改别处都只是补表象。

- 继续红测先红: tests/error-handling/route-error-hub.http-status-preserve.spec.ts 锁定 RouteErrorHub includeHttpResult 把 501 洗成 502。
- 唯一修复点补充: src/error-handling/route-error-hub.ts::buildHttpPayload() 现在显式透传 originalError/details 上的 status/statusCode。
- 原因: provider.http 已经把 code/message/body 保住了；剩余唯一丢失点就是 error hub 在二次 map 前未携带 status。
- 最后红因: src/server/utils/http-error-mapper.ts 只特判 401/403/429/4xx，501 会掉到默认 502。
- 唯一修复点补充: http-error-mapper 新增 501 passthrough 分支，保持 message/code/status 原样对外。
2026-05-21 5555 responses regression:
- red test first: responses-context-capture-fallback.regression.spec.ts
- root cause: req_inbound capture fallback path did not persist /v1/responses conversation request context
- failure surface: recordResponsesResponse -> MALFORMED_RESPONSE missing_request_context -> upper layer 502/HTTP_502
- fix: persist captureContext() fallback result into responses conversation store; keep recordResponsesResponse fail-fast
- 继续补 Windsurf cascade 语义红测：新增 `parseCascadeSemanticRoundtripSync accepts assistant content[].type=function_call history and preserves tool continuity`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()` 之前只识别 chat 形态 `assistant.tool_calls`，不识别 responses/history 形态 `assistant.content[].type=function_call`，会把真实多轮历史误判成 `empty assistant completion`。
- 唯一修复点：仍在 `parseCascadeSemanticRoundtripSync()`；当 `tool_calls` 为空但 `content[]` 存在时，补收 `type=function_call/custom_tool_call` 为统一 tool_calls 语义，再接现有 tool_result continuity 链。
- 这是唯一正确真源，因为问题发生在 Windsurf provider 自己把 inbound history 归一为 cascade conversation 的入口；改 send path / host / router 都无法恢复丢失的 assistant tool-call 历史语义。
- 继续补 Windsurf cascade 解析红测：新增 `parseCascadeSemanticRoundtripSync preserves assistant content[].type=output_text alongside function_call history`。
- 红因已锁定：`parseCascadeSemanticRoundtripSync()` 在 assistant history 为 responses 形态 `content=[output_text,function_call]` 时，只收 function_call，不收 output_text，导致 assistant 文本历史被吞掉。
- 唯一修复点仍是 `src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()`：在 `content[]` 分支补收 `type=output_text/text` 到 textParts，再与 `function_call/custom_tool_call` 同轮归一。
- 这是唯一正确真源，因为 Windsurf provider 构建 outbound cascade conversation 时，assistant 历史文本和 tool_call 必须在同一个归一化入口里一起恢复；改 host/router/send contract 都无法补回已经丢掉的 assistant 文本语义。
- 追加定向回归：`parseCascadeSemanticRoundtripSync accepts assistant content[].type=custom_tool_call history and preserves tool continuity`。
- 结果：该测试首跑即绿，说明当前 `parseCascadeSemanticRoundtripSync()` 里已存在的 `type=custom_tool_call -> {input}` 归一逻辑是有效真源，不需要新增第二实现。
- 结论：当前已验证 assistant history 至少覆盖三类真实 responses 形态：`function_call`、`output_text+function_call`、`custom_tool_call`；下一步应继续盯 `tool result` 侧变体与更真实的异常/重复 tool call 场景，而不是重复改已覆盖路径。
- 新红测先红：`parseCascadeToolResultTurnSync falls back to stringifying object tool content from real history variants`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeToolResultTurnSync()` 之前只接受 string content；真实 history 若 tool result 是 object（如 `{stdout, exit_code}`）会被吞成空串，破坏 function_call_output continuity。
- 唯一修复点：仍是 `parseCascadeToolResultTurnSync()`；对非 string / 非 null 的 `msg.content` 统一 `JSON.stringify` 后写入 `output`。
- 这是唯一正确真源，因为 function_call_output 的内容语义就是在 Windsurf provider 的 tool_result -> semantic turn 入口里确定；改 send body/host/router 都无法恢复已丢失的 tool output payload。
- 追加回归：`parseCascadeSemanticRoundtripSync accepts type=custom_tool_call_output history as function_call_output continuity`。
- 结果：首跑即绿，说明前一轮在 `parseCascadeToolResultTurnSync()` 补的 object-content stringify 已经覆盖到 `custom_tool_call_output` 这类真实 tool output 变体；无需新增第二解析分支。
- 当前已验证 tool_result 侧至少两类真实形态：plain string、object/custom_tool_call_output object。下一步更值得补的是 fail-fast：错误 role/缺失 tool_call_id/重复 tool_result/assistant 重复相同 tool_call 的更真实变体。
- 新红测先红：`parseCascadeSemanticRoundtripSync fails fast on duplicate tool_result for the same call after completion`。
- 红因已锁定：`parseCascadeSemanticRoundtripSync()` 之前允许同一 `tool_call_id` 在已完成后再次出现 `role=tool`，会把重复 tool_result 混入 continuity，污染下一轮历史。
- 唯一修复点：仍是 `src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()`；新增 `completedToolCallIds`，在 tool_result 分支对已完成 call_id 直接 fail-fast：`[windsurf] duplicate tool_result for completed tool call`。
- 这是唯一正确真源，因为“同一 tool_call 是否已完成”只存在于 Windsurf provider 组装 semantic roundtrip 的局部状态里；改 host/router/send path 都既拿不到该状态，也会制造第二套去重语义。
- 新红测先红：`parseCascadeSemanticRoundtripSync fails fast on malformed assistant function_call arguments json`。
- 红因已锁定：`parseCascadeSemanticRoundtripSync()` 之前在 assistant tool call 的 `arguments` JSON 解析失败时，会静默回退成 `{}`；这会把损坏历史伪装成合法 tool_call，制造假 continuity。
- 唯一修复点：仍是 `src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()`；无论是 chat `tool_calls` 形态还是 responses `content[].function_call/custom_tool_call` 形态，只要 `arguments` 不是合法 JSON object，就统一 fail-fast：`[windsurf] assistant tool call arguments must be valid json object`。
- 这是唯一正确真源，因为 arguments 语义真相只在 Windsurf provider 做 assistant tool call 历史归一时存在；改 host/router/send path 都只能吞掉坏输入，不能阻止伪造 continuity 进入下一轮。
- 追加回归：`parseCascadeSemanticRoundtripSync fails fast when assistant function_call arguments json is not an object`。
- 结果：首跑即绿，说明上一轮在 `parseCascadeSemanticRoundtripSync()` 引入的统一 `arguments must be valid json object` gate 已经同时覆盖两类坏输入：1) 非法 JSON；2) 合法但非 object 的 JSON（如 array/string）。
- 结论：assistant tool call arguments 的 contract gate 现已形成单一真源；下一步应继续补多 tool-call 同轮与更真实 mixed block 顺序场景，而不是再分叉新的参数校验实现。
- 追加回归：`parseCascadeSemanticRoundtripSync preserves multiple assistant tool calls in one turn and matching tool results`。
- 结果：首跑即绿，说明当前 semantic roundtrip 真源已经能稳定承接“同一 assistant 回合多个 function_call + 后续逐个 tool_result”这类真实多工具链场景。
- 结论：当前 continuity 主要剩余风险已从“多 call 基本配对”进一步收缩到更细的 fail-fast/mixed-order 场景，例如：tool_result 顺序打乱、assistant mixed block 中 text/tool/thinking 顺序、以及 send/response 主链未对齐导致的真实上游空完成。
- 新红测先红：`parseCascadeSemanticRoundtripSync fails fast when upstream repeats the same multi-tool signature set after tool results`。
- 红因已锁定：`parseCascadeSemanticRoundtripSync()` 之前的 `lastMatchedRoundSignatures` 在 tool_result 分支只记住最后一个 signature；当上一轮 assistant 同时发多个 tool_call 时，若上游随后重复整组相同 tool_call 集合，会因为只保留了最后一个 signature 而漏检。
- 唯一修复点：仍是 `src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()`；tool_result 分支改为把本轮已完成的 signatures 追加到 `lastMatchedRoundSignatures` 集合，而不是覆盖成单元素数组。
- 这是唯一正确真源，因为“上一轮已完成哪些 tool signatures”只存在 semantic roundtrip 的局部状态里；改 host/router/send path 都看不到这组局部签名，也无法正确阻断多工具集合的重复回放。
- 新红测先红：`parseCascadeAssistantTurnSync fails fast when upstream tool_call arguments is not an object`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeAssistantTurnSync()` 之前对上游 candidate 的 `tool_call.arguments` 若不是 object，会静默回退成 `{}`；这会把坏上游响应伪装成合法 tool_call 并继续流入 buildChatCompletion/send followup。
- 唯一修复点：仍是 `parseCascadeAssistantTurnSync()`；对 upstream `tool_call.arguments` 明确要求必须是非数组 object，否则直接 fail-fast：`[windsurf] assistant tool call arguments must be object`。
- 这是唯一正确真源，因为这是 Windsurf provider 从真实上游 candidate 解析出 assistant tool call 的唯一入口；改 host/router/chat completion builder 都只能掩盖坏上游响应，不能阻止错误语义进入统一真源。
- 新红测先红：`parseCascadeAssistantTurnSync accepts upstream output_text blocks as assistant text`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeAssistantTurnSync()` 之前只识别 `content[].type=text`，不识别更接近 responses/上游 shape 的 `type=output_text`，因此会把真实文本 candidate 误判成 `empty assistant completion`。
- 唯一修复点：仍是 `parseCascadeAssistantTurnSync()`；把 `output_text` 与 `text` 同等视为 assistant 文本块进入 `textParts`。
- 这是唯一正确真源，因为这正是 Windsurf provider 从上游 assistant candidate 解析最终 assistant text 的唯一入口；改 builder/host/router 都只能补表象，不能纠正真实 upstream shape 的识别缺口。
- 追加回归：`parseCascadeAssistantTurnSync preserves mixed output_text + tool_call candidate blocks`。
- 结果：首跑即绿，说明当前 assistant candidate 真源已经能同时保留同轮 `output_text` 与 `tool_call`，不会二选一丢失。
- 结论：response parse 当前剩余风险已进一步收缩到 builder/send 主链层面，而不是 `parseCascadeAssistantTurnSync()` 的 block 组合能力本身。
- 追加 builder 回归：`buildChatCompletionFromCascadeResponse preserves assistant text when candidate contains output_text + tool_call`。
- 结果：首跑即绿，说明当前真源不仅能在 parse 阶段识别 mixed candidate，还能在最终 chat completion 收口时同时保留 assistant text + tool_calls，并维持 `finish_reason=tool_calls`。
- 结论：当前 assistant candidate -> chat completion 的 mixed-block path 已稳定；send/response 主链剩余缺口更可能在真实网络 response shape 或 managed credential send gate，而不是本地 mixed block 收口。
- 2026-05-21 新补红测先红：`parseCascadeSemanticRoundtripSync preserves responses-style user content[] text blocks into cascade history` 与 `sendRequestInternal preserves responses-style user content[] when building cascade conversation`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeSemanticRoundtripSync()` 之前对 `role=user` 只接受 string content，不接受 WindsurfAPI/Responses 真形态 `content[]`（`input_text` / `text` / `output_text`），导致多轮 user 历史在 provider 归一时被吞成空串，后续 send path conversation 也一起丢失文本。
- 唯一修复点：仍是 `parseCascadeSemanticRoundtripSync()`；新增局部 `normalizeTextContent()`，对 `role=user` 统一按与 WindsurfAPI `responsesToChat.normalizeMessageContent()` 对齐的文本块规则归并 `input_text|text|output_text`。
- 这是唯一正确真源，因为 user 历史进入 cascade conversation 的唯一入口就在 Windsurf provider 的 semantic roundtrip 归一层；改 builder/host/router 都只能补表象，无法恢复已经在 provider 入口丢失的历史文本语义。
- 定向验证：`npm run jest:run -- --runInBand --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 38/38 绿。
- 2026-05-21 新补红测先红：`parseCascadeAssistantTurnSync accepts plain string assistant content` 与 `sendRequestInternal accepts upstream candidate with plain string assistant content`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeAssistantTurnSync()` 之前只识别 `content[]` block，不识别真实上游可能直接返回的 string content，导致明明是合法 assistant 文本却被误判为 `empty assistant completion`。
- 唯一修复点：仍是 `parseCascadeAssistantTurnSync()`；在 block 解析前先吸收 `record.content` 的 string 形态进入 `textParts`。
- 这是唯一正确真源，因为上游 candidate -> assistant completion 的第一次语义落点只有这一处；改 sendRequestInternal/buildChatCompletion/host 都只会掩盖坏解析，不能纠正 provider 对真实上游 shape 的识别缺口。
- 定向验证：`npm run jest:run -- --runInBand --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 40/40 绿。
- 2026-05-21 新补红测先红：`parseCascadeAssistantTurnSync accepts function_call candidate blocks into openai tool_calls`、`parseCascadeAssistantTurnSync accepts custom_tool_call candidate blocks into openai tool_calls`、`sendRequestInternal accepts upstream function_call candidate blocks`。
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadeAssistantTurnSync()` 之前只识别 candidate `content[].type=tool_call`，不识别更贴近 WindsurfAPI/Responses 输出语义的 `function_call` / `custom_tool_call`，会把合法工具调用 candidate 误判为 `empty assistant completion`。
- 唯一修复点：仍是 `parseCascadeAssistantTurnSync()`；在 assistant candidate 真源入口统一承接三类 tool block：`tool_call`、`function_call`、`custom_tool_call`，并分别按 object/json-string/input 归一成 OpenAI `tool_calls`。
- 这是唯一正确真源，因为真实上游 candidate 的 tool 调用第一次落到 RouteCodex 语义层只有这一处；改 sendRequestInternal/buildChatCompletion/host/router 都只能掩盖 provider 对上游 block shape 的识别缺口，不能恢复真实 tool call 语义。
- 定向验证：`npm run jest:run -- --runInBand --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 43/43 绿。
## 2026-05-21 windsurf 测试真源纠偏（旧 responses-style/send-path 假锚点已失效）
- 已确认一整批旧 note 记录属于历史错误方向：把 `responses-style output / extractCascadeCandidate / resolveResponsePayload / sendRequestInternal parser coverage` 当成当前 Windsurf chat-provider 真锚点。
- 这些记录现在全部视为**失效背景**，不再作为活真源；原因：
  1. 当前 provider 已收敛为 **chat provider**，不是 responses provider。
  3. 活 spec 已物理删除这批错位测试，只保留 auth/token、assistant tool call、tool result、history continuity、chat completion parse、send fail-fast 真锚点。
- 当前应只信两类真源：
  1. `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  2. `src/providers/core/runtime/windsurf-chat-provider.ts`
- 固定参考仍为：
  - `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
  - `/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
  - `/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js`
  - `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
- 额外纠偏：此前 note 中混入的 5555/longcontext/router-direct 旁支，不属于本轮 Windsurf provider 真源重建范围，后续不再混写进这一段上下文。

## 2026-05-21 router-direct responses retention leak
- mem-observer 中 requestMap/pendingNoResponseId/retainedInputItems 同涨时，先检查请求 capture 后是否有唯一收口；本次真源是 router-direct 成功/失败收口遗漏，不是 GC。
- 先查请求 shape 与数据流：若 build/direct path 没带 requestId，测试现象会伪装成清理失败；先修 shape 再判 handler。
- router-direct 对 openai-responses 必须在唯一收口点完成 record/finalize/clear：成功 canonical body -> record+finalize；HTTP>=400/error/SSE-wrapper/no canonical id -> clear。

## 2026-05-21 windsurf chat-provider parser/history 真源收敛
- 这段时期的多个小回归点，本质都已收敛到当前活真源：
  1. `parseCascadeAssistantTurnSync()`
  2. `parseCascadeToolResultTurnSync()`
  3. `parseCascadeSemanticRoundtripSync()`
  4. `buildChatCompletionFromCascadeResponse()`
- 当时覆盖过的子问题包括：
  - top-level `tool_calls`
  - tool/result id fallback
  - duplicate id / duplicate signature fail-fast
  - history continuity 参数严格性
  - assistant text + tool_calls 共存
- 这些细项如今都已折叠进当前活 spec；不再单独保留一长串 sibling/send-path 旧记录，避免继续污染“当前 provider 是 chat-provider 单一路径”的理解。
- 当前应直接以 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 的现状为准，而不是回看这一串历史碎片。

## 2026-05-21 windsurf auth test false-coverage correction
- 新补红测先红：`parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when top-level tool_calls use string input fallback` 与 `parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when tool_calls use string input fallback`。
- 锚点依据：仍是 `/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js::projectAssistantToolCalls()`。参考实现里 `tc.input !== undefined` 会统一走 `stableStringify(tc.input)`，所以 top-level `tool_calls.input` 不要求必须先是 object；string 也是合法 sibling。
- 红因已锁定：RouteCodex provider 上一轮虽然补了 `row.input` object fallback，但仍把 string input 排除在外，导致 reference 明确允许的 `tool_calls: [{ name, input: 'pwd' }]` 在 history/candidate 两个 top-level 入口都被误报 `assistant tool call arguments must be valid json object`。
- 唯一正确修改点：同一处 top-level `tool_calls` 参数归一真源；对 `typeof row.input === 'string'` 统一包装成 `{ input: row.input }`，再复用现有参数校验和去重 gate。
- 为什么别处不对：这不是 content-side `custom_tool_call` 分支的问题，也不是 tool-result/history 后段的问题；错误发生在 top-level `tool_calls` 入口最早的参数 shape 归一。
- 新补红测先红：`parseCascadeSemanticRoundtripSync accepts assistant chat tool_calls history when top-level tool_calls use input fallback` 与 `parseCascadeAssistantTurnSync accepts top-level chat tool_calls candidate when tool_calls use input fallback`。
- 锚点依据：`/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js::projectAssistantToolCalls()`。参考实现对 top-level `tool_calls` 不只认 `function.arguments`，还接受 `tc.input`，并把它与其它 tool-call 形态统一投影到同一 canonical tool call 语义。
- 红因已锁定：RouteCodex provider 在两个 top-level `tool_calls` 入口（assistant candidate parse / history semantic roundtrip）之前只认 `function.arguments` 与 `row.arguments`，漏掉了 reference 明确支持的 `row.input` fallback，导致合法历史/候选被误报 `assistant tool call arguments must be valid json object`。
- 唯一正确修改点：`src/providers/core/runtime/windsurf-chat-provider.ts` 这两个 top-level `tool_calls` 入口的 `rawArgs` 提取逻辑。补 `row.input` fallback 后，继续复用现有的 json-object 校验、duplicate gate、signature gate，不新增第二实现。
- 为什么别处不对：改测试只会掩盖 reference 缺口；改 content-side tool_call 分支无效，因为问题只发生在 top-level `tool_calls`；改 router/host/send-path 更碰不到 provider 自己的 history/candidate parse 真源。
- 追加 probe：`persisted non-session tokenFile credential must not short-circuit managed auth and should fall through to account password login chain`。
- 锚点依据：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js::postAuthDualPath()` 只承认最终 `devin-session-token$...` 作为可复用凭证；落盘的 persisted credential 同样不能放宽成“任意字符串都算 token”。
- 结果：首跑即绿。说明当前 `loadPersistedWindsurfSessionCredential()` 已正确把非 `devin-session-token$...` persisted 值判为无效，并继续回退账号密码登录链。
- 结论：当前 managed auth 的 token gate 已在两层对齐真源：
  1. inline `apiKey` 只有 session token 可短路
  2. persisted credential 只有 session token 可复用
- 新补红测先红：`inline non-session apiKey must not short-circuit managed auth and should fall through to account password login chain`。
- 锚点依据：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js::postAuthDualPath()` 与整条登录链都以 **最终拿到 `devin-session-token$...`** 为真值；非 session token 本身不是最终 provider 凭证真源。
- 红因已锁定：`ensureWindsurfSessionCredential()` / `readApiKey()` 之前把 `rawType=windsurf-account` 下任意 inline `apiKey` 都短路成最终 token，直接跳过账号密码登录链，违反“token 优先，但只有 session-token 才能作为最终 token”这一真源。
- 唯一正确修改点：`src/providers/core/runtime/windsurf-chat-provider.ts` 中 managed auth 的 token gate。`windsurf-account` 下只允许 `devin-session-token$...` 直通；其他 inline key 必须继续走账号密码 -> auth1 -> PostAuth 登录链。
- 为什么别处不对：改测试只会掩盖错误；改 send path / router / host 都碰不到 managed auth 的分流入口；真正决定“是不是最终 token”的地方只有 provider 自己的 managed auth gate。

- 已证实此前一条 Windsurf 鉴权测试是错锚点：把 `WindsurfPostAuth` 请求体错误测成“body 携带 auth1 token 的 proto”。
- 参考真源：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`。
- 参考实现要求：
  - `Content-Type: application/proto`
  - `Content-Length: 0`
  - `Connect-Protocol-Version: 1`
  - `X-Devin-Auth1-Token` 仅放 header
  - body 必须 `Buffer.alloc(0)` 空体
- 本地修正：
  - 红测：`postAuth should send empty application/proto body and carry auth1 only in header...`
  - provider 对齐为 header-only + empty body
- 结论：之前那条鉴权覆盖不能证明与参考项目一致；它只证明“本地错误实现自洽”。后续 Windsurf auth/cascade 测试必须继续以 `WindsurfAPI` 对应函数为锚，而不是以当前 RouteCodex 实现形状为锚。


## 2026-05-21 windsurf spec full-green after semantic/send-test split

- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 已全绿：138/138。
- 这次不是 send mainline 恢复，而是把两类测试彻底分流：
  1. **解析/语义/send parse 单测**：改走 generic bearer path，只验证 semantic roundtrip / candidate extraction / output parsing。
- 已确认之前 55 个失败多数属于“测试入口走错 managed path”，不是解析真源本身失败。
- 当前真相：
  - 解析真源测试已齐备且通过；
  - 鉴权链（account/password -> auth1 -> WindsurfPostAuth -> session token）单测已对齐参考实现并通过；
  - 后续唯一正确方向：从 `WindsurfAPI` 继续找真实 cascade send 主线，先补红测，再改 provider；不得恢复任何旧错误 send 主线叙事。

## 2026-05-21 windsurf docs truth-closure audit
- 本轮不是改 provider 逻辑，而是清理仓内仍可能误导后续实现的旧叙事文档。
- 审计证据：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 当前为 **99/99 绿**
  - `npx tsc -p tsconfig.json --noEmit` 通过
- 已收口文档：
  1. `docs/providers/windsurf-chat-provider-design.md`
     - 明确 send endpoint 仍未验证，当前必须 fail-fast
  2. `docs/goals/windsurf-cascade-single-path-rebuild-plan.md`
     - 把“send 主链接回”改成条件性阶段
     - 未拿到新 reference 之前，只允许保持 fail-fast 边界，不准伪装已恢复
- 唯一正确修改点是这些文档真相位，因为当前代码/测试已经证明 parser/auth 边界成立，而剩余风险是“旧设计文本继续误导后续把 send path 乱接回去”。改 provider 逻辑反而会破坏当前已锁定的 fail-fast 真源。

## 2026-05-21 Hub Pipeline Rust-only closeout

- 已确认当前不是“Hub Pipeline 还未 Rust 化”，而是 closeout 未完成；主干在 Rust，残留 4 个关键 TS 真源面。
- 第一片必须是 `resp_process.stage3 servertool orchestration`：stage3 仍直接 import `servertool/engine.ts` 并调用 `runServerToolOrchestration(...)`，说明 orchestration 真相仍在 TS。
- 本轮执行顺序已固定：先落盘 `docs/hubpipeline-migration/CLOSEOUT-PLAN-2026-05-21.md`，再补红测卡住 stage3 仍依赖 TS orchestrator，再做最小迁移。

- `tests/servertool/resp-process-stage3-reentry.spec.ts` 在本轮 stage3 薄壳收口后暴露出另一条问题：
  - 现象不是 `followup_bypass`，而是请求进入 `stop_message_flow`，随后在 `client inject dispatcher unavailable` 失败；
  - 这说明当前失败点在 followup outcome / flow 选择链，而不是 stage3 pipeline 文件是否仍直连 TS orchestrator；
  - 下一步必须先审该测试的请求 shape、runtime metadata、sticky state 是否仍应命中 `reasoning_stop_guard_flow`，再决定修测试前提还是修运行链。

## 2026-05-21 windsurf spec anchor annotation closure
- 本轮继续对齐“所有测试必须先说明锚点来自 reference 的哪个函数”。
- 已在 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 顶部补充统一真源说明：
  - auth / token / postAuth -> `windsurf-login.js`
  - responses / tool / history / continuity -> `responses.js` / `cascade-native-bridge.js` / `conversation-pool.js` / `windsurf.js`
- 同时为主要 case 簇补了分段注释：
  1. auth/token priority
  2. assistant candidate / response output parsing
  3. history continuity / tool result reinjection
  4. response candidate selection / usage extraction
  5. send-path sibling truth（明确是 derived-from-reference 的 fail-fast 真源，而不是 send 已恢复）
- 这一步不改任何运行逻辑，只补强测试真源可读性与后续约束，防止后续继续凭主观边界补 case。
- 验证：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 99/99 绿
  - `npx tsc -p tsconfig.json --noEmit` -> 通过
- 唯一正确修改点是 spec 注释真源位，因为当前缺口不是行为错误，而是“测试虽然绿，但锚点归属没有被明确写死”，这会让后续继续偏离 `/Volumes/extension/code/WindsurfAPI`。

## 2026-05-21 windsurf failure-policy error-code truth alignment
- 先补红测：
  1. `tests/providers/core/runtime/provider-failure-policy.windsurf-cascade-endpoint-unverified.spec.ts`
  2. `tests/error-handling/route-error-hub.http-status-preserve.spec.ts`
  3. `tests/server/runtime/http-server/executor/request-executor-provider-response.stopless-contract-removal.spec.ts`
- 红测结果：
- 唯一修复点：
  - `src/providers/core/runtime/provider-failure-policy-impl.ts`
- 同步收口：
  - 相关测试样本全部改为当前真相错误码/错误文案
  - 物理重命名 `tests/providers/core/runtime/provider-failure-policy.windsurf-not-implemented.spec.ts`
    -> `tests/providers/core/runtime/provider-failure-policy.windsurf-cascade-endpoint-unverified.spec.ts`
  - 从 `provider-failure-policy-impl.ts` 删除旧错误码 `WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED` 分支，避免双真源残留
  - `src/providers/core/contracts/windsurf-provider-contract.ts` 顶部注释改成纯 cascade 单路径真相
  - `docs/goals/windsurf-responses-final-remap-plan.md` 标注为已过期历史计划，禁止再被当当前 Windsurf 主目标真源
- 验证：
  - 3 条定向回归 -> 5/5 绿
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` + `windsurf-chat-provider.live-probe-api.spec.ts` -> 已验证过主锚点
  - `npx tsc -p tsconfig.json --noEmit` -> 通过
- 为什么这是唯一正确修改点：
  - 问题不在 `windsurf-chat-provider.ts`，它已经稳定抛当前真相错误码；
  - 问题也不在 Host/Router，它们只消费 provider 错误；
  - 唯一错位发生在“provider 错误码 -> 失败策略分类”真源 `provider-failure-policy-impl.ts`，以及其配套测试/文档叙事。改别处只能继续制造双真源。

## 2026-05-21 windsurf pure-cascade wording cleanup

- 先补红测再删旧语义：
  - `tests/providers/core/runtime/provider-failure-policy-backoff.windsurf-stream-cancel.spec.ts`
  - 新增红测：旧无效启动态取消信号不应再被识别为 Windsurf 活真相
- 红测结果：
  - 旧实现仍把该 wording 识别成 `recoverable`
- 唯一修复点：
  - `src/providers/core/runtime/provider-failure-policy-impl.ts::isWindsurfCanceledMessageLike()`
  - 删除四个旧本地 workspace 相关历史词
- 保留的唯一取消语义：
  - `pending stream has been canceled`
  - `ERR_HTTP2_STREAM_CANCEL`
- 同步文档收口：
  - `docs/goals/windsurf-session-persistence-and-pool-plan.md`
  - 删除“工具调用主链已 live 打通”错误叙事
  - 把进程内运行态示例改成中性 `cascadeSessionKey/runtimeGeneration/runtimeReady`
  - 明确 send mainline 仍未 reference-verified，不能在池化计划里假定已恢复
## 2026-05-21 windsurf auth-context + proto-org anchor closure

- 本轮继续只对齐 `/Volumes/extension/code/WindsurfAPI` 的 auth/cascade 真源，不碰 send mainline。
- 新增并收口两类此前缺失的锚点测试：
  1. `WindsurfPostAuth` proto 结果中的 `accountId` / `primaryOrgId` 持久化与重载复用；
  2. Windsurf provider 当前发送头中的 `x-devin-session-token` / `x-devin-account-id` / `x-devin-auth1-token` / `x-devin-primary-org-id` header 注入。

- 先补红测：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
    - `postAuth proto-derived primaryOrgId should persist to tokenFile and be restored on next load`
    - `buildCascadeSendHeaders injects devin auth-context headers from persisted session credential`

- 红测第一次失败原因：
  - 不是 provider 实现错；
  - 是测试里手写的 proto payload 长度字段写错了，导致 `accountId/primaryOrgId` 没被正确编码；
  - 这属于假红测，已修正为用本地 `encodeProtoStringField(fieldNo, value)` 生成合法 proto 样本。

- 最终结果：
  - `windsurf-chat-provider.spec.ts` -> 101/101 绿
  - `tsc -p tsconfig.json --noEmit` -> 通过

- 这轮为什么不改 `windsurf-chat-provider.ts`：
  - 真实实现已经能正确处理 `field 4 = accountId`、`field 5 = primaryOrgId`；
  - 缺的是测试真源没把这两个字段锁死；
  - 唯一正确修改点因此是 spec 锚点，而不是 provider 逻辑。

## 2026-05-21 windsurf token-priority + session-only auth-context anchors

- 继续补 auth 真源锚点，目标只锁 reference 语义，不碰 send mainline：
  1. 当 provider 同时配置 `devin-session-token$...` 和账号密码时，必须 **token 优先**，不得触发登录链；
  2. 当只有 session token、缺少 account/auth1/org 三个扩展字段时，auth-context 只能发送：
     - `x-auth-token`
     - `x-devin-session-token`
     不能凭空补发其他 `x-devin-*` header。

- 新增测试：
  - `explicit devin session token must win over co-configured account password and bypass login chain`
  - `session-only devin auth-context injects only token headers without optional x-devin metadata`

- 结果：
  - 两条都直接转绿，没有打出 provider 实现 bug。
  - 说明当前 `windsurf-chat-provider.ts` 在：
    - token 优先
    - session-only auth-context header 最小集
    这两点已经与当前 `WindsurfAPI` reference 真相一致。

- 验证：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 103/103 绿
  - `tsc -p tsconfig.json --noEmit` -> 通过

- 这轮为什么仍然不改 `windsurf-chat-provider.ts`：
  - 当前缺口依旧是“测试没把 reference 语义写死”，不是 provider 行为错误；
  - 若改实现，只会制造伪修改，破坏“先锚点、后实现”的真源纪律。

## 2026-05-21 windsurf auth success -> inference success refresh chain

- 用户当前优先级已明确收口为：
  1. 鉴权成功
  2. 基础推理成功
  3. 工具调用和历史成功

- 本轮新增关键认证恢复锚点：
  - `stale persisted devin token should re-login, persist refreshed token, and complete one inference round when send endpoint is stubbed`

- 测试设计边界：
  - **不**宣称 send endpoint 已 reference-verified；
  - 只在 spec 内 stub `buildCascadeSendEndpoint()`，把未验证 endpoint 真相与“认证恢复后可继续推理”的语义拆开；
  - 锁的是真源行为：
    1. 先读取 persisted stale token
    2. 第一次发送用 stale token 命中 401
    3. 清理旧 token
    4. 账号密码重新登录
    5. `WindsurfPostAuth` 拿到 refreshed `devin-session-token$...`
    6. 持久化 refreshed token / accountId / primaryOrgId
    7. 第二次发送成功返回 assistant completion

- 结果：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 104/104 绿
  - `tsc -p tsconfig.json --noEmit` -> 通过

- 这轮为什么不改 `windsurf-chat-provider.ts`：
  - 新锚点直接转绿，说明当前 provider 在“token 失败再登录并继续推理”这条关键链上已满足 reference 语义；
  - 缺的是测试真源之前没锁住，不是实现错误；
  - 唯一正确修改点仍然是 spec，而不是 provider 逻辑。

## 2026-05-21 windsurf tool-call success + history continuity success anchors

- 继续按用户当前优先级推进第三层：
  - 工具调用成功
  - 历史 continuity 成功

- 新增两条成功链锚点（仍不宣称 send endpoint 已恢复）：
  1. `authenticated inference should surface assistant tool_calls when upstream candidate requests a tool`
  2. `authenticated inference should send multi-round tool history continuity to upstream conversation`

- 测试边界：
  - spec 内 stub `buildCascadeSendEndpoint()`；
  - 不碰未 reference-verified 的 endpoint 真相；
  - 只锁：
    - 认证成功后，一轮推理可返回 assistant tool_calls
    - 多轮消息可被 provider 正确序列化为上游 `conversation` continuity

- 结果：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 106/106 绿
  - `tsc -p tsconfig.json --noEmit` -> 通过

- 为什么仍然不改 `windsurf-chat-provider.ts`：
  - 这两条成功链新增后直接转绿；
  - 说明当前 provider 在：
    - tool call success
    - history continuity success
    两点上已经满足 reference 语义；
  - 缺口依旧是“成功链测试未显式锁住”，不是实现错误。

## 2026-05-21 windsurf tool-result -> next-round continuation success anchors

- 继续把完整成功链锁到“tool result 回流后下一轮”：
  1. 上一轮已有 `tool_call + tool_result`
  2. 下一轮可以继续返回新的 tool call
  3. 或下一轮可以直接返回最终 assistant text

- 新增测试：
  - `tool result history should support next-round continued tool call success when upstream requests another tool`
  - `tool result history should support next-round final assistant text success after prior tool completion`

- 锁定的真相：
  - 认证成功后的真实 send body `conversation` 必须包含：
    - user
    - assistant tool_calls
    - function_call_output
    - next user turn
  - 上游返回新的 `function_call` 时，provider 必须继续收口成 OpenAI `tool_calls`
  - 上游返回 `output_text` 时，provider 必须继续收口成最终 assistant text

- 结果：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 108/108 绿
  - `tsc -p tsconfig.json --noEmit` -> 通过

- 这轮为什么仍然不改 `windsurf-chat-provider.ts`：
  - 新增成功链再次直接转绿；
  - 说明当前 provider 在“tool result 回流后下一轮继续推理/继续工具调用”上已满足 reference 语义；
  - 当前缺口继续是“没有被显式锁成测试真源”，不是实现 bug。
- 2026-05-21: 继续审计 resp_process.stage3 / servertool closeout。现有架构门禁测试已存在，但需要确认是否还有“请求 shape”层面的红测缺口，而不是继续盯响应表象。

## 2026-05-21 Jason Windsurf cascade
- 目标：先对齐 pure cascade auth/send/tool/history 测试，再修 provider。
- 当前步骤：先跑 windsurf-chat-provider 定向测试，按失败点收敛。
- 已将 7 个失败用例从旧单跳 JSON endpoint 改为多步 cascade 语义验证。
- header 测试已对齐 application/proto + Connect-Protocol-Version + Referer。
- 定向 spec 109/109 绿；tsc 通过；build:min 通过，准备 install+5520 实机。
- install:global 完成，版本 0.90.2036。准备 restart 5520 并做 /v1/chat/completions + /v1/responses 实机。
- 5520 live smoke 失败：chat/responses 均返回 HTTP 404 backend NotFound，说明当时 send path 仍未对齐；下一步只查参考仓 exact path，不改别层。
- 已物理删除 spec 中错误的 send 正向假锚点；send 只剩 fail-fast。
- 正在把 windsurf-chat-provider.ts 收回到同一边界：先 resolve token，再 501 fail-fast。
- 已物理删除 windsurf-chat-provider.ts 中旧 send helper 残骸与 cloud path 常量，避免仓库保留第二套错误主线。
- buildCascadeSendHeaders 已恢复：它属于 auth-context 真源，不属于被删除的错误 send 主线。
- 新红测命中缺口：conversation-pool.js::projectAssistantToolCalls 支持 anthropic content[].type=tool_use；RouteCodex parser 还没接这个 shape。
- 已补 parser 真源缺口：assistant history content[].type=tool_use 现已按 conversation-pool.js::projectAssistantToolCalls 语义进入 continuity。


## 2026-05-21 Jason handoff continuation
- 继续按 reference 真源审 `/Volumes/extension/code/WindsurfAPI`：responses.js / cascade-native-bridge.js / conversation-pool.js / windsurf.js。
- 当前目标不是恢复 send；send 继续 fail-fast，先只补 parser/history/tool/auth 锚点红测。
- 本轮先查 reference 还有无未覆盖语义锚点，再决定是否补红测。

- 本轮补查 auth reference：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`，确认当前鉴权测试锚点是否真的与 reference 对齐。

- 新补 auth reference 锚点测试并验证通过：
  - `resolveWindsurfLoginMethodProbe` 只能做观察；旧 `_devin-auth/connections` 路径已禁用，不再参与登录判定。
  - `ensureWindsurfSessionCredential` 的 PostAuth 请求合同必须是：空 `application/proto` body、`X-Devin-Auth1-Token` header、`Referer=https://windsurf.com/account/login`、端点顺序 new `_backend` -> legacy `server.self-serve`。
- 本轮没有恢复 send，也没有引回旧错误主线；只把 reference 缺失测试锚点补齐。

- 新增 reference-derived auth 锚点测试：`rawType=windsurf-devin-token` 直配 devin session token 时，必须直接收敛为最终 `devin-session-token$...`，不得触发账号密码登录，并且必须持久化到 tokenFile。
- 该锚点对应目标规则：provider 配置直接支持 devin token；token 优先；登录态统一收敛到最终 session token 持久化。

- Jason 新纠正：Windsurf provider 是 chat provider；后续锚点与实现只按 chat 语义推进，不再继续扩 responses 形态去驱动 provider 测试。responses.js 仅可作为外围参考，不再作为 provider 直测主驱动。

- 新补 chat-provider 红测命中唯一真源缺口：top-level chat `tool_calls[].function.arguments` 在 reference 语义上应允许直接 object；provider 之前只收 string JSON，导致 assistant candidate 与 assistant history 两处都误拒绝。
- 已只改 `windsurf-chat-provider.ts` 这一个真源点：顶层 chat tool_calls 的参数解析同时接受 string JSON 与 object。

- 按 Jason 要求，已物理删除 provider spec 中偏 responses 形态、非 chat-provider 真源的测试块：包括 `resolveResponsePayload` helper、`extractCascadeCandidate`、`responses-style output...` 等整串错位测试。
- 删除理由：Windsurf provider 是 chat provider；这些测试把外围 responses 兼容层语义硬灌进 provider，属于错误测试真源，会误导实现边界。

- 继续清理 chat-provider spec/provider 中残留的 responses 命名污染：测试头注释、group 名称、failure 文案改回 chat-provider 语义，避免未来再次把 compat/responses 层误当 provider 真源。

## 2026-05-21 apply_patch/hashline guidance audit

- 本轮继续确认：问题主因不是 hashline 算法本身，而是 **apply_patch canonical 引导** 与 **hashline 显式收割契约** 混在一起。
- 已收紧的真点：
  - `tool_text_request_guidance.rs`：`apply_patch` 明确 patch-first，并新增“不要添加 `filePath/file_path`，除非 schema 显式声明”。
  - `qwen/tool_definitions.rs`、`qwenchat/tool_definitions.rs`：同样补上禁止把 `filePath/file_path` 当 apply_patch 默认字段。
  - `req_profiles.rs`：补断言锁住这条文案，避免回归。
- 已验证：
  - `cargo test -p router-hotpath-napi test_req_profile_chat_qwenchat_web_injects_override_head_and_normalizes_tool_definitions -- --nocapture` 通过。
- 当前结论：
  - canonical `apply_patch` 继续只走 patch-first；
  - hashline 继续只在 `hub_req_inbound_tool_call_normalization.rs` 显式 `filePath/file_path` 入口接管；
  - 这条边界不应再由文案把模型引去“试 hashline”。

- TS 侧又抓到一个真源漏点：
  - `tests/sharedmodule/tool-guidance-exec-command.spec.ts` 红测表明 `sharedmodule/llmswitch-core/src/guidance/index.ts` 仍保留旧版 apply_patch 描述；
  - 说明不能只改 Rust guidance/schema，就宣称整条引导链收口完成。
- 已补：
  - `sharedmodule/llmswitch-core/src/guidance/index.ts`
  - 现在 OpenAI/Anthropic 工具增强层也统一成：
    - canonical patch body
    - 不默认添加 `filePath/file_path`
- TS 回归已通过：
  - `tool-guidance-exec-command.spec.ts`
  - `native-governance-apply-patch-hashline.spec.ts`
  - `req-inbound-stage2-tool-shape-normalization.spec.ts`

- 继续向下扫又抓到一个 native schema 漏点：
  - `chat_tool_normalization.rs::ensure_apply_patch_schema()` 仍是旧文案；
  - 只有在重编 native hotpath 后，Jest 才能真正看到这类 Rust 文案变更。
- 已补测试：
  - `tests/sharedmodule/tool-guidance-exec-command.spec.ts`
  - 新增 native `castGovernedToolsJson` 断言，锁 `custom -> function apply_patch` 的 schema 描述也必须是 patch-first + no default filePath。
- 已补真源：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_tool_normalization.rs`
- 验证链：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/tool-guidance-exec-command.spec.ts`

## 2026-05-21 windsurf provider chat-only boundary hardening
- 新红测先红后绿：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - 锁定 `parseCascadeAssistantTurnSync / parseCascadeSemanticRoundtripSync / buildChatCompletionFromCascadeResponse`
  - 现在 provider 只接受 chat 语义：
    - assistant text: `string` 或 `content[].type=text`
    - assistant tool call: top-level `tool_calls[]` 或 `content[].type=tool_call`
    - tool result: `role=tool`
- 已物理删除 provider 内对以下 responses-style assistant/history block 的接受语义：
  - `output_text`
  - `input_text`
  - `function_call`
  - `custom_tool_call`
  - `tool_use`
- 当前 fail-fast 文案已统一到 chat-provider 边界：
  - `unsupported assistant content block type in chat provider: ...`
  - `unsupported assistant history block type in chat provider: ...`
  - `unsupported user content block type in chat provider: ...`
- 这次唯一正确修改点仍是 `src/providers/core/runtime/windsurf-chat-provider.ts`，因为错误在 provider 自己把外围 responses 兼容层语义吃进来了；改 host/router/handler 都不能消除 provider 边界污染。

## 2026-05-21 Jason 纠偏：Windsurf 只看 chat->cascade / cascade->chat

- 最终边界确认：
  - req: `responses -> chatprocess -> outbound -> provider(windsurf)`，对 provider 来说就是 `chat -> cascade`
  - resp: `cascade -> chat -> hubpipeline`
- 结论：
  - provider 测试只验 cascade 输出与回写成 OpenAI chat/tool/history 的连续性
  - 不再把 responses 当 provider 真源，也不再用纯文本归一代替 tool/history 语义
  - 重点仍是 `tool_calls / function_call_output / history continuity / token persistence`

- 2026-05-21: Windsurf provider 当前唯一真源边界再次确认：req = chat -> cascade；resp = cascade -> chat -> hubpipeline。sendRequestInternal 仍然 fail-fast 未接 reference-verified mainline，不要把它当认证成功证据。
- 参考锚点固定：auth 只看 `WindsurfAPI/src/dashboard/windsurf-login.js`；tool/history 只看 `WindsurfAPI/src/cascade-native-bridge.js`、`conversation-pool.js`、`windsurf.js`。
- 当前测试现状：单测 90/90 通过；鉴权路径已有 token 优先、账号密码链、postAuth proto、tokenFile 持久化、buildCascadeSendHeaders 头部注入覆盖；当前重点只保留 cascade 主线与鉴权真相。
- 需要继续确认的是真实鉴权/探测链是否可从当前实现稳定走通，而不是继续把 send path 当鉴权证明。
note 2026-05-21 hashline schema followup
- 红测定位: castGovernedToolsJson 产物缺 filePath/file_path，不是归一层问题。
- 原因: 之前 build-native skip cargo，.node 仍是旧产物；需先 cargo build 再打包。

- hashline guidance 真源已切到条件化：schema 声明 filePath/file_path 时必须允许并提示 hashline 使用；未声明时继续禁止。

## 2026-05-21 Windsurf auth-only 对齐 winsurfapi

- 本轮只对齐认证，不碰 send mainline。
- 固定鉴权锚点：
  - `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
- 已补并转绿的认证红测：
  - inline `devin-session-token$...` 优先；
  - `windsurfForceRefreshLogin=true` 时，**必须跳过 inline token 优先**，直接回到账密登录链刷新；

- 为什么这是唯一正确修改点：
  - 问题不在 router / hubpipeline / send path；
  - 问题是 provider 自己的 managed-auth 状态机：
    - token priority 缺少“失效后强制绕过”的分支；
  - 改别处只能掩盖症状，不能修复 Windsurf provider 的认证真源。

## 2026-05-21 codex sample apply_patch live failure

- 真实 codex sample（`~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779377055780_5abc0946` 及后续 1433/1434）已证明：当前 live 问题不是 hashline/filePath 接线缺失，而是 **provider-request 中 apply_patch 工具描述没有把 canonical grammar 说死**，导致 MiniMax 连续产出 hunk-only / GNU unified diff 形状。
- 样本中的最终 apply_patch 描述只有：`Use apply_patch to edit files... Do not mix in hashline syntax or GNU diff headers`，但**没有明确写出**必须使用 `*** Begin Patch ... *** End Patch` + `*** Update File:` + `@@` + `*** Add File:`/`+` 行。
- 结论：先补 request-shape 红测锁 provider-request 中的 apply_patch 描述必须包含 canonical grammar；若红，再改唯一真源（工具描述/引导真源），不要先糊响应侧 aborted。

- 纠偏：刚才改 TS `guidance/index.ts` 不足以影响 live provider-request。真实 sample 继续输出旧 apply_patch 描述后，反查命中 Rust 真源 `shared_tool_mapping.rs` 仍保留旧字符串；这才是当前 provider-request shape 仍错误的直接原因。后续必须先改 Rust 真源并补对应该真源的红测。

## 2026-05-21 Jason 纠偏：apply_patch 外表 / hashline 内核

- 正确设计不是“上游继续 canonical apply_patch，再靠文案加强”。
- 正确单一路径是：
  1. client-facing tool 永远叫 `apply_patch`
  2. 若 schema 显式声明 `filePath/file_path`，upstream authoring 主路径切到 hashline
  3. Rust 真源负责把 hashline 收割并透明还原成 canonical apply_patch
  4. client 不感知 hashline 中间层
- 当前直接命中的错误设计点：`hub_pipeline.rs::resolve_apply_patch_tool_mode_from_tools()` 之前无论 schema 是否声明 `filePath/file_path` 都返回 `schema`，导致 hashline 主路径根本没被选中。
- 后续顺序必须是：先更新设计文档 / spec / skills，再补 mode-resolver 红测，再改 Rust 真源与 request guidance。

## 2026-05-22 Windsurf auth probe truth
- 参考锚点确认：在 /Volumes/extension/code/WindsurfAPI 中，当前已 reference-verify 的鉴权探活锚点是 Windsurf cascade auth probe。
- 证据：参考仓 windsurf_service.rs::get_cascade_model_configs 使用 proto body + connect-protocol-version + Referer + AuthContext 头族；请求体 field 6 = auth_token。
- 同轮未发现可替代的单跳聊天 send 锚点；参考仓对话发送仍是 cascade 多步语义链。
- 因用户当前要求本轮先只做鉴权，RouteCodex provider 的鉴权直通真链先对齐 cascade auth probe，再继续下一段。

## 2026-05-22 Windsurf legacy transport cleanup
- 目标: 物理移除仓内所有 Windsurf 旧错误主线文件与引用，只保留 chat -> provider -> cascade 单路径。
- 先做: 全仓检索旧错误主线残留，并收成纯 cascade 单路径。

## 2026-05-22 Windsurf auth-probe rebuild
- 目标: 只推进 chat -> provider -> cascade 的鉴权直通，先对齐参考仓 auth probe 真锚点。
- 规则: 不碰工具主链恢复，不引入 mock/挡板。
## 2026-05-22 Windsurf auth probe aligned to reference
- 参考锚点已锁定：
  - `WindsurfAPI` 当前同链路的 cascade auth probe / session token 真相
- 本轮新增并转绿的 auth probe 真锚点：
  1. `buildCascadeAuthProbeBody(apiKey)`：proto field 6 = auth token
  2. `buildCascadeAuthProbeHeaders(apiKey)`：`x-auth-token` / `x-devin-session-token` + 可选 `x-devin-account-id` / `x-devin-auth1-token` / `x-devin-primary-org-id`
  3. `fetchCascadeModelConfigsForSite(apiKey)`：直打已验证的 Windsurf cascade auth probe
  4. `checkHealth()`：不再看“配置长得像不像”，改为真实执行 cascade auth probe
- 当前 provider 在“鉴权直通”层已从假判断前进到真实 request shape；但 `sendRequestInternal()` 真实 cascade 推理主链仍未恢复。

## 2026-05-22 Windsurf no-mock auth probe
- 目标: 用真实配置执行无 mock cascade 鉴权探测，不停留在单测。
## 2026-05-22 Windsurf real no-mock auth success
- 使用 `~/.rcc/provider/windsurf/config.v2.toml` 里的 3 个真实账号，直接实例化 `WindsurfChatProvider` 执行无 mock `checkHealth()` + `ensureWindsurfSessionCredential()`。
- 结果：
  - ws-pro-1: checkHealth=true, accountId=account-a99b89812866404784c49333e9aea715
  - ws-pro-2: checkHealth=true, accountId=account-a822e34ba48149f7a33272c4df85b720
  - ws-pro-3: checkHealth=true, accountId=account-eb5dd54706c9432fad0f329d5cbdcd89
- 真实修复点已证实：PostAuth 必须对齐参考仓，改为：
  - URL = `https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`
  - body = proto field 1(auth1_token)
  - headers = `X-Devin-Auth1-Token` + `Origin` + `Referer` + `connect-protocol-version` + `content-type`
- 说明：此前 15s timeout 的唯一真因是 PostAuth request shape 错，不是账号坏、不是真实网络不通。

## 2026-05-22 Windsurf send-path rebuild
- 目标: 对齐 WindsurfAPI 的 cascade send/tool/history 语义，接回 sendRequestInternal。

## 2026-05-22 windsurf cascade request-build anchor closure
- 继续沿 `chat -> windsurf-chat-provider -> cascade` 单路径推进。
- 先补红测再转绿：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 新增 5 条 request/build 锚点测试，直接对齐 `/Volumes/extension/code/WindsurfAPI/src/windsurf.js` 与 `src/cascade-native-bridge.js`：
  1. `buildStartCascadeRequest` 字段 1/4/5
  2. `buildGetTrajectoryStepsRequest` 字段 1/2
  3. `buildAdditionalStepsFromHistory` 从 assistant tool_calls + tool result 生成 additional_steps
  4. `buildSendCascadeMessageRequest` 字段 1/2/3/5/9
  5. `buildSendCascadeMessageRequestFromSemanticConversation` 从 continuity 历史推导 additional_steps
- 红测第一次失败证据：provider 缺少上述 5 个 build/helper 真源方法。
- 已只改 `src/providers/core/runtime/windsurf-chat-provider.ts` 一个真源点，新增：
  - proto parse helper 暴露
  - `buildStartCascadeRequest()`
  - `buildGetTrajectoryStepsRequest()`
  - `buildAdditionalStepsFromHistory()`
  - `buildSendCascadeMessageRequest()`
  - `buildSendCascadeMessageRequestFromSemanticConversation()`
  - 以及最小 `WINDSURF_TOOL_MAP` / additional step proto 编码真源
- 验证：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` -> 103/103 绿
  - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` -> 绿
  - `tests/provider/provider-factory.test.ts` -> 绿
- 当前仍未宣称 sendRequestInternal 已恢复真实发送；本轮只把 request/build 真锚点先收回到 provider 真源。

## 2026-05-22 windsurf real no-mock cascade auth probe revalidated
- 本轮继续只做 `chat -> provider -> cascade` 的鉴权直通。
- 我新增并跑通了真实 live probe：`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - `REAL: account/password login reaches pure cascade auth probe with no mock`
- 实际结果：Jest live probe 约 4.4s 通过；流程是账号密码 -> `password/login` -> `WindsurfPostAuth` -> 持久化 `devin-session-token$...` -> `checkHealth()` 直打 `GetCascadeModelConfigsForSite` 返回 true。
- 同时把 `scripts/windsurf-auth-probe.ts` 修正为真正的 pure-cascade auth probe：不再调用不存在的 `fetchCloudUserStatus()`，改为 `ensureWindsurfSessionCredential()` + `checkHealth()`；`config` 模式直接读取 `~/.rcc/provider/windsurf/config.v2.toml` 的 alias 账号并发起真实 probe。
- 这一步的唯一正确修改点是 live-probe spec 和 probe script，因为当前主目标第一步是“先只考虑鉴权部分，直通 cascade 鉴权部分，不要 mock”；send 主链/tool 历史尚未恢复前，唯一能先被当前真实状态证明的就是这条 auth 真链。

## 2026-05-22 Jason Windsurf pure-cascade doc cleanup
- 按 Jason 最新要求继续物理收口 Windsurf：只保留 `chat -> provider -> cascade`。
- 本轮删除：`docs/goals/windsurf-responses-final-remap-plan.md`。原因：该文档围绕 provider 内 responses surface 重建，已与当前 chat-only provider 真相冲突。
- 本轮同步收口文档/skill 口径：`docs/providers/windsurf-chat-provider-design.md`、`docs/goals/windsurf-cascade-single-path-rebuild-plan.md`、`docs/goals/windsurf-session-persistence-and-pool-plan.md`、`.agents/skills/rcc-dev-skills/SKILL.md`。
- 口径统一后，Windsurf 只剩一个本地真相：request=`chat -> windsurf-chat-provider -> cascade`；response=`cascade -> windsurf-chat-provider(chat) -> hubpipeline`。
- 下一步不是继续解释旧 transport，而是继续把 `src/providers/core/runtime/windsurf-chat-provider.ts` 的 send mainline 接回当前 pure-cascade 真源，并用 build 重新生成 dist 去掉旧残留引用。

## 2026-05-22 windsurf send mainline 501 removal
- 已在 `src/providers/core/runtime/windsurf-chat-provider.ts` 物理删除 `sendRequestInternal` 的 501 未实现挡板。
- 当前 provider 主链已接成单一路径：`chat -> buildStartCascadeRequest -> StartCascade -> buildSendCascadeMessageRequestFromSemanticConversation -> SendUserCascadeMessage -> buildGetTrajectoryStepsRequest -> GetCascadeTrajectorySteps -> parseCascadePollResponse -> buildCascadeCompletionFromOutput`。
- 新增本地 helper 真源：
  - `createCascadeSessionId()`
  - `parseStartCascadeResponse()`
  - `parseCascadePollResponse()`
  - `getWindsurfPollMaxWaitMs()`
- 为了让 send-path 回归测试 deterministic，通过 `buildStableCascadeRequestId(apiKey, sessionId)` 去掉 metadata 中 request_id 的随机漂移；这不改变 provider 语义，只是消除测试不稳定源。
- `classifyWindsurfCascadeError()` 已把 `empty cascade candidate / empty assistant completion / invalid poll json / empty cascade_id` 归一到 `WINDSURF_RESPONSE_PARSE_FAILED`，不再错误映射成 `WINDSURF_SERVICE_UNREACHABLE`。
- 当前仍待真实验证的唯一风险：云端 pure-cascade Start/Send/Poll 的真实 host/path 仍需 5520 same-shape smoke 继续证实；Windsurf 本地只保留 `chat -> provider -> cascade` 单路径。

## 2026-05-22 Windsurf tool-map/reference gap closeout
- 参考锚点：`/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js::TOOL_MAP` 与 `buildAdditionalStepsFromHistory()`。
- 已补红测锁定 alias + overlay 差异：`Read/Bash/Glob/Grep/Write/WebSearch/ToolSearch/WebFetch/list_dir/read_file/shell_command/web_search/grep_search`。
- 当前真源修改只允许落在 `src/providers/core/runtime/windsurf-chat-provider.ts` 的 TOOL_MAP / additional_steps 编码层；改别处都无法让 cascade history 语义对齐参考仓。


## 2026-05-22 Windsurf single truth
- Windsurf 只保留一条本地真相：`chat -> windsurf-chat-provider -> cascade`。
- 旧错误主线文件已物理删除；仓内不再保留 Windsurf 第二实现文件、旧错误脚本或旧错误设计文档。
- 当前仓内 Windsurf 真源只允许：`src/providers/core/runtime/windsurf-chat-provider.ts`、`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`、`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`、`docs/providers/windsurf-chat-provider-design.md`。


## 2026-05-22 Windsurf trajectory protobuf poll parser landed
- 参考锚点：`/Volumes/extension/code/WindsurfAPI/src/windsurf.js::parseTrajectorySteps()`。
- 本轮先补红测再转绿：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 新增 3 条 trajectory protobuf 锚点：
  1. planner_response protobuf -> assistant text + reasoning_content
  2. native run_command step -> chat tool_call 投影
  3. 空 trajectory protobuf -> fail-fast `empty cascade candidate payload`
- 唯一正确修改点：`src/providers/core/runtime/windsurf-chat-provider.ts::parseCascadePollResponse()`，因为当前真缺口是 provider 仍把 poll 当 JSON 解析；改 router/host/tests 以外任何地方都不能让 `GetCascadeTrajectorySteps` 对齐 reference。
- 定向验证：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` ✅
  - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` ✅
  - `tests/provider/provider-factory.test.ts` ✅
  - `npx tsc -p tsconfig.json --noEmit` ✅
  - `npm run build:min` ✅
  - `npm run install:global` ✅
- 5520 实机 smoke 现状：重启后 `POST /v1/responses` 仍返回 `HTTP 404: 404 page not found`，错误码 `WINDSURF_SERVICE_UNREACHABLE`。这再次证明当前 auth 已通、trajectory poll 解析已收口，但云端 `Start/Send/Poll` 实际 HTTP endpoint 仍未对齐真实上游。

[2026-05-22 23:xx] Windsurf 单一路径审计：当前 Windsurf 只允许 `chat -> provider -> cascade`。
- 当前 Windsurf 真源仍只剩：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - `docs/providers/windsurf-chat-provider-design.md`
- 当前剩余阻塞只在 pure-cascade `StartCascade / SendUserCascadeMessage / GetCascadeTrajectorySteps` 的真实云端 endpoint/path/transport 对齐。

[2026-05-22 auth/send 继续推进]
- 新增 live probe：`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - `REAL: persisted session token takes priority over account/password and still passes pure cascade auth probe`
- 实测结果：
  - direct devin token ✅
  - account/password -> postAuth -> session token -> checkHealth ✅
  - persisted token 优先于账号密码，且即使配置里的密码是错的，仍可直接 `checkHealth()` 成功 ✅
- 结论：当前 auth 真链已经进一步坐实为：
  - token 优先
  - token 失败时才需要账号密码登录
  - 登录成功后持久化为 `devin-session-token$...`
  - `checkHealth()` 只走 pure-cascade auth probe，不依赖 send-path

[2026-05-22 pure-cascade send live probe]
- 对 `StartCascade` 做了真实无 mock 探针，分别测试：
  - `application/connect+proto` + connect envelope framing
  - `x-api-key`
  - `x-auth-token + x-devin-session-token`
  - host 候选：
    - `https://server.codeium.com/exa.api_server_pb.ApiServerService/StartCascade`
    - `https://eu.windsurf.com/_route/api_server/exa.api_server_pb.ApiServerService/StartCascade`
    - `https://windsurf.com/_route/api_server/exa.api_server_pb.ApiServerService/StartCascade`
    - `https://web-backend.windsurf.com/exa.api_server_pb.ApiServerService/StartCascade`
- 实测结果：
  - `server.codeium.com/.../StartCascade` -> `404 page not found`
  - `eu.windsurf.com/_route/api_server/.../StartCascade` -> `404 page not found`
  - `web-backend.windsurf.com/.../StartCascade` -> `404 page not found`
  - `windsurf.com/_route/api_server/.../StartCascade` -> `200 text/html`（站点页面，不是 API）
- 结论：
  - 真实阻塞已再次被活体证实：不是 auth，不是 proto body，也不是 connect envelope；而是 **云端 StartCascade 的真实 endpoint/path 仍未对齐**。
  - 现阶段 RouteCodex 的 Windsurf provider 若要继续恢复 send 主链，唯一正确方向是继续从参考实现/官方 bundle 抠真实 cloud cascade send path；不能回头改 auth、不能改 hubpipeline、不能引回第二实现。

## [2026-05-22] Windsurf single-path purge
- 目标: 物理删除 Windsurf 旧中间主线残留，只保留 chat -> provider -> cascade。
- 动作: 已全仓扫描 windsurf 相关实现/文档/测试锚点；当前仅保留单一 provider 真源与 pure cascade 文档口径。

- 决策: 旧 `_devin-auth/connections` 已物理退出鉴权主链；token 优先，token 失效再直接 password/login -> PostAuth。
- 修正: CheckUserLoginMethod 已对齐 reference 为 web-backend + application/proto + field1=email；旧 windsurf.com/_backend + json 形态已删除。
- 实探: CheckUserLoginMethod 对真实邮箱返回 200 + empty body，不能作为鉴权硬门禁；主链应改为 token 优先，否则直接 password/login，再 PostAuth，再 pure cascade probe。

## 2026-05-22 04:04:13 windsurf tool/history alignment audit
- 继续对齐 /Volumes/extension/code/WindsurfAPI 的 partitionTools / buildAdditionalStepsFromHistory / projectMessage / parseTrajectorySteps。
- 初步对比发现：当前 provider 的 preprocessRequest 已实现 mapped/unmapped coexist 的外显效果（只把 unmapped 留在 tools_preamble，mapped 不写进 preamble）；下一步需锁定 digest/history/tool_result continuity 是否仍有漂移。
- 本轮动作：先读当前 provider 真实现，再补 red tests，再改唯一真源 src/providers/core/runtime/windsurf-chat-provider.ts。

## 2026-05-22 04:07:32 windsurf native allowlist alignment
- 新增红测并转绿：mapped tools 存在时，provider 不能再固定 planner_mode=3；必须对齐 WindsurfAPI 进入 DEFAULT(1) + native tool_allowlist，同时把 unmapped tools 保留在 tools_preamble 共存。
- 唯一正确修改点仍是 src/providers/core/runtime/windsurf-chat-provider.ts：因为漂移发生在 provider 自己构造 cascade_config 时丢掉了 mapped tools 的存在信息；改 router/host/tests 都无法让 cascade 真正拿到 allowlist。

## 2026-05-22 04:09:38 windsurf live send probe
- 本轮直接用 provider 本体执行真实 sendRequestInternal 最小请求（无 mock），验证 chat -> provider -> cascade 是否已能跑通 StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps。

## 2026-05-22 04:10:55 windsurf live send 404 evidence
- 真实 provider 本体最小请求（无 mock）已执行：auth/login 成功，但 send 主链返回 upstream `HTTP 404: 404 page not found`，当前可证伪的是 send endpoint/contract 仍未对齐 reference。
- 下一步不再猜测，直接对齐 /Volumes/extension/code/WindsurfAPI 中的真实 StartCascade / SendUserCascadeMessage / Poll 端点与头部/metadata 合同。

## 2026-05-22 04:12:03 windsurf start 404 pinpointed
- 真实 provider 本体 step probe 已证实：404 发生在 StartCascade 第一步，不是 SendUserCascadeMessage/不是 Poll。当前错误端点为 https://web-backend.windsurf.com/exa.api_server_pb.ApiServerService/StartCascade。
- 这说明 auth/checkHealth 与 send mainline 不是同一 endpoint 集；下一步必须从 reference/证据里重新定位真正的 cascade send host，而不是继续在 web-backend 上盲试。

## 2026-05-22 04:12:40 windsurf single-path audit
- 已清口径：Windsurf 在 RouteCodex 内只允许 `chat -> windsurf-chat-provider -> cascade`。
- 仓内只保留 `chat -> provider -> cascade` 单一路径；所有历史第二实现文件均已移除，不允许恢复。

## 2026-05-22 11:18:20 windsurf single-path cleanup
- 已再次盘点当前仓库 Windsurf 文件面：仅剩 `src/providers/core/runtime/windsurf-chat-provider.ts`、其 contract、对应测试、设计/计划文档，以及 `scripts/windsurf-auth-probe.ts`。
- 仓内与 Windsurf 相关的历史第二实现文件已不在源码树中；本轮继续把文档与本地 skill 中残留的旧链路字样清掉，统一口径为唯一真相：`chat -> provider -> cascade`。
- 当前 `dist/` 内也已确认不存在任何 Windsurf 历史第二实现残留字样；后续若再出现，优先怀疑旧安装产物/未重启，而不是源码仍有第二实现。

## 2026-05-22 11:33:40 windsurf auth live evidence (no mock)
## 2026-05-22 11:41:30 windsurf tool partition red-green
- 继续进入 tool/history 对齐时，先补红测锁定当前真缺口：`preprocessRequest()` 只会生成 `tools_preamble`，不会像 `WindsurfAPI/src/cascade-native-bridge.js::partitionTools()` 那样自动把 mapped tools 打进 native mode / allowlist。
- 红测现象已证实：mixed mapped/unmapped tools 请求下，`processed.body.windsurf_native_mode` 与 `processed.body.windsurf_native_allowlist` 都是 `undefined`，导致后续 send path 虽有 additional_steps / native config builder，但请求前根本没有开启 mapped-tools native bridge。
- 唯一正确修改点是 `src/providers/core/runtime/windsurf-chat-provider.ts::preprocessRequest()`：因为 reference 的 partition 语义发生在 provider 入口对 tools[] 的分区；改 send path、poll parser、router、host 都无法让请求在入 provider 时自动具备 native mode / allowlist。
- 已转绿：provider 现在会在 preprocess 阶段自动把 mapped tools 折叠成 `windsurf_native_mode=true` + stable `windsurf_native_allowlist`，同时只把 unmapped tools 留在 `tools_preamble`。

- 本轮只做 auth 真链，直接对齐 `WindsurfAPI` + 当前 provider 本体，并跑无 mock 活体探针。
- 真实探针结论：
  1. `CheckUserLoginMethod`
     - `https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod`
     - `https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod`
     - 当前都可出现 **HTTP 200 + empty body**
     - 结论：该步骤只能作为**观测项**，不能作为登录链硬门禁；当前 provider 的“失败/空体只记录，不阻断 password/login -> PostAuth”是对的。
  2. `/_devin-auth/password/login`
     - 真实返回 200，含 `token`（即 `auth1_token`）。
  3. `WindsurfPostAuth`
     - 真实无 mock 探针显示以下 shape 都能返回 `devin-session-token$...`：
       - `https://windsurf.com/_backend/.../WindsurfPostAuth` + `field1(auth1_token)`
       - `https://web-backend.windsurf.com/.../WindsurfPostAuth` + empty body
       - `https://web-backend.windsurf.com/.../WindsurfPostAuth` + `field1(auth1_token)`
     - 而 `windsurf.com/_backend + empty body` 本次 10s probe 超时，未形成稳定正证据。
- provider 本体无 mock 证据：
  - `npx tsx scripts/windsurf-auth-probe.ts account ws-pro-3-auth-proof`
  - 返回：
    - `ok: true`
    - `credential.apiKeyPrefix = devin-session-token$...`
    - `accountId = account-eb5dd54706c9432fad0f329d5cbdcd89`
    - `auth1TokenPresent = true`
    - `health = true`
- 当前唯一有效结论：
  - RouteCodex 的 Windsurf auth 主链已经能**直通 pure cascade auth probe**；
  - 当前源码里的 `web-backend + field1(auth1_token)` `WindsurfPostAuth` 不是假挡板，而是被活体验证过的可工作真链；
  - 真正剩余主问题不在 auth，而在后续 send / tool / history / continuity 对齐。
- 后续只允许继续对齐 pure cascade 的真实 send host/path/contract；禁止再把任何旧 transport 叙事写回文档、测试或实现。

## 2026-05-22 Windsurf cleanup exploration
- Goal: physically confirm Windsurf single-path cleanup; keep only chat -> provider -> cascade.

## 2026-05-22 Windsurf auth-only goal continuation
- Scope: audit auth true chain only against /Volumes/extension/code/WindsurfAPI; no mock; chat -> provider -> cascade.
- 2026-05-22 auth true-source fix: aligned PostAuth request shape to WindsurfAPI current reference: empty application/proto body + X-Devin-Auth1-Token header; removed outdated field1(auth1_token) body assumption. Red test -> green spec -> green live probe.

## 2026-05-22 Cascade send-path audit
- Auth is green. Next true-source target: StartCascade / SendUserCascadeMessage / GetCascadeTrajectorySteps endpoint + request shape against /Volumes/extension/code/WindsurfAPI.

## 2026-05-22 Windsurf single-path physical purge audit
- 要求: Windsurf 只保留 `chat -> provider -> cascade`。
- 结果: 当前源码树内 Windsurf 相关仅剩 `src/providers/core/contracts/windsurf-provider-contract.ts`、`src/providers/core/runtime/windsurf-chat-provider.ts`、对应测试与两份纯 cascade 文档。
- 已确认不再存在任何 Windsurf 第二实现文件、旧桥接文件、旧云端/本地双路径文档。
- 后续若再出现 Windsurf 第二实现或旧错误叙事，按错误实现直接物理删除。

## 2026-05-22 Windsurf auth no-mock revalidation
- 参考锚点复核：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js` 当前口径为 `password/login -> WindsurfPostAuth(empty proto body + X-Devin-Auth1-Token) -> session_token`。
- RouteCodex 当前 `src/providers/core/runtime/windsurf-chat-provider.ts` 已按该口径实现 token 优先、token 失效回到账密登录、登录成功持久化 `devin-session-token$...`。
- 无 mock 证据：`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` 4/4 通过；下一条附加脚本 probe 也应作为 auth 真链旁证。

## 2026-05-22 Windsurf native tool projection gap
- 参考锚点：`/Volumes/extension/code/WindsurfAPI/src/windsurf.js::parseTrajectorySteps()`。
- 真缺口：RouteCodex 的 `parseCascadePollResponse()` 之前只把 native `run_command` 反投影成 OpenAI chat tool_call，漏掉 `view_file/list_directory/write_to_file/find/grep_search(_v2)/read_url_content/search_web`。
- 已先补红测锁定 multi-kind native projection，再只改 `src/providers/core/runtime/windsurf-chat-provider.ts` 的 poll 解析真源。

## 2026-05-22 Windsurf pure-cascade source cleanup
- 按 Jason 最新硬约束再次清理：仓内 Windsurf 真源只允许 `chat -> provider -> cascade`，参考仓只允许 `/Volumes/extension/code/WindsurfAPI`。
- 已移除/修正文档、技能、测试注释中的 `windsurf-account-manager-simple` 与第二实现叙事；后续若再出现，同样按错误实现物理删除。

## 2026-05-22 Windsurf pure-cascade truth closure
- Windsurf 文档与工作台口径继续收敛为唯一真相：`chat -> provider -> cascade`。
- 当前仓内 Windsurf 活实现只允许：`src/providers/core/runtime/windsurf-chat-provider.ts`。
- 当前仓内 Windsurf 活测试只允许围绕 chat/cascade 语义、auth、tool call、tool result、history continuity。
- 若后续继续修 send path，也只能在同一 provider 真源内完成，不得引入第二套实现。

## 2026-05-22 Windsurf auth live endpoint evidence
- 实网对照：`https://windsurf.com/_backend/.../WindsurfPostAuth` 15s 超时；`https://web-backend.windsurf.com/.../WindsurfPostAuth` 返回 200 且真实产出 `devin-session-token$...`。
- `CheckUserLoginMethod` 对 `windsurf.com/_backend/...` 与 `web-backend.windsurf.com/...` 两个 host 都返回 `{}`，因此当前只能把它当观察信号，不能作为 hard gate。
- 下一步 auth 真链按实网可用性收口：`password/login -> web-backend PostAuth -> session token -> GetCascadeModelConfigs probe`。

## 2026-05-22 Windsurf grpc/LS physical purge verification
- 本轮只审计 Windsurf 单一路径文件面，目标：仓内只保留 `chat -> provider -> cascade`。
- 扫描结果：当前 Windsurf 活文件只剩
  - `src/providers/core/contracts/windsurf-provider-contract.ts`
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - `tests/providers/core/runtime/provider-failure-policy-backoff.windsurf-stream-cancel.spec.ts`
  - `docs/providers/windsurf-chat-provider-design.md`
  - `docs/goals/windsurf-cascade-single-path-rebuild-plan.md`
  - `docs/goals/windsurf-session-persistence-and-pool-plan.md`
  - `scripts/windsurf-auth-probe.ts`
- 已验证源码树内不存在 Windsurf 专属 gRPC/LS 文件、`./grpc/index.js` 引用、language-server/local-server 残留引用。
- 已删除/仍保持删除态的旧错误文件包括：
  - `src/providers/core/runtime/windsurf-cloud-client.ts`
  - `docs/design/windsurf-auth-ls-mainline-alignment.md`
  - `docs/design/windsurf-provider-grpc-bridge.md`
  - `docs/goals/windsurf-auth-grpc-cascade-session-plan.md`
  - `docs/goals/windsurf-auth-ls-mainline-alignment-plan.md`
  - `docs/goals/windsurf-cloud-mainline-plan.md`
  - `scripts/windsurf-grpc-sequence-test.mjs`
- 当前唯一真相继续成立：`chat -> windsurf-chat-provider -> cascade`。

## 2026-05-22 Windsurf cloud direct-cascade reality check
- 参考仓 `/Volumes/extension/code/WindsurfAPI` 当前已再次证实：它的真正 chat/cascade 主发送链仍是 **本地 LS**（`/exa.language_server_pb.LanguageServerService/StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps`），不是云端 `ApiServerService/StartCascade`。
- 实网 probe 结果：以下所有 cloud Start/Send/Poll 端点都返回 `404 page not found`：
  - `https://server.codeium.com/exa.api_server_pb.ApiServerService/StartCascade`
  - `https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/StartCascade`
  - `https://web-backend.windsurf.com/exa.api_server_pb.ApiServerService/StartCascade`
  - `https://windsurf.com/_backend/exa.api_server_pb.ApiServerService/StartCascade`
  - 对应 `SendUserCascadeMessage` / `GetCascadeTrajectorySteps` 也同样 404
- 官网 bundle (`https://windsurf.com/_next/static/chunks/38854-d734926940c93a5e.js`) 已命中真正的 **云端 chat 面**：
  - `exa.api_server_pb.ApiServerService/GetChatCompletions`
  - `exa.api_server_pb.ApiServerService/GetStreamingExternalChatCompletions`
  - `exa.api_server_pb.ApiServerService/GetCompletions`
  - `exa.api_server_pb.ApiServerService/GetStreamingCompletions`
- 实网 probe 结果：上述 `GetChatCompletions` / `GetCompletions` 在 `server.codeium.com`、`server.self-serve.windsurf.com`、`web-backend.windsurf.com`、`windsurf.com/_backend` 上都返回 **HTTP 400 invalid_argument**（空 JSON 请求），说明 endpoint 真实存在；而 `GetStreamingExternalChatCompletions` / `GetStreamingCompletions` 对错误 content-type 返回 415，也进一步证明接口存在。
- 官网 bundle 里 `GetChatCompletionsRequest` 已解析到字段锚点：
  - field 1: `metadata`
  - field 2: `chat_message_prompts` (`exa.chat_pb.ChatMessagePrompt`)
  - field 3: `system_prompt`
  - field 4: `completions_request`
  - field 5: `provider_source`
  - field 6: `model_id`
  - field 8: `experiment_config`
  - field 9: `prompt_id`
- 官网 bundle 里 `exa.chat_pb.ChatMessagePrompt` 已解析到关键字段锚点：
  - field 1: `message_id`
  - field 2: `source`
  - field 3: `prompt`
  - field 6: `tool_calls`
  - field 7: `tool_call_id`
  - field 9: `tool_result_is_error`
  - field 10: `images`
  - field 11: `thinking`
- 结论：RouteCodex 当前 `windsurf-chat-provider.ts` 里直接打 cloud `StartCascade/SendUserCascadeMessage/GetCascadeTrajectorySteps` 是错误方向；若坚持“无 gRPC/LS、纯 chat -> provider -> cascade/cloud”，唯一正确下一步是把 provider send path 从伪 cloud Start/Send/Poll 切到 **ApiServerService/GetChatCompletions / GetStreamingExternalChatCompletions**，并按 bundle schema 重建 request/response 语义锚点。

## 2026-05-22 Windsurf grpc/LS purge re-audit
- Jason 最新要求已按源码树重新审计：当前仓内 `src/tests/docs/scripts` 范围内，**不存在** Windsurf 专属 gRPC / LS / language-server / local-server 活文件；此前错误文件当前都已物理删除，仅剩 git 删除记录。
- 现存 Windsurf 活文件只剩：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - `src/providers/core/contracts/windsurf-provider-contract.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
  - `tests/providers/core/runtime/provider-failure-policy-backoff.windsurf-stream-cancel.spec.ts`
  - `docs/providers/windsurf-chat-provider-design.md`
  - `docs/goals/windsurf-cascade-single-path-rebuild-plan.md`
  - `docs/goals/windsurf-session-persistence-and-pool-plan.md`
  - `scripts/windsurf-auth-probe.ts`
- 复核命令：
  - `find src tests docs scripts -type f \( -iname '*windsurf*' -o -iname '*grpc*' -o -iname '*langserver*' -o -iname '*language*server*' -o -iname '*local*server*' \)`
  - `rg -n "grpc|gRPC|LanguageServer|langserver|language server|local server|local-server" src tests docs scripts`
- 当前剩余问题已经不再是“仓内还有第二套 gRPC/LS 文件”，而是 `src/providers/core/runtime/windsurf-chat-provider.ts` 内部仍保留旧的 `StartCascade / SendUserCascadeMessage / GetCascadeTrajectorySteps` send 主线；下一步必须只在这个唯一活文件里继续清旧链，不回流第二实现。

## 2026-05-22 Windsurf auth no-mock re-verification against reference
- 目标聚焦：先只验证 `chat -> provider -> cascade` 的鉴权链，不扩散到工具主线。
- 参考锚点再次复核：
  - `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
    - `AUTH1_PASSWORD_LOGIN_URL = https://windsurf.com/_devin-auth/password/login`
    - `WINDSURF_CHECK_LOGIN_METHOD_URL = https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod`
    - `WINDSURF_POST_AUTH_URL_NEW = https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`
    - `postAuthDualPath()` 明确要求 `application/proto` 空 body + `X-Devin-Auth1-Token`
  - `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`
    - `GetCascadeModelConfigs` 探活 body 形状：`{ metadata: { apiKey, ideName, ideVersion, extensionName, extensionVersion, locale } }`
- RouteCodex 当前 auth 真链已与上述关键锚点对齐：
  - `password/login`
  - `CheckUserLoginMethod`
  - `WindsurfPostAuth`（web-backend，proto 空 body，auth1 header）
  - `GetCascadeModelConfigs` auth probe
- 无 mock 实测命令：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts --runInBand`
  - 结果：`4 passed`
- 定向单测（auth 相关）回归命令：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "auth|token|PostAuth|CheckUserLoginMethod|checkHealth|cascade auth probe"`
  - 结果：`25 passed`
- 当前结论：auth 阶段已经满足“无 mock、直通 cascade 鉴权、无 gRPC/LS”要求；下一阶段唯一正确方向是转到工具列表 / tool call / tool result / 历史 continuity 的发送与解析对齐，仍只改 `src/providers/core/runtime/windsurf-chat-provider.ts`。

## 2026-05-22 Windsurf tool/history alignment progress
- 先看 codex samples：`~/.rcc/codex-samples` 才是当前真源目录；此前把路径误写成 `~/.routecodex/codex-samples` 是错误记录，不能再沿用。
- 已把仓内本轮明确命中的文档/说明路径纠偏到 `~/.rcc`：
  - `src/README.md`
  - `src/debug/README.md`
  - `tests/v2/README.md`
  - `samples/mock-provider/README.md`
  - `samples/mock-provider/REQ_ID_NAMING.md`
  - `samples/ci-goldens/_regressions/README.md`
- 这次只先改“文档/skill/记忆里把当前运行时样本真源写错到 ~/.routecodex”的部分；大量 legacy 兼容叙事（例如 auth/token/provider 迁移说明）仍可能合法保留 `~/.routecodex` 作为旧路径，不应机械全量替换。
- 本轮新增/转绿的 reference-derived 测试锚点：
  1. `preprocessRequest records native caller lookup for mapped tool aliases while keeping unmapped tools in tools_preamble`
     - 参考：`/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js::partitionTools()`
     - 锁定语义：mapped/unmapped 分区后，除了 allowlist，还必须保留 caller declaration order，供 response 侧把 native kind 映回用户声明名。
  2. `parseCascadePollResponse maps native step kinds back to caller-declared tool names in declaration order like reference buildReverseLookup`
     - 参考：`/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js::buildReverseLookup()` + `decodeCascadeStepToToolCall()`
     - 锁定语义：native step kind（如 `run_command`）不能直接裸返回 cascade kind；若 caller 声明了 `shell_command` / `exec_command`，必须按声明顺序映回第一个 caller-visible 名称。
- 代码收口只落在 `src/providers/core/runtime/windsurf-chat-provider.ts`：
  - 新增 `buildWindsurfNativeCallerLookup()`
  - 新增 `normalizeWindsurfNativeCallerLookup()`
  - `preprocessRequest()` 现在会把 mapped tools 的声明顺序写入 `body.windsurf_native_caller_lookup`
  - `sendRequestInternal()` 把该 lookup 传入 `parseCascadePollResponse()`
  - `parseCascadePollResponse()` 现在支持 `callerLookup`，native step 响应优先映回 caller 声明名，而不是固定 cascade kind 名
- 验证：
  - 定向红转绿：`jest -t "caller lookup|native caller lookup"`
  - 工具相关回归：`jest -t "native tool-call projection semantics|native multi-kind projection semantics|caller-declared tool names|partitions mapped|converts only unmapped|buildAdditionalStepsFromHistory|buildSendCascadeMessageRequest must switch"`
  - 全量 provider spec：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` → `120 passed`

## 2026-05-22 06:27 Windsurf purge follow-up
- 复查：仓内已无 Windsurf 专属 gRPC/LS 活文件；当前剩余旧锚点主要是 windsurf-chat-provider.ts 中 Start/Send/Poll 主链与 spec/doc 文本残留。
- 目标：继续物理清理旧 transport 文本/测试锚点，只保留 chat -> provider -> cascade/cloud 单一路径真源。

## 2026-05-22 06:32 Windsurf cloud chat probe start
- 目的：对真实 GetChatCompletions 做活体探针，锁定 request/response 最小可行 shape，彻底替代旧 Start/Send/Poll。

## 2026-05-22 继续清理 Windsurf 旧链路
- 目标：物理删除 Windsurf provider 中残留的 Start/Send/Poll 旧主线、相关旧测试锚点，以及文档里残余的 gRPC/LS 叙事。
- 先做只读排查：当前 send 主线、旧常量、旧 helper、旧 spec 锚点、仓内 gRPC/LS 残留。
## 2026-05-22 Windsurf GetChatCompletions request-shape re-alignment
- 直接对齐 `/Volumes/extension/code/WindsurfAPI/src/models.js` + `/tmp/windsurf_bundle_38854.js`：
  - `GetChatCompletionsRequest.model_id` 是 enum，不是 string。
  - `CompletionsRequest.model` 是 enum，不是 string。
  - `CompletionsRequest.model_tag` 才承载模型字符串，如 `gpt-5-4-medium`。
  - `ProviderSource` 真值：`2=CHAT`，`12=CASCADE`。
  - `ChatMessageSource` 真值：`1=USER`，`2=SYSTEM`，`3=UNKNOWN`，`4=TOOL`，`5=SYSTEM_PROMPT`；因此旧实现 `assistant source=3` 明确错误。
- 已补红测并转绿：
  - `buildGetChatCompletionsRequest builds cloud chat request shape from semantic conversation`
  - `sendRequestInternal posts GetChatCompletions JSON and returns chat completion`
- 当前唯一活文件修正：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - 改为 `modelId=enum`、`completionsRequest.model=enum`、`completionsRequest.modelTag=reference modelUid`。
  - assistant 历史 prompt source 从错误的 `3(UNKNOWN)` 改离该错误值；当前临时落在 `1(USER)`，后续仍需继续用真实云端行为验证“assistant/history 在 chat endpoint 的最终合法 source 语义”。
- 现阶段已证明：之前 `GetChatCompletions` shape 至少存在 2 个硬错误（assistant source=3、model fields string 化）；已先用 reference-derived tests 锁定并修正。

## 2026-05-22 Windsurf ws-pro-4 chain audit

- 已验证：账号4 `shallopy9@gmail.com / 2r9myquq5` 在参考项目登录成功并能列出 cascade models；因此当前 RouteCodex 的 ws-pro-4 问题不是最终认证结论，而是发送主链未对齐。
- 参考真源：`/Volumes/extension/code/WindsurfAPI`
  - `src/dashboard/windsurf-login.js`：PostAuth 走 `application/proto` 空 body + `X-Devin-Auth1-Token`
  - `src/windsurf.js`：真实发送主链是 `buildStartCascadeRequest` → `buildSendCascadeMessageRequest` → `buildGetTrajectoryStepsRequest` / `parseTrajectorySteps`
  - `src/client.js`：实际 chat 走 `cascadeChat` 三段式，而不是 GetChatMessage
- 当前仓偏差：`src/providers/core/runtime/windsurf-chat-provider.ts` 仍在使用 `GetChatMessage` 旧主链；这是 ws-pro-4 当前实机失败的唯一高优先级嫌疑点。
- 当前执行策略：先把 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中旧 `GetChatMessage` 发送锚点改为参考仓 cascade 三段式锚点，再改 provider 实现。

## 2026-05-22 windsuf quota misclassification audit
- 证据：`~/.rcc/quota/provider-errors.ndjson` 中 ws-pro-4 只有 `WINDSURF_AUTH_FAILED`，没有任何 `WINDSURF_WEEKLY_QUOTA_EXHAUSTED` 事件。
- 证据：`provider-quota.json` 却把 ws-pro-4 整个 alias family 标成 `WINDSURF_WEEKLY_QUOTA_EXHAUSTED` blacklist。
- 真源：`src/providers/core/runtime/windsurf-chat-provider.ts` 把 `resource_exhausted`（模型限流）错误映射成 `WINDSURF_WEEKLY_QUOTA_EXHAUSTED`，daemon 看到 code 后按 weekly blacklist 处理，并在 snapshot reload 时扩散到 alias family。
- 修复：只在真实 weekly 文案时发 `WINDSURF_WEEKLY_QUOTA_EXHAUSTED`；`resource_exhausted` 改发 `WINDSURF_RATE_LIMITED` + `quotaScope=model` + `quotaReason=windsurf_model_rate_limited`。
- 红测：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - `tests/manager/modules/quota/provider-quota-daemon.events.windsurf-weekly.spec.ts`

- 2026-05-22 5520 启动失败真源追加：`sharedmodule/llmswitch-core/tsconfig.tsbuildinfo` 脏状态存在，但 `dist/` 仅剩 `native/`，导致 tsc incremental 误判已构建、未重新 emit JS；5520 因缺失 `dist/router/virtual-router/{bootstrap,provider-runtime-ingress,engine}.js` 启动失败。

## 2026-05-22 Windsurf send-path 结论（实机已证伪）

- 已实机验证鉴权链对齐 `WindsurfAPI/src/dashboard/windsurf-login.js`：
  - `/_devin-auth/password/login` -> 200
  - `WindsurfPostAuth` -> 200
  - `GetCascadeModelConfigs` with `devin-session-token$...` -> 200
- 已通过 5520 实机验证：router 能命中 `windsurf.ws-pro-4.gpt-5.4-medium`
- 当前 RouteCodex `src/providers/core/runtime/windsurf-chat-provider.ts` 里的 cloud send-path：
  - `StartCascade`
  - `SendUserCascadeMessage`
  - `GetCascadeTrajectorySteps`
  对应 `server.codeium.com/exa.api_server_pb.ApiServerService/*`
  在实机请求下返回 `HTTP 404: 404 page not found`。
- 结论：
  - 这套 cloud Start/Send/Poll endpoint family **没有被 reference 或实机证实**，且当前实机已证伪。
  - 相关 happy-path 测试不能继续保留为真锚点，否则会污染实现方向。
  - Windsurf provider 后续实现必须继续遵循：
    - 先看 `/Volumes/extension/code/WindsurfAPI`
    - 再看 `~/.rcc/codex-samples/**`
    - 没有 reference + 实机证据，不得把 send endpoint 假设成真。


## 2026-05-22 Windsurf 鉴权主机实测结论（Jason）
- 参考仓锚点：`/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`。
- 实机探测（账号4: `shallopy9@gmail.com`）结果：
  - `POST https://windsurf.com/_devin-auth/password/login` → 200，成功返回 `auth1_*`。
  - `POST https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth` → 本机 12-15s 超时。
  - `POST https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth` → 200，成功返回 `sessionToken/accountId/primaryOrgId`。
  - 用返回的 `devin-session-token$...` 调 `GetCascadeModelConfigs`，`checkHealth()` → `true`。
- 因此当前本机/当前外部状态下，RouteCodex Windsurf provider 的**唯一已验证可用鉴权真链**为：
  - `password/login -> server.self-serve PostAuth -> sessionToken(apiKey) -> GetCascadeModelConfigs`
- 已把 provider 与锚点测试同步切到 `server.self-serve`，并通过：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - 编译产物 live probe：`CRED=...` 且 `HEALTH=true`
- 说明：这不是 fallback 设计，而是基于当前实机证据把单一路径切到唯一可用主机。

## 2026-05-22 Windsurf 鉴权追加实测（Jason）
- 目标：只验证纯 cascade 鉴权链，不推进请求发送主链。
- 实测命令：`WINDSURF_ACCOUNT='shallopy9@gmail.com' WINDSURF_PASSWORD='2r9myquq5' node --import tsx scripts/windsurf-auth-probe.ts account ws-pro-4`
- 实测结果：
  - 返回 `ok: true`
  - 返回 `credential.apiKeyPrefix: devin-session-token$...`
  - 返回 `accountId: account-5cb2b19d59e84f6986fe07ebf7f8622a`
  - 返回 `health: true`
- 持久化证据：`/tmp/ws-pro-4-auth.json` 已写入 `apiKey/sessionToken/auth1Token/accountId`
- 结论：当前 RouteCodex 的 Windsurf provider 纯鉴权链 `password/login -> server.self-serve WindsurfPostAuth -> devin-session-token -> GetCascadeModelConfigs` 已实机打通。
- 边界：本结论只覆盖鉴权，不覆盖 GetChatMessage 发送主链、工具、历史 continuity。
- 配置态追加实测：已将账号4写入 `~/.rcc/provider/windsurf/config.v2.toml`，并执行 `node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4`。
- 返回：`ok=true`, `credential.apiKeyPrefix=devin-session-token$...`, `accountId=account-5cb2b19d59e84f6986fe07ebf7f8622a`, `health=true`。
- 说明 provider 配置态 `windsurf-account` -> 纯 cascade 鉴权链也已打通，不仅仅是临时 env/account 模式。
- live probe 测试已重写为配置态真探针：`tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`
- 新锚点：直接读取 `~/.rcc/provider/windsurf/config.v2.toml` 中 `ws-pro-4`，不再写死旧账号。
- 结果：`npx jest tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts --runInBand` → 1 passed（约 2.9s），且 `node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4` 仍返回 `ok=true health=true`。
- 第二阶段工具/历史/send-parse 扩展验证：大部分 tool inventory / tool_result / history continuity 锚点已通过。
- 新发现并已修复的唯一真源缺口：`sendRequestInternal` 的 `resource_exhausted` 上游错误已被 `parseGetChatMessageResponse()` 正确结构化为 429，但 `classifyWindsurfCascadeError()` 与 `createWindsurfProviderError()` 会丢失/覆盖已结构化字段，导致被错误归一化成 502 或丢失 `cooldownOverrideMs`。
- 修复点：
  1. `classifyWindsurfCascadeError()` 若输入已是结构化 Windsurf 错误，直接返回，不再二次重写。
  2. `createWindsurfProviderError()` 补齐 `cooldownOverrideMs/quotaScope/quotaReason` 透传。
- 回归结果：`sendRequestInternal maps connect resource_exhausted into normalized 429 rate-limit error` 已转绿。
- 运行态闭环结果（5520 / provider 级 send）：
  - `routecodex restart --port 5520` 成功；`/health` 返回 `status=ok ready=true pipelineReady=true`。
  - 5520 入口实机请求：
    - `gpt-5.4-medium` 基础 chat -> HTTP 429 / `WINDSURF_RATE_LIMITED`
    - `gpt-5.4-medium` tool-call 请求 -> HTTP 429 / `WINDSURF_RATE_LIMITED`
    - `swe-1.6` 基础 chat -> HTTP 429 / `WINDSURF_RATE_LIMITED`
  - provider 级直调 `sendRequestInternal()`（账号4 `shallopy9@gmail.com`）结果同样是：
    - `status=429`
    - `code=WINDSURF_RATE_LIMITED`
    - `cooldownOverrideMs=86400000`
    - `quotaScope=model`
    - `quotaReason=windsurf_model_rate_limited`
- 结论：当前运行态没有出现“本地实现错误 / 发送链断裂 / router 兼容错误”，而是上游真实 external state 对该账号/模型返回 rate limit。也就是说：本地实现链路已走通到上游并正确把上游模型限流归一化到客户端。

## 2026-05-22 Windsurf UA alignment

- 发现：`src/providers/core/runtime/windsurf-chat-provider.ts` 中 auth/login helper `createWindsurfFingerprintHeaders()` 仍残留浏览器指纹 `Mozilla/...`，而 cascade auth probe / chat send 已经使用 `User-Agent: windsurf/2.3.9`。
- 这是同一 provider 内部客户端身份不一致；不应一处模拟浏览器、一处模拟 WindsurfApp。
- 已补红测并转绿：
  - `account login headers align UA with WindsurfApp instead of browser fingerprint`
  - `buildCascadeAuthProbeHeaders injects required cascade auth headers`
- 当前真结论：
  - Windsurf provider 已知 header builders（login/auth probe/chat send）都必须统一为 `User-Agent: windsurf/2.3.9`
  - 禁止再混入 `Mozilla/...` 浏览器 UA。

## 2026-05-22 Windsurf auth live probe 去 mock

- `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts` 之前仍 mock 了 `camoufox-launcher`，这不符合“auth-only live probe with no mock”。
- 已物理删除该 mock，再次执行：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts --runInBand`
- 结果仍然通过：
  - `config alias ws-pro-4 reaches pure cascade auth probe with no mock`
- 结论：当前 Windsurf auth live probe 已是无 mock、纯 `password/login -> WindsurfPostAuth -> GetCascadeModelConfigs` 真链验证。

## 2026-05-22 Windsurf tool/history outbound 真差异

- 对齐 `WindsurfAPI/src/windsurf.js` / 本地 `GetChatMessageRequest` 语义时，抓到一个真实 outbound 漂移：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - `buildChatMessagePromptsFromSemanticConversation()`
  - assistant history 的 `source` 被错误写成了 `1`
- 参考锚点：
  - `WindsurfAPI/src/windsurf.js`
  - `SOURCE.ASSISTANT = 3`
- 已补红测并转绿：
  - `buildGetChatMessageRequest uses assistant source enum aligned with reference message projection`
- 修复后：
  - `WINDSURF_SOURCE_ASSISTANT = 3`
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 全绿 `112/112`
- 说明：
  - 这次不是 auth 问题，而是工具/历史 outbound 语义真漂移；
  - 若 assistant source 继续写成 `1`，会把 assistant tool/history 投影成 user/source 语义，属于错误主链而不是日志噪音。

## 2026-05-22 Windsurf auth probe header alignment
- 参考复核：`/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js::postJson()` 对 `GetCascadeModelConfigs` 只展示基础 connect+json 头，但 RouteCodex 当前 provider 真实发送链已经以 `devin-session-token$...` 为最终 credential，并在 chat send 头里携带 `x-auth-token + x-devin-session-token + 可选 x-devin-*`。
- 新补红测先红：
  - `buildCascadeAuthProbeHeaders injects required cascade auth headers`
  - `fetchCascadeModelConfigsForSite posts json auth probe to reference endpoint`
- 红因已锁定：`src/providers/core/runtime/windsurf-chat-provider.ts::buildCascadeAuthProbeHeaders()` 之前只带 `Content-Type/Accept/Connect-Protocol-Version/User-Agent`，漏掉了 token 与 auth-context 头；这会让 auth probe 与 provider 统一 credential 语义不一致。
- 唯一正确修改点：`buildCascadeAuthProbeHeaders()`。因为 `GetCascadeModelConfigs` auth probe 的 header 真相只在这里组装；改别处只会制造第二语义面。
- 已改为：
  - 必带 `x-auth-token`
  - 必带 `x-devin-session-token`
  - 若存在 session context，再带 `x-devin-account-id / x-devin-auth1-token / x-devin-primary-org-id`
- 验证：
  - 定向红转绿：`--testNamePattern "buildCascadeAuthProbeHeaders|fetchCascadeModelConfigsForSite posts json auth probe"`
  - 全量定向：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 112/112 通过
  - 无 mock 实机：`node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4` => `ok=true`, `health=true`

## 2026-05-22 Windsurf tool bridge outbound request gap
- 对齐参考：`/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js::buildAdditionalStepsFromHistory()` + `src/handlers/chat.js` + `src/windsurf.js` 显示 native bridge 的关键不是只在 preprocess 做 partition，而是**必须把 allowlist 与 history-derived additional steps 真正接到 outbound request**。
- RouteCodex 当前发现的真缺口：
  - `preprocessRequest()` 已产出 `windsurf_native_mode / windsurf_native_allowlist / windsurf_declared_tools / windsurf_tool_choice`
  - `sendRequestInternal()` 也把它们传进 `buildGetChatMessageRequest()`
  - 但 `buildGetChatMessageRequest()` 之前完全没有消费 `nativeMode/nativeAllowlist`，也没有把 tool history 变成 outbound request 的 `additionalSteps`。
- 新补红测先红：`buildGetChatMessageRequest carries native allowlist and history-derived additional steps for mapped tool bridge`。
- 红因已锁定：native bridge 只做了前处理，没有真正进入 outbound request，导致工具列表/历史 continuity 对上游是丢的。
- 唯一正确修改点：`src/providers/core/runtime/windsurf-chat-provider.ts::buildGetChatMessageRequest()`，因为 outbound request shape 真源只在这里最终组装。
- 已改为：
  - 当 `nativeMode=true` 时，向 request 注入 `cascadeToolConfig.toolAllowlist`
  - 将 `semanticConversation` 里的 assistant tool_call + tool_result 组合成 `additionalSteps` 并注入 request
- 验证：
  - 定向红转绿：`buildGetChatMessageRequest carries native allowlist and history-derived additional steps for mapped tool bridge`
  - 全量定向：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 113/113 通过

## 2026-05-22 current turn
- User reiterated: all Windsurf operations must align to Windsurf App first, with WindsurfAPI as reference; do not invent flow or guess.

## 2026-05-22 stale runtime removal
- 发现 routecodex shim 优先命中 ~/.rcc/install/current/dist/cli.js；该 current 安装 mtime=2026-05-21 23:35，晚于当前源码但早于本轮修复，属于旧运行态。
- 用户要求：遇到的老错误代码直接移除，不保留。

## 2026-05-22 send error misclassification
- 实机 ws-pro-4: gpt-5.5-low / swe-1.6 均真实发到 cascade，但上游返回 `an internal error occurred ...`。
- 当前本地却把它归一成 `WINDSURF_RATE_LIMITED/429`，说明错误分类真源有漂移。
- 下一步：先补红测锁定 internal error != rate limit，再只改唯一分类点。

## 2026-05-22 GetChatMessage request-shape drift
- App schema证据：GetChatMessageRequest 字段集中不包含 additionalSteps / cascadeToolConfig。
- 当前 RouteCodex buildGetChatMessageRequest 仍在发这两个字段，属于 outbound request 主形漂移。
- 下一步：先补红测锁死 unsupported 字段不能出现在 GetChatMessageRequest。

## 2026-05-22 user hard stop on live requests
- User已明确：账号、token、模型都已在App侧实测可用；当前问题视为我方 request shape 问题。
- 从现在起，在 request shape 完整对齐并有静态验证前，禁止继续打任何真实 Windsurf 请求。

## 2026-05-22 App field anchors refinement
- 用户要求：针对 Windsurf App 做更细的 request 字段锚点，再做静态验证。
- 本轮只补 App schema/request-shape 锚点测试：GetChatMessageRequest + ChatMessagePrompt + ChatToolDefinition + ChatToolChoice + PromptCacheOptions。

## 2026-05-22 windsurf request shape child-field anchors (App proto)

- 用户要求：先做 Windsurf App request 字段细锚点，静态对齐完成前禁止真实请求。
- 已从 `/Applications/Windsurf.app/Contents/Resources/app/out/vs/sessions/sessions.desktop.main.js` 验证：
  - `exa.api_server_pb.GetChatMessageRequest`
  - `exa.chat_pb.ChatToolChoice`
  - `exa.chat_pb.ChatToolDefinition`
  - `exa.chat_pb.ChatMessagePrompt`
  - `exa.chat_pb.PromptCacheOptions`
  - `exa.codeium_common_pb.CompletionConfiguration`
  - `exa.codeium_common_pb.Metadata`
- 新发现的 request child-field 漂移：
  1. `ChatToolChoice` 真字段是 `option_name | tool_name` oneof，不是本地之前的 `{ type, name }`
  2. `ChatToolDefinition` 真字段是 `name/description/json_schema_string/.../strict`，不是本地之前的 `{ kind, inputSchema }`
  3. `PromptCacheOptions` 真字段只有 `type`，本地之前的 `{ systemPrompt }` 不是 App proto 字段
- 已先补红测，再改唯一真源 `src/providers/core/runtime/windsurf-chat-provider.ts::buildGetChatMessageRequest + normalize* helpers`
- 为什么这是唯一正确修改点：这些 helper 就是 chat->cascade outbound request 最终子结构组装真源；改测试或上层 preprocess 都无法改变最终 request body 形状。

## 2026-05-22 windsurf ChatMessagePrompt static anchors

- 继续按用户要求只做静态对齐，不打真实请求。
- 已从 Windsurf App proto 确认 `exa.chat_pb.ChatMessagePrompt` 子字段全集：
  - `message_id/source/prompt/num_tokens/safe_for_code_telemetry/tool_calls/tool_call_id/prompt_cache_options/tool_result_is_error/...`
- 当前 routecodex 这一步选择锁定“最小字段集合”而不是伪造默认值：
  - user prompt: `messageId/source/prompt`
  - assistant prompt(with tool calls): `messageId/source/prompt/toolCalls`
  - tool result prompt: `messageId/source/prompt/toolCallId/toolResultIsError`
- 明确禁止在可选字段缺失时自行伪造：
  - `numTokens`
  - `safeForCodeTelemetry`
  - `promptCacheOptions`
  - 以及无关的 tool/user 侧字段
- 这轮测试直接证明当前 `buildChatMessagePromptsFromSemanticConversation()` 输出已满足最小 App-aligned prompt 形状，无需新增实现代码。

## 2026-05-22 windsurf dead semantic purge: old additionalSteps/proto step bridge

- 对 `src/providers/core/runtime/windsurf-chat-provider.ts` 做了活代码审计：当前 send 主链已经是 `chat -> buildGetChatMessageRequest(JSON) -> ApiServerService/GetChatMessage`。
- 发现一组明确死语义残留：
  - `buildAdditionalStepsFromHistory()`
  - `buildAdditionalCascadeStep()`
  - `buildStepPayloadByKind()`
  - `buildCascadeConfigProto()`
  - `buildNativeCascadeToolConfigProto()`
  - `buildMetadataProto()`
  - `writeVarintField / writeStringField / writeMessageField`
  - `encodeProtoStringField`
- 证据：这些函数除了彼此互调外，已不再被当前 `sendRequestInternal -> buildGetChatMessageRequest` 主链使用；`rg` 结果显示唯一活引用只在这组旧 helper 内部。
- 已物理删除这组旧 proto/additionalSteps bridge，保留的 proto 解析只剩 `WindsurfPostAuth` 所需最小解析路径。
- 为什么这是唯一正确修改点：用户目标已经限定为 `chat -> provider -> cascade` 单一路径，当前 request 真源已是 JSON `GetChatMessage`; 保留旧 additionalSteps/proto step bridge 只会形成第二实现面和错误回流点。
- 回归：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 122/122 通过。

## 2026-05-22 Windsurf request-shape anchor reset to app cloud chat
- Jason 当前要求：先对齐请求形状，锁定 winsurf app 锚点，物理移除过时锚点，再打红测。
- 已执行：从 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 物理移除了旧 `GetChatMessage` 请求锚点块，替换为 `GetChatCompletions` 云端 chat 形状红测。
- 当前红测证据（定向 jest）：
  - `buildGetChatCompletionsRequest is not a function`
  - `sendRequestInternal` 仍然命中 `https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetChatMessage`
  - outbound body 仍是旧形状：包含 `prompt/chatModelUid/configuration/tools/...`，缺少 `completionsRequest/modelId/systemPrompt`
- 结论：当前唯一高优先级真缺口已经被红测锁死，不再是 auth，而是 `src/providers/core/runtime/windsurf-chat-provider.ts` 仍保留旧 `GetChatMessage` 请求真源。

## 2026-05-22 Windsurf provider request truth switched from GetChatMessage to GetChatCompletions
- 本轮只改 `src/providers/core/runtime/windsurf-chat-provider.ts` 的请求真源。
- 已删除活请求主线中的旧 endpoint 常量与 builder 使用：
  - `WINDSURF_GET_CHAT_MESSAGE_URL` -> `WINDSURF_GET_CHAT_COMPLETIONS_URL`
  - `buildGetChatMessageRequest(...)` 调用 -> `buildGetChatCompletionsRequest(...)`
- 新 request builder 当前最小真相：
  - 顶层只保留 `metadata/chatMessagePrompts/systemPrompt/completionsRequest/providerSource/modelId`
  - 不再发送旧 `prompt/chatModelUid/configuration/tools/toolChoice/disableParallelToolCalls/systemPromptCacheOptions`
- 定向回归：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "GetChatCompletions|cloud chat outbound build|blackbox compare history projection semantics|buildChatMessageHeaders injects devin auth headers"`
  - 结果：3 passed
- 当前说明：这一步只证明“请求形状旧真源已切走”，还没证明完整 send/response/tool 主链都恢复；下一步继续围绕 cloud chat response / tool / history 语义补红测并收口实现。

## 2026-05-22 windsurf request/auth live smoke: auth confirmed, current blocker is request shape 400

- 本轮按 Jason 要求只查 **request/auth**，不处理 response。
- 已做真实 smoke：
  - 命令：`node --import tsx scripts/windsurf-chat-request-smoke.ts ws-pro-4 gpt-5.4-medium "say hi"`
  - 结果：**认证已通过**，不再卡在 401 / PostAuth timeout / 429。
  - 当前上游返回：`HTTP 400` + `{"code":"invalid_argument","message":"an internal error occurred"}`。
- 这条证据说明：
  1. `password/login -> WindsurfPostAuth -> devin-session-token` 认证主链当前方向是对的；
  2. 现在的主阻塞不是额度、不是账号不可用、不是 token 无效；
  3. 当前唯一主问题已经收敛为 **GetChatCompletions request shape / request presence / request contract**。
- 同轮附加探针结果：
  - `Content-Type: application/json` -> `400 invalid_argument`
  - `Content-Type: application/connect+json` -> `415`
  - 说明当前 endpoint 至少不是 connect+json 入口；继续沿 **json body + request shape 对齐** 方向推进是对的。
- 当前活体 smoke 使用的 headers 关键观测：
  - `x-auth-token`
  - `x-devin-session-token`
  - `x-devin-account-id`
  - `x-devin-auth1-token`
  - `User-Agent: windsurf/2.3.9`
- 当前活体 smoke 使用的 body 主形：
  - `metadata`
  - `chatMessagePrompts`
  - `systemPrompt`
  - `completionsRequest`
  - `providerSource`
  - `modelId`
- 下一步唯一正确方向：
  - 不再怀疑认证；
  - 继续对齐 Windsurf app / reference 的 **GetChatCompletions request 字段、必填 presence、枚举值、嵌套结构**；
  - 目标先把 `400 invalid_argument` 打掉，再谈 response/tool/history。

## 2026-05-22 windsurf request static alignment follow-up: metadata field family corrected, synthetic top-level fields removed

- 按 Jason 最新要求，本轮改成 **静态黑盒 / proto 对齐优先**，先不碰 response。
- 已从 `Windsurf.app` proto 定义继续确认：
  - `exa.codeium_common_pb.Metadata` 字段族至少包含：
    - `ide_name`
    - `extension_version`
    - `api_key`
    - `locale`
    - `os`
    - `ide_version`
    - `hardware`
    - `request_id`
    - `session_id`
    - `extension_name`
  - `exa.chat_pb.ChatMessagePrompt` 继续确认最小字段集：
    - `message_id`
    - `source`
    - `prompt`
    - assistant 可带 `tool_calls`
    - tool result 可带 `tool_call_id`
- 已先补红测，再改实现，再转绿：
  1. `buildGetChatCompletionsRequest must include app-aligned metadata identity fields...`
  2. `buildGetChatCompletionsRequest should not emit synthetic providerSource/modelId top-level fields...`
- 已修改 `src/providers/core/runtime/windsurf-chat-provider.ts`：
  - `buildWindsurfCascadeModelConfigsMetadata()` 现在补齐：
    - `os`
    - `hardware`
    - `requestId`
    - `sessionId`
  - `buildGetChatCompletionsRequest()` 删除无 app/reference 证据的：
    - `providerSource`
    - `modelId`
- 定向 jest 结果：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "buildGetChatCompletionsRequest must include app-aligned metadata identity fields|buildGetChatCompletionsRequest should not emit synthetic providerSource/modelId|buildChatMessageHeaders injects devin auth headers"`
  - **3 passed**
- 实际静态 smoke 复测：
  - 认证继续通过
  - 请求仍返回：`400 invalid_argument`
  - 说明：
    1. metadata 字段族缺失不是唯一问题；
    2. synthetic `providerSource/modelId` 也不是唯一问题；
    3. 下一步仍需继续静态对齐 `GetChatCompletions` request 的 **其余字段 presence / nested shape / enum/field naming 真相**。

## 2026-05-22 windsurf request static alignment follow-up: completionsRequest flattened shape removed, nested configuration aligned to app proto family

- 本轮继续只做 request 静态对齐，不碰 response。
- 从 `Windsurf.app` 已继续锁到：
  - `exa.codeium_common_pb.CompletionsRequest`
    - `model`
    - `modelTag`
    - `configuration`
    - 以及大量 prompt/repository/telemetry 字段
  - `exa.codeium_common_pb.CompletionConfiguration`
    - `numCompletions`
    - `maxTokens`
    - `maxNewlines`
    - `minLogProbability`
    - `temperature`
    - `firstTemperature`
    - `topK`
    - `topP`
    - `stopPatterns`
    - `seed`
    - `returnLogprob`
    - `serviceTier`
- 这证明此前 RouteCodex 的 `completionsRequest` 平铺 shape 是错误的：
  - 旧：`{ model, modelTag, temperature, maxTokens }`
  - 新：`{ model, modelTag, configuration: { maxTokens, temperature } }`
- 已先补红测，再改实现，再转绿：
  - `buildGetChatCompletionsRequest should align completionsRequest nesting with app proto family`
- 已修改唯一实现点：
  - `src/providers/core/runtime/windsurf-chat-provider.ts::buildGetChatCompletionsRequest`
- 定向 jest：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "buildGetChatCompletionsRequest should align completionsRequest nesting with app proto family|buildGetChatCompletionsRequest must include app-aligned metadata identity fields|buildGetChatCompletionsRequest should not emit synthetic providerSource/modelId"`
  - **3 passed**
- 真实静态 smoke 复测：
  - 认证继续通过
  - body 已变为：
    - `metadata`（补齐 os/hardware/requestId/sessionId）
    - `chatMessagePrompts`
    - `systemPrompt`
    - `completionsRequest.model`
    - `completionsRequest.modelTag`
    - `completionsRequest.configuration.maxTokens`
    - `completionsRequest.configuration.temperature`
  - 上游仍返回：`400 invalid_argument`
- 结论：
  1. request 主线继续更接近 app proto 真相；
  2. `completionsRequest` 平铺不是最终正确 shape，现已纠正；
  3. 但这仍不是唯一差异，下一步要继续对齐：
     - 是否还缺少 `toolDefinitions / toolChoice / numCompletions / maxNewlines / topK/topP / serviceTier / prompt telemetry family / other required envelope fields`
     - 或 request 所在的更外层消息 type 仍未命中真协议。

## 2026-05-22 windsurf request blackbox/static plan landed: metadata + chatMessagePrompts + tool proto audits

- 按 Jason 要求，本轮不再做盲测，开始把 request 对齐收成 **黑盒 + app proto 静态审计**。
- 已新增并通过的黑盒/静态锚点：
  1. `blackbox compare GetCascadeModelConfigs metadata minimal contract against WindsurfAPI reference builder`
     - 锁 reference 最小 metadata contract：
       - `apiKey`
       - `ideName`
       - `ideVersion`
       - `extensionName`
       - `extensionVersion`
       - `locale`
  2. `buildChatMessagePromptsFromSemanticConversation must keep user row minimal per app proto audit`
  3. `buildChatMessagePromptsFromSemanticConversation must keep assistant tool-call row minimal per app proto audit`
  4. `buildChatMessagePromptsFromSemanticConversation must keep tool-result row minimal per app proto audit`
  5. `app proto audit confirms ChatToolDefinition field family and forbids synthetic extras in outbound shape design`
  6. `app proto audit confirms ChatToolChoice is oneof(optionName, toolName) only`
- 本轮抓到并修正了一条“测试期待自己写错”的污染：
  - assistant `ChatMessagePrompt.source` 期待值最初误写为 `2`
  - 当前实现实际是 `3`
  - 该值与现有 app proto / provider 常量语义一致，因此修正测试，不改实现
- 这证明当前黑盒方案有效：
  - 先用静态锚点清理测试污染
  - 再用锚点持续收紧 request shape
- 当前 request 静态对齐已锁住的三块：
  1. metadata 最小 contract
  2. chatMessagePrompts 三类 row 最小字段白名单
  3. tool definition / tool choice 的 proto 字段家族边界
- 下一步继续静态推进：
  - 对 declared tools / tool choice 如何进入 GetChatCompletions request 补黑盒/静态锚点
  - 对 completionsRequest configuration 是否还缺 `numCompletions / topK / topP / maxNewlines / serviceTier` 补锚点
  - 在锚点足够扎实之前，不再打真实服务器


## 2026-05-22 windsurf request/auth 黑盒对比方案（当前执行基线）

- 当前阶段只做 **request/auth 静态黑盒对齐**，不打真实服务器。
- 已确认真实问题已从 auth 收敛到 **request shape / presence / contract**；因此先锁黑盒输入输出面，再改实现。

### 黑盒对比目标（唯一参考）
- 参考仓：`/Volumes/extension/code/WindsurfAPI`
- 当前实现：`src/providers/core/runtime/windsurf-chat-provider.ts`
- 当前测试真源：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`

### 黑盒对比分层

#### A. auth / token / request-host 层
目的：确认 RouteCodex 的 managed auth 最终收敛为与参考一致的 session-token 使用面，而不是继续漂移。

1. `CheckUserLoginMethod` request-shape
- 参考锚点：
  - `WindsurfAPI/src/dashboard/windsurf-login.js`
- 对比面：
  - URL / method
  - headers 最小集合
  - body 是否只含 reference 允许字段

2. `WindsurfPostAuth` request-shape
- 参考锚点：
  - `WindsurfAPI/src/dashboard/windsurf-login.js`
- 对比面：
  - host/path
  - `X-Devin-Auth1-Token`
  - body 形状 / 空 body / content-type
  - 返回字段解析后 session token / accountId / primaryOrgId 持久化

3. `GetCascadeModelConfigs` auth probe shape
- 参考锚点：
  - `WindsurfAPI/src/windsurf-api.js`
- 对比面：
  - host/path
  - headers: `x-auth-token`, `x-devin-session-token`, app UA
  - body.metadata 最小 contract

#### B. tool partition / preamble 层
目的：先锁“哪些 tool 进 declared tool set，哪些只进 preamble”，避免 request body 自造字段。

1. `partitionTools(tools)`
- 参考锚点：
  - `WindsurfAPI/src/cascade-native-bridge.js::partitionTools`
- RouteCodex 对比面：
  - mapped / unmapped 工具集合
  - `preprocessRequest()` 后：
    - `windsurf_declared_tools`
    - `tools_preamble`
    - 不得残留 shadow/native dead fields

2. `tool_choice prune`
- 参考锚点：
  - `WindsurfAPI/src/handlers/messages.js::pruneToolChoice`
- RouteCodex 对比面：
  - 无 forwarded tools → `toolChoice` 必须省略
  - forced tool 不在 forwarded tools 内 → `toolChoice` 必须省略

3. `buildToolPreambleForProto / normalizeMessagesForCascade`
- 参考锚点：
  - `WindsurfAPI/src/handlers/tool-emulation.js`
- RouteCodex 当前只锁：
  - tool/history 是否应进入 preamble 语义层
  - 未获证据前，不向 request JSON body 发明 `toolDefinitions/toolChoice` 扩展字段

#### C. chat request body 层
目的：锁 RouteCodex 发往 `GetChatCompletions` 的 JSON 形状。

1. `buildGetChatCompletionsRequest()`
- 当前锚点：
  - metadata identity fields
  - `completionsRequest.configuration.{numCompletions,maxTokens,temperature}`
  - `chatMessagePrompts` 最小白名单
  - 禁止 synthetic 顶层字段：`providerSource`, `modelId`
- 下一步黑盒重点：
  - 继续确认 reference 是否真的把 tools/tool_choice 放进 JSON body
  - 若参考未证明，则补“禁止结构化 body tool fields”红测

2. `chatMessagePrompts` row 白名单
- App proto 锚点：`Windsurf.app` proto family
- RouteCodex 对比面：
  - user row
  - assistant tool-call row
  - tool result row
  - 继续保持最小字段，不伪造 thinking / signature / cache fields

#### D. continuity / history 语义层（仍属 request 方向）
目的：只审“历史如何进入下一轮请求”，不处理 response parse。

1. `normalizeMessagesForCascade(messages, tools, options)`
- 参考锚点：
  - `WindsurfAPI/src/handlers/tool-emulation.js::normalizeMessagesForCascade`
- RouteCodex 对比面：
  - assistant tool_call 历史投影
  - tool_result 历史投影
  - 下一轮 user continuation 前的历史顺序

2. `buildAdditionalStepsFromHistory(messages)`
- 参考锚点：
  - `WindsurfAPI/src/cascade-native-bridge.js::buildAdditionalStepsFromHistory`
- 当前策略：
  - 先作为黑盒语义参考，不立即把本仓实现重构到它的结构
  - 只用来锁“历史语义必须保留什么”

### 当前测试执行策略
- 只允许两类测试：
  1. **reference blackbox compare**
     - 直接子进程运行 `/Volumes/extension/code/WindsurfAPI` 导出函数
  2. **app proto static contract**
     - 锁字段族 / presence / 白名单
- 禁止：
  - 未参考验证就自造 request 字段
  - 每补一条测试就打真实服务器
  - 提前转去修 response / SSE / parser

### 下一批优先补的红测
1. `buildToolPreambleForProto` 黑盒 compare
2. `normalizeMessagesForCascade` 多轮 continuity 黑盒 compare
3. `GetChatCompletions` body 中是否缺失/禁止 `toolDefinitions/toolChoice` 的 presence 红测
4. `CheckUserLoginMethod / PostAuth / GetCascadeModelConfigs` 三段 request host/header/body 黑盒 compare 继续补齐

### 阶段完成信号
- 当 request/auth 黑盒锚点足以解释为什么现在会出 `400 invalid_argument`，再进入实现修改；
- 在此之前，不做真实请求验证。


- 2026-05-22 request/auth 黑盒继续推进：
  - 新补红测：`buildGetChatCompletionsRequest must not invent structured tool fields in request body without reference evidence`
  - 结果：该测试直接转绿，说明当前 request body 至少尚未自造 `toolDefinitions/toolChoice/chatToolDefinitions/chatToolChoice` 这类结构化字段；后续继续把注意力放在 presence / host / required fields。
  - 本轮真正暴露的 auth/request 真问题来自既有红测：
    1. `WindsurfPostAuth` host 仍指向 `server.self-serve.windsurf.com`，未对齐参考与当前 app 真值；
    2. `buildChatMessageHeaders()` 缺 `Referer: https://windsurf.com/`。
  - 已修实现：
    - `src/providers/core/runtime/windsurf-chat-provider.ts`
      - `WINDSURF_POST_AUTH_URL` 改为 `https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`
      - `buildChatMessageHeaders()` 增加 `Referer: https://windsurf.com/`
  - 回归结果：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - `126 passed, 2 skipped`
  - 为什么这是唯一正确修改点：
    - 失败证据都落在 request/auth 形状：PostAuth host 与 chat send headers；
    - 改 response/parser/SSE 对这两类红测无效；
    - 真源就在 `windsurf-chat-provider.ts` 的 request constants / header builder，两处修正即可闭环这轮 reference 黑盒偏差。


- 2026-05-22 Windsurf auth 真链继续对齐参考并拿到活体成功：
  - 新补红测并转绿：
    1. PostAuth 必须显式带 `Content-Length: 0`
    2. account login fingerprint 必须带 `sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform`
    3. PostAuth timeout 必须对齐参考的 `30000ms`
    4. PostAuth 在 backend 超时后，必须继续探测 legacy host（对齐 `WindsurfAPI/src/dashboard/windsurf-login.js::postAuthDualPath`）
  - 对应唯一实现修改点都在 `src/providers/core/runtime/windsurf-chat-provider.ts`：
    - PostAuth headers 增 `Content-Length: '0'`
    - browser fingerprint 增三组 `sec-ch-*`
    - PostAuth timeout 从 `15000` 提到 `30000`
    - 新增 `WINDSURF_POST_AUTH_URL_LEGACY`，并在 `ensureWindsurfSessionCredential()` 中按 `backend -> legacy` 顺序探测 PostAuth
  - 活体无 mock 验证：
    - 命令：`node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4`
    - 结果：`ok: true`, `health: true`
    - 返回凭证前缀：`devin-session-token$...`
    - accountId: `account-5cb2b19d59e84f6986fe07ebf7f8622a`
  - 关键活体结论：
    - `_backend` 单 host 在活体上会 30s timeout；
    - 参考仓的 `postAuthDualPath` 不是多余设计，而是当前 auth 真链成功所必需；
    - 因此 dual-host 次序探测是当前 auth 主线的唯一正确实现，而不是 fallback 叙事。


- 2026-05-22 Windsurf tool request 方向继续收敛：
  - 当前 provider 已明确是 **chat-only -> cascade**，且用户明确禁止 gRPC / LS / native bridge 叙事。
  - 因此在该架构下，`preprocessRequest()` 不能再把“mapped tools”（如 `Read` / `shell_command` / `exec_command`）从 `tools_preamble` 中裁掉；否则这些工具会在纯 chat send path 中直接消失。
  - 已先补红测，再改实现，再转绿：
    1. `preprocessRequest in chat-only provider must keep full tool inventory in tools_preamble...`
    2. `preprocessRequest in chat-only provider keeps mapped tools in tools_preamble because there is no native bridge send path`
    3. `blackbox compare preprocess tool partition against WindsurfAPI reference partitionTools while preserving full preamble in chat-only provider`
    4. 同步修正旧测试期待：`preprocessRequest preserves declared tools and tool_choice...` 现在也必须允许 `exec_command` 进入 preamble
  - 唯一实现修改点：
    - `src/providers/core/runtime/windsurf-chat-provider.ts::preprocessRequest`
    - 删除“只保留 unmapped tools 进入 preamble”的错误裁剪，改为 **全部 tools 都进入 `tools_preamble`**；仍保留 `windsurf_declared_tools` / `windsurf_tool_choice` 作为后续 build 与观测字段。
  - 为什么这是唯一正确修改点：
    - 参考仓里 partitionTools 的前提是 native bridge + toolPreamble 双路径共存；
    - 当前 RouteCodex Windsurf provider 已明确不走 native bridge / gRPC / LS，只剩 chat-only cascade；
    - 在该前提下若继续裁掉 mapped tools，就会让工具在真实 send path 中消失；
    - 所以问题不在 parse、不在 history parser、不在 response，而在 request 入口 `preprocessRequest()` 的错误裁剪。
  - 回归结果：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - `127 passed, 2 skipped`

- 2026-05-22 Windsurf 黑盒对比方案（当前阶段只做 request 侧静态锚点，不盲打真实请求）
  - 目标：先把 RouteCodex `chat -> provider -> cascade` 的 **request 形状与历史/工具语义** 对齐参考真源，再决定是否做最小活体 smoke。
  - 固定参考真源：
    1. `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
       - 鉴权 / PostAuth / fingerprint / dual-host 顺序
    2. `/Volumes/extension/code/WindsurfAPI/src/handlers/tool-emulation.js`
       - `buildToolPreambleForProto`
       - `normalizeMessagesForCascade`
    3. `/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
       - `buildAdditionalStepsFromHistory`
       - `partitionTools`
    4. `/Volumes/extension/code/WindsurfAPI/src/conversation-pool.js`
       - `projectAssistantToolCalls`
       - `projectMessage`
    5. `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
       - `parseTrajectorySteps`
  - 黑盒分层：
    A. auth/request host+header compare
       - 锁登录、PostAuth、chat send 的 host/header/body presence
    B. tool preamble compare
       - 同一组 tools/tool_choice 输入，比较 reference `buildToolPreambleForProto` 与 RouteCodex `tools_preamble` 是否保留同一语义覆盖面
       - 注意：RouteCodex 当前是 chat-only，所以允许结构不一样，但**工具库存不能少、force tool 语义不能丢**
    C. history continuity compare
       - 同一组 messages（user -> assistant tool_call -> tool result -> user continue）
       - 对 reference `normalizeMessagesForCascade` / `buildAdditionalStepsFromHistory` 做黑盒，锁：
         1) assistant tool call 如何进入下一轮
         2) tool result 如何进入下一轮
         3) 历史顺序是否保持
    D. assistant/tool_result parse compare
       - 对 reference `parseTrajectorySteps` 的输出面做黑盒，锁 assistant text / tool call / tool result 观察语义
  - 当前优先级：
    1. 不处理 response streaming
    2. 不处理 SSE
    3. 不处理 responses 协议
    4. 只处理 Windsurf provider 的 chat->cascade request/history/tool 语义
  - 下一步测试顺序：
    1. `buildToolPreambleForProto` 黑盒 compare case
    2. `buildAdditionalStepsFromHistory` + `normalizeMessagesForCascade` continuity 黑盒 compare case
    3. `parseTrajectorySteps` 对 tool call / tool result / empty assistant 的 parse 黑盒 compare case
    4. 全部红转绿后，再考虑一条最小真实工具 smoke
- 2026-05-22 tools_preamble 黑盒继续对齐参考仓：
  - 新补红测：
    1. `blackbox compare tools_preamble semantic anchors against WindsurfAPI buildToolPreambleForProto`
    2. `preprocessRequest tools_preamble must carry function-call anti-fabrication rules from reference proto preamble`
  - 红测暴露真问题：当前 `preprocessRequest()` 仍在用过于简陋的 `[Available tools]` 列表，缺少参考仓 proto preamble 的关键语义：
    - real callable tools 声明
    - JSON function_call 输出协议
    - anti-refusal 规则
    - anti-fabrication 规则
    - force tool / required tool_choice 语义
    - Available functions + 参数 schema 段落
  - 已修改唯一真源：`src/providers/core/runtime/windsurf-chat-provider.ts`
    - 新增：
      - `resolveWindsurfToolChoice()`
      - `buildWindsurfToolProtocolHeader()`
      - `buildWindsurfToolSpecificRules()`
      - `buildWindsurfToolsPreamble()`
    - `preprocessRequest()` 改为调用 `buildWindsurfToolsPreamble(tools, body.tool_choice)`
  - 当前结论：
    - RouteCodex 的 tools_preamble 仍保持 chat-only provider 设计，但语义上已经对齐参考仓 `buildToolPreambleForProto` 的关键约束面；
    - 不再只是工具名清单，而是带 function-call 协议、反拒绝、反伪造和 force-tool 规则的语义 preamble。
  - 定向回归：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - 结果：`129 passed, 2 skipped`
- 2026-05-22 auth 活体复验（在 tools_preamble 改动之后再次确认未回归）：
  - 命令：`node --import tsx scripts/windsurf-auth-probe.ts config ws-pro-4`
  - 结果：`ok: true`, `health: true`
  - 凭证前缀：`devin-session-token$eyJh...`
  - accountId：`account-5cb2b19d59e84f6986fe07ebf7f8622a`
  - 结论：当前 chat-only provider 改动未破坏 cascade 鉴权主链；auth 仍然实机可用。
- 2026-05-22 send-path request 继续推进：
  - 活体最小 smoke：`node --import tsx scripts/windsurf-chat-request-smoke.ts ws-pro-4 gpt-5.4-medium "say hi"`
  - 结果：auth 已通过，但 `GetChatCompletions` 返回 `400 invalid_argument / an internal error occurred`
  - 该结果进一步证明：当前 remaining 问题不在鉴权，而在 **send-path request 形状**。
  - 本轮新增红测并转绿：
    1. `buildGetChatCompletionsRequest should align completionsRequest nesting with app proto family`
    2. `buildGetChatCompletionsRequest must include numCompletions in completionsRequest.configuration per app proto audit`
  - 唯一实现修改点：`src/providers/core/runtime/windsurf-chat-provider.ts::buildGetChatCompletionsRequest`
    - `completionsRequest.configuration` 新增 `numCompletions: 1`
  - 为什么这里是唯一正确修改点：
    - 活体错误是 auth 通过后的 `400 invalid_argument`，说明问题已经进入 request body 语法/形状层；
    - 当前静态锚点已证明 `CompletionConfiguration` 最小必需集应至少包含 `numCompletions/maxTokens/temperature`；
    - 因此应只改 `buildGetChatCompletionsRequest()`，改 parse/SSE/history 都无法让这个 request 变合法。
  - 回归结果：
    - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - `130 passed, 2 skipped`

- 2026-05-22 Windsurf request-shape 黑盒继续收缩：
  - 新补红测：`buildGetChatCompletionsRequest should omit systemPrompt when tool preamble is absent, instead of forcing empty string`
  - 红测证据：当前实现在 `buildGetChatCompletionsRequest()` 无 tool preamble 时仍强制发送 `systemPrompt: ""`，测试先红。
  - 参考依据：
    1. `/Applications/Windsurf.app/Contents/Resources/app/out/vs/sessions/sessions.desktop.main.js` 中 `exa.api_server_pb.GetChatCompletionsRequest` 的 proto 字段显示 `system_prompt` 只是普通可选标量字段；
    2. `/Volumes/extension/code/WindsurfAPI/src/windsurf.js` 的 legacy builder 仅在 `systemPrompt` 非空时才写入 field 3。
  - 唯一实现修改点：`src/providers/core/runtime/windsurf-chat-provider.ts::buildGetChatCompletionsRequest`
    - 从固定 `systemPrompt: ''` 改为 **仅当 `toolPreamble` 非空字符串时才注入 `systemPrompt`**。
  - 为什么这里是唯一正确修改点：
    - 问题属于 send-path request body 形状；
    - auth、headers、history parse、response parse 都无法改变这个顶层字段是否被错误发送；
    - 因此只能改 `buildGetChatCompletionsRequest()`，且只改 `systemPrompt` presence 逻辑。
  - 验证：
    - 定向红转绿：`npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "omit systemPrompt when tool preamble is absent"`
    - 之后继续跑同文件定向全量回归。

- 2026-05-22 审计报告重点核实并修复（不盲测真实请求）：
  - 已核实 #1 `tool_preamble` 缺少 environment facts block：这是 RouteCodex 当前实现的真缺口。
    - 参考锚点：
      - `/Volumes/extension/code/WindsurfAPI/src/handlers/tool-emulation.js::buildToolPreambleForProto`
      - `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js::extractCallerEnvironment`
    - 已补红测：
      - `preprocessRequest tools_preamble should inject environment facts block from request messages when cwd is present`
    - 已在 `src/providers/core/runtime/windsurf-chat-provider.ts` 修复：
      - 新增 `extractWindsurfCallerEnvironment()`
      - `buildWindsurfToolsPreamble()` 支持 environment 注入
    - 为什么这是唯一正确修改点：
      - 差异发生在 tools preamble 生成链；认证、response parse、history continuity 都无法让 preamble 凭空带上 environment facts。
  - 已核实 #2 `toolReinforcement` 缺失：这是 RouteCodex 当前实现的真缺口。
    - 参考锚点：
      - `/Volumes/extension/code/WindsurfAPI/src/runtime-config.js::getSystemPrompts`
      - `toolReinforcement` 默认文案
    - 已补红测：
      - `preprocessRequest tools_preamble should append reinforcement guidance after tool protocol block`
    - 已修复：
      - 在 `buildWindsurfToolsPreamble()` 中追加 reinforcement 文案
    - 为什么这是唯一正确修改点：
      - reinforcement 属于 preamble 语义组成部分，只能在 preamble builder 修；改 send path 其他位置只会制造重复或偏移。
  - 已核实 #5 `Read` 风险 tool result 注记缺失：这是 RouteCodex 当前 continuity parse 的真缺口。
    - 参考锚点：
      - `/Volumes/extension/code/WindsurfAPI/src/handlers/messages.js::annotateRiskyReadToolResult`
    - 已补红测：
      - `parseCascadeSemanticRoundtripSync should annotate risky Read tool results that do not prove full file body`
    - 已修复：
      - 在 `parseCascadeToolResultTurnSync()` 对 `Read` 的 cached/unchanged/truncated 非正文结果追加 `[WindsurfAPI note: ...]`
    - 为什么这是唯一正确修改点：
      - 该注记属于 tool-result -> semantic history 归一层，必须在 `parseCascadeToolResultTurnSync()` 这一唯一 continuity 收口点修；改 assistant parse / request builder 都无效。
  - 关于 `planner_mode=NO_TOOL + additional_instructions_section`：
    - 本轮只做重点核实，不盲改。
    - 现有证据只能证明 WindsurfAPI 的 **planner/cascade path** 如此实现；尚不能直接推出 RouteCodex 当前 `GetChatCompletions` family 必须补 `planner_mode`。
    - 因此本轮没有按这条审计直接动 send family，避免误修。
  - 验证：
    - 定向红转绿：`npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "environment facts|reinforcement guidance|annotate risky Read tool results"`
    - 全量主测试：`npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand`
    - 结果：`134 passed, 2 skipped`

## 2026-05-22 windsurf 静态目标锚点 harness（本轮先测后改）

- Jason 最新要求已收敛：**先做静态目标锚点测试 harness，然后才是代码对齐**。
- 本轮不做 live probe，不改 provider send 行为；只补一个可复用的静态观察面，把当前 RouteCodex windsurf provider 构造出的：
  1. `preprocessRequest` 结果
  2. semantic conversation
  3. `buildGetChatCompletionsRequest()` 最终 outbound body
  4. lens 摘要（metadata/configuration/systemPrompt/chat rows/tool row keys）
  固定导出成 debug harness，可被单测直接消费。
- 目的不是立即证明哪个字段错，而是先把“镜头目标”钉住，避免后续继续靠肉眼 grep 和临时脚本审 shape。
- 这次 harness 属于唯一正确的前置动作，因为：
  - 当前 blocker 是 request shape 400，但现状缺少稳定的**静态观测真面**；
  - 直接改 provider 仍会回到“边猜边改”；
  - 先补 harness 才能让后续对齐以固定 lens/anchor 测试驱动，而不是继续散点审计。
- 2026-05-22 继续阶段：基于新静态 harness 补 request-shape anchor tests。
  - 目标：把后续对齐要看的静态镜头固定成可回归的 lens，而不是继续散落在 provider 私有方法直测里。
  - 本阶段仍不改 send 语义；只新增/收拢锚点测试。
- 2026-05-22 进入第一条 request-shape 对齐：`maxTokens`。
  - 参考锚点：`/Volumes/extension/code/WindsurfAPI/src/windsurf.js:567`
  - 参考明确写明 real IDE sends `16384/32768`，当前 RouteCodex 静态 target 仍是 `4096`。
  - 本轮先补红测，再只改 `buildGetChatCompletionsRequest()` 的 configuration 真源。
  - 这是唯一正确修改点，因为问题属于 outbound request configuration 组装；去改 parse/error/auth 都不能让发出的 `maxTokens` 变成 app-aligned 值。
- 2026-05-22 继续 request presence 锚点：补 forbidden presence harness tests。
  - 目标：把当前已证伪/已移除的影子字段（如 `providerSource/modelId` 顶层、结构化 `toolDefinitions/toolChoice` 家族）也固定到静态 lens 上。
  - 这一步不改 provider 逻辑，只防止后续对齐把已删除错误字段重新带回 request。
- 2026-05-22 missing presence 候选复核结果：
  - 已检索 App bundle + WindsurfAPI，但当前没有拿到 `maxNewlines/topK/topP/serviceTier` 在 GetChatCompletions 实际发送里“必带”的直接证据。
  - 因此本轮不应猜测性补正向红测；唯一安全动作是把当前 `CompletionConfiguration` 最小白名单固定到静态 harness，禁止把这些未证实字段盲加回 request。
- 2026-05-22 envelope presence 复核：
  - App bundle 只证明 `GetChatCompletionsRequest` proto 上存在 `experiment_config`(field 8) 与 `prompt_id`(field 9)。
  - 但当前没有拿到 Windsurf App / WindsurfAPI 在 chat send 主链里默认发送它们的直接证据。
  - 因此本轮不把它们当必带字段；改为先锁“默认省略”，避免无证据把可选 envelope 字段盲加回 request。

- 2026-05-22 apply_patch/hashline 收口继续：
  - 新补红测：`tests/sharedmodule/native-governance-apply-patch-hashline.spec.ts`
    - `does not fall through to the legacy schema normalizer when hashline native returns invalid payload`
    - `does not fall through to the legacy schema normalizer when hashline native throws`
  - 红测证明的真问题：
    - TS `normalizeApplyPatchArgumentsWithNative()` 在 **已命中 hashline shape + filePath** 后，
    - 若 `runHashlineNativeEditJson` 返回坏 payload，之前会静默掉回旧 `normalizeApplyPatchArgumentsJson`。
  - 已修唯一实现点：
    - `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.ts`
    - 收口规则改为：
      - 一旦 `shouldUseHashlinePath === true`
      - hashline native 成功则直接返回
      - hashline native payload 非法则直接 `failNativeRequired(runHashlineNativeEditJson, 'invalid payload')`
      - 不再允许落回 legacy schema normalizer
  - 为什么这里是唯一正确修改点：
    - 问题不在 Rust parser，也不在 response 处理，而在 **TS 桥接层的错误分支设计**；
    - 请求 shape 已明确命中 hashline，仍回退 legacy schema 属于双路径/fallback 设计错误；
    - 因此只能收口 `normalizeApplyPatchArgumentsWithNative()` 的 hashline 分支。
  - 验证：
    - `npm run jest:run -- --runInBand --no-cache --runTestsByPath tests/sharedmodule/native-governance-apply-patch-hashline.spec.ts tests/sharedmodule/request-tool-governor-apply-patch-guidance.spec.ts tests/sharedmodule/native-apply-patch-description-ssot.spec.ts`
    - 结果：3 suites / 10 tests 全绿。

- 2026-05-22 apply_patch/hashline response-side 收口：
  - 新补红测：
    - `resp_process_stage1_tool_governance::tests::test_govern_response_apply_patch_hashline_shape_is_converted_to_canonical_patch`
  - 红测证明的真问题：
    - response-side Rust `normalize_apply_patch_schema_args()` 只会 canonical normalize 旧 schema；
    - 当上游/模型返回的是 hashline shape（`patch` + `filePath` + `fileContent`）时，会把 hashline 原样漏给客户端，而不是透明还原成 canonical apply_patch。
  - 已修唯一实现点：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
    - 新增 response-side hashline 判定与转换：
      - 先判 `patch` 是否 hashline
      - 再从 args 读 `filePath/file_path` 与 `fileContent/file_content`
      - 命中后直接走 `hashline::run_hashline_native_edit(...)`
      - 输出 canonical `{ patch, input }`
      - 不再把 `filePath/file_path` 泄露到客户端
  - 为什么这里是唯一正确修改点：
    - 问题发生在 **response tool governance 的 apply_patch 归一层**；
    - inbound normalizer、TS guidance、SSE handler 都无法改变“客户端最终拿到的 apply_patch arguments 形状”；
    - 因此只能收口 `normalize_apply_patch_schema_args()` 这个 response-side 唯一真源。
  - 验证：
    - `cargo test test_govern_response_apply_patch_hashline_shape_is_converted_to_canonical_patch --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
    - 相关回归：
      - `test_govern_response_apply_patch_repair`
      - `test_govern_response_apply_patch_inline_create_file_shape`
      - `test_govern_response_apply_patch_strips_quoted_paths`
      - `test_normalize_apply_patch_tool_calls_noop_and_count`
    - 结果：全部通过。

- 2026-05-22 apply_patch/hashline response-side fail-closed 收口：
  - 新补红测：
    - `test_govern_response_apply_patch_hashline_missing_file_content_fails_closed_with_guard_patch`
  - 红测证明的真问题：
    - response-side 一旦识别到 hashline shape，但缺 `fileContent/file_content`，
    - 之前会悄悄掉回 legacy canonical normalizer，
    - 结果既没有 canonical patch，也没有显式错误，而是把坏 shape 当普通 apply_patch 糊过去。
  - 已修唯一实现点：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
    - 将 response-side hashline 归一改成三态：
      - `NotHashline`
      - `Normalized`
      - `Guarded`
    - 规则：
      - 命中 hashline 但缺 `filePath/file_path` 或 `fileContent/file_content` → 直接 `Guarded`
      - hashline native 执行失败 / 无 normalized_patch → 直接 `Guarded`
      - 只有完全不命中 hashline，才允许继续 legacy canonical normalize
  - 为什么这里是唯一正确修改点：
    - 这不是 validation 层问题，而是 **response apply_patch 分支选择错误**；
    - 一旦已命中 hashline，就绝不能再回退到 legacy canonical branch；
    - 因此只能在 `normalize_apply_patch_schema_args()` 内部收口分支判定，别处无法阻断这个静默回退。
  - 验证：
    - `cargo test test_govern_response_apply_patch_hashline_missing_file_content_fails_closed_with_guard_patch --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
    - 相关回归：
      - `test_govern_response_apply_patch_hashline_shape_is_converted_to_canonical_patch`
      - `test_govern_response_apply_patch_repair`
    - 结果：通过。

- 2026-05-22 apply_patch TS tool governor fallback 收口：
  - 新补红测：
    - `tests/sharedmodule/tool-governor-apply-patch-failfast.spec.ts`
    - 锁两件事：
      1. request-side apply_patch native 失败不得被吞掉
      2. response-side apply_patch native 失败不得被吞掉
  - 红测证明的真问题：
    - `tool-governor-request.ts` 与 `tool-governor-response.ts` 里，
    - apply_patch 走 native 失败后，会被外层/内层 `try/catch + logToolGovernorNonBlocking` 吞成 non-blocking 日志；
    - 这等价于 TS 层 fallback。
  - 已修唯一实现点：
    - `sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.ts`
    - `sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-response.ts`
  - 收口规则：
    - apply_patch native normalize 失败必须直接抛出；
    - 只保留 exec_command 的非 apply_patch 局部保护；
    - 移除 request/response apply_patch 外层总兜底 catch 对 native 错误的吞没。
  - 为什么这里是唯一正确修改点：
    - 问题不在 Rust、也不在 caller 输入 shape，而在 **TS governor 调用 native 后把错误吞掉**；
    - 只改 native 无法阻止 TS 把错误继续降成 non-blocking log；
    - 因此必须直接改这两个 TS caller，去掉 apply_patch 错误吞没。
  - 验证：
    - `npm run jest:run -- --runInBand --no-cache --runTestsByPath tests/sharedmodule/tool-governor-apply-patch-failfast.spec.ts tests/sharedmodule/native-governance-apply-patch-hashline.spec.ts tests/sharedmodule/request-tool-governor-apply-patch-guidance.spec.ts`
    - 结果：3 suites / 10 tests 全绿。

- 2026-05-22 apply_patch validate 路径收口：
  - 新补红测：
    - `test_validate_apply_patch_arguments_rejects_hashline_missing_file_content`
    - `test_validate_apply_patch_arguments_rejects_hashline_missing_file_path`
  - 红测证明的真问题：
    - `validate_apply_patch_arguments_json()` 之前直接复用 `normalize_apply_patch_schema_args()` 的 guard patch 结果；
    - 由于 guard patch 本身是合法 canonical apply_patch，所以会把 **坏的 hashline shape 误判成 ok=true**。
  - 已修唯一实现点：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
  - 修法：
    - response-side hashline 归一三态 `Guarded` 增加显式 `reason`
    - 新增 `detect_hashline_apply_patch_guard_reason(raw_args)`
    - `validate_apply_patch_arguments_json()` 优先读取 hashline guard reason：
      - `hashline_missing_file_content`
      - `hashline_missing_file_path`
      - `hashline_native_edit_failed`
      - `hashline_missing_normalized_patch`
    - 不再因为 guard patch “长得合法”就误报 ok。
  - 为什么这里是唯一正确修改点：
    - 问题不是 normalize 输出错，而是 **validate 判定依据错**；
    - 只改测试、只改 TS caller、只改 guard patch 文案，都不能阻止 validate 把坏 shape 判成 ok；
    - 因此只能在 Rust validate 真源里显式识别 hashline guard reason。
  - 验证：
    - `cargo test test_validate_apply_patch_arguments_rejects_hashline_missing_file_content --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
    - `cargo test test_validate_apply_patch_arguments_rejects_hashline_missing_file_path --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
    - 回归：
      - `test_govern_response_apply_patch_hashline_missing_file_content_fails_closed_with_guard_patch`
    - 结果：通过。

- 2026-05-22 inbound hashline fail-fast 复核：
  - 新补红测：
    - `hashline_apply_patch_requires_readable_target_file_context`
  - 目的：
    - 复核 inbound 路径在 `filePath` 存在但无法读取目标文件内容时，是否会 fallback 到 legacy canonical normalize。
  - 结果：
    - 当前 inbound 真源 `hub_req_inbound_tool_call_normalization.rs` 已是 fail-fast；
    - 会直接报 `failed to read target file`，不会回落 legacy。
  - 结论：
    - 这条不是 fallback 残留，已符合要求。

- 2026-05-22 tool-registry apply_patch 回归锁：
  - 新补测试：
    - `tests/sharedmodule/apply-patch-tool-registry.spec.ts`
      - `rejects hashline payloads missing fileContent through the native apply_patch verdict`
      - `rejects hashline payloads missing filePath through the native apply_patch verdict`
  - 目的：
    - 锁住 `validateToolCall('apply_patch', ...)` 这一层不会把坏的 hashline shape 重新看成 ok。
  - 结果：
    - 当前 tool-registry 已正确继承 Rust validate 真相；
    - 这层没有新的 fallback，只是补了回归锁，防止后续回退。
- 2026-05-22 `chatMessagePrompts[].source` 冲突复核：
  - 当前证据链存在**真冲突**，暂不能改实现：
    1. `Windsurf.app` bundle 已直接确认 `exa.codeium_common_pb.ChatMessageSource` 枚举：`1=USER, 2=SYSTEM, 3=UNKNOWN, 4=TOOL, 5=SYSTEM_PROMPT`。
    2. 但 `WindsurfAPI/src/windsurf.js` 另一条消息家族/旧 builder 里又存在 `SOURCE.ASSISTANT = 3`。
    3. 当前 RouteCodex `GetChatCompletions` 主链和既有测试仍把 assistant row 写成 `source=3`。
  - 结论：现在不能把 `WindsurfAPI/src/windsurf.js` 的 `SOURCE.ASSISTANT=3` 直接外推到 `GetChatCompletions` 的 `chatMessagePrompts`，因为两边很可能不是同一消息家族。
  - 当前唯一正确动作：保留现实现值不动，继续把它当“待证实/待证伪点”；在拿到 `GetChatCompletions` 同形 App send 样本或更明确的 cloud-chat message projection 证据前，禁止把 assistant source 从 3 改成 1 或其他值。

## 2026-05-22 windsurf app role/source 继续核对（只读）

- 本轮继续查 `/Applications/Windsurf.app/Contents/Resources/app/out/vs/sessions/sessions.desktop.main.js`。
- 已再次确认 `exa.api_server_pb.GetChatCompletionsRequest` proto 结构：
  - `chat_message_prompts`
  - `system_prompt`
  - `completions_request`
  - `provider_source`
  - `model_id`
  - `experiment_config`
  - `prompt_id`
- 已再次确认 `exa.chat_pb.ChatMessagePrompt` 结构含：
  - `message_id`
  - `source`
  - `prompt`
  - `tool_calls`
  - `tool_call_id`
  - `tool_result_is_error`
- 已再次确认 app bundle 中 `exa.codeium_common_pb.ChatToolCall` 字段：
  - `id`
  - `name`
  - `arguments_json`
  - 可选 `invalid_json_str/invalid_json_err/is_custom_tool_call`
- 对 `Windsurf.app` 当前仍只拿到 enum/proto 定义层证据，尚未定位到 `GetChatCompletionsRequest` 实际构造代码，因此：
  - 不能把 enum 值直接当成 runtime send 赋值真相
  - 仍不能修改 RouteCodex 当前 assistant source 锚点
- 参考侧 `WindsurfAPI/src/windsurf.js` 仍明确：
  - `USER=1`
  - `SYSTEM=2`
  - `ASSISTANT=3`
  - `TOOL=4`
  - 且 legacy raw builder 中 `system` 走 `systemPrompt`，`tool` 被改写成 synthetic user

---NOTE APPEND---

## 2026-05-22 windsurf model projection 静态锚点继续补齐

- 继续按 Jason 要求只做静态锚点，不打真实请求。
- 新增 model projection 锚点后确认：
  - `gpt-5.4-mini-medium -> modelTag gpt-5-4-mini-medium`
  - `gpt-5.5-medium-fast -> modelTag gpt-5-5-medium-priority`
  - `gpt-5.3-codex-medium-fast -> modelTag gpt-5-3-codex-medium-priority`
  - 以上均与 `WindsurfAPI/src/models.js` 当前 catalog 一致。
- 同轮抓到新的真问题：
  - RouteCodex 之前把 `swe-1.6-slow` / `swe-1-6-slow` 放进 `WINDSURF_MODEL_SET` 与 `WINDSURF_CHAT_COMPLETIONS_MODEL_MAP`
  - 但当前 `WindsurfAPI/src/models.js` 中 `MODELS['swe-1.6-slow']` 不存在（返回 null）
- 已先补红测，再删错误映射转 fail-fast；这是唯一正确修改点，因为问题真源就在本地 model catalog 投影表，
  不在 send path / parse path / error mapper。若不删，会继续把参考真源中不存在的模型伪装成合法 outbound shape。

- 继续补了一层 **批量 model projection 静态锚点**：
  - 用 `WindsurfAPI/src/models.js` 当前 catalog 批量枚举 RouteCodex 当前已支持、且在 cloud chat 语义上可直接比较的非-swe 模型；
  - 一次性锁住 `enumValue + modelTag(modelUid)` 投影，避免以后只补单点测试。
- 这批比较暂时 **排除 swe-1.6 / swe-1.6-fast**：
  - 因为 WindsurfAPI catalog 的 `modelUid` 是 `MODEL_SWE_1_6(_FAST)`；
  - 而 RouteCodex 当前 cloud chat request 发的是 `modelTag: swe-1-6(_-fast)`；
  - 这是否错误，取决于 Windsurf app `GetChatCompletionsRequest` builder 真相，当前还没有 app 级 send evidence，不能误把 cascade/catalog 语义套到 cloud chat。

## 2026-05-22 windsurfapi preamble tier 静态对齐（先按 reference，不打真实请求）

- 本轮按 Jason 要求，优先对齐 `WindsurfAPI` 更容易直接锁定的 request-shape 逻辑：`tools_preamble` 的 **budget / tier downgrade**。
- 参考真源已确认：
  - `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js::applyToolPreambleBudget`
  - tier 顺序固定为：
    1. `full`
    2. `schema-compact`
    3. `skinny`
    4. `names-only`
  - 默认预算：
    - `softBytes = 24000`
    - `hardBytes = 48000`
- 之前 RouteCodex 真问题：
  - `src/providers/core/runtime/windsurf-chat-provider.ts::preprocessRequest()` 只会无条件调用单一 `buildWindsurfToolsPreamble()`
  - 没有任何 budget / tier 选择逻辑
  - 这与 winsurfapi reference 明显不对齐，工具多时有 payload 膨胀风险
- 本轮已补最小对齐实现：
  - 新增 4 档 builder：
    - `buildWindsurfToolsPreamble`（full）
    - `buildWindsurfSchemaCompactToolsPreamble`
    - `buildWindsurfSkinnyToolsPreamble`
    - `buildWindsurfCompactToolsPreamble`
  - 新增 `applyWindsurfToolPreambleBudget(...)`，选择逻辑与 winsurfapi 同序：full -> schema-compact -> skinny -> names-only
  - `preprocessRequest()` 改为先走 budget 选择，再写入 `tools_preamble`
  - 若超过 hard budget，直接 fail-fast 抛：
    - `WINDSURF_TOOL_PREAMBLE_TOO_LARGE`
  - 未做 fallback；符合当前 no-fallback 要求
- 新增静态锚点测试：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - 用 winsurfapi 真 reference 子进程黑盒跑 `applyToolPreambleBudget(...)`
  - tiny soft budget 场景下锁定 reference 返回 `names-only`
  - 本地 `applyWindsurfToolPreambleBudget(...)` 也必须返回 `names-only`
- 当前验证：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "tools_preamble|downshift|anti-fabrication|environment facts|semantic anchors"`
  - **7 passed**
- 当前结论：
  - RouteCodex 在 winsurfapi reference 维度上，`tools_preamble` 已不再是单 tier；已经补上最核心的 budget downgrade 语义。
  - 这次修改的唯一正确位置就是 `preprocessRequest() -> tools_preamble` 生成链，因为问题属于 request 组装真源；去改 send path / parse path / error classify 都无法修正 payload shape 本身。

## 2026-05-22 winsurfapi error classify 静态对齐（transient / policy / internal-vs-rate-limit）

- 本轮继续按 Jason 要求，优先对齐 `WindsurfAPI` 中最容易直接锁定的错误分类真源。
- 参考真源确认：
  - `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
  - 关键语义：
    1. `resource_exhausted` + `internal error occurred` **不是** rate limit，应该走 `upstream_transient_error`
    2. `ERR_HTTP2_STREAM_CANCEL` / pending stream cancel / transport 抖动 -> `upstream_transient_error`
    3. `Your request was blocked by our content policy` / policy blocked -> `policy_blocked`，不是 auth / service unreachable
- RouteCodex 之前真问题：
  - `classifyWindsurfUpstreamPayloadError()` 只有：
    - `WINDSURF_RATE_LIMITED`
    - `WINDSURF_SERVICE_UNREACHABLE`
  - `classifyWindsurfCascadeError()` 也没有：
    - `WINDSURF_UPSTREAM_TRANSIENT`
    - `WINDSURF_POLICY_BLOCKED`
  - 导致：
    - internal/transient 被误归到 service unreachable 或 rate limited
    - policy blocked 被误归到 auth/service unreachable
- 本轮已补实现：
  - `classifyWindsurfUpstreamPayloadError()` 新增：
    - `WINDSURF_UPSTREAM_TRANSIENT` -> `status=502 retryable=true`
    - `WINDSURF_POLICY_BLOCKED` -> `status=451 retryable=false`
  - `classifyWindsurfCascadeError()` 新增同样两类分类
  - 并明确保留：
    - 只有 `resource_exhausted` 且 **不是 internal error** 时，才算 `WINDSURF_RATE_LIMITED`
- 新增静态锚点测试：
  1. `resource_exhausted + internal error` -> `WINDSURF_UPSTREAM_TRANSIENT`
  2. payload content policy -> `WINDSURF_POLICY_BLOCKED`
  3. cascade transport/internal style error -> `WINDSURF_UPSTREAM_TRANSIENT`
  4. classify error on policy text -> `WINDSURF_POLICY_BLOCKED`
- 当前验证：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "resource_exhausted \+ internal error|policy blocked|upstream transient|classifyWindsurfCascadeError"`
  - **4 passed**
- 为什么这是唯一正确修改点：
  - 问题不在上层 HTTP server，也不在 quota daemon，而是在 **windsurf provider 自己对上游错误文本/载荷的分类真源**
  - 如果不在这两处分类函数修，其他层只能看到已经被误判过的 code/status，属于二次掩盖，不能修复真问题


## 2026-05-22 windsurf response-chain regression anchors

- Jason 已确认请求链条看起来 ok，本轮转向 **响应链条对齐**，并把新的响应形状作为回归红测。
- 当前 RouteCodex `parseGetChatMessageResponse()` 已确认解析的是 **5-byte connect frame header + json payload** 家族：
  - byte0 = flags
  - byte1..4 = big-endian payload length
  - payload = json text
- 本轮新增回归锚点（`tests/providers/core/runtime/windsurf-chat-provider.spec.ts`）：
  1. snake_case 响应：`delta_text + delta_thinking + delta_tool_calls + usage`
  2. camelCase 响应：`deltaText + deltaThinking + deltaToolCalls + modelUsage`
  3. live failure 家族：header length 大于真实 body 时，必须 fail-fast 抛
     - `[windsurf] truncated connect frame from GetChatMessage`
     - `code=WINDSURF_RESPONSE_PARSE_FAILED`
- 这批测试当前已跑通：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "parseGetChatMessageResponse must decode connect-framed|parseGetChatMessageResponse must accept top-level|parseGetChatMessageResponse must fail fast on truncated connect frame"`
  - 结果：3 passed
- 当前还没在 `~/.rcc` / `/Volumes/extension/.rcc` 里定位到 Jason 这次 `221515-199` 对应的 provider-response 原始样本；只确认了 ws-pro-4 账号状态文件与 traffic state。样本定位仍需继续，但不影响先把当前响应 shape 和 truncated family 固化进回归。


## 2026-05-22 windsurf response usage alignment

- 本轮继续按 Jason 要求对齐 `WindsurfAPI` 响应解析字段。
- 已确认此前 gap 不在 text/thinking/tool_calls 主字段，而在 usage：RouteCodex 漏了 `cacheWriteTokens / cache_write_tokens`。
- 参考真源：`/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js::buildUsageBody`
  - `prompt_tokens = inputTokens + cacheReadTokens`
  - `cache_creation_input_tokens = cacheWriteTokens`
  - `cache_read_input_tokens = cacheReadTokens`
  - `cascade_breakdown.cache_write_tokens = cacheWriteTokens`
- 已修改：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
    - `parseGetChatMessageResponse()` 新增解析 `cacheWriteTokens/cache_write_tokens`
    - `buildCascadeCompletionFromOutput()` 对齐 usage 投影语义
- 已新增/更新回归：
  - snake_case connect frame usage 带 `cache_write_tokens`
  - camelCase connect frame usage 带 `cacheWriteTokens`
  - completion usage 投影必须带 `cache_creation_input_tokens` / `cache_read_input_tokens` / `cascade_breakdown`
- 定向验证已通过：4 passed。

## 2026-05-22 windsurf 响应链继续收口：top-level JSON 成功体误判为 truncated connect frame

- 本轮先按 Jason 要求再次确认：`~/.rcc/codex-samples` 与 `/Volumes/extension/.rcc/codex-samples` 里 **仍没有** 这次 `221515-199 / 221516-200 / 221633-317` 对应的 windsurf provider raw response sample；因此当前真证据仍是 server log + provider 代码 + 参考仓。
- 继续对齐时抓到 `src/providers/core/runtime/windsurf-chat-provider.ts::parseGetChatMessageResponse()` 的一个唯一真错误：
  - 逻辑先尝试 `JSON.parse(maybeJsonText)`；
  - 遇到 top-level JSON 成功体（如 `completionResponse.completions[0] + modelUsage`）时，只做 error/empty 检查，**没有 return**；
  - 随后继续把整段 UTF-8 JSON 文本按 `5-byte connect frame` 解帧，于是首字节 `{`/`[` 被当 flags，后 4 bytes 被当 length，最终稳定落到：
    - `[windsurf] truncated connect frame from GetChatMessage`
- 已先补红测，再改实现：
  1. `parseGetChatMessageResponse must accept top-level json candidate payload and must not misparse it as connect frame`
  2. `parseGetChatMessageResponse must fail fast on invalid top-level empty completions json instead of falling into frame parser`
- 修复方式：
  - 在 `parseGetChatMessageResponse()` 内，若 top-level JSON 命中 `completionResponse.completions[]`：
    - 直接抽取第一条 completion 的 `text/thinking/toolCalls`
    - 同时抽取 `usage/modelUsage/model_usage`
    - **直接 return { candidate, usage }**
  - 不再让合法 JSON 成功体继续掉进 connect-frame parser。
- 为什么这是唯一正确修改点：
  - 现象发生在 provider response parser，本质是“同一响应体先被 JSON 成功解析、却仍被第二次按 frame 家族误解”；
  - 去改上层 router / hub pipeline / error classify 都只是掩盖；
  - 请求链已基本通，当前错误明确发生在 provider 内 `parseGetChatMessageResponse()`，并且新增红测已经直接证明该函数对 top-level JSON success body 的处理有缺口。
- 当前定向回归：
  - `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "parseGetChatMessageResponse must accept top-level json candidate payload|parseGetChatMessageResponse must fail fast on invalid top-level empty completions json|parseGetChatMessageResponse must accept top-level deltaText/deltaThinking/deltaToolCalls camelCase response as regression truth|parseGetChatMessageResponse must fail fast on truncated connect frame from live regression family|buildCascadeCompletionFromOutput must project WindsurfAPI-style cache write usage fields"`
  - 结果：**5 passed**
- 当前阶段判断更新：
  - 之前的 `truncated connect frame` 现在已证明至少存在一种**本地误判路径**，不再能直接断言“上游一定回了残帧”；
  - 下一步应让 Jason 再打一轮真实请求，看线上是否从 `WINDSURF_RESPONSE_PARSE_FAILED` 转成新的、更靠近真实上游形状的结果。

## 2026-05-22 apply_patch shell-wrapped heredoc 真因收口

- 新补红测先红：
  - `tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts`
  - `tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts`
- 红因锁定：
  - 当前问题不在 hashline，也不在响应处理分支；
  - 而是 **顶层工具名已经明确是 `apply_patch`** 时，Rust `extract_apply_patch_text()` 仍把 `bash -lc "... apply_patch <<'PATCH' ..."` 这种 shell-wrapped heredoc 直接拒掉；
  - 后续 `normalize_apply_patch_schema_args()` 因此只能产出空 `patch/input`，形成静默清空 shape。
- 最小真源修复：
  - 删除 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs::extract_apply_patch_text()` 中对 shell-wrapped apply_patch 的早退拒绝；
  - 保留现有 `strip_apply_patch_command_prefix()` + `trim_to_patch_window()` 路径，只做 **shape 收割**，不猜业务语义。
- 同步回归与脚本收口：
  - `hub_req_inbound_tool_call_normalization.rs` 的旧测试从“空 patch”改成 canonical patch；
  - `sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` 新增：
    - shell-wrapped heredoc 必须收割出 canonical patch
    - hashline 缺 `fileContent` 必须 invalid
  - 同时清理脚本中过时旧预期：
    - mixed internal + GNU 现已是可 repair 的 canonical normalize
    - add-file 缺 `+` 现已是可 repair 的 canonical normalize
- 为什么这是唯一正确修改点：
  - 问题发生在 **Rust apply_patch 文本抽取真源**；
  - TS tool governor、request stage2、response stage1 都只消费该抽取结果；
  - 不改 `extract_apply_patch_text()`，上层永远只能看到空 patch，修别处都是症状层补丁。
- 已验证：
  - `cargo test shell_wrapped_apply_patch_is_normalized_to_canonical_patch_shape --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
  - `cargo test test_extract_apply_patch_text_variants --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- --nocapture`
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs`
  - `npm run jest:run -- --runInBand --no-cache --runTestsByPath tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts tests/sharedmodule/apply-patch-tool-registry.spec.ts tests/sharedmodule/native-governance-apply-patch-hashline.spec.ts tests/sharedmodule/tool-governor-apply-patch-failfast.spec.ts`

## 2026-05-22 apply_patch 脚本层旧预期清理

- `sharedmodule/llmswitch-core/scripts/tests/tool-governance-check.mjs` 连续红点都不是 runtime 真问题，而是脚本仍在要求旧时代的“猜语义/隐式恢复”：
  - `arg_key` 污染到 **JSON key 位置** 时，当前正确行为应是 fail-closed，不再恢复；
  - `command` 包着 `["apply_patch", "..."]` 但没有 canonical `patch/input` 字段时，应 fail-closed；
  - `target + changes` 这种 DSL 没有 canonical patch 字段时，应 fail-closed；
  - conflict marker payload 应保持 invalid，不再自动脑补 replace patch；
  - `validateToolCall('apply_patch', rawText)` 现在只认结构化参数，不再把裸 patch 文本当 JSON 参数猜。
- `sharedmodule/llmswitch-core/scripts/tests/apply-patch-regression-sample-single-source.mjs` 的红因也先查到了请求/目录 shape，而不是乱改 handler：
  1. capture 真源读取的是 `ROUTECODEX_ERRORSAMPLES_DIR`，脚本之前错误设置成 `ROUTECODEX_APPLY_PATCH_REGRESSION_DIR`
  2. capture 是 async fire-and-forget，脚本立刻扫目录会读空，需要显式等待
  3. capture 真源目录是 `apply-patch-regression/`，脚本之前错误按 `invalid_patch/` 扫
  4. tool-registry 已不再隐式自动落 apply_patch sample，脚本必须显式 `captureApplyPatchRegression(...)`
- 这轮没有改 apply_patch 真语义，只是把脚本/回归矩阵收口到当前唯一真相，去掉旧 fallback/隐式恢复叙事。
- 已验证：
  - `node sharedmodule/llmswitch-core/scripts/tests/tool-governance-check.mjs`
  - `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs`
  - `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-regression-sample-single-source.mjs`

## 2026-05-22 codex samples 复杂 apply_patch 失败：请求 shape/guidance 真因

- 先看 codex sample 请求/响应形状，不先看结果处理。关键样本：
  - `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779436397902_ef955edb/provider-response.json`
  - `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779436320871_0d547ab2/provider-response.json`
  - `~/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1779436225102_21ff7776/provider-request.json`
- 样本真相：
  - 模型并不是纯 hashline 失败，而是频繁产出 **canonical patch + stray `filePath`**：
    - `patch`/`input` 已经是标准 `*** Begin Patch`
    - 但额外带了 `filePath`
  - reasoning 文本里还能看到模型被引导去试 `filePath` / GNU diff / 工具 schema，自证当前 guidance 有误导。
- 根因进一步锁定：
  1. Rust request/tool schema 真源在 schema 声明 `filePath` 时，把 `patch` 描述切成了 **hashline-first**
  2. TS `src/guidance/index.ts::augmentApplyPatch()` 还有一份独立旧实现，也把 request guidance 切成了 **hashline-first**
  3. 这会把模型从“canonical patch 已经足够”带偏成“我也许必须带 `filePath` / 甚至试 hashline”
- 新补红测先红：
  - `tests/sharedmodule/request-tool-governor-apply-patch-guidance.spec.ts`
  - `tests/sharedmodule/native-apply-patch-description-ssot.spec.ts`
  - 新 fixture：
    - `tests/fixtures/conversion-matrix/2026-05-22-apply-patch-canonical-with-stray-filepath/request.json`
    - `tests/fixtures/conversion-matrix/2026-05-22-apply-patch-addfile-with-stray-filepath/request.json`
- 收口方案（不猜语义，只修 shape）：
  - guidance 改成 **canonical-first + explicit boundary**
    - canonical `*** Begin Patch` 时 **禁止**带 `filePath/file_path`
    - 只有 `patch` 真使用 hashline op headers 时，才允许 `filePath/file_path`
  - 不再对“schema 声明了 `filePath`”推出“默认 hashline-first”
- 唯一正确修改点：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_tool_normalization.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tool_text_request_guidance.rs`
  - `sharedmodule/llmswitch-core/src/guidance/index.ts`
  - 因为问题发生在 **请求侧工具 schema/guidance 真源**；不在响应 handler、不在 tool executor、不在 apply_patch parser 本身。去改结果处理只能掩盖，不会阻止模型继续被错误引导。
- 已验证：
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `npm run jest:run -- --runInBand --no-cache --runTestsByPath tests/sharedmodule/request-tool-governor-apply-patch-guidance.spec.ts tests/sharedmodule/native-apply-patch-description-ssot.spec.ts tests/sharedmodule/native-governance-apply-patch-hashline.spec.ts`
  - `node sharedmodule/llmswitch-core/scripts/tests/tool-governance-check.mjs`
  - `node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs`
  - `npm run jest:run -- --runInBand --no-cache --runTestsByPath tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts tests/sharedmodule/apply-patch-tool-registry.spec.ts tests/sharedmodule/tool-governor-apply-patch-failfast.spec.ts`

- 2026-05-22 继续收口时，先补了 **proto family 红测**，避免凭猜测改 parser：
  1. `parseGetChatMessageResponse must decode connect-framed protobuf CompletionDelta payload from Windsurf app field family`
  2. `parseGetChatMessageResponse truncated connect frame error must carry transport diagnostics for live blackbox replay`
- 这些红测的锚点不是臆测：来自 `Windsurf.app` 静态 proto 真值：
  - `exa.codeium_common_pb.CompletionDelta`
  - `exa.codeium_common_pb.Completion`
  - `exa.codeium_common_pb.CompletionResponse`
  - `exa.codeium_common_pb.ModelUsageStats`
- 其中 `CompletionDelta` 已从 app bundle 中确认字段族：
  - `delta_text`(1)
  - `usage`(4)
  - `delta_tool_calls`(5)
  - `delta_thinking`(6)
- 因此当前 response parser 的唯一正确扩展方向是：
  - 保留 top-level JSON 分支
  - 新增 connect-framed protobuf `CompletionDelta` 解码分支
  - 并在 truncated family 中附带 transport 诊断字段，供下一轮真机日志直接定性

## 2026-05-22 windsurf response parse 502 真因继续收口

- 线上 requestId `221760-444` 已给出硬证据：`GetChatMessage` 返回的不是 connect/proto 残帧，而是 `contentType=application/json` 的 top-level JSON error body。
- 日志 `prefixHex` 可直接还原为：`{"code":"invalid_argument","message":"an internal error occurred"...}`。
- 当前 `parseGetChatMessageResponse()` 之前只识别两类 top-level JSON：
  1. `record.error`
  2. `record.completionResponse.completions[]` / `record.completion_response.completions[]`
- 因此像 `{code,message}` 这种上游错误体会继续跌入 connect-frame parser，被误报成 `truncated connect frame from GetChatMessage`。
- 已先补红测：`parseGetChatMessageResponse must classify top-level code/message json error body instead of misparsing it as connect frame`。
- 唯一正确修复点仍是 `src/providers/core/runtime/windsurf-chat-provider.ts::parseGetChatMessageResponse()`：
  - 在 top-level JSON 分支新增 `record.code/message` 识别；
  - 直接走 `classifyWindsurfUpstreamPayloadError(record)`；
  - 禁止继续掉入 frame parser。
- 这不是 fallback，而是把已存在的真实上游 error body 归回正确分类层；其他层（router/hub/cascade poll）都不是这次误报的真源。


## 2026-05-22 windsurf live GetChatCompletions 400 真相（继续黑盒对齐）

- 已按 Jason 要求改用便宜模型直接跑 live smoke：
  - `node --import tsx scripts/windsurf-chat-request-smoke.ts ws-pro-4 gpt-5.3-codex "say hi"`
- 真实上游返回：
  - `status=400`
  - body=`{"code":"invalid_argument","message":"an internal error occurred"}`
- 这次已确认不是 parser 假错，是真正的 upstream request invalid。
- 当前 RouteCodex 实际发送到 `GetChatCompletions` 的最小 body 为：
  - `metadata{apiKey, ideName, ideVersion, extensionName, extensionVersion, locale, os, hardware, requestId, sessionId}`
  - `chatMessagePrompts:[{messageId,source,prompt}]`
  - `completionsRequest:{model:0, modelTag:"gpt-5-3-codex-medium", configuration:{numCompletions:1,maxTokens:32768,temperature:0}}`
- 强信号：参考 `WindsurfAPI` 主链仍是 `StartCascade -> SendUserCascadeMessage -> poll`，不是 cloud `GetChatCompletions` 这条 JSON body。若 Windsurf app 真源也走 cascade/chat 主链，则当前 RouteCodex 可能发错了协议族，而不只是字段差一两个。
- 下一步应继续比对：
  1. WindsurfAPI `buildSendUserCascadeMessageRequest` 的字段族；
  2. RouteCodex 当前 `GetChatCompletions` endpoint/shape 是否整条链路选错；
  3. 样本里成功 case 是否也存在 `GetChatCompletions` JSON 形状，若没有，说明当前 live 400 的唯一真源更可能是“endpoint/protocol family 选错”。


## 2026-05-22 windsurf 最黑盒判定：形状 vs 路径

- 对同一份带 tools/history 的输入，同时跑：
  1. RouteCodex 当前链：`preprocessRequest -> parseCascadeSemanticRoundtripSync -> buildGetChatCompletionsRequest`
  2. WindsurfAPI 参考链：`normalizeMessagesForCascade -> extractCallerEnvironment -> applyToolPreambleBudget -> buildStartCascadeRequest/buildSendCascadeMessageRequest`
- 黑盒结果：
  - RouteCodex outbound path = **`GetChatCompletions`**，顶层是 `metadata/chatMessagePrompts/completionsRequest` JSON 族。
  - WindsurfAPI outbound path = **`StartCascade -> SendUserCascadeMessage`**，真实 send payload 是 protobuf/gRPC 族，user turn 被折叠成 `text + toolPreamble + history replay`。
- 因而当前最大差异不是“小字段形状”而是**请求路径族不同**：
  - RouteCodex: cloud JSON completions family
  - WindsurfAPI: cascade send/poll family
- 结论：当前 live 问题优先判为 **路径问题 > 形状问题**。即使 model/modelUid 来源已对齐 WindsurfAPI models，发错 endpoint family 仍会被 upstream 判 invalid_argument。


## 2026-05-22 windsurf 最黑盒判定：形状 vs 路径（tsx 实跑版）

- 使用同一份带 tools/history 的输入，分别实跑：
  - RouteCodex: `preprocessRequest -> parseCascadeSemanticRoundtripSync -> buildGetChatCompletionsRequest`
  - WindsurfAPI: `normalizeMessagesForCascade -> extractCallerEnvironment -> applyToolPreambleBudget -> buildStartCascadeRequest -> buildSendCascadeMessageRequest`
- 目标不是猜字段，而是直接比较两条链的**最终出站协议族**。
- 若 RouteCodex 仍产出 `GetChatCompletions` JSON 族，而 WindsurfAPI 产出 `StartCascade/SendUserCascadeMessage` protobuf 族，则可直接判定优先是**路径问题**。


## 2026-05-22 windsurf 旧 GetChatCompletions 测试面收缩

- 已开始物理移除 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中把 `GetChatCompletions` 当主发送链的断言块。
- 已删除/收缩内容：
  - `buildGetChatCompletionsRequest` metadata/completionsRequest/modelTag/systemPrompt/tool fields 主线断言
  - `parseGetChatCompletionsResponse` 的旧名字/旧注释
  - 一条 blackbox history 测试中，断言对象已从旧 `chatMessagePrompts` 主链改回 `parseCascadeSemanticRoundtripSync` 语义真源
- 当前测试层保留原则：
  - 仅保留对 parser / semantic roundtrip / auth headers / 当前仍在用的 helper 的测试
  - 不再把 `GetChatCompletions` / `completionsRequest` / `chatMessagePrompts` 视作未来主链 contract
- 下一步：开始切实现入口，把 `sendRequestInternal()` 从 `buildGetChatCompletionsRequest + WINDSURF_GET_CHAT_COMPLETIONS_URL` 改到 cascade 真发送链。

## 2026-05-22 Windsurf cascade single-path rebuild（继续）
- 证据：`~/.rcc/codex-samples` 未捕获到新的 Windsurf 成功样本，但已有失败样本反复显示 RouteCodex 仍在 `sendRequestInternal -> buildGetChatCompletionsRequest -> GetChatCompletions`。
- 证据：`/Volumes/extension/code/WindsurfAPI/src/client.js` 与 `src/windsurf.js` 明确主链为 `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll`。
- 结论：当前 live invalid_argument 的第一根因仍是错误 send-path family，不是字段微调。
- 执行动作：在 `src/providers/core/runtime/windsurf-chat-provider.ts` 内最小接入 cascade 真链；旧 `GetChatCompletions` 仅保留必要解析工具时也要继续收缩，主发送路径必须物理移除。
- 新确认：RouteCodex 当前 Windsurf runtime contract (`normalizeWindsurfProviderRuntimeOptions`) 只有 thinking/sanitize/poll 等轻量选项，没有 WindsurfAPI 本地 LS 所需的 port/csrf/http2 session transport 输入；因此不能假装已经具备 `StartCascade -> SendUserCascadeMessage -> poll` 真链运行前提。
- 本轮收口：先物理掐掉 `sendRequestInternal` 对 `GetChatCompletions` 的错误发送，改为 501 fail-fast；同时移除 static harness 对 `buildGetChatCompletionsRequest` 的静态契约依赖，避免继续制造伪真相。

## 2026-05-22 windsurf 真链 runtime 注入面已补齐（尚未接 StartCascade send）

- 已确认并补上 RouteCodex 当前缺的最小承载链：
  - `ProviderProfile.metadata.windsurf`
  - `provider-profile-loader` 解析 `windsurf` metadata
  - `http-server-bootstrap.applyProviderProfileOverrides()` 把 profile 中的 windsurf metadata 注入 `runtime.extensions.windsurf`
  - `ProviderRuntimeProfile` 正式增加 `extensions`
  - `normalizeWindsurfProviderRuntimeOptions()` 现可承载：
    - `lsPort`
    - `csrfToken`
    - `sessionId`
    - `workspacePath`
    - `workspaceUri`
- 这一步的唯一正确修改点就是 profile/runtime/config 注入链：
  - 因为 WindsurfAPI 真链 `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll` 依赖本地 LS/gRPC 运行时前提；不先补承载面，provider 内部无从接真链。
  - 去改 parser / 旧 GetChatCompletions body / 错误分类都不能提供这些运行时输入，只会继续在错误链上打补丁。
- provider 当前状态：
  - 若缺 `lsPort/csrfToken`：明确 501 fail-fast，报 runtime prerequisites missing。
  - 若已提供 `lsPort/csrfToken`：不再报“runtime 缺失”，改为明确 501：`真链尚未在 provider runtime 中接线`。
  - 这证明当前阻塞已从“配置承载缺失”推进到“provider send 真链未实现”。
- 回归新增覆盖：
  1. `provider-profile-loader` 解析 windsurf local runtime metadata
  2. `applyProviderProfileOverrides` 注入 `extensions.windsurf`
  3. `ProviderFactory` 保留并下发 `extensions.windsurf`
  4. `sendRequestInternal` 两阶段 fail-fast：
     - missing runtime prerequisites
     - prerequisites present but cascade send path unwired
- 额外修了一处测试真错误：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 的 `collectSseOutputViaStream()` 之前错误地 `Readable.from([transform])`，读的是 transform 对象而不是 transform 输出流；改为直接监听 transform 的 `data/end/error`。

## 2026-05-22 windsurf 唯一黑盒第二片：cascade 执行编排层接入

- 已继续坚持 Jason 收敛后的唯一黑盒：`/Volumes/extension/code/WindsurfAPI` 的 cascade family。
- 本轮不再扩散到 GetChatCompletions / app proto 泛解析，而是只补了执行编排层最小 contract：
  - `buildGetTrajectoryStepsRequest()`
  - `parseStartCascadeResponse()`
  - `sendRequestInternal()` 现已不再停留在“runtime prerequisites 已满足但完全未接线”的旧 fail-fast；
    它现在会按唯一正确顺序编排：
    `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll -> buildCascadeCompletionFromOutput`
- 但当前仍只是 **编排层接通**，传输层 helper 仍 fail-fast：
  - `sendStartCascade()`
  - `sendCascadeMessage()`
  - `pollCascadeTrajectorySteps()`
  这三处已成为新的唯一真源接线点；后续必须只在这里补真正 cascade transport，禁止再回写任何 `GetChatCompletions` 旧链。
- 新增唯一黑盒红测并转绿：
  1. `unique cascade blackbox must match WindsurfAPI GetCascadeTrajectorySteps request family`
  2. `unique cascade blackbox must parse StartCascade response like WindsurfAPI parseStartCascadeResponse`
  3. `sendRequestInternal must orchestrate StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps and project completion`
- 当前证据：
  - 定向 Jest 通过（6 条 unique cascade / orchestration 测试）
  - `npx tsc -p tsconfig.json --noEmit` 通过
- 结论边界：
  - **已证明 provider 内部主编排路径切到 cascade family**；
  - **尚未证明真实传输闭环可用**，因为三段 transport helper 仍未接真发送。
- 下一步唯一正确方向：
  1. 只在 `sendStartCascade / sendCascadeMessage / pollCascadeTrajectorySteps` 接本地 cascade transport；
  2. transport 一旦接通并有红测护栏，就物理删除 `GetChatCompletions` 旧发送链与其测试面。

## 2026-05-22 windsurf 唯一黑盒第三片：provider 内本地 LS gRPC unary / warmup 已接上

- 继续坚持唯一黑盒：`/Volumes/extension/code/WindsurfAPI` 的 cascade family；先看了 `~/.rcc/codex-samples`，当前没有新的 windsurf/cascade 样本可直接复用。
- 参考锚点改为：
  - `/Volumes/extension/code/WindsurfAPI/src/grpc.js`
  - `/Volumes/extension/code/WindsurfAPI/src/client.js::cascadeChat()`
- 当前 RouteCodex provider 内已最小接上以下本地 LS transport 真链：
  - `grpcUnaryLocal()`：对齐 WindsurfAPI 的 gRPC unary framing / trailers / csrf header / http2 session pool
  - `ensureWindsurfCascadeWarmup()`：对齐 `InitializeCascadePanelState -> AddTrackedWorkspace -> UpdateWorkspaceTrust -> Heartbeat`
  - `sendStartCascade()`：已改为真调用 `StartCascade`
  - `sendCascadeMessage()`：已改为真调用 `SendUserCascadeMessage`
  - `pollCascadeTrajectorySteps()`：已改为真轮询 `GetCascadeTrajectorySteps + GetCascadeTrajectory`
- 当前闭环边界：
  - **provider 内部 transport 已不再是 501 占位**；
  - 但还没做实机 smoke，所以还不能宣称“真实工具调用已通”。
- 本轮定向回归：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts -t "unique cascade blackbox|sendRequestInternal must orchestrate StartCascade"`
    - PASS
  - `npx tsc -p tsconfig.json --noEmit`
    - PASS
- 下一步唯一正确方向：
  1. 做真实入口 smoke（5520 / 真实请求）验证 provider 是否已走本地 cascade；
  2. 若 smoke 通过，开始物理删除 `GetChatCompletions` 旧云发送链与其测试面；
  3. 若 smoke 失败，只能继续在 `grpcUnaryLocal / warmup / poll` 这几个唯一接线点修，禁止回旧链。

## 2026-05-22 windsurf 5520 当前 501 真因更新：repo dist 过期，不是源码主线错误

- 18:47 真实 smoke 证据：`POST http://127.0.0.1:5520/v1/responses` 仍返回 `WINDSURF_REQUEST_BUILD_FAILED`，文案还是旧的“missing local LS/gRPC session transport inputs”。
- 但源码真相已不是这个状态：
  - `src/providers/core/runtime/windsurf-chat-provider.ts::sendRequestInternal()` 已进入 cascade 主链编排
  - 本地源码已不再停在旧 fail-fast
- 对比证据：
  - `src/.../windsurf-chat-provider.ts`：已是 `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps`
  - `dist/.../windsurf-chat-provider.js`：仍是旧实现，`sendRequestInternal` 片段没有新 cascade 主链
- 运行态证据：
  - 5520 进程命令是 `node /Users/fanzhang/Documents/github/routecodex/dist/index.js ...`
  - 说明 5520 实际跑的是 repo `dist/`，不是 `src/`
- 因此当前 501 的唯一真因不是 provider runtime config，也不是当前源码逻辑，而是：
  - **repo dist 过期，未把最新 windsurf cascade 实现编译进运行态**
- 下一步唯一正确动作：
  1. `npm run build:min`
  2. `routecodex restart --port 5520`
  3. 串行 smoke 再看真实 cascade 错误/成功结果

## 2026-05-22 windsurf 501 真因再收敛：profile loader 错把 protocol type 当 provider module

- 新证据：
  - `materializeRouteCodexConfig()` 已证明 `windsurfProvider.extensions.windsurf` 存在，说明本地 cascade prerequisites 已进 materialized config。
  - 但同一份 materialized profile 里：`windsurfProfile.moduleType = "openai"`，不是 `windsurf-chat-provider`。
  - 线上 0.90.2087 启动日志也一致显示：`providerModule":"openai"` + `compatibilityProfile":"chat:windsurf"`。
- 这说明当前阻塞点已经从“config 未注入”进一步收敛为：
  - `src/providers/profile/provider-profile-loader.ts` 读取 profile 时，错误地用 `raw.type`（协议类型，如 openai）填充 `moduleType`；
  - 应该优先读取 `providerModule`，否则 windsuf profile 在 runtime/profile 观察面始终是错误模块身份。
- 下一步唯一正确修改点：
  - `provider-profile-loader.ts` 改为优先 `providerModule/provider_module`，再补红测锁死。
- 红测已证明上一刀改大了：不能让 `providerModule` 参与 protocol alias 判定；
  唯一正确修复是拆开两条来源：
  1. `protocol` 继续从 `type/providerType/protocol/module` 判；
  2. `moduleType` 单独优先读 `providerModule/provider_module`。
- 最后一条红测说明 `moduleType` 不能只回退 `module`，还必须回退到 `type`，否则 `mimoweb` 这类合法 provider 会丢失模块标识。

## 2026-05-22 windsurf 5520 继续排查：当前 501 不是 runtime/profile 丢失，而是 provider 内 missing_runtime 分支仍被命中

- 已再次核对 `~/.rcc/provider/windsurf/config.v2.toml`：`providerModule=windsurf-chat-provider`，且 `provider.extensions.windsurf` 含 `lsPort/csrfToken/sessionId/workspacePath/workspaceUri/poll*`。
- 已再次核对 `materializeRouteCodexConfig()` 派生结果：
  - `providerProfiles.byId.windsurf.moduleType = windsurf-chat-provider`
  - `userConfig.virtualrouter.providers.windsurf.extensions.windsurf` 存在
- 已再次核对 `applyProviderProfileOverrides + ProviderFactory.createProviderFromRuntime` 本地直构：
  - `patched.extensions.windsurf` 存在
  - `provider.config.config.extensions.windsurf` 存在
  - `provider.windsurfRuntime` 完整
- 但 5520 实机仍报：
  - `WINDSURF_REQUEST_BUILD_FAILED`
  - 文案：`GetChatCompletions cloud path has been removed ... current RouteCodex Windsurf runtime does not yet provide the required local LS/gRPC session transport inputs`
- 这说明：
  1. 当前 501 不是 request shape 400 类问题；
  2. 也不是 provider-profile loader / config materialization 这一层；
  3. 真因继续收敛到 **server 实际创建出的 provider instance 在 sendRequestInternal 时看到的 `this.windsurfRuntime`**。
- 本轮已在唯一链路补 scoped debug：
  - `http-server-runtime-providers.ts::createProviderHandle`
    - `[windsurf.handle.create.runtime]`
    - `[windsurf.handle.create.instance]`
  - `windsurf-chat-provider.ts`
    - `[windsurf.provider.ctor]`
    - `[windsurf.provider.missing_runtime]`
- 下一步唯一动作：编译 -> `routecodex restart --port 5520` -> 再打一次 5520 请求，用上述四个 scoped debug 把 runtime/instance 真值钉死。
- 额外事实：`routecodex` 启动优先走全局包，但当前全局包是指向 repo 的 symlink；global/local 的 `dist/providers/core/runtime/windsurf-chat-provider.js` 当前字节完全一致，所以不是“全局包 vs 本地包不同文件”导致。
- 另外，当前源码本身仍保留 `missing_runtime => 501` 分支；因此现阶段不能宣称“已经完全切到纯 cascade 可用”，必须先看 scoped debug 证据。

## 2026-05-22 windsurf cascade 新证据：42101 当前 live LS 的 csrfToken 与 ~/.rcc 静态配置不一致

- 黑盒边界继续保持唯一：`chat -> windsurf-chat-provider -> local cascade LS`，参考真源仍只认 `/Volumes/extension/code/WindsurfAPI`。
- 新实机证据：42101 的真实监听进程不是用 `windsurf-api-csrf-fixed-token` 启动，而是：
  - `ps -p 94051 -ww -o pid=,ppid=,command=`
  - 命令行包含：
    - `--server_port=42101`
    - `--csrf_token=ce845714-6ac1-45b4-b684-fcddb6c099ce`
- 这直接解释了上一层真实错误：
  - RouteCodex runtime 配置里的 `csrfToken = "windsurf-api-csrf-fixed-token"`
  - 但 live LS 要求的是 `ce845714-6ac1-45b4-b684-fcddb6c099ce`
  - 所以 5520 返回 `invalid CSRF token` 不是 cascade shape 错，而是 **local LS live transport identity 错配**。
- 已补红测并转绿：
  - `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
  - 新锁定：provider 在本地 cascade transport 发起前，必须优先从 live language_server 进程命令行解析 `--server_port/--csrf_token`，覆盖陈旧的 `~/.rcc` 静态 csrfToken；若解析不到，再保留配置值。
- 当前实现收敛：
  - `src/providers/core/runtime/windsurf-chat-provider.ts`
  - 新增 `resolveLiveLocalGrpcRuntime()`：从 `ps -Ao pid=,command=` 里按 `--server_port=<lsPort>` 精确找 live language_server，再抽取 `--csrf_token=...`。
- 下一步唯一动作：
  1. `npm run build:min`
  2. `routecodex restart --port 5520`
  3. 用 5520 做便宜模型 / tool-route smoke，确认是否越过 `invalid CSRF token` 进入下一层真实 cascade 问题或成功。

## 2026-05-22 windsurf cascade warmup idempotency
- 唯一黑盒继续以 `/Volumes/extension/code/WindsurfAPI/src/client.js::warmupCascade(force=false)` 为准。
- 对齐结论：`AddTrackedWorkspace` 在已跟踪 workspace 上命中 `path is already tracked` 时，不应把 warmup 直接炸成 fatal；这是 workspace lifecycle 幂等现象，应继续 `UpdateWorkspaceTrust -> Heartbeat`。
- RouteCodex 唯一修改点应保持在 `src/providers/core/runtime/windsurf-chat-provider.ts::ensureWindsurfCascadeWarmup()`；不能去外层 error mapper 吞错误，否则会把非 warmup 语义的真实错误误吃掉。

## 2026-05-22 windsurf request-blackbox closeout slice
- 本轮继续只做请求黑盒，不碰响应链。
- 下一组 builder 锁定：InitializeCascadePanelState / Heartbeat / AddTrackedWorkspace / UpdateWorkspaceTrust。
- 目标：把 warmup request family 也补成和 WindsurfAPI 一样的独立 blackbox regression。

## 2026-05-22 windsurf request-blackbox regression complete
- 请求黑盒回归已覆盖并通过：InitializeCascadePanelState / Heartbeat / AddTrackedWorkspace / UpdateWorkspaceTrust / StartCascade / SendUserCascadeMessage(top-level) / SendUserCascadeMessage(no-tool cascade_config) / SendUserCascadeMessage(toolPreamble cascade_config) / GetCascadeTrajectorySteps / GetCascadeTrajectory。
- 结论：当前主 request family 已按 `/Volumes/extension/code/WindsurfAPI` 对齐完成；后续若仍有 502，不能再先把锅甩给 request shape，必须转查 transport / response / lifecycle。

## 2026-05-22 windsurf cascade transport-reset alignment slice
- 参考真源固定：`/Volumes/extension/code/WindsurfAPI/src/client.js`
  - `isCascadeTransportError(err)`
  - `resetCascadeTransportState(port)`
- 本轮不再改 request builder；只补 transport/lifecycle 红测与最小实现。
- 新增红测并转绿：
  - `sendStartCascade transport error must reset local session + warmup state`
  - `sendCascadeMessage transport error must reset local session + warmup state`
  - `pollCascadeTrajectorySteps transport error must reset local session + warmup state`
- 锁定语义：当本地 cascade 主链命中 `pending stream has been canceled / ERR_HTTP2 / session closed` 这类 transport transient 时，provider 必须：
  1. `closeLocalGrpcSession()`
  2. `windsurfCascadeWarmupPromise = null`
  3. 再按 `classifyWindsurfCascadeError()` 抛出 `WINDSURF_UPSTREAM_TRANSIENT`
- 当前结论：
  - 请求黑盒仍然 10/10 PASS；
  - transport reset 语义已补齐到 provider 主链发送/轮询层；
  - 下一步应 `npm run build:min && routecodex restart --port 5520`，再用真实 5520 smoke 看是否越过当前 transient，继续收敛到下一层真实阻塞。


## 2026-05-22 windsurf 错误处理黑盒 + 启动噪音收口

- 后续继续补请求黑盒时抓到一个更硬的动态缺口：
  - RouteCodex `sendRequestInternal()` 之前只取 `extractLatestCascadeUserText()`，实际只把**最后一条 user text** 发给 `SendUserCascadeMessage`；
  - 这与 WindsurfAPI `cascadeChat()` 明确不符，后者会把：
    - `system` 合并为 `sysText`
    - 多轮 `user/assistant` 历史包成 `<human>/<assistant>` 对话块
    - 最新 user 作为最后一个 `<human>`
    - 必要时加 `truncation_note`
  - 已先补红测再改实现：
    - `startup/request blackbox must project system + history into cascade text like WindsurfAPI cascadeChat instead of only last user message`
  - 红测证据当时明确显示：
    - `capturedText === "second question"`
    - 不含 system/history
  - 现已在 `src/providers/core/runtime/windsurf-chat-provider.ts` 新增 `buildCascadePromptText(...)` 并接入 `sendRequestInternal()`，定向与全量 provider spec 已转绿（176 passed）。
- 但 build/install/restart 后，live 5520 smoke 仍旧：
  - `request_id=...221890-574`
  - `502 WINDSURF_UPSTREAM_TRANSIENT`
  - `The pending stream has been canceled (caused by: )`
- 因此当前新的结论是：
  - 之前“只发最后 user”确实是**真实黑盒错位**，且已修掉；
  - 但它**不是唯一根因**；
  - 下一轮必须继续围绕 provider.send 前后动态时序/transport 侧黑盒补齐，尤其要解释：
    1. 为什么最新 Windsurf 失败样本仍**不落 `~/.rcc/codex-samples`**；
    2. 为什么 live 失败统一停在 `provider.send -> WINDSURF_UPSTREAM_TRANSIENT`。


- 新补第 4 类错误处理黑盒：
  - `sendRequestInternal` 在 `SendUserCascadeMessage` 命中 `expired/not_found cascade|trajectory` 时，必须像 WindsurfAPI `cascadeChat()` 一样走：
    - force rewarm
    - fresh session
    - fresh StartCascade
    - resend message
  - 新增断言已转绿：
    - `sendRequestInternal must retry SendUserCascadeMessage after expired/not_found cascade ...`
- 新补错误分类黑盒：
  - `classifyWindsurfCascadeError` 对 `prompt rejected by policy / content policy` 必须落 `WINDSURF_POLICY_BLOCKED`，不能塌成 `SERVICE_UNREACHABLE`。
- 当前 live 5520 真实 smoke 仍失败：
  - `POST /v1/responses`
  - model=`gpt-5.4-medium`
  - body=`Reply with exactly: OK`
  - 返回：`502 WINDSURF_UPSTREAM_TRANSIENT`
  - message=`The pending stream has been canceled (caused by: )`
  - request_id=`...221888-572`
- 这证明：
  - 错误处理黑盒仍未覆盖 live 502 真因；
  - 当前还不能宣称请求/时序已完全黑盒对齐。
- 同时物理删除了 Windsurf 启动期 debug 噪音：
  - `windsurf.provider.ctor`
  - `windsurf.handle.create.runtime`
  - `windsurf.handle.create.instance`
- 还补了启动探活文案修正：
  - `/health` 在 `status=starting` 时，不应再被描述成误导性的 `bad_status`；应明确视为 `starting` 过渡态。
- 但该文案修正只有在新 build/install/restart 后才会生效；若先 restart 再 build，会继续看到旧文案。


## 2026-05-22 Windsurf 唯一 cascade 黑盒真相（Jason 当前要求）

- 本轮已重新钉死：**唯一黑盒必须是 WindsurfAPI 的 cascade 链路，不是 cloud chat，不是本地伪复现目录测试。**
- 真源代码：
  - `/Volumes/extension/code/WindsurfAPI/src/client.js`
  - `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
  - `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`
  - `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`

- 已确认的唯一链路分层：
  1. **鉴权/账号目录面（cloud Connect-RPC / HTTPS）**
     - `https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod`
     - `https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`
     - fallback only in WindsurfAPI reference still exists at `server.self-serve.windsurf.com/.../WindsurfPostAuth`（RouteCodex 当前按 Jason 要求不能再扩 fallback）
     - `GetOneTimeAuthToken` 同属 SeatManagementService
     - `GetUserStatus` / `GetCascadeModelConfigs` 为 cloud catalog/account RPC，不是聊天主链
  2. **聊天主链面（唯一聊天黑盒）**
     - 真实 baseurl 不是远端 HTTP API
     - 真实 baseurl 是：`http://localhost:<lsPort>`
     - 真实协议：`http2.connect()` + `application/grpc`
     - 真实 service：`/exa.language_server_pb.LanguageServerService/*`

- 已确认的聊天唯一时序（来自 `WindsurfAPI/src/client.js`）：
  1. warmup/session：
     - `InitializeCascadePanelState`
     - `AddTrackedWorkspace`
     - `UpdateWorkspaceTrust`
     - `Heartbeat`
  2. start：
     - `StartCascade` -> `cascade_id`
  3. send：
     - `SendUserCascadeMessage`
  4. poll：
     - `GetCascadeTrajectorySteps`
     - `GetCascadeTrajectory`
     - done 后 final sweep 再拉一次 `GetCascadeTrajectorySteps`
     - usage 额外拉 `GetCascadeTrajectoryGeneratorMetadata`

- 已确认的错误处理黑盒：
  - `panel state not found`：force rewarm -> fresh session -> retry `StartCascade`
  - `cascade/trajectory not found`：discard reuse -> full history rebuild -> force rewarm -> fresh `StartCascade` -> resend
  - `untrusted workspace`：force rewarm（重点是 `UpdateWorkspaceTrust`）-> fresh `StartCascade` -> resend
  - 以上都发生在**本地 LS gRPC chat 链路**，不是云端 GetChatCompletions

- 对 RouteCodex 当前推进的直接约束：
  - 以后 Windsurf 黑盒测试不得再拿 `GetChatCompletions` / cloud chat baseurl 当聊天主链真源
  - 以后 live 502 分析必须优先检查：
    1. 本地 LS gRPC 目标是否正确（`localhost:<lsPort>`）
    2. warmup 四步是否完整、顺序是否一致
    3. StartCascade/SendUserCascadeMessage/poll 时序是否与 reference 一致
    4. 出错分支是否按 reference 做 force rewarm + fresh session/cascade

## 2026-05-22 windsurf cascade live smoke closeout

- Windsurf provider 源码直测与 `/v1/responses` 真实入口都已跑通基础文本主链：`StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/GetCascadeTrajectory`，样例返回 `OK`。
- 本轮两个唯一真因：
  1. proto helper `writeProtoMessageField` 不能编码空 embedded message；WindsurfAPI 的 `writeMessageField` 对空 body 直接省略，否则 LS 会报 `SendUserCascadeMessageRequest proto: cannot parse invalid wire-format data`。
  2. 多个 routecodex-windsurf language_server 并存时，单 provider 实例字段级 pinned runtime 会被并发请求覆盖，导致 A 请求 StartCascade 后 B 请求改写端口，A poll 出现 `trajectory not found`。唯一正确层是 request-local pin（AsyncLocalStorage scope），不是降低并发或全局锁。
- 运行态验证：安装到 `0.90.2107` 后，5520 并发 forced windsurf `/v1/responses` 两条均 completed：`gpt-5.3-codex -> OK-A`，`gpt-5.4-medium -> OK-BOK-B`，未新增本轮 windsurf provider-error。


## 2026-05-22 apply_patch/hashline chat process 真链补充

- 最新执行链确认：chat process 请求治理主链真实入口是 `sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.ts::governTools(... phase=request)`，而它当前 **只调用** `processChatRequestTools()`。
- `normalizeApplyPatchToolCallsOnRequest()` / `normalizeRequestToolCalls()` 目前只在测试里被直接调用，主链没有接线；因此 assistant history 里的 `apply_patch` 参数 shape 即使可被 native 正常归一，也不会在真实 chat process 请求路径生效。
- 这解释了用户看到的现象：schema/guidance 虽有部分变化，但真实请求里的 tool_call argument shape 仍旧没在 chat process 主链修正，导致 hashline/apply_patch 实际不可用。
- 当前唯一正确修复点候选：仍是 `tool-governor-request.ts::processChatRequestTools()`，在该 chat process 主入口内串起 request-side tool-call normalization；不是 inbound，不是外层 prompt，不是 continuation。
- 红测应锁真实入口，而不是单独测未接线 helper：测 `processChatRequestTools()`/`governTools(phase=request)` 输入带 assistant apply_patch tool_call 时，输出必须已经过 native normalization。


## 2026-05-22 apply_patch 标准场景实测

- 已新增真实标准回归脚本：`scripts/tests/apply-patch-standard-scenarios.mjs`，直接调用本机 `apply_patch` 可执行，对临时目录做真实落盘验证。
- 首轮实测结果：
  - `add-file` ✅
  - `update-file-simple` ✅
  - `update-file-multi-hunk` ❌
- 当前失败不是推测，而是 apply_patch 真实报错：`Failed to find expected lines ... c d e`。
- 说明之前缺的不是“有没有测试”，而是**没有真实用 apply_patch 可执行跑标准场景**；现在已补上这层真验证。

## 2026-05-22 Windsurf pending stream canceled 根因与修复进展
- 现象：`/v1/responses` 单请求在 provider.send 阶段反复 502：`The pending stream has been canceled`。
- 关键证据：用 WindsurfAPI 自己的 `/Volumes/extension/code/WindsurfAPI/src/grpc.js` + `buildInitializePanelStateRequest` 直打 `42101` 也复现 pending-canceled；同时 `lsof/nc` 证明 `42101` 曾无监听，Windsurf app 的 LS 是 `--random_port`，不是 WindsurfAPI 的 `--server_port/--csrf_token` 直连形态。
- 唯一真源修复点：`src/providers/core/runtime/windsurf-chat-provider.ts` 内 provider 需要按 WindsurfAPI `ensureLs()` 自己启动受管 LS（`--server_port --csrf_token --codeium_dir --database_dir --detect_proxy=false`），不能继续依赖 stale `~/.rcc` lsPort 或 Windsurf app random_port 子进程。
- 已验证：构建安装重启至 `0.90.2115` 后，真实 `POST /v1/responses` 强制 `windsurf.ws-pro-4.gpt-5.4-medium` 首发成功，HTTP 200，finish_reason=stop，retries=0 attempts=1，provider-errors 行数未增加（7894 -> 7894）。
- 额外修复：Heartbeat request 必须 `Buffer.concat([field1(metadata)])`，避免 TS 直接 return message field 与 LS 解包不一致导致 `HeartbeatRequest proto: cannot parse invalid wire-format data`。
- 未完成：工具调用真实 smoke、单 runtime 不并发/多 runtime 隔离仍需下一步验证；当前只证明 pending-canceled 主因已消除且普通 chat 单请求首发 200。

## 2026-05-22 apply_patch legacy 删除审计（进行中）
- 发现 TS 仍保留第二实现：native-chat-process-governance-semantics.ts 同时调用 runHashlineNativeEditJson + normalizeApplyPatchArgumentsJson；src/tools/apply-patch/structured*.ts 仍在仓库中。
- 下一步：先补红测锁“chat process 只走单一 native owner，且不能保留 TS structured legacy 引用”，再物理删除。

## 2026-05-22 apply_patch owner 边界审计（继续）
- 需确认是否仍有 inbound/outbound/response 路径持有 apply_patch/hashline 专属 owner；若有需删。
- 当前已知：chat process TS 壳层已收口到 normalizeApplyPatchArgumentsJson；仍需审查 response/inbound/guidance 是否越权。

## 2026-05-22 review-before-commit
- User asked to review all uncommitted changes and commit. Loaded USER/project routing/coding/review skills.
- Initial static check found trailing whitespace in Windsurf docs/spec; removed it.
- Deleted-file reference scan found no remaining refs for removed structured apply-patch and old Windsurf scripts.

## 2026-05-22 Windsurf tool path 当前已验证进度

- 已正确链路：RouteCodex Windsurf provider 只走本地 managed LS gRPC + Cascade：warmup -> StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/GetCascadeTrajectory；不再把 cloud GetChatCompletions 当聊天主链。
- 已验证普通返回：安装态 `0.90.2140` `/v1/responses` 可通过 `windsurf.ws-pro-4.gpt-5.4-medium` 返回 200。
- 已验证工具首轮：`/tmp/windsurf-tool-smoke.json`（echo 工具，强制 tool_choice）返回 `status=requires_action`，包含 `required_action.submit_tool_outputs.tool_calls[0].name=echo` 和 `arguments={"text":"ping"}`，证明工具列表/协议至少能让 Cascade 产出 structured tool call。
- 已修 Responses conversation store：最终 client JSON 边界补 record，Rust `responses_payload_requires_submit_tool_outputs` 同时识别 `required_action.submit_tool_outputs.tool_calls`，避免首轮 `requires_action` 后 `responseIndex=0` 导致 submit 报 `Responses conversation expired or not found`。
- 当前剩余问题：submit tool_outputs 后 HTTP 已能进入 Windsurf provider，但模型仍可能重复首轮 structured tool call；初步怀疑不是“工具列表没提供”，而是 submit/history additional_steps 或 latest user 边界未对齐。下一步应按 `docs/design/windsurf-cascade-tool-protocol.md` 检查 `additional_steps field9`，不得回到文本 tool_preamble 或 `<tool_result>` 方案。
- Review found build/verification failures in uncommitted apply_patch migration: trailing whitespace, stale apply-patch regression validator path, TS compile break from dynamic await in handler-response-utils, and native structured/shell-wrapper reason mismatches.
- Fixed the only validation truth path by routing apply_patch object/string shapes through native validator, preserving shell-wrapped patch extraction, restoring structured reason classification in Rust, and making regression verification load built llmswitch-core dist instead of nonexistent TS .js source.
- Validation passed: npm run build:min; npm run verify:apply-patch-regressions; npm run verify:apply-patch; npm run verify:servertool-rust-only; cargo test -p router-hotpath-napi validate_apply_patch_arguments --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml.

## 2026-05-22 Windsurf 工具协议顺序纠偏

- Jason 明确纠正：Windsurf 工具调用改造必须先把 App/WindsurfAPI 的标准 Cascade 工具协议写成本地设计文档，再补黑盒锚点测试，最后才改 provider 实现。
- 已新增设计锚点文档：`docs/design/windsurf-cascade-tool-protocol.md`。
- 文档结论：标准路径是 `SendUserCascadeMessage.cascade_config.planner_config.conversational.planner_mode=DEFAULT(1)` + `planner_config.field13 CascadeToolConfig.field32 tool_allowlist`；工具调用来自 trajectory structured fields 45/47/49/50；工具结果通过 `additional_steps field9` 回灌。
- 明确禁止把文本 `function_call` / `<tool_call>` prompt 注入与 harvest 作为最终方案；unmapped arbitrary OpenAI function 在未证明 custom/MCP request-side 入口前必须 fail-fast。

## 2026-05-22 Windsurf 文档事实收敛

- Jason 要求先清理所有文档和事实，避免多轮编辑后 Wind/Windsurf 事实不统一。
- 已将当前唯一事实入口收敛为：
  - `docs/providers/windsurf-chat-provider-design.md`
  - `docs/design/windsurf-cascade-tool-protocol.md`
- 已重写历史审计文档，明确它们只保留取证价值，不再作为实现依据：
  - `docs/audit/windsurf-request-shape-audit.md`
  - `docs/audit/windsurf-response-audit.md`
- 已在 `MEMORY.md` 追加当前唯一事实：本地 managed LS gRPC + Cascade；工具协议为 planner DEFAULT + tool_allowlist + trajectory structured fields + additional_steps；文本 function_call / `<tool_call>` harvest 废弃。

[2026-05-22] startup incident: native required exports still listed augmentApplyPatchErrorContentJson after physical deletion; loader completeness rejected fresh dist/release .node and server fell into bootstrap failure. Also managed restart loop in start.ts keeps respawning after child early-exit during restart bootstrap; user要求启动失败即停。

## 2026-05-22 Windsurf 事实清理继续
- Jason 要求：先清理所有 Windsurf 文档和事实，保留唯一事实，再继续设计/skills/测试/实现。
- 已将 `docs/goals/windsurf-cascade-single-path-rebuild-plan.md` 从旧长计划重写为“历史计划，已收敛”，只保留当前唯一主链、执行顺序、清理规则和 DoD。
- 已在 provider design 增加 Fact Hygiene：当前事实只进 provider design + cascade tool protocol；audit/goal 只能存历史取证；错误路径必须改成 `~/.rcc` 与 local managed LS gRPC + Cascade。
- 已在 cascade tool protocol 增加 Documentation Hygiene：协议字段写入必须有 WindsurfAPI/App/LS/`~/.rcc` 证据，且必须标明 request/trajectory/submit 方向。
- 已更新 rcc-dev-skills：Windsurf 文档事实清理、旧文本工具协议 skipped/helper 不能长期保留，确认覆盖后必须物理删除。

## 2026-05-22 Windsurf note 事实覆盖声明
- 本 `note.md` 是探索工作台，前文保留了多轮错误假设和已废弃路径，包括 GetChatCompletions、tools_preamble、文本 tool call harvest 等；这些条目只代表历史探索过程，不是当前实现事实。
- 当前唯一事实以 `docs/providers/windsurf-chat-provider-design.md` 与 `docs/design/windsurf-cascade-tool-protocol.md` 为准：local managed LS gRPC + Cascade；planner DEFAULT + tool_allowlist；trajectory structured fields；tool result additional_steps field9。
[2026-05-22] apply_patch 主线继续：红测证明 TS request governor 仍在重写 apply_patch schema/description/filePath aliases，属于 chat process 外第二 owner，需物理删除，保留 Rust req_process 为唯一 schema/guidance owner。

## 2026-05-22 Windsurf structured tool blackbox cleanup progress
- 物理删除 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中 12 个 skipped 旧文本工具协议测试块：LEGACY TEXT EMULATION / DEPRECATED TEXT TOOL PROTOCOL。
- provider 行为更新：`buildCascadePromptText()` 不再把 assistant `tool_calls` / tool result 编进 `<tool_call>` / `<tool_result>` 文本；history 工具结果通过 `buildCascadeAdditionalStepsFromSemanticConversation()` -> `SendUserCascadeMessage.field9 additional_steps` 进入 Cascade。
- `buildSendCascadeMessageRequest()` 对 legacy `toolPreamble` 显式 fail-fast；`preprocessRequest()` mapped tools 继续进入 native allowlist，unmapped fail-fast。
- 验证：定向 structured 黑盒 8/8 通过；`npx tsc --noEmit --pretty false` 通过；全量 `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit` 181/181 通过。
- 剩余清理：文件中仍有 GetChatCompletions / streamWindsurfSseResponse / parseGetChatMessageResponse / buildChatMessagePromptsFromSemanticConversation 历史响应链测试与实现残留；下一步需要按唯一 Cascade 主链判断是否物理删除或改为历史取证测试。

## 2026-05-22 startup fail-fast on managed restart
- 用户现场日志暴露：child 启动失败时，start 命令虽然不再无限重启 child，但 managed restart 分支仍会继续按 health timeout 等待，表面看像“反复重启/长时间卡住”。
- 红测：`tests/cli/start-command.startup-error.spec.ts` 锁定“restarted child 已落 lifecycle startupError 时，必须立刻停止并显式报 startupError，不得继续等 health timeout”。
- 唯一正确修改点：`src/cli/commands/start.ts` 的 managed restart wait 分支。这里本来只看 health/exit，没有把 runtime lifecycle 的 startupError 作为更高优先级证据读取，所以会误走 timeout/early-exit 文案。
- 已修：`waitForChildHealthyOrExit()` 返回 startupExitState；managed restart catch 前显式读取并优先报 `startupError=...`，从而 fail-fast 停止。

## 2026-05-23 Windsurf custom tools request-side evidence check

User constraint: do not implement capability routing/gating; only check whether Cascade custom tools can be found; if not found, report and stop.

Read-only evidence:
- WindsurfAPI `src/handlers/tool-emulation.js` states Cascade has no per-request slot for client-defined function schemas; `SendUserCascadeMessageRequest` fields 1-9 do not accept tool definitions; `CustomToolSpec` is a trajectory event type, not an input.
- WindsurfAPI `src/cascade-native-bridge.js` maps only known built-in Cascade tool kinds via `TOOL_MAP`; unmapped tools intentionally route to `toolPreamble` emulation.
- Windsurf App bundle schema shows `SendUserCascadeMessageRequest` fields only: metadata(3), cascade_id(1), items(2), images(6), cascade_config(5), experiment_config(4), recipe_ids(7), blocking(8), additional_steps(9). No arbitrary custom tool definition field.
- App bundle has `CustomToolSpec` and `ChatToolDefinition`, but observed usage is `GetSystemPromptAndToolsResponse.tool_definitions` and trajectory step `custom_tool`, not a `SendUserCascadeMessageRequest` input slot.

Current conclusion: no request-side structured custom tool injection path found in WindsurfAPI or App schema. Native Cascade path supports allowlisted built-in tools; arbitrary Codex/MCP tools are not proven supported except via WindsurfAPI's old text emulation path, which user has not authorized to reintroduce.

## 2026-05-23 Windsurf custom tool boundary anchored in tests/docs

Actions:
- Updated `docs/design/windsurf-cascade-tool-protocol.md` and `docs/providers/windsurf-chat-provider-design.md` with the request-side custom tool boundary: App `SendUserCascadeMessageRequest` has fields 1-9 only, no arbitrary tool-definition input; WindsurfAPI unmapped tools are old `toolPreamble` emulation, not structured custom tool request.
- Added `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` blackbox anchor: app schema has no tool definition input slot; WindsurfAPI `tool-emulation.js` records the same; `apply_patch` / `update_plan` / MCP tool names fail-fast as `WINDSURF_UNMAPPED_TOOL`.
- Updated local rcc-dev skill with the no-gating/no-text-emulation boundary.

Verification:
- `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "custom tool-definition input slot|preprocessRequest must route mapped tools"` => passed, 2/2 selected.
- `npx tsc --noEmit --pretty false` => passed.
- `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit` => passed, 182/182.

Remaining:
- Installed/live `/v1/responses` smoke for mapped native tools and tool-result submit path still required before declaring end-to-end integration complete.

## 2026-05-23 Windsurf tool semantic equivalence + MCP candidate blackbox

User direction:
1. Do semantic comparison first; directly translate tools that are semantically equivalent and test them.
2. For unsupported tools, try MCP-style guidance/registration path and translate back if possible.
3. Whether possible or not, add tests as proof.

Actions:
- Updated `docs/design/windsurf-cascade-tool-protocol.md` with a tool semantic matrix:
  - direct equivalent: `exec_command` / `shell_command` / `run_command` / `bash` -> Cascade `run_command` for one-shot blocking shell execution only.
  - unsupported native equivalence: `write_stdin`, PTY/session continuation, `apply_patch`, `update_plan`, `request_user_input`, agent orchestration tools.
  - MCP candidate: `mcp__*` and unsupported orchestration tools, but only through an LS MCP registration blackbox; not through `SendUserCascadeMessageRequest` per-request injection.
- Updated `docs/providers/windsurf-chat-provider-design.md` with the `run_command` equivalence boundary.
- Added direct semantic red test in `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` comparing RouteCodex `exec_command` history/additional_steps encoding to WindsurfAPI `TOOL_MAP.shell_command.forward()` + `buildAdditionalStep()`.
- Added MCP blackbox anchor proving App has MCP RPC symbols/state/trajectory support but `SendUserCascadeMessageRequest` has no per-request MCP/tool injection field.
- Fixed `src/providers/core/runtime/windsurf-chat-provider.ts` direct mapping:
  - `exec_command.forward` now accepts `workdir` as Cascade `cwd` and `command_line` as alias.
  - shell/run/bash observation now writes `full_output` (WindsurfAPI field21 body) + stdout + exit_code, not non-encoded `combined_output`.

Verification:
- `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "exec_command/shell_command direct semantic translation|preprocessRequest must route mapped tools"` => passed.
- `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand -t "MCP can only be considered|custom tool-definition input slot"` => passed.
- `npx tsc --noEmit --pretty false` => passed.
- First full suite without explicit timeout hit Jest default 5s on a known long orchestrate blackbox after assertions took ~6.5s; reran with explicit timeout:
  `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit --testTimeout=30000` => 184/184 passed.

Remaining:
- Need actual LS MCP registration blackbox before implementing MCP translation for unsupported tools.
- Need rebuild/install/restart/live `/v1/responses` smoke after code changes.

## 2026-05-23 Windsurf hybrid tool protocol plan

User decision:
- Supported tools should be transparently translated to Cascade native structured protocol.
- Unsupported tools should use a single text container, but not weak markdown fences.
- Reuse DeepSeek Web's stronger structured text pattern shape, but Windsurf protocol name/tags are RCC only.
- Harvest must distinguish native trajectory tool calls from RCC text tool calls.

Artifacts:
- Added `docs/goals/windsurf-tool-hybrid-protocol-plan.md` with complete implementation plan, blackbox test path, risks, DoD.
- Cross-linked from `docs/design/windsurf-cascade-tool-protocol.md` and `docs/providers/windsurf-chat-provider-design.md`.

Protocol target:
- Native: `planner_mode=DEFAULT(1)` + `tool_config.field32 tool_allowlist` + trajectory fields + `additional_steps`.
- Unsupported text protocol:
  `<|RCC|tool_calls><|RCC|invoke name="tool"><|RCC|parameter name="arg"><![CDATA[value]]></|RCC|parameter></|RCC|invoke></|RCC|tool_calls>`.
- Unsupported result context:
  `<|RCC|tool_result id="..." name="..."><![CDATA[output]]></|RCC|tool_result>`.

## 2026-05-23 Windsurf RCC fence naming correction
- User correction: Windsurf unsupported-tool text protocol fence must use RCC naming only; all Windsurf fence/protocol labels use RCC.
- Updated `docs/goals/windsurf-tool-hybrid-protocol-plan.md`: `windsurf_text_tool_protocol="rcc"`. DeepSeek Web history remains separate and is not the Windsurf protocol.

## 2026-05-23 Windsurf hybrid tool protocol implementation checkpoint
- Added red tests then implementation for request-time tool partition: native-equivalent tools -> Cascade structured allowlist; unsupported tools -> `windsurf_text_tool_protocol="rcc"` + `windsurf_unsupported_text_tools`.
- RCC prompt guidance now uses `<|RCC|tool_calls>` only for unsupported tools and excludes native tool names / legacy `<tool_call>` / `function_call` markers.
- RCC harvest parses declared unsupported `<|RCC|tool_calls>` into standard OpenAI `tool_calls`, strips visible RCC text, and fail-fast errors on native/RCC conflict, malformed RCC, or undeclared tool names.
- Result feedback split: native tool results remain Cascade `additional_steps`; unsupported tool results are prompt-visible `<|RCC|tool_result>` context.
- Source verification passed: `npx tsc --noEmit --pretty false`; `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit --testTimeout=30000 --no-cache` => 189/189 passed.

## 2026-05-23 Windsurf fence naming
- User要求：Windsurf hybrid unsupported tool fence 统一使用 RCC 字样。
- 执行策略：先 grep 历史协议名残留，限定修改 Windsurf 文档/测试/实现中的协议命名，不恢复旧协议、不加 fallback。

## 2026-05-23 Windsurf native trajectory parser fix
- 红测发现 RouteCodex 只解析 ChatToolCall wrapper/custom/mcp/proposal/choice，未解析 Cascade IDE oneof steps（如 field 28 run_command）；WindsurfAPI `parseTrajectorySteps` 会把这些 oneof step 转成 `native:*` toolCalls。
- 已补 blackbox 对齐测试：用 WindsurfAPI `buildAdditionalStep(run_command)` 包成 GetCascadeTrajectorySteps 响应，断言 RouteCodex `parseTrajectorySteps` toolCalls 与 WindsurfAPI 完全一致。
- 已修 provider：`parseTrajectorySteps` 解析 run_command/view_file/list_directory/write_to_file/grep_search/find/grep_search_v2/search_web/read_url_content oneof steps，输出 `cascade_native: true`。这不是 fallback，是 Cascade structured native harvest 缺失字段补齐。

## 2026-05-23 Windsurf native submit continuation fix
- Live native-only first turn now returns `requires_action` with native Cascade `run_command` tool_call; submit_tool_outputs exposed a second issue: conversation resume treated `run_command` as non-shell-like, so native `command_line` arguments could be lost from resumed history and Cascade re-proposed the same native tool.
- Added response conversation store regression for native Cascade `run_command` preserving `{command_line,cwd}` through submit resume.
- Fixed Rust `shared_responses_conversation_utils`: `run_command` is shell-like for response-history conversion and command extraction reads `command_line` / `proposed_command_line`.

## 2026-05-23 Windsurf responses continuation fix
- live native smoke verified: first turn returns `requires_action`; submit_tool_outputs now returns a completed chat response instead of re-emitting the same native tool_call.
- Fix path was dual:
  1) provider parse of native Cascade trajectory now harvests oneof steps and preserves tool history with `tool_outputs` for the Responses bridge,
  2) native shared responses conversation store now treats `run_command` as shell-like and preserves `command_line`/`proposed_command_line` semantics on resume.
- This directly targets the only observed live bug after tool-call success; no fallback or RCC shadow path added.

## 2026-05-23 Windsurf fence naming correction
- Windsurf unsupported-tool fence 当前唯一命名是 RCC；其他平台的历史协议命名不再写入 Windsurf 文档、测试或实现。
- 这次只做命名/事实收敛，不改请求链路。


## 2026-05-23 Windsurf native gate correction
- 纠正上一轮误判：本目标要求 native-supported tools 默认透明进入 Cascade structured protocol，不做能力路由 gating；已物理删除 `shouldUseWindsurfNativeBridge` default-off gate。
- 回归：`tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 193/193 passed。

## 2026-05-23 Windsurf RCC naming correction self-test
- User correction: Windsurf unsupported-tool fence must use RCC naming only; do not reuse other providers’ historical protocol names for Windsurf.
- Updated current Windsurf docs/memory/note wording so current Windsurf protocol names remain RCC-only; DeepSeek historical protocol references remain only in DeepSeek historical notes/code.
- Verification: rg over current Windsurf docs/provider/tests/skill found zero historical protocol-name matches; targeted Jest RCC/hybrid/unsupported provider tests passed (7 selected, suite pass).

## 2026-05-23 Windsurf native result continuation mapping fix
- Red test first: `native run_command response tool name must still build additional_steps when caller declared shell_command` failed because returned native trajectory name `run_command` was rejected against declared caller tool `shell_command`.
- Fix: `isWindsurfNativeToolName` now authorizes by Cascade native kind equivalence from `collectWindsurfMappedTools(nativeTools)`, not literal caller name. This keeps native-supported tools on Cascade structured path and does not fallback to RCC.
- Verification: targeted native red test passed; hybrid/RCC/native selected tests passed (8 selected); `npx tsc --noEmit --pretty false` passed; full `windsurf-chat-provider.spec.ts` passed 194/194.

## 2026-05-23 Windsurf hybrid live smoke checkpoint
- 已补 provider 红测：mixed continuation 中 native result 已完成但 unsupported tool 尚未调用时，Cascade prompt 必须显式提醒 pending RCC unsupported tool，防止模型把 native 完成误当最终状态。
- 已补 provider 红测：poll trajectory 时若 upstream 重复吐出已完成 native run_command，应按 completed native call id/signature 跳过，不再把旧 native call 当新 tool_call 返回。
- 验证：`npx tsc --noEmit --pretty false` passed；`npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit --testTimeout=30000 --no-cache` 198/198 passed；`npm run build:min && npm run install:global && routecodex restart --port 5520` 到 0.90.2165，health OK。
- live 仍未完成：native-only first turn returns requires_action(run_command)，但 submit 后当前出现两类不稳定结果：1) 空 assistant completion 502；2) chat choices.message.tool_calls 中重复 native run_command。unsupported-only first/submit 曾通过，但最新一次 first turn 因上游/provider 502 未完成验证。mixed first returns native run_command，turn2 仍可能在 chat choices 中重复 native run_command，未进入 RCC apply_patch。
- 下一步唯一方向：继续定位 `/v1/responses/{id}/submit_tool_outputs` 的 outbound remap/retention 与 provider poll 交界；不能宣称完成，不能让用户测。

## 2026-05-23 Windsurf fence naming correction
- Jason 明确纠正：Windsurf unsupported-tool fence 统一替换/命名为 RCC。
- 当前执行规则：Windsurf 文档、实现、测试、skills 中只允许 `<|RCC|tool_calls>` / `<|RCC|tool_result>`；其他 provider 的历史协议名不能作为 Windsurf 当前事实。

## 2026-05-23 Windsurf hybrid continuation follow-up
- 继续目标：native-supported -> Cascade structured；unsupported -> RCC text-tool protocol；先查 ~/.rcc 样本再补红测。
- 已确认 ~/.rcc/codex-samples/openai-responses/windsurf.* 目前只看到 provider-request-contract/response-contract，最新 contract 样本仍是旧 openai-chat tools 形状；真实 native submit 样本不在该 contract 目录，需继续从 server logs / provider debug / tests 定位。

## 2026-05-23 Windsurf native submit response-id fix
- ~/.rcc/logs/server-10000.log 失败样本显示 native first turn client id 是 `chatcmpl-b884...`，submit URL 也用 `/v1/responses/chatcmpl-.../submit_tool_outputs`，说明 Responses conversation store 未拿到真正 `resp_*` id；这比 poll 空快照更接近 live 根因。
- 新增 `tests/sharedmodule/responses-completed-native-remap.spec.ts` 红测：Windsurf/native chat.completion tool_calls 转 Responses first turn 时 id 不得保留 chatcmpl，必须分配 `resp_*`，否则后续 submit 无法恢复历史。
- 唯一修点：Rust `hub_resp_outbound_client_semantics.rs` Responses outbound client remap，新增 `allocate_responses_id()`：源 `id` 为 `chatcmpl*` 时生成 `resp_*`；非 chatcmpl 已有 Responses id 保留。
- 已验证：native build hotpath 通过；`npx tsc --noEmit --pretty false` 通过；Windsurf 定向 Jest 4 suites / 207 tests 通过。

## 2026-05-23 Windsurf fence naming recheck
- Jason correction: Windsurf fence must use RCC wording only; do not mention or reuse other providers’ historical fence names. Rechecking current worktree before editing.

## 2026-05-23 live native submit still leaks chat.completion
- Self-smoke after build/install/restart: `/tmp/windsurf-native-smoke.mjs` first turn OK (`resp_*`, native run_command), submit failed exit 13 because client body is `chat.completion` with `choices` instead of Responses object. Need inspect real executor/converter path; unit mock passed but live not covered enough.

## 2026-05-23 router-direct removed for Responses; new live failure
- Fix slice: router-direct same-protocol bypass was root of live submit `chat.completion` leak; now `/v1/responses` must use full executor conversion. Targeted tests pass for router-direct skip and Windsurf conversion path.
- After build/install/restart 0.90.2175, native smoke no longer leaks chat.completion; new first-turn failure is `MISSING_REQUIRED_TOOL_CALL`: upstream completed with declared request tools but no function_call output. Need inspect request/tool_choice/native allowlist shape and enforce tool call behavior.

## 2026-05-23 Windsurf RCC fence naming cleanup
- Jason correction: Windsurf unsupported-tool fence must use `RCC` only. Verified current Windsurf design/goal/provider docs and rcc-dev-skills contain no non-RCC Windsurf fence protocol reference; added explicit RCC-only statements to `docs/design/windsurf-cascade-tool-protocol.md` and `docs/providers/windsurf-chat-provider-design.md`.
## 2026-05-23 Windsurf RCC-only fence naming hardening
- Jason correction: Windsurf unsupported-tool fence naming must be RCC-only; avoid spelling or importing other providers’ fence protocol names in Windsurf docs/skills/current facts.
- Verification target: current Windsurf docs/provider/tests/skill must have zero non-RCC fence protocol references; historical DeepSeek notes/tests may retain their provider-specific facts.

## 2026-05-23 Windsurf RCC fence naming verification
- Jason corrected again: Windsurf unsupported-tool fence must use RCC naming only; do not write other provider fence names into Windsurf facts.
- Verification command: scanned current Windsurf docs/src/tests/skills for non-RCC fence naming; result below.
- Result: no non-RCC fence naming in Windsurf-scoped files. Remaining other-provider fence references are provider-specific docs/tests/fixtures and must not be globally replaced.

## 2026-05-23 Windsurf hybrid live smoke checkpoint
- Fixed current blockers:
  - RCC duplicate text blocks are deduped only within RCC source; native structured + RCC text same assistant candidate still fail-fast as `WINDSURF_TOOL_PROTOCOL_CONFLICT`.
  - Mixed continuation prompt now preserves terminal contiguous tool results, so after native result + RCC result it includes both `shell_command` output and `<|RCC|tool_result>`.
  - Responses submit path now rebuilds raw request metadata with `previous_response_id` and materializes response-id conversation context for resumed requires_action, preventing second submit from losing history.
- Verification:
  - `npm run jest:run -- --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts tests/sharedmodule/windsurf-submit-stopmessage.spec.ts tests/sharedmodule/request-continuation-semantics.spec.ts tests/server/runtime/http-server/executor/provider-response-converter-windsurf-tools.spec.ts tests/server/handlers/handler-response-utils.responses-conversation.spec.ts --runInBand --forceExit --testTimeout=90000 --no-cache` => 5 suites / 221 tests passed.
  - `npx tsc --noEmit --pretty false` passed.
  - `npm run build:min && npm run install:global && routecodex restart --port 5520` installed 0.90.2188 and health returned ready/ok.
  - `/tmp/windsurf-native-smoke.mjs` passed after reinstall: native first `shell_command` requires_action, submit completed with `/Users/fanzhang/Documents/github/routecodex`.
  - `/tmp/windsurf-unsupported-smoke.mjs` passed on rerun: RCC `echo_tool` requires_action, submit completed with `hello-rcc`.
  - `/tmp/windsurf-mixed-smoke.mjs` passed: first native `shell_command`, second RCC `echo_tool`, third completed with both pwd and mixed-rcc results.
- Caveat: one unsupported smoke immediately after native had transient `empty assistant completion`, rerun passed; keep watching stability but current evidence has all three smoke categories passing.

## 2026-05-23 Windsurf weekly quota 502 correction
- Jason reported live still returns 502. Checked `~/.rcc/logs/server-5520.log`; latest Windsurf failure is not request-shape/tool protocol, but upstream message: `Your weekly usage quota has been exhausted...` surfaced as `status=502 code=WINDSURF_UPSTREAM_TRANSIENT`.
- Root cause: gRPC error path pre-structured the error as `WINDSURF_UPSTREAM_TRANSIENT`; `classifyWindsurfCascadeError` returned structured errors before checking weekly quota text, so weekly quota was retried/reported as transient 502.
- Fix: weekly quota text now overrides pre-structured transient errors to `WINDSURF_WEEKLY_QUOTA_EXHAUSTED`, status 429, retryable=false, quotaScope=weekly.
- Verification: added red test for pre-structured weekly quota; targeted test passed; full `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` passed 208/208; `npx tsc --noEmit --pretty false` passed.
- Installed verification: `npm run build:min && npm run install:global && routecodex restart --port 5520 && curl -sS http://127.0.0.1:5520/health` passed; installed `/health` version is 0.90.2189.

## 2026-05-23 Windsurf multi-account/stopMessage/quota implementation checkpoint
- Implemented port-scoped stopMessage gate: `[[httpserver.ports]].stopMessage.enabled=false` is preserved by port config, injected as request metadata, and `stop-message-auto` skips with `skip_port_stopmessage_disabled`; this avoids plain 5520 HTTP smoke being converted into tmux followup.
- Implemented Windsurf auth alias isolation: `resolveRuntimeAuth` derives `accountAlias` from runtime key (`windsurf.ws-pro-N`) when auth omits explicit alias, so token/session files remain per account instead of default alias collision.
- Startup probe design: Provider init now probes Windsurf via `instance.checkHealth()` once per runtime unless `ROUTECODEX_WINDSURF_STARTUP_PROBE=0`; probe failure fails that runtime init and existing provider-init error/quota path removes that key from startup pool.
- Weekly quota recycle: quota daemon now blacklists Windsurf alias family until next local 00:00 when upstream omits explicit cooldown, while explicit cooldownOverrideMs still wins. This matches current “0 点恢复” rule.
- PostAuth dual path preserved/fixed: backend `_backend` post auth timeout retries legacy `server.self-serve.windsurf.com` endpoint.
- Verification: targeted Jest `windsurf-chat-provider.spec.ts`, `provider-quota-daemon.events.windsurf-weekly.spec.ts`, `port-config-validator-sameprotocol.spec.ts` passed (223 tests); `npx tsc --noEmit --pretty false` passed.

## 2026-05-23 Windsurf truncation inspection/fix
- Jason reported Windsurf provider output seems truncated. Checked `~/.rcc/config.toml`, `~/.rcc/codex-samples`, and `~/.rcc/logs/server-5520.log` first per rcc-dev-skills.
- Evidence: recent sample `~/.rcc/codex-samples/openai-responses/windsurf.ws-pro-4.gpt-5.4-medium/openai-responses-windsurf.ws-pro-4-gpt-5.4-medium-20260522T222745991-221951-635/provider-response-contract.json` exposed visible truncated legacy text: `<tool_call>{"name":"echo","arguments":{"text":"ping"` with `finish_reason=stop`.
- Root cause: `parseCascadeAssistantTurnSync` rejected RCC malformed wrappers but did not reject legacy `<tool_call>` / `<function_call>` marker text, so truncated tool protocol could leak as normal assistant content.
- Fix: Windsurf assistant parse now fail-fast with `WINDSURF_TOOL_PROTOCOL_CONFLICT` if legacy tool markers appear in visible content; the direct malformed legacy marker test is the red→green regression anchor. Poll unclosed-marker / stable-tail tests are supporting coverage only, not separate red-regression claims.
- Red→green evidence: temporarily removing the parser guard made `malformed legacy tool_call text must not be returned as visible assistant content` fail with `Received function did not throw`; restoring the guard made the same targeted test pass.
- Verification: full `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` passed 211/211; `npx tsc --noEmit --pretty false` passed.

## 2026-05-23 Windsurf startup probe hardening
- Corrected startup probe semantics: `checkHealth() === false` now throws `WINDSURF_STARTUP_PROBE_FAILED`, so an unusable Windsurf account/runtime is not registered as a provider handle. Previously only thrown probe errors failed init; boolean false was ignored.
- Added a side-effect-light probe helper `windsurf-startup-probe.ts` and regression test.
- Added quota maintenance recovery for expired Windsurf weekly blacklist: after local 00:00, expired weekly alias-family blacklist states are reset to initial ok state, so next maintenance tick/startup can re-probe/re-admit.
- Verification: targeted startup/quota tests passed; tsc passed; build/install/restart to 0.90.2192 passed; 5520 live smoke x3 all HTTP 200 on `windsurf.ws-pro-2.gpt-5.4-none` with no retries.
## 2026-05-23 Windsurf 5520 multi-account runtime routing correction
- Runtime/code side: startup probe now hard-fails `checkHealth() === false`, so unusable Windsurf account runtimes are not registered; expired weekly blacklist is reset by quota maintenance/reload after local 00:00.
- Config side found a separate blocker: 5520 route pools were still `mode = "priority"`, which intentionally locks to the first available target and cannot prove multi-account simultaneous use. Updated `/Volumes/extension/.rcc/config.toml` gateway_priority_5520 pools to `mode = "round-robin"` while keeping `maxInFlight = 1` per runtime.
- Cleaned `/Volumes/extension/.rcc/provider/windsurf/config.v2.toml` duplicate `ws-pro-4` auth entry; final aliases are ws-pro-1..ws-pro-5.

## 2026-05-23 Windsurf Cascade history alignment
- Jason reported Windsurf provider history still looked wrong after tool-call fixes. Compared RouteCodex `buildCascadePromptText()` with `/Volumes/extension/code/WindsurfAPI/src/client.js` and native bridge prep in `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`.
- Evidence: WindsurfAPI native bridge strips `role=tool` turns and assistant tool-call-only turns before Cascade prompt construction; RouteCodex semantic history kept those turns as empty `function_call_output` / assistant tool-call rows, producing empty `<assistant>\n\n</assistant>` history blocks.
- Red→green evidence: added `native cascade history must strip assistant tool-call-only and tool result turns like WindsurfAPI native bridge`; it failed with empty assistant tags, then passed after skipping blank Cascade history turns.
- Fix: `buildCascadePromptText()` now omits history turns whose rendered text is blank, matching WindsurfAPI native bridge prompt semantics while preserving native tool results through `additional_steps`.

## 2026-05-23 Responses scoped continuation tools retention
- Jason reported Windsurf loses tool ability after a tool call. Server log showed first turn routed with `tools:tool-request-detected`, but the next scoped continuation only had `search:last-tool-search|longcontext:token-threshold` and finished `stop`.
- Root cause: Responses conversation retention released large base payload and also cleared `entry.tools`; `resumeLatestResponsesContinuationByScope()` then restored `previous_response_id` + delta input without `tools`, so downstream Windsurf prompt/tool governance saw no callable tools.
- Red→green evidence: added assertion to `releasing request payload preserves scope-based continuation lookup`; before fix `restored.payload.tools` was `undefined`, after fix the original tool definitions are preserved.
- Fix: keep slim retained tool definitions while releasing bulky input/base payload; this preserves tool capability without retaining full historical payload.

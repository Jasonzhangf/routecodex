# Servertool 统一骨架设计（收敛草案）

## 目标
- 把 servertool 收敛成**单一骨架**：统一请求注入、统一响应收割、统一续轮决策。
- internal servertool 绝不泄露到客户端。
- malformed tool_call 绝不在 finalize 阶段伪装成 `stop + 空回复`；应保留错误闭环，让客户端或上层显式报错。

## 现状问题
1. **followup 特判旁路**
   - `serverToolFollowup=true` 目前会让部分响应编排直接 bypass。
   - 但 internal RCC/tool_call 往往在 governance 之后才结构化出来，导致“注入统一、收割失效”。
2. **双命运系统**
   - 一部分走 `reenterPipeline`。
   - 一部分走 `clientInjectOnly`（tmux/client 注入）。
3. **pendingInjection 侧路**
   - mixed tools 通过 session 文件把 servertool 结果滞后注入到下一轮请求。
4. **finalize 错误吞并**
   - malformed tool_call 被清洗后可能降成 `stop + placeholder`，破坏错误闭环。

## 统一骨架（目标态）

### 阶段 0：请求入口归一
- 入口：`HTTP server -> llmswitch-core Hub Pipeline -> Provider`
- 责任：
  - 采集 `capturedChatRequest / sessionId / conversationId / runtime metadata`
  - 注入 request-side servertool state（如 stopless/clock/session scopes）
- 约束：
  - 不在这里做响应级推断
  - 不引入 provider-specific followup 旁路

### 阶段 1：响应预处理（provider -> canonical）
- 责任：
  - decode / format parse / semantic map
  - 保留 provider 原始 text/tool intent
- 约束：
  - 不消费 internal tool_call
  - 不替客户端“修”错误命令

### 阶段 2：tool governance（唯一结构化入口）
- 责任：
  - 把文本 RCC/XML wrapper 收敛成 canonical `tool_calls`
  - 修复**外层形状**，不猜正文语义
- 约束：
  - 只修 wrapper/container
  - 允许 malformed arguments 原样保留，交给客户端校验报错

### 阶段 3：servertool orchestration（唯一消费入口）
- 责任：
  - 统一消费 internal servertool：
    - `reasoning.stop`
    - `review`
    - `clock`
    - `continue_execution`
    - `stop_message_auto`
  - 统一决定：
    - `reenter`
    - `clientInjectOnly`
    - `mixed tools pending injection`
- 约束：
  - followup 响应也必须进入该阶段
  - **必须支持 post-governance pass**
  - internal tool 一旦执行，必须在 finalize 前被 strip

### 阶段 4：finalize（只做形状收口，不做语义吞并）
- 责任：
  - shape normalize
  - reasoning policy
  - strip executed internal tool calls
- 禁止：
  - 禁止把 malformed tool_call 洗成 `stop + empty assistant`
  - 禁止把 internal tool 泄露到 client `required_action/output`

### 阶段 5：client remap / outbound
- 责任：
  - 转成 openai-responses / chat / anthropic 客户端协议
  - 对 client tools 做最终 allowlist + args validation
- 结果：
  - malformed client tool arguments -> 显式 `CLIENT_TOOL_ARGS_INVALID`
  - unknown tool -> 显式 `CLIENT_TOOL_NAME_MISMATCH`

## 统一骨架的硬规则
1. **tool governance 是唯一结构化入口**
   - 不在多个阶段重复 harvest。
2. **servertool orchestration 是唯一 internal tool 消费入口**
   - 不允许 followup bypass 后再期待 finalize 兜底。
3. **finalize 不负责“掩盖错误”**
   - finalize 只能收口形状，不能伪造成 stop。
4. **clientInjectOnly 是命运分支，不是响应编排分支**
   - 允许存在，但必须在统一 orchestration 阶段产生命运决定。
5. **pendingInjection 仅作为 mixed tools 过渡机制**
   - 长期目标是缩减；短期必须加强 session/conversation 绑定与 stale 清理。

## 收敛实施顺序
### P0
1. followup 响应补 post-governance servertool pass
2. finalize 禁止把坏 tool_call 清洗成空回复
3. executed internal tool 在 finalize 前统一 strip

### P1
4. 把 `reasoning_stop_guard / stop_message_auto` 从 dedicated skeleton 逐步压回统一 orchestration 骨架
5. 明确 `clientInjectOnly` 只是一种 execution outcome

### P2
6. 审计并缩减 `pendingInjection`
7. 把 servertool flow graph 文档化，形成单一真源

## 当前决策
- malformed tool_call 的正确处理：**保留到客户端错误闭环**，而不是服务端伪装成成功 stop。
- servertool followup 的正确处理：**按正常响应统一编排**，而不是走 followup 特判旁路。

## 2026-04-16 审计实锤（本轮新增）

### 已确认的结构问题
1. **request 标准化双实现**
   - `src/server/runtime/http-server/executor-response.ts`
   - `src/server/runtime/http-server/executor/provider-response-converter.ts`
   - 两边都各自维护：
     - `backfillAdapterContextSessionIdentifiersFromOriginalRequest(...)`
     - `seedReasoningStopStateFromCapturedRequest(...)`
   - 这会导致 session / conversation / stopless 进入骨架不是单点真源。

2. **response wrapper 双实现**
   - 两边都各自手拼 `__sse_responses` wrapper
   - 各自挂 `finish_reason`
   - 之前都**没有**把 `reasoning.stop finalized` 状态变成统一 wrapper 元数据

3. **stopless 对 streamed wrapper 漏校验**
   - `RequestExecutor.detectStoplessTerminationWithoutFinalization(...)`
   - 之前一旦看到 `__sse_responses` 就直接跳过
   - 导致 `finish_reason=stop` + 无 finalized marker 的 wrapper 仍可 200 透传

4. **engine 仍是超大聚合体**
   - `sharedmodule/llmswitch-core/src/servertool/engine.ts` ≈ 2317 行
   - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` ≈ 1037 行
   - `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-guard.ts` ≈ 705 行
   - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts` ≈ 665 行
   - 当前并非“薄骨架”，而是 trigger / execution outcome / followup dispatch / finalize / loop guard 混在一起。

5. **历史残留仍在 servertool 真路径**
   - `server-side-tools.ts.bak~bak6`
   - `handlers/memory/cache-writer.ts.bak`
   - 说明该区域长期热修，但没有完成真正骨架化。

### 本轮已先落的第一刀
1. 新增 host 壳层共享 helper：
   - `src/server/runtime/http-server/executor/servertool-request-normalizer.ts`
   - `src/server/runtime/http-server/executor/servertool-response-normalizer.ts`

2. 已把 request 侧共享逻辑先抽单点：
   - session / conversation backfill
   - stopless seed

3. 已把 SSE wrapper 共享逻辑先抽单点：
   - `buildServerToolSseWrapperBody(...)`
   - 统一挂：
     - `__sse_responses`
     - `__routecodex_finish_reason`
     - `__routecodex_reasoning_stop_finalized`

4. stopless streamed wrapper 漏检已修：
   - 若 wrapper `finish_reason=stop`
   - 且缺 finalized flag
   - `RequestExecutor` 现在统一抛：
     - `STOPLESS_FINALIZATION_MISSING`

### 下一刀切点（按顺序）
1. **Host 壳层继续单点化**
   - 收掉 `executor-response.ts` / `provider-response-converter.ts` 里剩余的 request/followup metadata 组装重复逻辑

2. **engine 按四段骨架拆分**
   - `trigger detect`
   - `execution outcome decide`
   - `followup dispatch`
   - `finalize + strip`

3. **清历史侧路**
   - pending injection 过渡逻辑
   - followup bypass / post-governance 不一致点
   - `.bak` 残留文件

## 2026-04-16 第二刀（host followup dispatch/error helper 落地）

### 已收口
1. **nested followup dispatch 单点化**
   - 新增 `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
   - 统一承接：
     - followup nested metadata 组装
     - `clientInjectOnly` 预处理
     - nested request execute
   - `executor-response.ts` 与 `provider-response-converter.ts` 不再各自手拼一套 `reenterPipeline` / `clientInjectDispatch`。

2. **followup 错误标记单点化**
   - 新增 `src/server/runtime/http-server/executor/servertool-followup-error.ts`
   - 统一承接：
     - `SERVERTOOL_*` → `provider.followup` stage marker
     - followup reason compact/logging
     - 缺省 HTTP status（当前 converter 路径默认补 502）

### 这一步的意义
- followup 进入 host 壳层后，不再有两份“长得差不多但不完全一样”的 nested dispatch。
- followup 错误不再由多个 callsite 各自猜测和打印，开始收敛到单点 helper。
- 这是把 **followup 当普通请求重进统一链路** 的继续落地，而不是再给 followup 开一条特判旁路。

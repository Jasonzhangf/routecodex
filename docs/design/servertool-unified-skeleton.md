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

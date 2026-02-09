---
# Provider V2 Profile: Gemini Protocol + Family

> 目标：将 `gemini-http-provider` 与 `gemini-cli-http-provider` 中的品牌特判迁移到 Kernel → Protocol → Profile 三层架构。

## 现状盘点

| 当前特判 | 位置 | 应属层级 | 备注 |
|---------|------|----------|------|
| OpenAI Chat → Gemini contents 形状转换 | `gemini-http-provider.ts:preprocessRequest` | Protocol (gemini-chat) | 协议层字段映射 |
| systemInstruction 提取与合并 | `gemini-http-provider.ts:preprocessRequest` | Protocol (gemini-chat) | 同上 |
| x-goog-api-key 认证头处理 | `gemini-http-provider.ts:finalizeRequestHeaders` | Protocol (gemini-chat) | 协议层认证规范 |
| Authorization: Bearer → x-goog-api-key 转换 | `gemini-http-provider.ts` | Protocol (gemini-chat) | 同上 |
| generationConfig 构建 | `gemini-http-provider.ts:buildGenerationConfig` | Protocol (gemini-chat) | 字段映射 |
| Antigravity runtime 检测 | `gemini-http-provider.ts` | Family Profile (antigravity) | 品牌特有运行时 |
| Antigravity session/signature 头注入 | `gemini-http-provider.ts:applyAntigravityRequestCompat` | Family Profile (antigravity) | 同上 |
| Antigravity 错误包装 (wrapAntigravityHttpErrorAsResponse) | `gemini-http-provider.ts:sendRequestInternal` | Family Profile (antigravity) | 错误处理策略 |
| Gemini CLI user-agent 处理 | `gemini-cli-http-provider.ts` | Family Profile (gemini-cli) | CLI 特有头策略 |
| Gemini empty-reply-continue servertool | `gemini-empty-reply-continue.ts` | Protocol (gemini-chat) | 协议层空回复处理 |

## 迁移策略

### Phase 1: Protocol 层 `gemini-chat`

新建 `src/providers/profile/protocols/gemini-chat-protocol.ts`：
- 实现 `ProtocolAdapter` 接口
- 提供 `toProtocolPayload(openaiChat)` → `geminiContents`
- 提供 `fromProtocolResponse(geminiResponse)` → `openaiChat`
- 认证头标准化：`x-goog-api-key`

### Phase 2: Family Profile `antigravity`

新建 `src/providers/profile/families/antigravity-profile.ts`：
- 继承 `gemini-chat` protocol
- 注入 antigravity 特有头：`x-antigravity-session`, `x-antigravity-signature`
- 错误处理：识别 antigravity 特有错误码并包装

### Phase 3: 影子实现验证

1. 保留现有 `gemini-http-provider` 作为影子
2. 新实现走 `http-transport-provider` + profile 路径
3. 对比测试通过后再移除旧实现

## BD 任务拆分

- routecodex-113.10: Gemini Protocol Adapter 设计与实现
- routecodex-113.11: Antigravity Family Profile 迁移
- routecodex-113.12: Gemini CLI Profile 对齐
- routecodex-113.13: 影子实现与对比验证

## 验收标准

- [ ] same-shape replay: Gemini 原生请求前后一致
- [ ] control replay: OpenAI Chat 请求不受影响
- [ ] antigravity 特有功能（session/signature）正常
- [ ] 无回归：现有 Gemini 相关测试通过

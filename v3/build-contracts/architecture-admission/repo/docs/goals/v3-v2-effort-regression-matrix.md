# V2/V3 Reasoning Effort Parity Regression Matrix

## 目的
对比 V2 和 V3 在 reasoning effort 相关字段上的行为等价性。以 responses <> chatprocess <> anthropic/openai 为主要审计路线。

## 核心原则
- 禁止把 V2 单测 PASS 当 V3 等价证据：必须同场景同值断言。
- V2 路径：src/providers/profile/families/；V3 路径：v3-runtime/src/hub_v1/
- 每行必须同时有 V2 测试路径、V3 相同场景、预期等价断言。

## 矩阵

### 1. OpenAI Chat effort -> Provider Wire

| 场景 | V2 测试路径 | V3 红测状态 | 等价断言 |
|------|-----------|------------|---------|
| Responses reasoning_effort=medium -> OpenAI Chat provider wire | router-direct-passthrough.blackbox.spec.ts:301,319 | responses_relay_local_continuation_integration.rs:3464 | V3: body.reasoning_effort==medium；V2: forwarded.reasoning_effort==medium |
| Responses reasoning_effort=low -> OpenAI Chat primary/backup routing | router-direct-pipeline.spec.ts:370,416 | responses_relay_local_continuation_integration.rs:3464 | primary: low preserved；backup: absent（语义一致） |
| Legacy reasoningEffort camelCase -> passthrough | vercel-ai-sdk-openai-transport.spec.ts:195,234 | responses_openai_codec.rs:224 | V2: pickString(reasoning_effort ?? reasoningEffort)；V3: root.get("reasoning_effort") 兼容 camelCase |
| OpenAI Chat effort 无 Responses context -> client response | hub-pipeline-stage-residue-audit.spec.ts:2423 | P2 gap annotation | 无等价：client response 无 effort 字段，V2 不还原，V3 显式不支持 |

### 2. Anthropic thinking budget -> Provider Wire（Inbound）

| 场景 | V2 测试路径 | V3 红测状态 | 等价断言 |
|------|-----------|------------|---------|
| Responses reasoning.budget_tokens -> Anthropic thinking.budget_tokens | hub_anthropic_codec_characterization | anthropic_relay_runtime_integration.rs:89,103,167,223 | V3: thinking.type=enabled，budget_tokens 保留；V2 codec 同语义 |
| Responses thinking_budget alias -> Anthropic thinking.budget_tokens | anthropic_codec fallback | anthropic_codec.rs:497 | V3: reasoning.get("thinking_budget") 备选；V2 同语义 |

### 3. Anthropic thinking budget -> Responses（Outbound）

| 场景 | V2 测试路径 | V3 红测状态 | 备注 |
|------|-----------|------------|------|
| Anthropic thinking.budget_tokens -> Responses reasoning_effort | gap | P3-outbound 待 Jason 授权 | 未实现，gap 标注：v3-protocol-semantic-field-matrix.yml:1554 |

### 4. Gemini thinkingConfig -> Provider Wire

| 场景 | V2 测试路径 | V3 红测状态 | 等价断言 |
|------|-----------|------------|---------|
| thinkingLevel HIGH/MEDIUM/LOW -> Gemini provider wire | V2 N/A（V2 Gemini 不完整） | gemini_relay_runtime_integration.rs E3 GREEN | passthrough：generationConfig.thinkingConfig.thinkingLevel 原样 |
| thinkingBudget+includeThoughts -> Gemini provider wire | V2 N/A | gemini_relay_runtime_integration.rs E3 GREEN | passthrough，无 reasoning.effort 字段 |

### 5. Grok provider rejection

| 场景 | V2 测试路径 | V3 红测状态 | 等价断言 |
|------|-----------|------------|---------|
| reasoning_effort -> Grok wire 显式拒绝 | grok-profile.ts:354-355 | P6 gap annotation | V2: delete body.reasoning_effort/reasoningEffort；V3: sanitizeGrokResponsesWireBody 同语义 |

### 6. Responses Direct effort preservation

| 场景 | V2 测试路径 | V3 红测状态 | 等价断言 |
|------|-----------|------------|---------|
| reasoning_effort=xhigh -> Direct passthrough | router-direct-pipeline.spec.ts:370 | direct_route_model_hooks.rs P4 GREEN | V2: xhigh 保留；V3: passthrough 同 |
| 无 metadata -> Direct passthrough | router-direct-passthrough.blackbox.spec.ts:313 | direct_route_model_hooks.rs P4 GREEN | V2: 不存在即不存在；V3: 同 passthrough |
| 异常值 -> Direct passthrough | router-direct-pipeline.spec.ts:412 | direct_route_model_hooks.rs P4 GREEN | V2: 保留 legacy；V3: 不归一化 |
| 路由不覆盖 -> Direct passthrough | router-direct-pipeline.spec.ts:377 | direct_route_model_hooks.rs P4 GREEN | V2: 无转换；V3: 同 passthrough |

## V3 红测覆盖状态

| 测试文件 | 覆盖场景 | 状态 |
|---------|---------|------|
| gemini_relay_runtime_integration.rs (E3) | Gemini thinkingConfig passthrough | GREEN |
| anthropic_relay_runtime_integration.rs | Anthropic thinking budget inbound | 存在 |
| responses_relay_local_continuation_integration.rs:3464 | Responses -> OpenAI Chat reasoning_effort | 存在 |
| direct_route_model_hooks.rs (P4) | Direct effort no-loss | GREEN |
| v2_v3_reasoning_effort_parity.rs | V2/V3 同场景等价（E5） | 待创建 |

## 未完成项

- E5：v2_v3_reasoning_effort_parity 测试文件待创建。
- P3-outbound：Anthropic thinking.budget_tokens -> Responses reasoning_effort 反向映射待 Jason 授权。

## Owner

- E5: routecodex-v3-runtime
- P3-outbound: 需要 Jason 授权

Refs:
- docs/goals/v3-reasoning-effort-bidirectional-normalization-goal.md E5
- feature_id:v3.gemini_relay_runtime_integration
- feature_id:hub.direct_route_model_hooks.reasoning_effort_no_loss

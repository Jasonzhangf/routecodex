# Provider V2 分层重构 ADR（Draft）

- Status: Draft
- Date: 2026-02-09
- Owner: routecodex-113.1
- Scope: 仅架构与迁移草案，不包含运行时代码改动

## 1. 背景与问题

当前 Provider V2 已实现“协议优先 + 家族表达”的主线，但仍存在以下问题：

1. 通用传输层（`HttpTransportProvider`）混入了多品牌特判，Kernel 职责边界被侵蚀。
2. Protocol 与 Family 差异部分耦合，导致新增供应商时改动面偏大。
3. 兼容行为分散在 profile/header/body/metadata 多点，回归面难以预测。

基于当前代码可观察到的典型信号（作为迁移切入点）：

- Kernel 中存在 iFlow/Antigravity/Codex UA 分支逻辑与签名行为。
- `service-profiles.ts` 既承载基础配置，也承载品牌特定 header 与行为暗约束。
- Factory 在协议映射、module 选择、brand 归一间承担了超出“构造器”范畴的语义。

## 2. 决策（Proposed Decision）

采用三层分离并固定执行次序：

`Kernel -> Protocol -> Family Profile`

并将 Protocol 固定为四大线：

1. OpenAI Chat
2. OpenAI Responses
3. Anthropic Messages
4. Gemini（Gemini CLI 作为同协议变体长期保留）

同时固定配置驱动解析规则：

- 配置显式字段 `providerProtocol` + `providerId` + `compatibilityProfile` 共同决定：
  - 加载哪个 Protocol Adapter
  - 选择哪个 Family 特殊分支（Profile）
  - 启用哪个 Compat Profile
- `providerId` / `providerFamily` 的单一事实来源为“配置文件 + provider 目录映射”。
- runtime metadata 仅承载已解析结果，不再进行二次覆盖决策。

## 3. 分层职责定义

### 3.1 Kernel（基础坑位）

Kernel 只保留“与业务语义无关”的纯通用能力：

- 认证装配（apikey/oauth/tokenfile/cookie）
- HTTP 执行（重试、超时、连接层错误标准化）
- 观测与审计（snapshot、provider error 上报）
- 运行时 metadata 传递与最小标准化
- Hook 调度框架（仅调度，不承载品牌策略）

Kernel 禁止：

- 品牌识别分支（例如 `iflow` / `qwen` / `glm`）
- 特定上游签名算法、header 语义修复
- 模型级行为修复与策略 fallback

### 3.2 Protocol（四大协议层）

Protocol 层只负责 wire contract：

- 路径与方法约束（例如 `/chat/completions`、`/responses`、`/v1/messages`）
- 请求体基础 shape（消息字段、stream 字段、tools 字段）
- 响应体解析与流式边界
- 与 Hub Pipeline 的协议接口一致性

Protocol 禁止：

- 品牌业务规则
- OAuth/风控策略特判

### 3.3 Family Profile（供应商品牌层）

Family Profile 承载“同协议下不同品牌”的差异策略：

- header policy（默认头、优先级、互斥/清理）
- auth policy（oauthProviderId 解析、token 形态扩展）
- request policy（字段注入、字段裁剪、模型映射）
- response policy（错误 envelope 归一、供应商业务码映射）
- optional signing policy（例如 iFlow 的签名规则）

Profile 必须是声明式 + 小型策略函数，不允许变成第二个 transport kernel。

## 4. 建议抽象（接口草案）

> 下面是抽象方向草案，用于统一未来实现，不代表本次已改代码。

### 4.1 Kernel SPI

```ts
interface ProviderKernel {
  send(input: KernelRequest): Promise<KernelResponse>;
  buildContext(runtime: ProviderRuntimeProfile): ProviderContext;
  reportError(error: unknown, context: ProviderContext): ProviderErrorAugmented;
}
```

### 4.2 Protocol Adapter

```ts
interface ProtocolAdapter {
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini';
  resolveEndpoint(input: ProtocolInput): string;
  buildBody(input: ProtocolInput): Record<string, unknown>;
  parseResponse(raw: unknown, context: ProviderContext): Record<string, unknown>;
}
```

### 4.3 Family Profile

```ts
interface ProviderFamilyProfile {
  family: string;
  applyRequestPolicy(input: RequestPolicyInput): RequestPolicyOutput;
  applyHeaderPolicy(input: HeaderPolicyInput): HeaderPolicyOutput;
  applyResponsePolicy(input: ResponsePolicyInput): ResponsePolicyOutput;
  classifyUpstreamError?(error: unknown, context: ProviderContext): ProviderErrorAugmented;
}
```

### 4.4 组合执行顺序

1. Kernel 构建上下文
2. Protocol 生成基础 endpoint/body
3. Family Profile 应用增量策略
4. Kernel 发送请求并标准化错误
5. Protocol 解析响应
6. Family Profile 后处理（可选）

### 4.5 配置驱动解析顺序（已定稿）

1. 从配置读取 `providerProtocol`，绑定唯一 Protocol Adapter。
2. 从配置读取 `providerId`（并通过 provider 目录映射到 `providerFamily`），绑定 Family Profile。
3. 从配置读取 `compatibilityProfile`，绑定 Compat Profile。
4. 若缺字段或映射不存在，直接 fail-fast（禁止运行时猜测或静默降级）。

## 5. 目录与模块建议（目标态）

```text
src/providers/core/
  kernel/
    provider-kernel.ts
    http-executor.ts
    auth-runtime.ts
    error-normalizer.ts
  protocols/
    openai-chat/
    openai-responses/
    anthropic-messages/
    gemini/
  profiles/
    families/
      iflow/
      qwen/
      glm/
      antigravity/
      openai/
      anthropic/
      gemini/
    registry.ts
  runtime/
    provider-composer.ts
    provider-factory.ts
```

## 6. 当前代码到目标层的迁移原则

1. 先抽“边界”再迁“逻辑”：先把入口与调用点稳定，再移动策略实现。
2. 保持 fail-fast：任何未知 family/profile 不自动兜底修复。
3. 单一事实来源：同一策略只能在一层实现一次。
4. 一次一个 family 的最小切片迁移，配套 replay 证据。

## 7. 分阶段计划（与 BD 子任务对应）

### Phase A（routecodex-113.1）

- 冻结分层定义、接口草案、风险边界（本 ADR）

### Phase B（routecodex-113.2）

- 完成“现有特判 -> Kernel/Protocol/Profile”迁移矩阵

### Phase C（routecodex-113.3）

- 确定 Profile API 与 Registry 解析顺序

### Phase D（routecodex-113.4）

- 输出迁移批次和回滚机制（按 family 批次）

### Phase E（routecodex-113.5）

- 固化验证矩阵：same-shape replay + control replay + build/install gate

## 8. 关键风险与控制

1. **风险：Profile 膨胀为新内核**
   - 控制：Profile API 仅允许策略函数，禁止直接发 HTTP。
2. **风险：Protocol 与 Profile 双重改写冲突**
   - 控制：定义字段所有权，冲突即 fail-fast。
3. **风险：迁移期行为漂移**
   - 控制：每个切片必须提供 before/after replay 对照。

## 9. 非目标（本轮明确不做）

- 不在本 ADR 阶段做运行时代码迁移。
- 不改 Hub Pipeline 的工具与路由职责边界。
- 不引入新协议类型（先稳定四协议）。

## 10. 已确认决策（2026-02-09）

1. Gemini CLI 长期作为 Gemini 协议变体。
2. `providerId` / `providerFamily` 单一事实来源来自配置文件与 provider 目录映射。
3. 配置显式字段 `providerProtocol + providerId + compatibilityProfile` 决定 protocol/profile/compat 加载。

## 11. 待后续细化（routecodex-113.2/113.3）

1. provider 目录映射表的最终落地位置与维护方式。
2. compatibilityProfile 在 host/provider/core 的边界校验策略（仅透传 vs 预校验）。
3. Profile API 的最小能力集（首批是否仅 header/auth/request）。


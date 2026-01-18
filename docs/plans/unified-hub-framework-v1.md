# Unified Hub Framework V1（单一路径 + 强制白名单 + 协议注册表）设计文档

本文档是一个“逐步迁移”的架构改造计划，目标是把当前 llmswitch-core 的入站/出站/工具治理/ServerTool followup 等逻辑，收敛到**一套不可绕过的骨架**（single execution path），并把协议差异从“各处散落实现”改造成“表驱动 + 注册表 + 强制策略（policy）”。

## 0. 背景与约束（不可违背）

来自 RouteCodex V2 Working Agreement 的硬约束：

- **单一执行路径**：`HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`。
- **llmswitch-core 负责工具与路由**：host/server/provider 不得“修补工具调用/重写参数/决定路由”；只能使用 Hub Pipeline APIs。
- **Provider 层仅做传输**：auth/HTTP/retry/compat hook，不做 payload 语义检查与修补。
- **Fail fast**：上游错误必须经 providerErrorCenter + errorHandlingCenter 冒泡，无静默 fallback。
- **Config-driven**：host 只消费 `bootstrapVirtualRouterConfig` 的输出。

本文档的方案会把这些约束“制度化”为框架级别的强制机制，而不是依赖开发习惯。

## 1. 问题陈述（为什么会反复回归）

现状并不是“没有骨架”，而是：

1) **协议差异分散在多处，形成多套“局部骨架”**
- 同一类规则（参数白名单/字段位置/工具形态）在 semantic-mapper、bridge、servertool followup builder 等地方各写一份。
- 这些模块在实践中具备“独立执行能力”（自己组包/自己变更结构），导致出现“绕过骨架”的第二路径。

2) **白名单不是中心化的“契约/政策”，而是若干实现片段**
- 改动时很容易只改到一处，漏掉其它分支（例如 wrapper/字段位置差异导致的 400/502）。
- CI 难以系统性捕获：因为没有统一的策略验证点，违规不会在边界处被观测/阻断。

3) **语义治理（tools/servertools/stopMessage/web_search）仍然夹杂在协议实现里**
- 导致协议越多，分叉越多；新增功能时会在多个协议上重复做“相同语义”的实现与修补。

## 2. 目标（V1 的“完成态”）

V1 的完成态强调“可被强制执行”的工程结构：

- **HubPipeline 是唯一可执行入口**：任何入站、出站、followup 都必须通过同一条 pipeline 路径。
- **协议实现不可独立执行**：协议代码只允许提供 `ProtocolSpec`（表/纯函数），不允许直接拼装可出站 payload。
- **白名单/字段位置/映射规则由 PolicyEngine 统一执行**：协议实现不能绕过；CI 可以强约束。
- **语义统一到 ChatSemantics 的 Operation Table**：协议只负责“wire ↔ ops”的映射；所有行为由统一的 ops 执行器完成。

## 3. 核心方案（架构组件）

### 3.1 ProtocolSpec：协议规格注册表（不可执行）

为每个协议定义一个“规格对象”，用于描述差异，而不是承载执行逻辑。

建议结构（概念）：

- `id`: 协议标识（如 `openai-responses` / `anthropic-messages` / `gemini-chat` …）
- `wireShape`: 入站/出站字段布局约束
  - 允许出现在哪些层级（top-level / metadata.extraFields / internal carrier）
  - streaming 字段优先级与限制（followup 必须 non-stream 等）
- `parameterPolicy`: 参数白名单与映射
  - allowlist（按方向：client_in / provider_out / provider_in / client_out）
  - key remap（如 `max_tokens -> max_output_tokens`）
  - container/layout（例如 Responses：禁止 `parameters:{...}` wrapper，只能 flatten）
- `toolSurface`: 工具定义/调用/结果的形态规范
  - tool definition shape（function tools / builtin tools）
  - tool call shape（chat 的 tool_calls vs responses 的 output.function_call）
  - tool result shape（submit_tool_outputs 形态）
- `compatProfiles`: 可选的兼容 profile（仅做字段 remap/cleanup；禁止做语义修复/路由决策）

实现原则：

- ProtocolSpec 只允许“表 + 纯函数”，不得访问网络/环境/路由状态。
- ProtocolSpec 不能调用 Provider；所有出站必须由骨架统一负责。

### 3.2 PolicyEngine：强制白名单/字段位置/映射执行器（骨架所有）

PolicyEngine 是 HubPipeline 内部组件，负责把 ProtocolSpec 转化为“不可绕过的边界政策”。

PolicyEngine 在每个边界执行三类动作：

1) `sanitize`：不允许字段一律转入 `metadata.extraFields`
- 不丢上下文，但**绝不让违规字段出站**。

2) `normalize`：按 spec 做 key remap + 字段布局标准化
- 解决“同语义不同字段位置/命名”导致的协议不兼容问题。

3) `assert`：在 CI/调试模式下硬断言
- “违规字段/布局/工具形态”直接抛错（fail fast）。
- 生产环境可采用 “采样断言 + 快照上报”，先观测再逐步收紧。

PolicyEngine 的关键要求：

- **所有出站（含 servertool followup）必须经 PolicyEngine**。
- 协议实现不得自行做白名单过滤/布局变更；否则将形成多套政策源。

### 3.3 Operation Table：统一语义到 ChatSemantics（配置驱动）

把“行为”从协议实现里抽离，迁移到 chat process 的统一语义表上：

- `ChatSemantics.ops: Operation[]`（或分域后最终归并为 Operation 表）
- 每个 Operation 是可组合的执行单元（已有能力应尽量复用现存实现）：
  - tool governance（形态校验/归一化/透传策略）
  - web_search（注入 tool result / 或其它注入策略）
  - stopMessage（停下/继续的 followup 生成）
  - streaming 决策
  - route hints / sticky / clear 等路由指令（仍属于 core）

协议差异将变为：

- “wire → ops 的映射表” + “ops → wire 的渲染表”

而不是：

- “每协议一套 if/else 行为实现”。

### 3.4 Canonical Builders：收口所有“组包”入口（尤其 followup）

在 V1 里必须明确禁止以下行为：

- 在 servertool handler 内自行 build provider payload（协议分支拼装）
- 在 bridge 内部自行决定字段布局（绕过政策）

替代方案：

- `buildProviderRequestFromChat(envelope, spec, ctx)`：唯一出站组包入口
- `buildClientResponseFromChat(envelope, spec, ctx)`：唯一回包入口
- `buildFollowupFromCapturedEntry(capture, injection, ctx)`：唯一 followup 入口
  - followup 必须复用入口 capture（深拷贝），只做 injection
  - `disableStickyRoutes: true` / `preserveRouteHint: false` / entry endpoint meta 等策略由框架统一注入，而不是散落在各 handler

## 4. 迁移路线（逐步收敛、可回滚）

### Phase 0（观测）：只记录不改写

目标：建立“可量化的违规清单”，不破坏现有行为。

- 在 HubPipeline 关键边界插入 PolicyEngine 的 observe 模式：
  - req inbound 完成后
  - provider outbound 发送前
  - provider inbound 解析后
  - client outbound 回包前
- 输出：
  - 每协议的违规字段统计
  - 违规快照（含 requestId/endpoint/protocol）

验收标准：

- 不改变任何线上行为（只加日志/快照）。
- 能得到一份“每协议整改 checklist”。

### Phase 1（政策收口）：统一参数白名单 + 字段位置（收益最大、风险最低）

目标：解决大部分 “400/字段不认/位置不对” 类问题，并防止复发。

- 建立 `ProtocolSpec.parameterPolicy` 并把所有协议的 allowlist/映射/容器规则收口。
- 所有 provider outbound（含 followup）必须走：
  - `sanitize → normalize → buildProviderRequestFromChat`
- CI 新增断言：
  - “禁止出现未允许字段”
  - “禁止出现错误容器/布局（例如 parameters wrapper）”

验收标准：

- 通过错误样本回归（errorsamples）与现有 e2e。
- 违规字段数量显著下降，且新增协议不会引入新路径。

### Phase 2（工具形态收口）：统一 tools 的 definition/call/result 骨架

目标：工具循环不再因为“形态改写/历史与本次不一致”反复出错。

- 将工具表述抽象为 `ProtocolSpec.toolSurface`，并在 PolicyEngine/ToolGovernance 边界统一治理：
  - “形态归一”与“透传模式”都必须可由 spec/policy 配置（支持 A/B）。
- 明确规则：
  - **任何情况下回包格式必须正确**（内容不一定正确，但结构不得静默失败）。
  - 禁止 silent catch：需要结构化记录 + 可定位快照。

验收标准：

- 新增工具/新增协议不会导致工具循环分叉。
- tool governance 的行为可配置、可回放、可回归。

### Phase 3（followup 收口）：ServerTool followup 彻底统一

目标：stopMessage/web_search/apply_patch_guard 等 followup 都走同一条路径。

- 强制：所有 handler 只负责“决定 injection”，不得自行构造 payload。
- `FollowupRequestBuilder` 从 capture 构造（深拷贝）并注入：
  - entry endpoint meta（保证回路正确）
  - disableStickyRoutes / preserveRouteHint 等框架策略
  - route hint/stopMessage 状态推进策略

验收标准：

- servertools 之间只允许注入内容不同，结构生成逻辑完全复用。
- 任意协议下 followup 构建一致，差异由 spec 控制。

### Phase 4（语义迁移）：把协议逻辑迁移到 Operation Table

目标：把“协议分支中的语义实现”迁出，协议只保留映射表。

- 从通用语义开始迁移：streaming、tool choice、web_search、stopMessage。
- 再迁移协议特殊字段为 ops 映射（保持兼容 profile 仅做字段清理）。

验收标准：

- semantic-mapper 逻辑显著减少，主要是字段搬运+映射。
- 新增语义能力只需新增 Operation（无需改多协议分支）。

### Phase 5（删旧路径）：删除独立执行逻辑，保证“只有一个执行路径”

目标：结构性保证不再回到“各自实现”的状态。

- 标记旧的 builders/bridges 为 deprecated。
- 删除/封装所有允许绕过骨架的入口函数，仅保留：
  - ProtocolSpec 注册
  - PolicyEngine 执行
  - Operation 执行器

## 5. 测试与回归策略（保证可控演进）

建议把回归分为三层，确保每一层都有“格式必正确”的断言：

1) **PolicyEngine 单元测试**：每协议的 allowlist/layout/映射测试（可表驱动）。
2) **HubPipeline 快照回归**：errorsamples（输入/输出/快照 meta）覆盖典型失败场景。
3) **端到端（可选但建议）**：启动 mock upstream（如 antigravity）对 provider 直接请求，覆盖工具循环与 followup 行为。

## 6. 风险与控制（如何避免“大改崩盘”）

- 风险：一次性收口会影响多协议行为。
  - 控制：Phase 0 先观测，Phase 1 只动白名单与布局，逐步收紧断言。
- 风险：协议特殊 case 被误当作“违规字段”移入 extraFields。
  - 控制：spec 明确声明允许字段；extraFields 仅作为保留槽，不应出站。
- 风险：开发绕过框架继续写独立逻辑。
  - 控制：CI 增加“边界断言 + 禁止导入/调用某些 builder”的 lint 规则（后续实现）。

## 7. 需要你审批的“下一步落地切入点”

为了最小风险、最大收益，建议优先落地：

- **Phase 0**：PolicyEngine observe-only（不改行为）
- **Phase 1**：参数白名单与字段位置收口（把出站组包入口统一）

审批点建议：

- ProtocolSpec 的最小字段集合（V1 先覆盖 parametersPolicy + wireShape 的关键布局规则）。
- PolicyEngine 的运行模式（CI hard assert / prod 采样）。
- followup 的统一 builder 是否在 Phase 1 还是 Phase 3 再收口（取决于当前回归压力）。


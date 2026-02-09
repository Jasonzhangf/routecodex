# Provider V2 特判迁移矩阵（Draft）

- Status: Draft
- Date: 2026-02-09
- Owner: routecodex-113.2
- Strategy: 先实现，不连线；最后按批次逐个连线

## 1. 迁移方法（按你确认的策略）

本矩阵遵循固定执行法：

1. 先把 Kernel / Protocol / Profile 的新实现落地为“未接线模块”（dark implementation）。
2. 在不改变现网执行路径前提下，补齐单测、样本回放、same-shape 对比。
3. 最后按 provider family 逐个接线，单批次可回滚。

## 2. 当前特判清单与归属矩阵

| ID | 当前位置（文件:行） | 当前行为 | 目标层 | 迁移动作 | 风险级别 | 连线阶段 |
|---|---|---|---|---|---|---|
| M01 | `src/providers/core/runtime/http-transport-provider.ts:780` | `iflowWebSearch` 特判 endpoint `/chat/retrieve` | Family Profile（iflow） | 从 Kernel 抽离为 `iflow.requestPolicy.resolveEndpoint()` | 高 | Wave-1（iflow） |
| M02 | `src/providers/core/runtime/http-transport-provider.ts:804` | `iflowWebSearch` 特判 body 直透 `request.data` | Family Profile（iflow） | 抽离为 `iflow.requestPolicy.buildBody()` | 高 | Wave-1（iflow） |
| M03 | `src/providers/core/runtime/iflow-http-provider.ts:40` | iFlow 子类重复实现 webSearch endpoint/body 特判 | Family Profile（iflow） | 去重，保留单一事实实现（profile） | 高 | Wave-1（iflow） |
| M04 | `src/providers/core/runtime/http-transport-provider.ts:992` | iFlow UA 优先级反转（service UA > inbound UA） | Family Profile（iflow） | 抽离为 `iflow.headerPolicy.resolveUserAgentPriority()` | 高 | Wave-1（iflow） |
| M05 | `src/providers/core/runtime/http-transport-provider.ts:1212` | iFlow `session-id/conversation-id` 规范化 + 签名头 | Family Profile（iflow） | 抽离为 `iflow.signingPolicy.applyHeaders()` | 高 | Wave-1（iflow） |
| M06 | `src/providers/core/runtime/http-request-executor.ts:499` | iFlow HTTP200 + status=439 token expired 特判抛错 | Family Profile（iflow） | 抽离为 `iflow.responsePolicy.classifyBusinessEnvelope()` | 高 | Wave-1（iflow） |
| M07 | `src/providers/core/runtime/http-request-executor.ts:531` | iFlow business envelope `error_code/msg` -> HTTP_400 | Family Profile（iflow） | 抽离为 `iflow.errorPolicy.toProviderError()` | 高 | Wave-1（iflow） |
| M08 | `src/providers/core/runtime/http-transport-provider.ts:888` | Gemini-family 注入 `X-Goog-Api-Client` / `Client-Metadata` | Family Profile（gemini, qwen） | 下沉到对应 profile header policy | 中 | Wave-2（gemini/qwen） |
| M09 | `src/providers/core/runtime/http-transport-provider.ts:1048` | Antigravity 删除 `session_id/conversation_id` | Family Profile（antigravity） | 抽离为 `antigravity.headerPolicy.cleanup()` | 中 | Wave-2（antigravity） |
| M10 | `src/providers/core/runtime/http-request-executor.ts:403` | Antigravity 多 base fallback 条件（429/400/context-error） | Family Profile（antigravity）+ Kernel retry SPI | 先抽 SPI，再由 antigravity profile 提供策略 | 高 | Wave-2（antigravity） |
| M11 | `src/providers/core/runtime/gemini-http-provider.ts:70` | OpenAI 消息转 Gemini `contents/systemInstruction` | Protocol（gemini） | 保留在 Gemini Protocol Adapter，统一入口 | 中 | Wave-3（protocol） |
| M12 | `src/providers/core/runtime/gemini-http-provider.ts:176` | Antigravity 签名类错误包装为 response | Family Profile（antigravity） | 抽离为 profile response policy | 中 | Wave-2（antigravity） |
| M13 | `src/providers/core/runtime/provider-factory.ts:388` | `gemini-cli-oauth` 决定实例化 GeminiCLI provider | Protocol + Profile 选择器 | factory 仅装配，选择逻辑迁到 registry resolver | 中 | Wave-3（factory clean） |
| M14 | `src/providers/core/runtime/base-provider.ts:582` | gemini-cli/antigravity 429 bucket 粒度按 model | Family Profile（antigravity/gemini-cli） | 抽离为 rate-limit profile policy | 中 | Wave-2 |
| M15 | `src/providers/core/config/service-profiles.ts:123` | glm/qwen/iflow/gemini-cli 默认 header/base/model 混在基础 profile | Profile 目录（family defaults） | 拆成 protocol-base + family-default overlay | 中 | Wave-3 |
| M16 | `src/providers/core/utils/provider-type-utils.ts:14` | LEGACY family->type 映射与协议映射耦合 | Registry（provider 目录映射） | 单独迁入 provider-directory map | 中 | Wave-3 |
| M17 | `src/providers/core/config/provider-oauth-configs.ts:26` | OAuth 配置按 providerId 硬编码（qwen/iflow/gemini-cli/antigravity） | Family Profile（auth policy） | 抽为 profile-auth config，kernel 仅执行 flow | 中 | Wave-2 |
| M18 | `src/providers/core/runtime/http-transport-provider.ts:1290` | `isIflow/isAntigravity` 运行时识别散落在 transport | Registry + Profile resolver | 由配置 `providerId` + provider目录映射统一识别 | 高 | Wave-1/2 |

## 3. 哪些应该留在 Kernel（不迁）

以下能力保留在 Kernel，禁止品牌化：

- 认证 provider 生命周期装配（auth provider 初始化与 headers 合并）。
- HTTP 重试/超时/请求快照写入。
- Provider error 上报与标准字段补齐。
- runtime metadata 的只读透传。

## 4. 高风险项与依赖

### 高风险项

1. iFlow 业务错误 envelope（M06/M07）
   - 风险：迁移不完整会导致 200 响应落到后续阶段才报 malformed。
2. iFlow 签名头（M05）
   - 风险：签名 payload 任何字段顺序变化都会直接 400。
3. Antigravity fallback（M10）
   - 风险：错误重试策略漂移会放大失败率。
4. iflowWebSearch 双实现（M01/M02/M03）
   - 风险：双源逻辑导致行为不一致，必须先去重再连线。

### 前置依赖

- 需要先完成 `routecodex-113.3` 的 Profile API 与 Registry 解析顺序。
- 需要在 `routecodex-113.5` 固化 same-shape/control replay 模板后再做批量连线。

## 5. “先实现不连线”落地清单

### 实现阶段（不接线）

1. 新建 `profiles/families/iflow/*`，实现 endpoint/body/header/signature/error policy。
2. 新建 `profiles/families/antigravity/*`，实现 fallback/header/error policy。
3. 新建 `protocols/gemini/*` 适配器，承接消息 shape 转换。
4. 新建 `profiles/registry.ts` 与 provider-directory 映射解析器。

> 以上阶段只做“可调用实现 + 单测 + 回放对比”，不替换现有执行路径。

### 连线阶段（逐批次）

1. Wave-1 仅接 iFlow（M01~M07, M18-iflow）。
2. Wave-2 接 antigravity/gemini-cli（M09/M10/M12/M14/M17）。
3. Wave-3 做 factory/service-profile/provider-type-utils 清理（M11/M13/M15/M16）。

## 6. 验收证据（113.2 完成定义）

- 必须提供每个 Mxx 的“旧位点 + 新归属 + 迁移批次 + 风险”映射。
- 必须明确哪些保留在 Kernel，防止过度下沉。
- 必须给出分批连线顺序与回滚单位。


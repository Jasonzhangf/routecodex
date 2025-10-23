# LLMSwitch 模块抽离与透明切换计划（dev 专用）

本文档描述如何将现有 LLMSwitch 与编解码（codecs）能力抽离为独立可发布模块（位于 `./sharedmodule`），并在不影响现有主链路的前提下，实现“透明切换”。所有实现与提交仅在 `dev` 分支推进，待全面验证后再合入 `main`。

## 目标与非目标

### 目标
- 将协议转换核心（路由器 + 编解码器 + 映射 helper）抽离为独立包（临名：`@routecodex/llmswitch-core`）。
- 统一工具/参数/推理/工具结果映射的实现，形成唯一入口（shared helper）。
- 保持对现有 `routecodex` 包的“透明切换”：在 dev 下优先使用 `sharedmodule` 版本；发布后改用 NPM 依赖。
- 清理旧设计与冗余代码，现存 LLMSwitch 仅保留“薄适配器”。

### 非目标
- 不恢复 CI/CD；暂不接入自动化发布流程（先手动验证为主）。
- 不引入新的运行态“行为兜底”。配置生成层的最小构造器保留（用于启动保障），但协议/响应路径不新增 fallback。

## 产出物
- `sharedmodule/llmswitch-core/`（可发布 NPM 包）：
  - `src/conversion/codec-registry.ts`
  - `src/conversion/switch-orchestrator.ts`
  - `src/conversion/codecs/{anthropic-openai,openai-openai,responses-openai}.ts`
  - `src/conversion/shared/tool-mapping.ts`（server.method→通用函数、arguments 严格 JSON、tools schema 校验）
  - `src/conversion/shared/reasoning-mapping.ts`（provider `reasoning_content` → Responses.output reasoning）
  - `src/types/*`（最小对外类型）
  - `package.json`（独立版本、构建脚本、出包设置）

- `routecodex` 主包：
  - `llmswitch-*.ts`（薄适配器，仅委派到 core）
  - 删除/停用冗余逻辑与 `.bak`
  - dev 下通过 workspace 依赖 core；发布后切换为 NPM 依赖

## 分阶段计划

### 阶段 0：基线冻结与回放校验（0.5 天）
- 标记当前 dev 基线（0.53.x / 0.54.x）；运行端到端回放：/v1/messages、/v1/chat/completions、/v1/responses（非流+SSE）各 5 条。
- 目标：确认现状健康，为后续抽离提供基线对比。

### 阶段 1：在 `sharedmodule` 内新建 core 包（1 天）
- 新建 `sharedmodule/llmswitch-core/`：
  - `package.json`（name:`@routecodex/llmswitch-core`、type:module、exports、build 脚本）
  - `tsconfig.json`（独立编译）
  - 复制并收敛：`conversion/codec-registry.ts`、`conversion/switch-orchestrator.ts`、`conversion/codecs/*`、`conversion/shared/*`（新增）
- 在 core 中实现/统一：
  - server.method → 通用函数名 + `arguments.server` 注入（白名单：read_mcp_resource / list_mcp_resources / list_mcp_resource_templates）
  - arguments 严格 JSON 序列化与 schema 校验（复用 `tool-schema-normalizer` 逻辑）
  - provider `reasoning_content` → Responses.output reasoning 的唯一实现
- 在 dev 根 `package.json` 增加 workspace 引用该包。

### 阶段 2：薄适配器化现有 LLMSwitch（1–1.5 天）
- `llmswitch-openai-openai.ts`：仅做初始化、日志、委派到 core 的 openai-openai-codec；移除 normalize 细节。
- `llmswitch-response-chat.ts`：仅做初始化、日志、委派到 core 的 responses-openai-codec（或桥接的 codec 化实现）；移除手工拼接分支。
- `llmswitch-anthropic-openai.ts`：逐步收敛到 core；如仍需局部适配，仅保留薄层。

### 阶段 3：透明切换（0.5 天）
- dev 模式：路由器与编解码从 workspace 的 `@routecodex/llmswitch-core` 引用。
- 发布模式：`routecodex` 主包改为 NPM 依赖 `@routecodex/llmswitch-core`（版本锁定），并提供脚本 `scripts/switch-config-deps.mjs` 在“本地/发布”之间切换（仓库已有同类脚本，可复用）。

### 阶段 4：配置生成层稳态（0.5 天）
- 强化最小构造器（已实现）：
  - 从 `routeTargets/pipelineConfigs` 生成 pipelines/routePools/routeMeta
  - provider=glm → `glm-compatibility`；否则 `passthrough-compatibility`
  - llmSwitch 固定 `llmswitch-conversion-router`
  - 注入 alias API Key（从 keyMappings/authMappings 解析）
- 更新文档，说明“无 compat-exporter 时的最小化行为（仅配置生成层的兜底，非协议路径 fallback）”。

### 阶段 5：冗余清理与文档（0.5–1 天）
- 删除 `.bak` 历史副本（已做一轮，继续收尾）。
- 移除/弃用旧统一模块 `llmswitch-unified` 等（先标记弃用，再最终移除）。
- 更新 `llmswitch/README.md` 与开发文档，明确：
  - 主链路：conversion-router + orchestrator + codecs
  - 适配器职责：仅委派
  - 映射唯一入口：shared helper（工具/推理/结果）

### 阶段 6：回归与基准验证（0.5–1 天）
- /v1/messages、/v1/chat/completions、/v1/responses（非流+SSE）：
  - 工具调用/纯文本/空文本/大推理等变体；至少 30 条回放
  - 对齐 upstream.sse 的事件与字段（工具场景：`function_call_arguments.delta/done`→`response.completed`；不发 `response.required_action`）
  - 统计工具调用 arguments 严格率（100%）

## 验收标准
- dev 下：
  - 适配层稳定，只进行委派，不承载业务逻辑
  - SSE 与 JSON 在工具/文本两类场景与透传样本一致（字段/顺序）
  - 工具映射/参数校验/推理映射在 shared helper 统一实现
- `@routecodex/llmswitch-core` 可独立构建与发布（npm pack 正常、类型/exports 正常）
- 无运行时 fallback（协议路径）；配置生成层最小构造器可避免启动失败

## 风险与缓解
- 风险：分叉逻辑遗漏 → 用 rg 检查所有工具/推理映射与 ResponsesMapper/SSE 调用点，统一引用 shared helper。
- 风险：发布/本地双模式差异 → 保持脚本化切换与固定版本依赖；dev 全程使用 workspace。
- 风险：最小构造器遗漏 alias 注入 → 增强从 keyMappings/providers 解析的覆盖能力（已列入阶段 4）。

## 里程碑与时间
- 阶段 0：0.5 天
- 阶段 1：1 天
- 阶段 2：1–1.5 天
- 阶段 3：0.5 天
- 阶段 4：0.5 天
- 阶段 5：0.5–1 天
- 阶段 6：0.5–1 天

总计：约 4–5.5 天，不含额外 CI 恢复工时。

## 版本与发布
- dev：在 `routecodex` 根与 `sharedmodule/llmswitch-core` 同步 bump 预版本（0.0.x / 0.1.x）。
- main：整体迁移完成后，合并 dev → main，并发布 `routecodex` + `@routecodex/llmswitch-core`。


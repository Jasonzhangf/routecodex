# RouteCodex Mock 测试覆盖计划 (TOON 启用后更新)

## 背景

项目已启用 TOON（Tool Object Object Notation）格式用于工具调用参数编码，需要更新 mock 测试覆盖计划。

## 目标

1. 构建基于 Virtual Router classifier 的 codex 样本分类脚本
2. 完善 mock provider 测试，特别是 TOON 工具、apply_patch 测试
3. 确保所有新样本在加入 CI 前通过验证

## 执行计划

### Phase 1: 基础分析

- [x] 分析现有 mock-provider samples
- [x] 识别 TOON 相关样本（在 `samples/mock-provider` 中发现 TOON 编码样本）
- [ ] 创建 Virtual Router classifier 分类脚本
- [ ] 从最新 codex samples 提取 TOON 工具样本

### Phase 2: Mock Provider 测试增强

#### 2.1 基础测试矩阵

- [x] Mock provider 基础实现
- [x] 普通工具调用测试
- [x] apply_patch 工具测试
- [x] shell command 测试
- [ ] TOON 工具测试（新增）

#### 2.2 TOON 特殊测试

- [ ] TOON 参数编码 mock 响应
- [ ] TOON 参数解码验证
- [ ] 复杂 TOON 场景（多行、特殊字符）
- [ ] TOON 与现有工具格式兼容性

### Phase 3: 样本分类与筛选

#### 3.1 创建分类脚本

创建 `scripts/classify-codex-samples.mjs`：

```javascript
// 按 Virtual Router classifier 分类
- providerKey 分类（glm, gemini, openai, anthropic）
- 工具类型分类（apply_patch, TOON, shell, 普通工具）
- 识别 tool_calls 结构
- 标记未覆盖场景
```

#### 3.2 第一批覆盖目标

- [x] 普通工具调用：已有 mock samples
- [x] apply_patch：已有 `mock.apply_patch.toolloop`
- [ ] TOON 工具：从最新 samples 筛选
- [ ] shell command：筛选复杂命令样本

### Phase 4: 测试文件组织

```
tests/servertool/
├── mock-provider-tests.spec.ts
├── apply-patch-compat.spec.ts
├── toon-tool-compat.spec.ts      # 新增
├── shell-command-compat.spec.ts
└── tool-loop-compat.spec.ts
```

### Phase 5: CI 集成检查清单

- [ ] 所有测试本地通过
- [ ] TOON 编码/解码测试覆盖完整
- [ ] 测试运行时间 < 30s
- [ ] 无外部依赖
- [ ] CI 配置更新

## 下一步行动

1. 编写 `scripts/classify-codex-samples.mjs` 分类脚本
2. 从最新 codex samples 提取 TOON 工具样本
3. 创建 TOON 工具 mock 测试
4. 验证后集成到 CI

---

## Antigravity 429 调查任务（gcli2api ⇄ RouteCodex）

> 目标：从 **gcli2api 能 200 的请求形态** 和 **RouteCodex 当前 429 的 upstream 请求** 两端出发，靠 curl 一步步「收敛」，精确锁定导致 429 的最小差异，然后再回写到 RouteCodex。

### Phase A：收集两边的真实请求形态

- [x] A1 在 RouteCodex 上开启 `ROUTECODEX_DEBUG_ANTIGRAVITY=1`，打一次失败的 `claude-sonnet-4-5-thinking` 请求，拿到 `~/antigravity-rc-http.json`（RC → Antigravity 的真实 HTTP 请求）。
- [x] A2 在 gcli2api 上用同一个 token + 同一个模型打一次成功请求，确认生成/更新 `~/antigravity-debug-request.json`（gcli2api → Antigravity 的真实 HTTP 请求）。

### Phase B：从 gcli2api 200 形态向 RouteCodex 收敛（curl 实验）

- [x] B1 以 `antigravity-debug-request.json` 为 baseline，用 curl 直接打 Antigravity，确认 200（作为对照组）。
- [x] B2 在 gcli2api 环境中，把 baseline 的 `request.contents` 换成 RouteCodex 那条请求的 contents（保持 systemInstruction / generationConfig / headers 不变），用 curl 验证仍然 200（目前对于复杂 contents 会触发 400，已记录）。
- [x] B3 在不动 contents 的前提下，按 RouteCodex 现在的形态，依次改动：
  - B3.1 删除 / 修改 `generationConfig`；
  - B3.2 删除 `systemInstruction`；
  - B3.3 删除 / 修改 `requestType`；
  - B3.4 对齐 RouteCodex 当前的 headers 组合；
  每一步用 curl 打一次，记录第一次从 200 → 429（或 400）的拐点（已经确认“删除 systemInstruction”是 200→429 的拐点）。

### Phase C：从 RouteCodex 429 形态往回收敛到 200

- [x] C1 以 `antigravity-rc-http.json` 为起点，用 curl 直接打 Antigravity，确认可以稳定复现 429。
- [x] C2 在不改 URL 和 token 的前提下，按「最小修改」顺序，一步步往 gcli2api 200 形态靠拢：
  - C2.1 补回/调整 `request.systemInstruction`（用 gcli2api 的 Antigravity 固定 prompt 形态）；
  - C2.2 补回/调整 `generationConfig`（对齐 gcli2api 的 `build_antigravity_generation_config` 输出）；
  - C2.3 仅在 Claude 路径下，按 gcli2api 的 openai→Gemini 转换结果，修正 `contents` 中 tools / tool_use_id 的结构；
  每一步 curl 一次，记录第一次从 429 → 200 的拐点。

### Phase D：对齐 RouteCodex Provider 行为

- [x] D1 把在 Phase B/C 中验证过的「必要字段 + 结构」固化进 `GeminiCLIHttpProvider`，区分 Gemini 与 Claude：
  - D1.1 Antigravity 必须始终注入 `request.systemInstruction`（且前缀为 gcli2api 的 Antigravity 固定 prompt）；
  - D1.2 按 gcli2api 的规则生成/映射 `generationConfig`（尤其是 Claude 的 thinkingConfig / topP 剥离逻辑）；（当前实验证明在简单用例中可选，保留为后续优化项）
  - D1.3 对 Claude 工具消息，调用/对齐 gcli2api 的 openai→Gemini 转换逻辑，保证 `contents` 结构与 200 样本一致。（受限于“Provider 层不做工具语义转换”的架构约束，暂不在 Provider 层实现）
- [x] D2 用同一个 token + 同一个模型，在 RouteCodex 上重打请求，确认 provider snapshot 与 `antigravity-debug-request.json` 关键字段一致（model / requestType / userAgent / systemInstruction / contents 结构）。
- [x] D3 回归：在 RouteCodex 上对 `gemini-3-pro-low/high` 和 `claude-sonnet-4-5(-thinking)` 分别跑一轮，确认不再出现「同一个 token gcli2api=200 / RouteCodex=429」的形态差异（当前仅 `gemini-3-flash` 仍返回 429，已单独标记为后续 case）。

---

## Daemon / Token 管理 UI ＆ Config V2 Provider 视图任务

> 目标：将 token / quota / health / credentials 管理和基于 Config V2 的 Provider 管理统一到一个独立 WebUI 模块中，前端仅通过 API 获取数据。

### 1. Daemon / Token 管理 UI（现状 & 后续）

- [x] 设计整体信息架构（Tabs：Overview / Token & Quota / Credentials / Providers / Settings）。
- [x] 落盘静态设计页面 `docs/daemon-admin-ui.html`。
- [x] 设计并落盘 daemon/token 管理模块的文件结构（后端路由 / handler 模块 / 前端静态资源路径），文档：`docs/daemon-admin-module-structure.md`。
- [x] 设计并记录后台所需 API（daemon status / quota / credentials / providers runtimes），文档：`docs/daemon-admin-api-design.md`。
- [x] 在 host/daemon 中实现只读 API（本地访问，隐藏敏感数据）。
- [x] 将静态页面改造为通过 API 拉取数据的动态视图（保持只读）。
- [x] 对 Daemon 管理 UI 做端到端集成测试（在 `scripts/verify-e2e-toolcall.mjs` 中附加 `/daemon/status`、`/daemon/credentials`、`/quota/summary`、`/providers/runtimes` smoke 校验，随 `npm run build:dev` 自动执行）。

### 2. Providers (Config V2) 管理视图

- [x] 设计基于 Config V2 的 Provider 管理视图（数据来源 / 边界 / 布局 / API 草案）。
- [x] 将设计落盘为文档：`docs/provider-config-v2-ui-design.md`。
- [x] 在 daemon-admin UI 中增加 Providers 二级 Tab：`Runtime health` / `Config V2`。
- [x] 接入 `/config/providers/v2*` 只读 API，完成列表 + 详情视图（基于 `loadProviderConfigsV2` 读取 `~/.routecodex/provider/*/config.v2.json`，仅返回非敏感字段）。
- [x] 与 Credentials / Runtime health 视图打通跳转（从 Credentials 行点击跳转到 Providers(Config V2) 并按 `credentialsRef` 过滤列表，前端仅做过滤与高亮，不改动路由逻辑）。
- [x] 对 Providers(Config V2) 视图做端到端集成测试（在 `scripts/verify-e2e-toolcall.mjs` 中附加 `/config/providers/v2` smoke 校验，确保 Config V2 列表 API 正常响应）。

---

## TOON 工具协议统一任务（全工具 TOON 化）

> 目标：对“模型视角”统一所有工具的调用参数为 TOON 格式，在 chat process 中实现唯一的 TOON ⇄ JSON 解码层，先改工具治理，再扩展解码器，并用 codex samples 做回放验证。

### Phase T1：协议与治理设计

- [ ] 梳理当前工具协议与治理位置：
  - 工具注册与描述：`sharedmodule/llmswitch-core/src/tools/tool-registry.ts`、`sharedmodule/llmswitch-core/src/guidance/index.ts`。
  - 工具治理与过滤：`sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.ts` 及其 hooks。
  - TOON 解码过滤器：`sharedmodule/llmswitch-core/src/filters/special/response-tool-arguments-toon-decode.ts`、`response-apply-patch-toon-decode.ts`。
- [ ] 确认“模型统一协议”的设计原则：
  - 模型侧所有工具一律使用 `arguments.toon`（不再区分 shell TOON / exec_command JSON）。
  - 工具说明中明确：模型只需写 TOON，不关心最终 JSON 字段名。
  - 执行器（CLI / daemon / provider）只消费结构化 JSON，由 chat process 负责 TOON ⇄ JSON。

### Phase T2：工具治理调整（先改治理，再改解码）

- [ ] 更新工具治理与系统提示：
  - 在全局 guidance 中统一变更工具使用说明，声明“所有工具参数均使用 TOON”，避免混合协议。
  - 针对 exec_command / shell / apply_patch / search / web_search / 文件读取写入等工具，移除“JSON 形态示例”，改为抽象 TOON 说明。
- [ ] 收紧 / 统一工具注入规则（与现有治理兼容）：
  - 保持现有 image / web_search / search / coding 等工具的注入时机与路由规则不变，只改变“对模型暴露的参数形态”为 TOON。
  - 确保 exec_command 在模型视角只暴露 TOON（避免 cmd-only JSON 与 TOON 混用）。

### Phase T3：TOON 解码器扩展与唯一化

- [ ] 在 chat process / filter 管线中明确唯一的 TOON 解码入口：
  - 保证 TOON ⇄ JSON 转换仅存在于 llmswitch-core 的一处（当前 response 侧已有基础过滤器，需扩展与归一）。
- [ ] 扩展 TOON 解码逻辑覆盖所有工具：
  - 将 `ResponseToolArgumentsToonDecodeFilter` 从“只支持部分工具（shell/exec/apply_patch）”扩展为：只要 `arguments.toon` 存在，就尝试通用 TOON 解析。
  - 基于 tool name / tool family（文件读写 / search / coding / web_search / apply_patch / exec_command 等）映射到对应的 JSON schema，构造统一的结构化参数对象。
  - 确保 apply_patch 仍生成兼容 Codex `apply_patch` CLI 的 unified diff `{ input, patch }`。
- [ ] 确保 TOON 编码/解码对称：
  - 请求侧：JSON → TOON（用于工具描述 / 模型系统提示）。
  - 响应侧：TOON → JSON（用于真实工具执行）。
  - 其他层（HTTP server / provider / CLI 执行器）不再各自实现 TOON 逻辑。

### Phase T4：测试与回放验证

- [ ] 更新 / 扩展测试用例：
  - 在 `tests/sharedmodule` 下新增 / 扩展 TOON 解码测试，覆盖多种工具（exec_command、shell、apply_patch、search、文件工具等）。
  - 保证 apply_patch 测试仍通过真实 `apply_patch` CLI 执行，验证 unified diff 正确性。
- [ ] 使用 codex samples 做回放验证：
  - 选取最新 codex samples 中包含 TOON 工具调用的样本，验证新解码器可正确解析并生成结构化参数。
  - 对历史上 exec_command 与 TOON 混用产生的错误样本，确认在“全 TOON 协议 + 新解码器”下行为合理（要么被正确解析，要么返回清晰错误）。
- [ ] 回归检查：
  - 确保 web_search / search / coding / longcontext / tools 等路由池在“全 TOON 协议”下行为与现有预期一致（不改变路由逻辑，只改变参数编码方式）。
  - 将关键错误样本加入标准回归路径（错误样本脚本 / 矩阵测试脚本），防止未来回归。

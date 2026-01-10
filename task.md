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

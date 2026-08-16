# V3 Reasoning Effort 双向归一化 — 执行计划

## 目标
对 V3 Responses reasoning effort 做双向归一化审计与闭环。以 `responses <> chatprocess <> anthropic/openai` 为主要审计路线。

## 已完成基线（不得重复实现，只作参考）

| ID | 状态 | 内容 | 证据 |
|----|------|------|------|
| E1 / P0 | 完成，跳过 | HTTP status body mask fix | `d5111226b` |
| E2 / P3-out | 完成，跳过 | Anthropic outbound 授权缺口已记录 | `74096208c` |
| E4 / P6 | 完成，跳过 | Grok wire rejection gap 已记录 | `a820213b9` |
| P1 | 完成，跳过 | OpenAI Chat → Anthropic thinking 无合法映射场景 | 已审计 |
| P2 | 完成，跳过 | 客户端 response effort 是不支持的 request-only 字段 | matrix 已记录 |
| P3-in | 完成，跳过 | Anthropic `thinking.budget_tokens` inbound | `anthropic_codec.rs:486-505` |
| P4 | 完成，跳过 | Responses Direct effort 保留 | `3f5a95686` |

## 剩余执行队列

只执行 E3、E5。开始每项前先检查工作区、提交记录和测试证据；已达到该项 DoD 的内容立即标记跳过，不重复修改。

### E3：P5 Gemini runtime 集成端到端红测（已纠正）

**当前状态**：红测已写（错误的 thinkingLevel→reasoning.effort 转换断言），需要重写为正确的 passthrough 断言

**关键架构确认**（已验证，禁止改动）：
- Gemini relay runtime path: `V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat`
- `provider_req_compat_06_provider_compat.rs:121`: Gemini 直接 `input.provider_semantic_payload().clone()`（passthrough）
- Gemini codec `collect_v3_gemini_request_thinking_config_semantics` 只提取 semantic，不做协议转换
- **正确合约**：thinkingLevel/thinkingBudget/includeThoughts 原始 JSON 直接到达 provider wire，**不产生** `reasoning.effort` 字段

**需要重写的 4 个红测断言**（`gemini_relay_runtime_integration.rs` 末尾）：
1. `gemini_thinking_level_high_reaches_provider_wire` → 断言 `generationConfig.thinkingConfig.thinkingLevel == "HIGH"`（不是 reasoning.effort）
2. `gemini_thinking_level_medium_reaches_provider_wire` → 断言 `"MEDIUM"`
3. `gemini_thinking_level_low_reaches_provider_wire` → 断言 `"LOW"`
4. `gemini_thinking_budget_and_include_thoughts_produce_no_reasoning_effort` → 反向断言：
   - `reasoning.effort` 不存在
   - `thinkingBudget=4096` 保留
   - `includeThoughts=true` 保留

**操作步骤**：
1. 重写 `gemini_relay_runtime_integration.rs` 末尾 4 个测试的断言逻辑
2. `cargo test -p routecodex-v3-runtime gemini_thinking_level_high_reaches_provider_wire -- --nocapture` 确认 GREEN（passthrough 已工作）
3. 若 GREEN → commit 红测
4. 若 RED → 检查 `gemini_relay_runtime.rs` 或 `provider_req_compat_06_provider_compat.rs` 是否意外 trim 了 thinkingConfig
5. 仅当有 impl 改动才需要 build + install:v3 + restart
**Owner**：routecodex-v3-runtime
**禁止**：改 `gemini_codec.rs`（单测已覆盖）；在 compat layer 加 thinkingLevel→reasoning.effort 转换

### E5：P7 V2/V3 Effort Parity Regression Matrix + 红测

**当前状态**：无 formal regression 矩阵，`gate_id:v3_protocol_field_semantic_equivalence` 已 stale
**实现操作**：
1. 新建 `docs/goals/v3-v2-effort-regression-matrix.md`
   - 列 V2 测试路径 × V3 相同场景 × 预期等价断言
   - 覆盖：OpenAI Chat effort → Anthropic thinking budget → Responses reasoning → client projection
   - 标注每场景的 V2 现有测试 + V3 红测状态（绿/红/缺）
2. 在 `v3/crates/routecodex-v3-runtime/tests/` 补一个 focused integration 红测
   - `v2_v3_reasoning_effort_parity` 测试
   - 验证同 effort 值在 V2/V3 路径上产生等价 provider wire 输出
3. 红测先红，实现后绿
4. build + install:v3 + restart
5. stage + commit（doc + test）
**禁止**：把 V2 单测 PASS 当 V3 等价证据；必须同场景同值断言
**Owner**：docs/goals + routecodex-v3-runtime

## 每任务强制循环（顺序不可改）

1. **看清楚唯一修改方案**：刷 MemoryPalace → resource map → function map → mainline call map → verification map → 主线源；定位唯一 owner / 唯一修改点 / 唯一相邻边
2. **架构检查**：对照 `pipeline-type-topology-and-module-boundaries.md`；metadata 生命周期；provider-特例禁入 Hub/VR；节点编号 contract
3. **红测先行**（E3/E5）：最小 failing sample 先红；正反成对；禁 fallback
4. **修改**：只改唯一真源；用 apply_patch 单文件原子编辑
5. **编译构建**：
   - `cargo build -p routecodex-v3-runtime`（E3/E5）
   - `cargo build -p routecodex-v3-provider-responses`（E1）
   - 相关 workspace crate 必须绿
6. **定向验证**：`cargo test -p routecodex-v3-runtime -- --nocapture` + 相关 verify gate
7. **全局安装**：`RUSTUP_TOOLCHAIN=stable npm run install:v3`（仅当触及 v3 runtime/provider 时）
8. **托管聚合重启**：`rccv3 config check && rccv3 restart -c /Volumes/extension/.rcc/config.v3.toml`
9. **样本重放**（E1）：从 `~/.rcc/codex-samples/` 取最新样本，确认 `causeStatus` 为真实码
10. **Codex review**：按 `~/.codex/skills/codex-review/SKILL.md` 的默认通道与备用 profile 顺序执行；审核提示词唯一真源为 `~/.codex/skills/codex-review/review-prompt.md`
    - 要求语义 PASS；缺即 FAIL；最多 5 轮修复循环
11. **精确 commit**：单任务 commit，只 stage 改动文件，禁批量 checkout / 通配恢复
12. **进入下一任务**：PASS + commit + 记忆沉淀完成后立即开始，禁止汇总

## 跨任务收尾（E3、E5 全部 PASS 后）

- `npm run verify:v3-protocol-conversion-field-parity` 全量绿
- 全 V3 成员端口 /health + version 检查
- 写 MEMORY.md（只追加确证）：5 个 owner / 唯一修改点 / 反向红测清单 / 真实样本指针
- 追加 note.md（按时间，不覆盖他人记录）
- 更新本地 skill（rcc-v3-architecture）：沉淀 effort 双向归一化清单
- `mempalace mine` 同一 stable wing

## 完成信号

- 已完成基线保持不变，E3、E5 各有一个精确 commit
- 全量回归 + health/version + sample replay 证据齐全
- Codex review 5 轮均语义 PASS
- MEMORY.md / note.md / skill 已更新并可检索
- 给 Jason 交付：变更、验证、剩余风险、未完成（如有）、下一步

## P3-outbound 授权说明

E2 的 gap 标注完成不代表实现完成。Anthropic `thinking.budget_tokens` → Responses
`reasoning_effort` 反向等价映射需要 Jason 书面授权才能实现。收到授权后，按 E2 相同
循环追加 E3a（实现 + 红测 + review + commit）后，再执行后续任务。

# Skill 路由化 + note.md 整理 + ~/.rcc 配置沉淀 综合目标

## 目标

三件事一起做，不拆 task：

1. **note.md 时间线重排**：按时间顺序整理；同一内容以最新记录为唯一真源；dedup + 冲突解决；提炼后已验证结论 → `MEMORY.md`；可复用工作流 → `rcc-dev-skills`。
2. **`rcc-dev-skills` 路由化重写**：description 短到一句话；详情全部分发到小文件（`references/<topic>.md` 或同级子目录）；SKILL.md 只做路由表 + 入口。
3. **function map / gate / owner 三者关系沉淀到 skills**：写清楚怎么按 feature_id 反查 owner，怎么按 owner_kind 正查所有 features，怎么新增 owner；并把当前 `~/.rcc` 路径与 provider 配置真源、查询方法、修改流程、典型 layout 全部写进 skills。
4. **执行要求**：先红测 → 绿化 → 旧样本在线复测；任何 skill 改动必须配对正向 + 反向例子，禁止口头验证。

## 边界

- 不删 `note.md` 原始 raw 调查行；只允许在顶部加 consolidation index + 标记 superseded/contradicted。删除必须有证据。
- 不覆盖 `MEMORY.md` 历史；只追加 dated correction。
- 不动 `rcc-dev-skills` 之外的 skill 文件（除非明确指向）。
- 不改运行时行为；只改文档 + skill 路径。
- 不碰 worker / daemon。

## 范围（In Scope）

- `note.md` 重排：consolidation index + 主题块 + 标记 superseded/contradicted。
- `MEMORY.md` 追加：按主题 append 已验证结论。
- `.agents/skills/rcc-dev-skills/SKILL.md` 重写：短 description + 路由表。
- `.agents/skills/rcc-dev-skills/references/` 新建小文件：
  - `40-owner-registry.md`（function map / verification map / owner_kind 关系；查询语法；新增 owner 流程；典型 owner_kind 列表）
  - `50-rcc-config-ssot.md`（`~/.rcc` 路径真源、`provider/<id>/config.v2.toml` schema、查询命令、修改流程、典型 layout）
  - `60-note-memory-flow.md`（note.md → MEMORY.md → skill 沉淀触发条件与模板）
  - `70-gate-discovery.md`（`npm run verify:*` 全部 map 索引；feature_id → required_gates 反查）
  - `80-skill-routing-convention.md`（rcc-dev-skills 自描述：本 skill 怎么用路由方式书写新子技能）
- 把现有 rcc-dev-skills 中 2026-05-27 ~ 2026-06-13 精华保留在 SKILL.md 顶部路由表下索引的小文件里（如 `references/90-lessons-2026-05-to-2026-06.md` 或按月拆 `91-lessons-2026-05.md` / `92-lessons-2026-06.md`）。

## 范围（Out of Scope）

- 运行时 / 协议 / 业务行为改动。
- 新增 provider / 移除 provider。
- 跨项目（其他 skill 目录、USER.md）。
- git push / release / 任何远端动作。

## 设计原则

1. **description 极简**：rcc-dev-skills description 必须 1 句中文 ≤ 50 字。
2. **路由不重复**：SKILL.md 主体只保留路由表 + 触发信号；细则不进 SKILL.md。
3. **小文件优先**：references/ 每个文件 ≤ 200 行；超过则继续拆。
4. **owner 三件套同源**：function-map.yml / verification-map.yml / 源码 `feature_id:` anchor 改一处必须同时改三处；skills 必须写明这个 contract。
5. **`~/.rcc` 单一真源**：仓库内 `config/`、`~/.codex/config.toml` 都退到派生；排查 provider/router/target 时只看 `~/.rcc/`。
6. **note.md append-only**：consolidation index 加在文件顶部；正文不删 raw；只标记 superseded/contradicted。
7. **MEMORY.md append-only**：禁止改写历史；新结论追加在主题小节，必要时附"supersede：<旧结论>"。

## 关键技术方案

### A. note.md 重排（不删 raw）

1. 用 `rg` 抓 `note.md` 中所有 `2026-06-12/13` 时间戳，按时间排序生成主题块：
   - Hub Pipeline Rust closeout + TS residue
   - servertool / stopless / followup
   - Virtual Router 路由 / health / quota
   - ErrorPolicy / provider failure / backoff queue
   - metadata 隔离 / pipeline topology
   - Responses continuation / direct / bridge
   - function map / verification map / owner_kind
   - `~/.rcc` / provider config 排障
   - apply_patch / servertool 投影
   - build / install / restart 验证基线
   - MiniMax / 1token / DF / XL provider 特约
2. 每主题下 dedup 重复段；冲突以最新（最晚时间戳）覆盖。
3. 顶部加 consolidation index 块：
   ```markdown
   ## 2026-06-14 note.md consolidation index
   - <主题>: promoted → MEMORY.md#<section>
   - <主题>: superseded by <最新日期>
   - <主题>: contradicted by <代码证据>
   - <主题>: one-off；保留 raw 不入 MEMORY
   ```
4. 主题块内每条注明 `latest:<date>`、`source:<note 行号>`。

### B. MEMORY.md 追加

按主题新增小节，格式沿用既有 `## YYYY-MM-DD <topic>`。只追加已验证的：

- function map owner_kind 6 类真源：`rust_ssot / ts_runtime_owner / ts_bridge / provider_runtime / server_projection / ts_entry_shell`
- 三件套 contract：改 owner 必须同步三处
- `~/.rcc` 真源顺序
- Responses continuation 三重隔离（entry + owner + session）
- provider 错误三分类 `recoverable / unrecoverable / special_400` + 入口 `resolveProviderFailureClassification` + 出口 `resolveProviderFailureActionPlan`
- autoRetry 已物理删除（必须含文件清单）
- 其它见 note.md 主题块的 promotion 列表

### C. rcc-dev-skills SKILL.md 重写

目标 ≤ 200 行。结构：

```yaml
---
name: rcc-dev-skills
description: <1 句中文 ≤ 50 字>
---

# RCC Dev Skills（路由入口）

## 触发
- <3-5 条触发信号>

## 路由表（按问题类型跳转）
| 主题 | 文件 | 用途 |
| --- | --- | --- |
| 架构 / 节点 | references/00-architecture-map.md | 节点 + 责任 |
| PipeDebug 流程 | references/10-pipedebug-flow.md | 调试步骤 |
| 变更索引 | references/20-change-index.md | 改了什么 |
| 唯一块索引 | references/30-unique-block-index.md | 找唯一真源 |
| Owner Registry | references/40-owner-registry.md | function map / gate / owner |
| RCC 配置 | references/50-rcc-config-ssot.md | ~/.rcc / provider config |
| Note Memory | references/60-note-memory-flow.md | note→MEMORY→skill |
| Gate 反查 | references/70-gate-discovery.md | feature_id → verify:* |
| 路由约定 | references/80-skill-routing-convention.md | 怎么写新子技能 |
| 5 月精华 | references/91-lessons-2026-05.md | 旧 lessons |
| 6 月精华 | references/92-lessons-2026-06.md | 新 lessons |

## 硬护栏（永远先读）
- <3-5 条短护栏>

## 标准重构 / 修复闭环（指针）
- 详细步骤在 references/80-skill-routing-convention.md
```

### D. references/<topic>.md 模板

每个小文件统一结构：

```markdown
# <编号> <主题>

## 何时用
- <触发信号 1>
- <触发信号 2>

## 真源 / 权威路径
- <路径 + 用途>

## 操作步骤
1. ...
2. ...

## 反模式 / 边界
- ❌ ...
- ✅ ...

## 验证
- <命令 + 期望>

## 相关 references
- <链接到其它小文件>
```

### E. function map / gate / owner 三者关系

在 `references/40-owner-registry.md` 写明：

- **反查**：`feature_id` → `function-map.yml` 找 `owner_kind / owner_module / owner_scope / canonical_builders / allowed_paths / forbidden_paths`；同步 `verification-map.yml` 找 `required_tests / required_gates`；源码 `feature_id:` anchor 反查文件位置。
- **正查**：`owner_kind` 枚举所有 `rust_ssot / ts_runtime_owner / ts_bridge / provider_runtime / server_projection / ts_entry_shell`；每类再列 `owner_module` 列表。
- **新增 owner 流程**：
  1. 写代码前先在 `function-map.yml` 加 `feature_id` + 完整 owner 字段
  2. 同步 `verification-map.yml` 加 `required_tests / required_gates`
  3. 源码加 `// feature_id: <id>` 锚点
  4. 跑 `npm run verify:function-map-compile-gate` + `verify:architecture-owner-queryability` + `verify:architecture-feature-map-growth-discipline`
  5. 跑对应 `required_gates` 中最低子集
  6. live probe
- **删除 owner 流程**：先确认无 caller；map 删；`git diff --check`；跑 owner 反查命令确认无残留；归档旧 `feature_id` 到 `note.md` 顶部 consolidation index。
- **命令**：
  - `rg -n 'feature_id: hub\.servertool_followup' docs/architecture/function-map.yml`
  - `rg -n 'owner_kind: rust_ssot' docs/architecture/function-map.yml | wc -l`
  - `npm run verify:function-map-compile-gate`

### F. `~/.rcc` + provider 配置真源

在 `references/50-rcc-config-ssot.md` 写明：

- 路径真源顺序：`~/.rcc/config.toml` > `~/.rcc/config.<provider>.toml` > `~/.rcc/provider/<providerId>/config.v2.toml` > 派生 `~/config/merged-config.<port>.json`
- 目录 layout：`auth/ backup-*/ camoufox-*/ config/ diag/ docs/ errorsamples/ guardian/ install/ log/ logs/ precommand/ provider/ quota/ run/ scripts/ servertool/ sessions/ state/ state-clean-backups/ statics/ stats/ windsurf-*/`
- provider config schema（v2）：
  - 顶层 `version / providerId`
  - `[provider]` id / enabled / type / baseURL / compatibilityProfile / transportBackend / defaultModel
  - `[provider.auth]` type / entries（alias + apiKey 环境变量引用）
  - `[provider.responses]` process / streaming
  - `[provider.concurrency]` maxInFlight / acquireTimeoutMs / staleLeaseMs
  - `[provider.models.<modelId>]` supportsStreaming / supportsThinking / thinking / maxTokens / maxContext / capabilities / aliases
- 典型 provider 例子：`1token` (responses/chat) / `DF` (openai/vercel-ai-sdk)
- 排障：先 `cat ~/.rcc/config.toml | head -50`，再 `cat ~/.rcc/provider/<id>/config.v2.toml`，再 `rg '<port>|gateway-priority-<port>' ~/.rcc/log/`
- 修改流程：编辑 `config.v2.toml` → `routecodex config validate`（只校验 schema）→ `routecodex restart --port <port>` → `curl 127.0.0.1:<port>/health` → live SSE 验证

### G. lessons 拆分

把现有 SKILL.md 中 "## 2026-05-XX ..." 与 "## 2026-06-XX ..." 段落（按行号找）抽到：
- `references/91-lessons-2026-05.md`
- `references/92-lessons-2026-06.md`

每个 lesson 拆 card，结构：
```markdown
### L<id> <一句话>
- 触发：<信号>
- 真源：<路径>
- 动作：<1-2 句>
- 反模式：<1 句>
- 验证：<命令>
```

## 风险与护栏

- 风险：rcc-dev-skills 拆分丢失 context。护栏：拆分前打印 SKILL.md 章节大纲 + 总行数；拆分后必须能用 `grep -c '^## '` 还原原始主题数。
- 风险：owner 新增流程被绕过。护栏：CI gate `verify:architecture-feature-map-growth-discipline` 已存在，必须保留并随 owner 新增同步更新。
- 风险：`~/.rcc` 路径随系统变。护栏：references/50 必须以 `~` 表达路径并加 `ls ~/.rcc | head` 验证示例命令。
- 风险：note.md raw 调查被误删。护栏：禁止 broad sed/awk 改写；只允许按 grep 行号定位具体段落 marker。
- 风险：MEMORY.md 写错主题小节。护栏：append 完跑 `rg -n '^## ' MEMORY.md` 校对新增小节标题。
- 风险：路由表过期。护栏：每次新增 references/ 文件必须同时改 SKILL.md 路由表 + 跑 `wc -l` 检查仍 ≤ 200。

## 验证矩阵

| 验证 | 命令 | 期望 |
| --- | --- | --- |
| SKILL.md 短 | `wc -l .agents/skills/rcc-dev-skills/SKILL.md` | ≤ 200 |
| description 短 | `sed -n '2,4p' .agents/skills/rcc-dev-skills/SKILL.md` | ≤ 50 字单行 |
| 路由表完整 | `rg -n 'references/' .agents/skills/rcc-dev-skills/SKILL.md` | 至少 8 个 |
| references/ 文件 | `ls .agents/skills/rcc-dev-skills/references/` | 11+ 个 |
| 每文件 ≤ 200 行 | `wc -l .agents/skills/rcc-dev-skills/references/*.md` | 每行 max ≤ 200 |
| owner 反查 | `rg 'feature_id: hub\.servertool_followup' docs/architecture/function-map.yml` | hit |
| gate 反查 | `rg 'feature_id: hub\.servertool_followup' docs/architecture/verification-map.yml` | hit |
| source anchor | `rg 'feature_id: hub\.servertool_followup' sharedmodule/llmswitch-core/src` | hit |
| `~/.rcc` 排障 | `ls ~/.rcc/provider/1token/ && cat ~/.rcc/provider/1token/config.v2.toml | head -5` | both pass |
| note.md index | `head -40 note.md` | 含 consolidation index 块 |
| MEMORY.md append | `rg '^## 2026-06-14' MEMORY.md` | hit |
| git 干净 | `git diff --check` | 0 |
| 旧样本在线复测 | live SSE on `127.0.0.1:5555/v1/responses` | RCC_BUILD_OK |

## 实施步骤

1. 读 `AGENTS.md` + `~/.codex/USER.md` + `CACHE.md` + `docs/agent-routing/*`。
2. 读 rcc-dev-skills 全文、references/ 现有 4 个文件、function-map.yml 头 60 行、verification-map.yml 头 40 行、`~/.rcc/provider/*/config.v2.toml` 至少 2 个样本。
3. `git status --short` 检查 dirty；非相关文件不动。
4. 跑主题块规划：先在 `note.md` 顶部加 consolidation index，**不删 raw**。
5. 按主题追加 MEMORY.md 段；每段标注 evidence 路径。
6. 重写 rcc-dev-skills SKILL.md（≤ 200 行）：description 短 + 路由表 + 硬护栏 + 闭环指针。
7. 新建 references/40、50、60、70、80、91、92 七个文件；把原 SKILL.md 2026-05/06 精华逐条迁移到 91/92 lesson card。
8. 跑全部验证矩阵；不通过则修。
9. 报告：变更文件清单 / 验证结果 / 残留缺口 / 下一步。
10. 任务收口：把没解决的差距写进 note.md 顶部 consolidation index 的 "open" 子项。

## 完成标准

- `note.md` 顶部存在 consolidation index，主题块有 `latest:` 标记，raw 调查未删。
- `MEMORY.md` 按主题追加 dated 段；无覆盖历史；`rg '^## 2026-06-14' MEMORY.md` ≥ 1。
- `rcc-dev-skills/SKILL.md` ≤ 200 行；description 1 句 ≤ 50 字。
- `references/` 含至少：00 / 10 / 20 / 30 / 40 / 50 / 60 / 70 / 80 / 91 / 92 共 11 文件；每文件 ≤ 200 行。
- owner / gate / `~/.rcc` 三件套在 references/40 / 50 / 70 写明反查/正查/新增流程。
- 验证矩阵 12 行全 PASS；`git diff --check` 干净。
- 没改运行时、没 push、没碰 worker / daemon。

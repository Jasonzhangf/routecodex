# /goal — 硬编码 + Fallback 架构风险收口

**日期**: 2026-06-05
**真源**: `docs/goals/hardcode-fallback-arch-audit-plan.md`

---

## 目标

把项目内"硬编码常量 / 字符串 + fallback / 降级 / 兜底 / 双路径"两类风险做系统化收口，确保常量 / 错误码 / provider key 唯一真源；禁止静默吞错、假成功回退、字符串前缀特判。

---

## 实现文档

`docs/goals/hardcode-fallback-arch-audit-plan.md`

详细设计、文件清单、阶段顺序、验证矩阵、风险规避均在文档中。执行前必读。

---

## 执行规范

- **SSOT 唯一**：常量迁 `src/constants/index.ts`；错误码迁 `provider-error-catalog.ts`；provider key 前缀改 providerFamily 抽象。禁止新增散落硬编码。
- **fail-fast + no fallback**：删除所有 `// ignore` / `// best-effort` / `} catch {}` 静默 catch；改为 `logger.warn` 显式记录。删除所有"主路径失败回退默认值"。
- **Provider 特例只能在 Provider runtime**：Hub Pipeline / Virtual Router / RequestExecutor 不得写 `windsurf.managed.` / `windsurf.` / `deepseek` / `qwen` 字符串特判。`health.rs` 的 `clear_windsurf_managed_persisted_503_family` 改为通用 persisted 503 family 清理。
- **物理删除**：迁出后旧 Set / 旧 `if` 块 / 旧常量字符串必须删除；保留白名单必须经 `silent-failure-audit.mjs` / `hardcode-audit.mjs` 报警并写理由。
- **红测先行**：每个 Phase 必须有红测先红后绿，命中数 < 基线。

---

## 验证

- **构建**：`pnpm run build:min` PASS
- **Rust**：`cargo test -p router-hotpath-napi health::tests -- --nocapture` PASS
- **Jest 定向**：`pnpm jest tests/providers/core/runtime/provider-failure-policy*` + `tests/server/http-server/http-server-runtime-providers*` + `tests/server/handlers/responses-handler*` 全绿
- **门禁**：`node scripts/ci/silent-failure-audit.mjs` + 新建 `scripts/ci/hardcode-audit.mjs` + `hub-deterministic-audit.mjs` + `llmswitch-rustification-audit.mjs` + `repo-sanity.mjs` + `check-file-line-limit.mjs` 全 PASS
- **Live smoke**：`routecodex restart --port 5555` + `--port 5520` 走 deepseek / windsurf 路径，windsurf 503 family cleanup 行为不变
- **黑盒**：`curl /v1/chat/completions` 走 5555，断言 200/4xx/5xx 行为不变

---

## 完成标准

1. `src/constants/index.ts` 增加 `API_BASE_URLS` / `PROVIDER_TIMEOUTS` / `PROVIDER_DEFAULT_MODELS` / `SSE_DEFAULT_CAPS`，service-profiles / bootstrap-templates / request-header-orchestrator 全部引用，无散落裸字符串。
2. `provider-error-catalog.ts` 是错误码唯一字典；`provider-failure-policy-impl.ts` 不再有本地 `UNRECOVERABLE_CODE_SET` / `NETWORK_ERROR_CODE_SET` / `BLOCKING_RECOVERABLE_CODE_SET`。
3. `http-server-runtime-providers.ts` / `request-executor.ts` / `request-executor-pipeline-attempt.ts` 无 `windsurf.managed.` / `windsurf.` 字符串特判；`health.rs` 无 windsurf 前缀硬编码（除 `#[cfg(test)]` fixture）。
4. `base-provider.ts` / `windsurf-chat-provider.ts` / `responses-handler.ts` 静默 catch 全部改显式 warn。
5. `pnpm run verify:hardcode` 新建并 PASS；`silent-failure-audit` 命中数 < 基线。
6. `MEMORY.md` / `note.md` / `AGENTS.md` / `.agents/skills/rcc-dev-skills/SKILL.md` 同步；plan md 保留供历史追溯。

---

## 阶段顺序（详细见 plan §7）

1. **Phase 1 SSOT 化**：constants 字典 + service-profiles / bootstrap-templates 引用 + `verify:hardcode` 基线
2. **Phase 2 错误码字典**：catalog 暴露三个 Set + `provider-failure-policy-impl.ts` 替换 import + red test
3. **Phase 3 provider key 字符串清理**：TS providerFamily 抽象 + Rust `health.rs` `clear_persisted_503_family_for_provider` 改名 + 双向 fixture 测试
4. **Phase 4 静默 catch 清理**：base-provider / windsurf-chat-provider / responses-handler / oauth-header-preflight / provider-http-executor-utils 改显式 warn
5. **Phase 5 门禁强化**：silent-failure-audit 加 provider prefix 规则 + 新建 hardcode-audit + package.json 串接
6. **Step 6 文档同步**：MEMORY / note / AGENTS / rcc-dev-skills 同步

---

## 不做的事

- 不改 Virtual Router 选路语义
- 不改 Hub Pipeline 节点类型拓扑
- 不改 Error Pipeline 契约拓扑
- 不改 SSE / responses continuation / servertool followup 业务逻辑
- 不引入用户没要求的新抽象
- 不 push

---
title: "llms-wasm 基线回放集（Replay Baseline）"
tags:
  - wasm
  - migration
  - baseline
status: planning
created: 2026-01-26
---

# llms-wasm 基线回放集（Replay Baseline）

> [!important] 目标
> 构建可重复、可回溯、可脱敏的基线回放集，用于 TS/WASM 双跑对比与差异修复闭环。

---

## 1. 采样策略（Sampling Strategy）

> [!tip] 分层覆盖
> 采样应覆盖 **模型 / 工具 / 路由 / SSE** 的典型场景，并保留长尾样本用于发现边界差异。

### 1.1 样本分层

- **模型维度**：高频模型 + 长尾模型（至少覆盖每个 provider 的主力模型）
- **工具维度**：tool_calls + function_call + 无工具场景
- **路由维度**：主路 / failover / alias 切换 / 冷却恢复
- **SSE 维度**：流式 chunk（含拆包差异）+ 非流式 response

### 1.2 采样比例（建议）

- 全量采样：0.1% - 1%（按租户/路由分层）
- 长尾采样：按错误率/差异率动态加权
- 基线回放集：固定 1000 - 5000 条稳定样本

### 1.3 采样触发条件

- diff 率升高时：自动提高该模块采样比例
- 新版本发布时：额外采样并标记 `build_version`
- 关键模块切换阶段（shadow → canary → default）：强制采样

---

## 2. 存储格式（Storage Format）

> [!warning] 必须可脱敏
> 所有字段必须经过 PII/密钥脱敏；存储结构必须保持可重放。

### 2.1 基线记录结构（JSON）

```json
{
  "request_id": "req_123",
  "tenant": "tenant_a",
  "route": "route_main",
  "timestamp": "2026-01-26T10:00:00Z",
  "request": {
    "endpoint": "/v1/chat/completions",
    "payload": {"...": "..."}
  },
  "response": {
    "status": 200,
    "payload": {"...": "..."}
  },
  "metadata": {
    "provider": "anthropic",
    "model": "claude-3-5",
    "compatibility_profile": "chat-gemini",
    "runtime_main": "ts",
    "runtime_shadow": "wasm"
  }
}
```

### 2.2 索引字段

- `request_id`
- `tenant`
- `route`
- `provider`
- `model`
- `compatibility_profile`
- `timestamp`

---

## 3. 脱敏规则（Data Sanitization）

> [!important] 不可逆脱敏
> PII 与 secrets 必须不可逆处理；但结构必须保持一致以保证重放。

### 3.1 PII 处理

- 字段值 → hash + mask
- 保留结构与字段名

示例：

```json
{
  "user_email": "sha256:***",
  "user_name": "sha256:***"
}
```

### 3.2 Secrets 处理

- API keys / tokens：完全移除
- 如果必需存在：替换为固定占位符 `"__redacted__"`

---

## 4. 基线版本快照字段

> [!note] 版本快照必须固定
> 回放时必须明确 TS/WASM/ruleset 版本，以保证对比可复现。

### 4.1 必含字段

- `ts_version`（@jsonstudio/llms 版本）
- `wasm_version`（llms-wasm 版本）
- `ruleset_version`（diff ruleset 版本）
- `compat_profile_version`（compat profile 版本）
- `sse_protocol_version`（SSE 协议版本）

示例：

```json
{
  "ts_version": "0.6.1172",
  "wasm_version": "0.1.0",
  "ruleset_version": "diff_ruleset_v1",
  "compat_profile_version": "compat_profiles_v1",
  "sse_protocol_version": "sse_protocol_v1"
}
```

---

## 5. 回放执行（Replay Runner）

> [!tip] 回放方式
> 优先离线回放；如需线上验证，必须隔离生产主路。

### 5.1 离线回放

- 输入固定基线集
- 输出 diff 结果
- 自动归因到模块（compat / logic / nondeterministic）

### 5.2 线上回放（可选）

- 影子模式执行
- 只记录 diff 摘要
- 不影响主路

---

## 6. 保留策略

- **全量回放集**：7-14 天
- **采样摘要**：30-90 天
- **历史归档**：按版本归档

---

## 相关文档

- [[docs/llms-wasm-migration.md]] - 迁移计划概要
- [[docs/plans/llms-wasm-migration-plan.md]] - 可执行清单
- [[docs/llms-wasm-module-boundaries.md]] - 模块边界清单

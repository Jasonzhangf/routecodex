# /goal 提示词：Server 模块架构修复

## 元信息

- **目标**：修复 `src/server/` 架构审计发现的 P0/P1/P2 问题
- **真源**：`docs/audits/server-module-architecture-audit.md`
- **预计 token**：单次修复任务 8k-15k；整轮完成约 60k-80k
- **验证方式**：TypeScript 编译通过 + 单元测试通过

---

## 背景与目标

RouteCodex `src/server/` 模块经架构审计发现以下 5 类问题：

### Pipeline 违规（破坏流水线拓扑）

| 级别 | 文件 | 问题 | 影响 |
|------|------|------|------|
| **P0** | `server/hub-pipeline.ts` L65 | `HubPipelineResult.__rt` 暴露给 `resp_outbound` 读取 | 违反 metadata 出站隔离原则；跨层脏读 |
| **P0** | `server/index.ts` | `ErrorHandlingCenter` 实例化但从未调用 | 死代码；违反"冗余代码物理移除"原则 |
| **P1** | `server/handler-response-utils.ts` | `assertClientResponseHasNoInternalCarriers` 递归无深度限制 | 潜在爆栈风险 |

### 设计漏洞（安全/并发/一致性）

| 级别 | 问题 | 影响 |
|------|------|------|
| **P0** | middleware.ts 无 helmet / CORS / rate-limit | 生产安全缺口 |
| **P1** | `TrafficGovernor` 多 port 实例竞争同一内存 state | 并发写覆盖 |
| **P1** | `SessionClientRegistry` session->client 绑定文件竞争 | 多实例写同一文件丢数据 |
| **P1** | `ErrorRespMap` 运行时状态泄漏 | 可观测性污染 |
| **P2** | env var 前缀 `RCC_*` / `RCX_*` / `ROUTE_` 混乱 | 配置管理混乱 |

### 性能问题

| 级别 | 问题 | 位置 |
|------|------|------|
| **P1** | `assertClientResponseHasNoInternalCarriers` 递归无深度限制 | `handler-response-utils.ts` |
| **P2** | stats 历史无限累积 | `stats-manager.ts` |
| **P2** | `structuredClone` 存在但未使用 | `server/index.ts` |
| **P2** | shadow compare 每次请求执行 | `server/hub-pipeline.ts` L70 |

---

## 执行规则（必须遵守）

1. **单次只改一个 P0/P1**：`stopreason=2` + `next_step` 串行推进
2. **先验证后结论**：改前 `git stash` 备份；改后 `pnpm build` 编译通过 + 相关测试绿
3. **禁止新引 fallback/retry/降级逻辑**
4. **metadata 只走 carrier**：不得混入 provider wire / client response
5. **错误链单向**：provider error → ErrorErr* 链；禁止本地 retry/reroute/cooldown
6. **冗余代码物理删除**：注释掉不行；必须 `git rm` / 整块删除
7. **每次 commit**：小步提交，commit msg 用 `type(scope): subject` 格式

---

## 验证门控

每次修复后必须同时满足：
- [ ] `pnpm build` TypeScript 编译通过
- [ ] 相关单元测试通过（无则运行全量 `pnpm test`）
- [ ] `git diff` 证明改动最小化
- [ ] `git log --oneline -1` 确认小步 commit

---

## 修复顺序（已排定优先级）

```
P0-1: hub-pipeline.ts 移除 __rt 跨层读取
P0-2: index.ts 删除未使用的 ErrorHandlingCenter
P0-3: middleware.ts 引入 helmet() + 基础 CORS
P1-1: TrafficGovernor 多实例竞争修复
P1-2: assertClientResponseHasNoInternalCarriers 递归加深度限制
P1-3: SessionClientRegistry 文件竞争修复
P1-4: ErrorRespMap 运行时状态隔离
P2-1: env var 前缀统一为 RCX_*
P2-2: stats 历史加 TTL 上限
P2-3: structuredClone 替换 deepClone
P2-4: shadow compare 条件化执行
```

---

## 预期产出

- `src/server/` 编译零错误
- 审计问题逐项关闭（有文件/测试证据）
- 小步 commit 历史（每 P0/P1 一个 commit）
- `docs/audits/server-module-architecture-audit.md` 更新：每个问题标注 `[FIXED: commit_hash]` 或 `[WONTFIX: reason]`

---

## 触发信号

- 用户说"开始 server 审计修复"或"run /goal server-audit-fix"
- 或用户说"帮我修 server 模块的架构问题"


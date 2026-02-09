# Provider V2 验证矩阵与 Replay 验收模板（Draft）

- Status: Draft
- Date: 2026-02-09
- Owner: routecodex-113.5
- Scope: 用于 Wave 连线与旧实现移除前的统一验证标准

## 1. Mandatory 验证项（每次 Wave 必跑）

1. 构建与安装
   - `npm run build:dev`
   - `npm run install:global`
2. 类型检查
   - `npx tsc --noEmit`
3. 目标改动测试
   - 运行该 Wave 关联的 provider / routing / pipeline 测试集
4. Replay 验证
   - same-shape replay（受影响 provider）至少 1 组
   - control replay（未受影响 provider）至少 1 组
5. Shadow 对比
   - 新主路径 vs 旧影子输出差异比对

## 2. Four-Protocol × Family 验证矩阵

> 说明：矩阵是“至少覆盖”；某 Wave 可聚焦子集，但必须包含对应 control 列。

| Protocol | 受影响 Family（示例） | Same-shape 必测 | Control 必测 | Mandatory 指标 |
|---|---|---|---|---|
| openai-chat | iflow / qwen / glm / lmstudio | 1+ 样本（目标 family） | 1+ 样本（openai 或未改 family） | shape 一致、错误分类一致、无新增 P0/P1 |
| openai-responses | iflow / openai / 其他 responses 路由 | 1+ 样本（目标 family） | 1+ 样本（responses 其他 family） | SSE/JSON 结构一致、工具回合一致 |
| anthropic-messages | anthropic / 兼容代理 | 1+ 样本（目标 family） | 1+ 样本（anthropic control） | tool alias / message shape 一致 |
| gemini-chat | gemini / gemini-cli / antigravity | 1+ 样本（目标 family） | 1+ 样本（gemini family control） | header policy 与错误映射一致 |

## 3. Same-shape Replay 模板

### 3.1 目标

验证“同一输入 shape 下，新主路径结果与旧影子可比”，并确保主链路正确。

### 3.2 命令模板

```bash
npm run replay:codex-sample -- \
  --sample <path-to-client-request.json> \
  --label wave-<n>-same-shape
```

### 3.3 证据最小字段

- requestId
- providerKey / runtimeKey
- providerProtocol
- routeName
- model（clientModelId / assignedModelId）
- 结果类型（JSON / SSE）
- 关键字段对比结论（pass/fail）

## 4. Control Replay 模板

### 4.1 目标

验证“未受影响 provider 不回归”。

### 4.2 选择原则

- 与目标 Wave 不同 family。
- 同协议优先（若有），跨协议可作为补充。

### 4.3 命令模板

```bash
npm run replay:codex-sample -- \
  --sample <path-to-control-client-request.json> \
  --label wave-<n>-control
```

### 4.4 证据最小字段

- requestId
- providerKey
- providerProtocol
- 关键响应 shape 结论
- 错误分类是否与基线一致

## 5. Shadow Diff 验证模板

## 5.1 必比字段

- endpoint
- header 关键键（UA、签名、protocol 相关头）
- body 关键键（messages/tools/stream/metadata）
- response.status / error.code / upstreamCode

## 5.2 通过阈值（建议默认）

- P0/P1 差异：0
- 关键错误分类一致率：>= 99%
- 性能增量：P95 不超过基线 +10%（或明确备案）

## 6. Wave 退出 Gate Checklist（可复制）

```markdown
## Wave-<n> Exit Gate
- [ ] npm run build:dev
- [ ] npm run install:global
- [ ] npx tsc --noEmit
- [ ] Targeted tests passed
- [ ] Same-shape replay evidence attached
- [ ] Control replay evidence attached
- [ ] Shadow diff metrics attached
- [ ] No P0/P1 regression
```

## 7. BD 关闭任务证据模板（可复制）

```markdown
## Verification Summary
- Wave: <wave-id>
- Scope: <families/protocols>
- Date: <YYYY-MM-DD>

## Build / Type / Test
- build:dev: <pass/fail>
- install:global: <pass/fail>
- tsc --noEmit: <pass/fail>
- targeted tests: <list>

## Same-shape Replay
- requestId: <id>
- providerKey: <key>
- providerProtocol: <protocol>
- model/route: <model>/<route>
- result: <pass/fail>
- evidence path: <runs/...>

## Control Replay
- requestId: <id>
- providerKey: <key>
- providerProtocol: <protocol>
- result: <pass/fail>
- evidence path: <runs/...>

## Shadow Diff
- compared fields: <list>
- P0/P1 diffs: <count>
- error-classification match: <percent>
- performance delta (P95): <value>

## Decision
- gate: <pass/fail>
- rollback required: <yes/no>
- notes: <details>
```

## 8. 与前序文档对齐关系

- 分层与决策来源：`docs/v2-architecture/PROVIDER-V2-LAYERING-ADR-DRAFT.md`
- 特判迁移清单：`docs/v2-architecture/PROVIDER-V2-MIGRATION-MATRIX-DRAFT.md`
- 分阶段与回滚：`docs/v2-architecture/PROVIDER-V2-PHASED-MIGRATION-ROLLBACK-DRAFT.md`


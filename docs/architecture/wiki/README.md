# Architecture Wiki

## Purpose

这个 wiki 只解决一件事：当你要定位架构真源、主线调用边、owner、验证栈时，应该先看哪里。

不要把它当设计长文。
不要在这里重复写第二份规则。
这里是“路径索引 + 使用顺序”。

## Read Order

1. `docs/agent-routing/10-runtime-ssot-routing.md`
   - 先判断是不是运行时/架构真源边界问题。
   - 这里给出核心 SSOT、禁止事项、最小门禁入口。

2. `docs/design/pipeline-type-topology-and-module-boundaries.md`
   - 看请求链 / 响应链 / 错误链拓扑。
   - 看节点命名、相邻 builder/parser/projector 规则。

3. `docs/architecture/function-map.yml`
   - 先找 `feature_id`
   - 看唯一 owner、allowed/forbidden paths、required tests/gates。

4. `docs/architecture/mainline-call-map.yml`
   - 看 request / response / error 主线当前实际经过哪个 caller/callee。
   - 看 facade / wrapper / runtime orchestration / typed contract 是否是同一条边。
   - 若边未证实，必须看到 `binding pending`，不能脑补。

5. `docs/architecture/wiki/mainline-call-graph.md`
   - 看 Mermaid 视图和 review 表格。
   - 这是从 `mainline-call-map.yml` 自动生成的 render artifact，不是第二份真源。

6. `docs/architecture/wiki/coverage-matrix.md`
   - 看哪些逻辑已经有 wiki review 面，哪些还缺。
   - 先确定下一批应该补哪一页，不要零散补图。

7. `docs/architecture/verification-map.yml`
   - 看最小验证栈。

8. `docs/goals/*`
   - 看当前专题 closeout / 审计 / migration 计划。

## Path Roles

### Core SSOT

- `docs/agent-routing/10-runtime-ssot-routing.md`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`

### Architecture Indexes

- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/mainline-call-graph.md`
- `docs/architecture/wiki/coverage-matrix.md`
- `docs/architecture/verification-map.yml`
- `docs/architecture/README.md`

### Closeout / Migration / Audit

- `docs/goals/mainline-call-map-closeout-plan.md`
- `docs/goals/function-map-audit-remediation-plan.md`
- `docs/goals/hub-pipeline-phase-typing-*.md`

## Usage Rules

- 先 owner，后 mainline：
  - 先查 `function-map.yml`
  - 再查 `mainline-call-map.yml`
  - 需要图面 review 时看 `wiki/mainline-call-graph.md`

- 若 owner 清楚，但 live caller/callee 不清：
  - 先补 `mainline-call-map.yml`
  - 再改代码

- 若 mainline edge 清楚，但 owner 不清：
  - 先补 `function-map.yml`
  - 再改代码

- 若 runtime orchestration 与 typed contract 不是同一条边：
  - 必须分层记录
  - 禁止压成单条“看起来完整”的假主线

## Gate Targets

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-mermaid-sync`
- `npm run verify:architecture-ci`

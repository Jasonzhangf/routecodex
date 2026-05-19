# P1 确定性修复方案（Hub）

## 目标
以“确定性替换不确定性”为原则，继续清理 Hub 侧 TS 语义残留：
- 禁止策略 fallback
- 禁止静默修补
- 缺关键条件时显式失败（fail-fast）

---

## P1-1（最高优先）
### 文件
`sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/rules.ts`

### 问题
`mapNativeRules(...) ?? fallbackBase` 在 native 规则缺失/异常时会静默回退到 TS 默认规则。

### 修复
1. 删除策略级 fallback 回退。
2. native 规则缺失或无效时直接抛错（含 requestId/stage）。
3. 仅保留“输入类型防御校验”，不保留“语义兜底”。

### 验收
- grep 不再出现策略 fallback 分支。
- tool governance 相关测试通过。

---

## P1-2
### 文件
`sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts`

### 问题
`fallback?: Record<string, unknown>` 作为泛型兜底输入，边界不清。

### 修���
1. 移除泛型 fallback object。
2. 改为结构化显式输入（tmux/session/scope）。
3. 关键字段缺失时返回显式不可构建状态并上抛原因。

### 验收
- 不再使用泛型 fallback 输入。
- heartbeat 相关测试通过。

---

## P1-3
### 文件
`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper-fastpath.ts`

### 问题
大量 `return undefined/null` 代表 fastpath 拒绝，但不可观测。

### 修复
1. 不改变 fail-fast 语义。
2. 把 fastpath 拒绝改为结构化 reason code（例如 `FASTPATH_REJECT_*`）。
3. 上层仅做“是否走主路径”选择，不做语义修补。

### 验收
- fastpath 拒绝可观测。
- 不新增 fallback 修补分支。

---

## P1-4（门禁固化）
### 范围
`sharedmodule/llmswitch-core/src/conversion/hub/**`

### 修复
新增轻量审计门禁脚本：
- 禁止新增策略级关键词模式：`fallbackTo*`, `repair*`, 语义 `coerce*`（白名单除外）
- 允许白名单：纯 env 默认值读取模块

### 验收
- CI 可阻断新增违规分支。

---

## 回归与构建
1. Hub 相关单测（governance / heartbeat / fastpath / ingress/router-metadata）
2. `npm run build:min`
3. 关键 grep 审计（fallback/repair/coerce 新增检查）

---

## 交付
1. 代码修复（按 P1-1 → P1-4 顺序）
2. 更新审计与修复报告（后补文档）
3. 最终 summary：改动/验证/风险/下一步

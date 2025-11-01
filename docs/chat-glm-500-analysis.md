# Chat GLM 500 调查与处置记录（精准定位）

## 背景
- 现象：Chat 通路上游 GLM 返回 500（Operation failed）。
- 最新失败样本目录：`~/.routecodex/codex-samples/openai-chat`
  - 例：`req_1761955101841_2d71u9w6x_provider-request.json`

## 症状与证据
- 请求载荷体积异常：多轮 `role:"tool"` 消息携带巨大 JSON/文本结果；两条超长 system 提示叠加。
- codec/compat 阶段的快照显示：`assistant.tool_calls` 的 `content` 已规范为 `null`；但 `provider-request.json` 依然包含大量工具结果文本（历史轮未最小化）。
- SSE 侧报错：`Error: GLM API error: 500 Internal Server Error - Operation failed`。

## 根因（Root Cause）
- 历史工具结果在多轮会话中持续累积为长文本，叠加双 system 文本，导致上游 GLM 对载荷体量/结构敏感触发 500。
- 并非“工具引导未生效”。工具引导与工具增强均在 llmswitch-core 正常注入（`[Codex Tool Guidance v1]` + 严格 schema）。

## CCR（Claude Code Router）的相关做法（预算来源）
- CCR 以“总上下文预算（token count）”为核心，计算消息 + system + tools 的 token 数，并基于阈值选用长上下文模型：
  - 位置：`../../claude-code-router/src/utils/router.ts`
  - 关键点：
    - 使用 `tiktoken` 计算 token（消息文本、tool_use/input、tool_result/content、system 文本、工具 schema 都计入）。
    - 与配置阈值比较（`config.Router.longContextThreshold`，默认 60,000 tokens）。
    - 超阈值或结合上一轮 usage 过大则切换到 `config.Router.longContext` 模型。
- CCR 并不把大段工具结果回灌到 assistant 文本；工作流结束时通过 ExitTool 返回最终文本，移除 `tool_calls`。

## 我们的对齐策略（直击根因）
- 唯一入口：仅在 `sharedmodule/llmswitch-core` 做统一处理；Provider/兼容层不做逻辑修改。
- 两类措施：
  1) 工具结果“主动最小化 + 分层预算”
     - 所有 `role:'tool'` 消息统一“文本化+裁剪”。
     - rcc.tool.v1 成功 → 提取 stdout/简明输出；失败 → `执行失败：前三行`；无输出 → `执行成功（无输出）`。
     - 为避免累计膨胀，引入分层预算：
       - 总载荷预算（token/字节，按 CCR 思路来自配置/环境）。
       - 每条工具消息预算（HEAD/TAIL、类型化提要），最近 N 条额度更大，其余更严格。
       - 保留结构与 `tool_call_id`，不改角色、不清历史（记忆靠历史）。
  2) 去噪
     - 删除“无 `tool_calls` 且内容为空/仅空白”的 `assistant` 回合，减少空 turn.

## 已落地（当前版本）
- 实施位置：`sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts`
  - 统一对所有 `role:'tool'` 消息做“文本化+截断”，并在文本前加截断提示（例如：`[输出已截断至 2048 字符]`）。
  - 默认阈值：`RCC_TOOL_TEXT_LIMIT`（默认 2048，可调）。
  - `assistant` 含 `tool_calls` 时，将空字符串 `content` 规范为 `null`（保留混合内容）。
  - 删除空文本 `assistant`（无工具调用）。

## curl 复现与验证
1. 启动本地服务（示例端口 5520）
   ```bash
   rcc start  # 或 routecodex start
   ```
2. 使用失败样本 `*_raw-request.json` 复现
   ```bash
   jq -r '.body' ~/.routecodex/codex-samples/openai-chat/<失败样本>_raw-request.json > /tmp/rc_req_body.json
   curl -s -o /tmp/rc_resp.json -w "%{http_code}" \
     -H 'Content-Type: application/json' \
     --data @/tmp/rc_req_body.json \
     http://127.0.0.1:5520/v1/chat/completions
   ```
3. 成功标准
   - `provider-request.json` 中：
     - `role:'tool'` 文本出现截断提示；历史轮不再巨量。
     - 不再出现空的 `assistant` turn。
   - SSE/JSON 不再出现上游 500。

## 后续工作（对齐 CCR 的“预算来源”）
- 预算来源与策略：
  - 总上下文预算：
    - 从配置载入（建议：`config.Router.longContextThreshold`/`ROUTECODEX_CONTEXT_BUDGET_TOKENS`）。
    - 用 `tiktoken` 计算请求 token 数，参照 CCR 的 `router.ts` 逻辑。
  - 分层预算落到工具结果：
    - 最近 N 条工具消息额度更大，其余更严格（HEAD/TAIL/摘要）。
    - 类型化提要（stderr/失败仅前几行，stdout/JSON 取关键信息）。
  - 超预算策略：
    - 优先压缩工具结果文本，不修改历史结构与角色；必要时切换长上下文模型（CCR 同源策略）。

## 结论
- 500 原因是“累积工具结果文本 + 超长 system 导致载荷过大”，而非“工具引导缺失”。
- 处置方案定位在唯一入口（llmswitch-core），以“主动最小化 + 预算控制”预防问题发生。
- 下一步将把“分层预算 + 类型化提要 + 全局上下文预算（CCR 同源）”落地为可配置策略，并继续用 curl 真样本回放验证。


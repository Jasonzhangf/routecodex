Triage is complete and validated. Both deliverables are in the record directory.

**交付物**
- [triage.json](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-triage/triage.json) — 机器可读，8 组、36 个失败 case 全覆盖（与 report 的 failed 集合逐一核对，无遗漏无多余）。
- [notes.md](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-triage/notes.md) — 分组、case ID、证据路径与建议。

**结论：36 failed ≠ 36 operator bug**
- 5 个是严格 oracle 的 wire 表示差异，语义保留：`anthropic-to-anthropic-json`（`messages.0.content` string vs 单 text-block 数组）、`chat-to-anthropic-json`（`system` string vs `system.0.text`）、`chat-to-responses-json`（system 留在 `input` vs `instructions`；`max_tokens`→`max_output_tokens`）、`media-anthropic-older-turn-tool-image`（图片 data URI 完全保留，仅末条消息索引假设不同）、`namespace-custom-complete-args`（`tools[0]=exec_command` 导致索引 off-by-one）。
- 6 个是 fixture/oracle/harness 缺陷，无产品语义丢失：`provider-error-exhaustion`（runner 把 `{ok:false,error:'empty_body'}` 占位 observation 当成已解析观测，实际 client 已按契约关闭）、`provider-fault-stream-cut`（断言 2 次尝试但无第二候选 `runtime_setup`）、`tool-followup-responses-to-chat`（responses 语义只按 `id` 去重，function_call 只有 `call_id` → 1 个调用变 3 个）、`responses-to-anthropic-sse`、`responses-to-chat-sse`（语义提取漏 `output_item.done` 文本 + fixture 用了 chat 键 `finish_reason`）、`chat-to-responses-sse`（断言 usage 但未请求 `include_usage`）。
- 21 个确认的产品观测：gemini 目标投影缺失（8，body 仍为 chat 形 `messages`、缺 gemini auth carrier、请求未送达）；gemini 入口 404 `path_not_found`（10）；anthropic→openai_chat `UnmappedOutboundFields`（1）；`responses-to-chat-json` 输出项被拍平成 `output_text`（1）；`anthropic-to-responses-sse` 丢掉文本 delta（1）。
- 4 个未决产品观测：`responses-to-responses-json/sse` 直连零 provider 尝试；`chat-to-anthropic-sse`、`usage-cache-writes-chat-entry` client 只收到 `:` keepalive（注意 `anthropic-to-chat-sse` 是通过的）。

**建议**：先按上面分层再排修复；产品侧最大簇是 gemini 目标/入口与 anthropic→chat 投影。G2 的具体最小修法已写进 triage（如 harness `assertions.mjs` 忽略 `ok:false` 占位、`protocol-semantics.mjs` 按 `call_id` 去重）。未编辑任何 expected/fixture/helper，未重跑 live（raw 样本未变），保留了 raw red baseline。

**边界**：仅写本记录目录；产品 worktree/source/fixtures/report 只读；无委托、无 review 判定、无提交、无生产变更；未绕过任何权限拒绝；未复制任何 secret（仅 baseline fake key）。正式 whole-milestone Review 仍由父级在作者验收后统一安排一次。
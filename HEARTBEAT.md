# RouteCodex Heartbeat

Heartbeat-Until: 2026-03-23T23:59:00+08:00
Heartbeat-Stop-When: no-open-tasks
Last-Updated: 2026-03-22 22:09 +08:00

## 当前状态
- Heartbeat 任务已清理：当前无待办 checklist（无 `- [ ]`）。
- drudge heartbeat 已关闭：`routecodex` session 状态为 `disabled`。
- `routecodex-274` / `routecodex-275` 已在本轮修复后关闭（含代码修复 + 回归 + live probe 证据）。
- DeepSeek “工具被当成文本”兼容修复已落地（Rust 真源）：补齐 quote 包裹与 JSON-ish 形状解析；回归证据见 `test-results/routecodex-276/`。
- 已调用 review（drudge）并落盘：`test-results/routecodex-275/drudge-review-after-deepseek-fix-20260322-2016.log`（本次超时 `EXIT_CODE=124`）。
- “回归 + 构建 + 全局安装 + 重启”已完成并复核：`test-results/routecodex-276/*-20260322-205041.*`。
- 最新 review（drudge）成功：`test-results/routecodex-276/drudge-review-after-build-install-restart-20260322-205500.json`（`ok=true`，`EXIT_CODE=0`）。
- reviewing-code 复核通过（21:05）：2026-03-22 20:59 DELIVERY 声明项全部有证据覆盖，无未完成项。
- Time/Date 标签已补 `timeRef=now` 语义标识，并完成 dev/release 构建安装：证据见 `test-results/routecodex-277/`。
- DeepSeek “nameless tool_calls（仅 input.cmd）”已修复并回归：证据 `test-results/routecodex-277/*nameless*`，当前版本 `0.90.731`。
- DeepSeek 普通工具 harvest 形状兼容已继续收口（按“形状”统一，不是按单命令打补丁）：
  - 支持 markdown bullet 包裹 `{"tool_calls":[...]}` 形状；
  - 支持 `cmd` 内部未转义双引号（如 `"Mailbox ..."`）的容错修复后再 harvest；
  - 证据：`sharedmodule/llmswitch-core/test-results/routecodex-278/` 与 `test-results/routecodex-278/`。

## 说明
- 若需要重新启用 heartbeat 巡检：
  1) 在本文件新增明确待办项（`- [ ]`）；
  2) 执行 `drudge heartbeat on -s routecodex`。
- 历史巡检记录请在 git 历史与 `DELIVERY.md` 查看。

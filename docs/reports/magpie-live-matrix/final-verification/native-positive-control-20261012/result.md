

P1 testinfra 完成。诊断、正向对照、observer 修复均已落证据。

**Saved red-case 诊断（读原始 client bytes，未改 case）**

`tool-followup-responses-to-chat` turn-1 是合法 Responses SSE，status 200。RCC 对同一条 `call_echo_1` 在 `response.output_item.added` / `response.output_item.done` / `response.completed` 三处各发一份 function_call 快照。observer 按 `item_id` 建条目，`item_id` 为空，三份快照未合并 → 3 个 call → `echo consumer requires exactly one observed call`。**确证为 harness observer defect**。

`namespace-custom-complete-args` turn-1：client status null、body 0 字节，diagnostics `client status missing for completed response`，只有 turn-0 一次 provider business capture，无 turn-2 provider capture。**确证为 product/RCC 空响应 gap，非 harness**。observer 修复不会让该 case 通过。

**Observer 修复（唯一 owner）**

`ensureResponsesOutputItem(outputItems, identity, match)` 现支持按 `call_id` 回退匹配，`match` 参数用于 delta 与 item 两条路径。并行工具各自 call_id 不合并。新增红测 `responses SSE coalesces repeated function_call snapshots by call_id without duplicating the call`。未改 oracle/expected。

红证双向成立：撤销 `call_id` 回退后重放 saved bytes → 3 条 `["call_echo_1","call_echo_1","call_echo_1"]`；当前代码 → 1 条。修后 replay 得 1 call：`call_echo_1 / echo / {"text":"ping"}`。

**Positive true-RCC control（独立，48 manifest 之外）**

`direct-chat-echo-control`：native `openai_chat→openai_chat` direct，声明 harmless echo。Turn 1 SSE 完成 `call_direct_echo_control` / `echo` / `{"text":"control-42"}`；consumer 执行 echo 一次得 `control-42`；turn 2 实际 JSON 完成。走 loopback mock → `/Users/fanzhang/.local/bin/rccv3 0.90.4887` foreground → 真实 client 请求。own unique business/Admin ports，fake keys，未用 8777/service。

第二 provider 实际捕获证明闭环：assistant `tool_calls[0].id=call_direct_echo_control`，同一条 tool message `tool_call_id=call_direct_echo_control`、`content="control-42"`；`business_attempt_count=1`；client 200，`choices.0.message.content="control-42"`。

命令：
```sh
node /Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/tool-live-proof/control.mjs \
  --repo /Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012 \
  --binary /Users/fanzhang/.local/bin/rccv3
```
exit 0，`behavior_pass=true`，`runCase=passed`，config_check 0，health 200。首次运行曾失败：我原 fixture 断言第二 provider 请求会重复 `tools`，RCC 不带。改为语义断言，未改产品代码。

**测试与 cleanup**

`node --test protocol-semantics tool-consumer case-runner assertions` → 67 pass / 0 fail。`lifecycle.test.mjs` 单独跑 15/15 pass；此前 full selftest 的 1 fail 是 lifecycle 单测 flake，与 observer 无关。

control cleanup：PID 89288 exit 0，primary+admin 两 listener 均 closed，mock closed，config/state 目录已删，`pgrep` 无残留 rccv3，无 lifecycle 临时目录。

**Hashes**

Source：`protocol-semantics.mjs` `57b41ee9…05ed`，`protocol-semantics.test.mjs` `20dd3931…fabe`。
Artifacts：`control.mjs` `ee225f58…a55`，`direct-chat-echo-control.json` `ac0fdb45…27`，`verify-saved-cases.mjs` `b0498c87…28`，`control-receipt.json` `73be1844…92`。
Baseline 未动：`baseline-report.json` `bd874c09…e91`，仍为 48/12 passed/36 failed。未触碰 package/main/report/fixtures，未 review/commit/merge。

**交付物**：[control.mjs](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/tool-live-proof/control.mjs)、[control-receipt.json](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/tool-live-proof/control-receipt.json)、[evidence/](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/tool-live-proof/evidence/)（`affected-tests.log`、`verify-saved-cases.log`、`lifecycle-only.log`、`red-control/`、4 份 capture）。

**剩余限制**：48 baseline 仍 12/36，本轮未重跑（active owner 协调后由 parent 重跑 affected case）。`namespace-custom-complete-args` 是 P2 runtime/RCC 真实 gap，需另行报 defect；本轮按边界不修 runtime。observer 修复仅覆盖 call_id 可得的重复快照，`item_id` 缺失时不再误报多 call。
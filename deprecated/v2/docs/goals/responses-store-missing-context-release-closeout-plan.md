# Responses Store Missing Context + Release Closeout Plan

## 1. 目标与验收标准

目标：闭环当前 5555 `/v1/responses` 仍报 `RESPONSES_STORE_MISSING_REQUEST_CONTEXT` 的线上问题，并把修复通过正常 release 打包、全局安装、受管重启和真实请求重放验证，避免再次出现“本地 rcc 已修但 live routecodex 仍跑旧包”的断层。

验收标准：

- 找到 `RESPONSES_STORE_MISSING_REQUEST_CONTEXT` 的唯一根因和唯一 owner。
- 证明当前失败不是靠猜测：必须用 `~/.rcc/codex-samples/ports/<port>/<requestId>/`、`~/.rcc/logs/server-5555.log`、installed package path/buildInfo 作为证据。
- 修复后 5555 live `/v1/responses` 不再出现同轮 `record.missing_request_context` / `RESPONSES_STORE_MISSING_REQUEST_CONTEXT`。
- `routecodex` 和 `rcc` release 包都来自同一修复后的 artifact，不依赖 dev repo，不出现旧 buildTime 继续运行。
- release 验证必须走正常 `npm install -g <tgz>`，禁止用 offline/prefer-offline 替代真实 npm lifecycle。

## 2. 范围与边界

In Scope：

- Responses request context capture / response record 链路。
- Provider response conversion 中 response record plan 的 request id / response id / scope truth。
- Global install package identity：`/opt/homebrew/lib/node_modules/routecodex` 与 `/opt/homebrew/lib/node_modules/rcc`。
- Release pack/install gate：`npm run pack:rcc`、`npm run verify:rcc-release-install`、真实 global install。
- Live 5555 restart 与 failing request replay。

Out of Scope：

- 新 provider 策略、provider probe、VR priority 重新设计。
- SSE 业务语义修补；SSE 只当 transport 证据。
- 用 fallback/scope 猜测来掩盖 request context 丢失。
- 删除/回滚无关脏改。

## 3. 当前已知证据

- 5555 报错栈来自 `/opt/homebrew/lib/node_modules/routecodex/...`，不是刚验证的 `/opt/homebrew/lib/node_modules/rcc/...`。
- `/opt/homebrew/lib/node_modules/routecodex/dist/build-info.js` buildTime 为 `2026-07-03T08:18:45.204Z`。
- `/opt/homebrew/lib/node_modules/rcc/dist/build-info.js` buildTime 为 `2026-07-03T11:33:39.729Z`。
- 最新 release install gate 已证明 `rcc-0.90.3533.tgz` 正常 `npm install -g <tgz>` 可用，且无 `esbuild` / repo path / symlink core。
- 当前 missing context 日志里 `details.requestId` 可能变成 `resp_*`，需要确认是 installed 旧包问题，还是 response record plan 使用了 response id 作为 request id。

## 4. 技术方案

### Phase 1：锁 live 真源

1. 查 5555 当前运行命令、binary、package root、buildInfo。
2. 查 `~/.rcc/logs/server-5555.log` 中目标 request 前后完整日志。
3. 查 `~/.rcc/codex-samples/openai-responses/ports/5555/<requestId>/` 是否存在 request/response/provider 快照。
4. 若样本缺失，记录为观测缺口，不用缺失样本代替结论。

### Phase 2：锁唯一 owner

1. 对比 repo source、repo dist、installed `routecodex` dist、installed `rcc` dist。
2. 确认 `recordResponsesResponse` 的 `requestId` 来源：
   - request executor `input.requestId`
   - provider context `requestId`
   - native `publishResponsesRecordPlan`
   - provider response payload `response.id`
3. 禁止在 store 层用 fallback scope 吞错；store 只能暴露缺失上下文。
4. 若根因是 response record plan 传错 id，修 `publishResponsesRecordPlan` / provider-response owner。
5. 若根因是 live 只安装了 `rcc` 没安装 `routecodex`，修 release/global install 流程，确保两个 CLI 真源一致。

### Phase 3：红测

最小红测必须覆盖：

- provider response `response.id = resp_*` 时，record plan 仍用原始 request id，而不是 response id。
- request context 已 capture/rebind 后，response record 能找到 entry。
- installed `routecodex` 与 `rcc` 不允许一个新一个旧。

### Phase 4：实现

按唯一 owner 修改：

- 如果是 record plan 错误：优先改 Rust/native plan，TS 只薄壳转发。
- 如果是 package/install 错误：改 pack/install script 和 gate，确保 `routecodex` / `rcc` 双包同步。
- 不在 SSE、handler、store fallback、日志投影处补第二套语义。

### Phase 5：验证

必须跑：

- focused red/green Jest 或 Rust test。
- `npm run verify:function-map-compile-gate`。
- `npm run build:base` 或 `npm run pack:rcc` 覆盖 build path。
- 正常 `npm install -g <tgz>`，确认 installed package 不指向 repo。
- `routecodex restart --port 5555`。
- `/health`。
- live `/v1/responses` 真实请求或同入口旧失败样本重放。
- grep 新日志确认无同轮 `record.missing_request_context` / `RESPONSES_STORE_MISSING_REQUEST_CONTEXT`。

## 5. 风险与规避

- 风险：只修 `rcc` 包而 5555 继续跑 `routecodex` 旧包。
  - 规避：每次 live 验证前输出 `routecodex --version`、realpath、buildInfo、server log startup module path。
- 风险：用 response id 当 request id 修到表面通过。
  - 规避：红测锁 `requestId != response.id`，并断言 record 使用 request id 查 requestMap。
- 风险：scope fallback 掩盖 request context 丢失。
  - 规避：禁止把 store fallback 当修复；capture/rebind/record plan 必须一致。
- 风险：真实 provider 不稳定。
  - 规避：先用 captured sample/dry-run 锁本地链路，再做 live replay；provider 错误要保留真实错误码。

## 6. 实施步骤

1. 读取 `~/.codex/USER.md`、`note.md`、`docs/agent-routing/05-foundation-contract.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 和相关 `25/24/40/70` reference。
2. 定位 `RESPONSES_STORE_MISSING_REQUEST_CONTEXT` 对应 feature_id、function map、mainline call map、verification map。
3. 收集 5555 live 证据：package path、buildInfo、server log、codex-samples。
4. 设计并写红测，证明当前失败。
5. 修改唯一 owner。
6. 跑 focused tests 和 required gates。
7. 重新打 release，正常全局安装 `routecodex` 与 `rcc`。
8. `routecodex restart --port 5555`，跑 `/health` 和 live `/v1/responses` replay。
9. grep 日志确认无同轮 missing context。
10. 更新 `note.md`、`MEMORY.md`、`.agents/skills/rcc-dev-skills/references/93-lessons-2026-07.md`。

## 7. 完成定义

只有同时满足以下条件才算完成：

- 根因有日志/样本/代码证据。
- 红测先红后绿。
- 修复点在唯一 owner，不是 fallback。
- `routecodex` 与 `rcc` installed package 均为新 build。
- 5555 live replay 通过，且新日志无 `RESPONSES_STORE_MISSING_REQUEST_CONTEXT`。
- release 安装走正常 npm lifecycle。
- 结果已沉淀到 note/MEMORY/skill。

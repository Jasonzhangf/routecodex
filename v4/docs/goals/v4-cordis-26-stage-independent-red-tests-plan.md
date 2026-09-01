# V4 Cordis 26-Stage Independent Behavior Red Tests Plan

状态：`proposed`
Owner：`v4.cordis_wiring_red_tests`
关联设计：
- `v4/docs/architecture/v3-v4-semantic-parity-map.yml`
- `v4/docs/architecture/v4-cordis-node-plugin-architecture.md`
- `v4/docs/goals/v4-cordis-shared-runtime-event-control-plan.md`

## 1. 目标与验收标准

为 V4 semantic parity map 中的 26 个 stage 各建立独立行为红测。每个红测必须调用对应 owner 的真实入口，覆盖至少一个成功语义和一个反向失败语义；在当前 `v4-cordis` 基线运行时明确失败，失败原因必须对应尚未完成的行为，而不是测试语法、依赖路径或测试环境错误。

验收标准：

- 26 个 stage 一一映射到独立测试用例和测试文件/模块。
- 每个 stage 都有正向行为断言和反向错误断言，或记录该 stage 不适用的理由。
- 红测在当前 `v4-cordis` 基线真实失败，并保留命令、commit、失败输出和失败原因。
- 测试只新增测试、fixture、测试矩阵和必要 gate，不修改生产实现，不把失败改成通过。
- 变更从独立 worktree 创建，提交范围只包含本任务声明的测试文件。
- 提交完成后 fast-forward 或显式 merge 到 `v4-cordis`，合并后的红测仍保持预期失败。

## 2. 范围与边界

### In scope

- Request 9 stages：inbound normalize、continuation classify、chat process、execution plan、route facts、target resolve、provider semantic、wire build、transport。
- Response 6 stages：provider inbound、normalize、response process、continuation commit、client projection、frame。
- Error 6 stages：source、capture、classify、policy、decision、projection。
- Config 5 stages：authoring、parse、validate、registry、manifest。
- Rust L2/L3 tests、Cordis Host tests、必要的独立 red gate 和机器可读测试矩阵。

### Out of scope

- 不修改 V3 源码、V4 生产实现、provider/router/SSE/handler 业务逻辑。
- 不添加 fallback、silent strip、第二执行路径或测试专用生产 mock。
- 不把已有 map/evidence 条目当作行为测试完成证据。
- 不把 compile failure、缺依赖或路径错误冒充行为红测；这些必须单独标为环境/合同缺口。

## 3. 设计原则

- 每个 stage 只通过其登记的 owner API 测试，禁止跨 stage shortcut。
- 测试输入和断言保持真实语义；禁止裁剪 payload、改协议或绕过 typed boundary。
- 正向测试证明预期行为尚未被破坏；反向测试锁住非法输入、错误状态、scope/owner/边界泄漏。
- 红测只记录当前失败，不在本任务中修实现；后续 green 化必须回唯一 owner。
- data/control/error/diagnostic 物理隔离；测试不得把控制状态写进业务 payload。

## 4. 技术方案与文件清单

优先复用现有测试 owner：

- runtime：`v4/crates/routecodex-v4-runtime/tests/`
- standard plugins：`v4/crates/routecodex-v4-standard-plugins/tests/`
- error：`v4/crates/routecodex-v4-error/tests/`
- config：`v4/crates/routecodex-v4-config/tests/`
- bridge：`v4/crates/routecodex-v4-cordis-bridge/tests/`
- Cordis Host：`v4/cordis/routecodex-v4-cordis-host/tests/`

新增文件仅在现有测试 owner 无法独立表达时使用。每个新增测试文件必须注明 stage ID、owner、正向断言、反向断言和预期红因。

机器索引：

- `v4/contracts/semantic-parity-test-matrix.json`
- `v4/scripts/architecture/verify-v4-semantic-parity-red.mjs`

矩阵至少绑定 `stage_id`、`owner`、`test_path`、`positive_case`、`negative_case`、`expected_red_reason`、`status` 和 `evidence`。

## 5. 风险与规避

| 风险 | 规避 |
| --- | --- |
| 现有测试已覆盖但没有独立 stage 归属 | 每个 stage 单独登记 test case 和 owner，不用总测试通过替代 |
| API 不存在导致 compile-red | 标记为合同缺口；同时补可运行的行为红测，避免全部依赖编译错误 |
| Cordis 依赖未安装 | 先安装/解析项目声明依赖；仍不可用时记录环境阻塞，不宣称行为红 |
| v4-cordis worktree 有用户 dirty 改动 | 不覆盖、不恢复；在干净独立 worktree 开发，在目标 worktree 只做授权 merge |
| 测试修改生产语义 | diff boundary 检查，只允许测试、fixture、矩阵和 gate 文件 |

## 6. 测试计划

按 26 个 stage 分组执行。每组必须有：

1. 独立测试入口。
2. 正向行为断言。
3. 反向失败断言。
4. 当前基线红证据。
5. 对应 owner 和 map/checkpoint 回链。

测试必须区分三类结果：

- `behavior_red`：代码入口可运行，但行为断言失败，属于有效红测。
- `contract_red`：目标 typed API 或边界合同缺失，编译失败，需明确记录。
- `environment_blocked`：依赖、安装、权限或运行环境失败，不计入行为红测完成数。

## 7. 实施步骤

1. 刷新 `.agent-collab`，创建 run、claim 和位于 `playground/` 下的独立 worktree。
2. 从 `v4-cordis` 当前 tip 建立干净基线，读取 resource/function/mainline/verification maps 与 26-stage parity map。
3. 为 26 个 stage 建立机器矩阵，逐项绑定真实 owner 和现有测试入口。
4. 逐组补独立行为红测；每次修改前读取目标文件，使用 `apply_patch`，不做脚本批量替换。
5. 逐项运行测试，过滤环境失败，只保留有效 `behavior_red` 或明确 `contract_red`。
6. 运行 diff check、测试矩阵 gate、定向测试和必要的 workspace 检查。
7. 检查 staged stat/name-status，确保提交只包含声明的测试变更。
8. 提交红测，不修改生产实现；将 commit 合并到 `v4-cordis`。
9. 在合并后的 `v4-cordis` tip 重跑红测，确认失败仍对应预期缺口。
10. 写入 `evidence.jsonl` 与 handoff；不得在红测阶段启动 green 修复或 review。

## 8. 完成定义

- 26/26 stage 均有独立行为测试记录和 owner/map 回链。
- 26/26 均有可审计的正向/反向测试设计。
- 有效红测结果按 `behavior_red` / `contract_red` 分类；环境失败单独报告。
- 独立 worktree、提交范围、合并 commit 和合并后重跑证据完整。
- `v4-cordis` 已包含红测提交，但生产实现保持未修改；后续 green 化任务可按矩阵逐项推进。

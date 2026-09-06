# Memory feature 接管与功能审计

状态：历史接管审计，以下原结论保留作证据。用户随后明确 proxy 只采集到 AppSDK L3 raw；当前范围与重分类见 [raw 采集设计](../../design/v3-memory-raw-capture.md)。已授权并删除 `agent-memory-foundation` 旧树；非 memory dirty 材料有独立恢复归档，不再等待第二旧树作为设计前置条件。

更新：旧方案的 compaction、撤回有效知识、recall、snapshot 更新不属于当前功能验收，不应继续作为当前 P1 要求实现。输出采集边界与持久化可靠性仍须解决；旧 PendingIndex 的双实例缺陷支持淘汰该存储，不能推断 AppSDK 已具备正确互斥。后文“未清理”和“后续顺序”均为上一轮历史状态。

## 基线与范围

- 新树：`playground/memory-0906`，分支 `codex/memory-takeover-20260906`。
- 基线：新建时从最新 `origin/main@6e86a7e60` 出发，再 fast-forward 到本地 `main@3fa86061a`，包含前次清理成果。
- 已确认来源：`playground/agent-memory-foundation@2c431042c` 的实际工作区文件，包含未提交修改。
- 第二来源尚未确认，不能据此删除任何旧树。活跃 cooldown/provider-error 重构树保留。
- AppSDK project-memory 是工程记忆治理；本报告对象是 RouteCodex runtime agent-memory。前者不能当作后者的第二份实现。
- 本轮不修改 main、不实现新行为、不安装/重启、不提交/合并、不删除来源树。

## 已搬运

`selection.json` 是文件清单与 SHA-256 回执，17 个文件在复制时逐个验证字节相同。

- 6 个 memory crate 文件进入 `v3/crates/routecodex-v3-agent-memory/`，仅注册为 workspace member，供独立测试；runtime/server 未依赖此 crate。
- 两份设计、Req04/Resp03 模块、两份 memory 接线测试、四份旧架构 map 和原始 run notes 保存在 `source/`，作为历史材料，不是当前生产契约。
- `mixed-integration-reference.patch` 保存历史基点到旧树工作区中匹配 memory 符号的 tracked 文件差异。它包含非 memory hunks，仅供查找依赖，禁止整包应用。未声称完整备份旧树的全部未提交文件。
- 新增 `tests/takeover_audit.rs` 是现状复现探针，断言继承缺口；通过不代表这些行为正确。
- 未接管整套通用 hook skeleton、SSE 修复、协议重构、provider/cooldown 改动、治理迁移或 V4 内容。

## 功能现状

| 能力 | 源码与证据 | 判定 |
| --- | --- | --- |
| 严格 schema、soft admission、内容去重 | Core 单测 | 可独立运行 |
| Pending append/freeze/commit 与损坏拒绝启动 | Core 单测 | 单实例基础成立 |
| organization prepare/commit/recovery | Core 单测 | 库能力成立，运行时入口未闭环 |
| bounded recall、Skill manifest/index | Core 单测 | 基础成立，无真实任务相关性检索证明 |
| Req04 注入 | 旧源码和测试已保存 | 未在新 runtime 接线或重测 |
| Resp03 JSON/SSE 采集 | 旧源码和测试已保存 | 未在新 runtime 接线；存在输出层契约缺口 |
| Tool/summary observer | 设计仍列后续接线 | 未完成 |
| 完整学习循环 | 采集→晋升→新快照→下一轮召回 | 未闭环 |

## 阻断新功能验收的问题

1. **P1：模型业务输出与 API 外壳采集不一致。** `src/lib.rs:405` 的 observer 只读取根 `memory`；旧 `memory_resp03.rs` 将响应外壳传入。探针证明：同一合法 memory JSON 直接传入可接受 1 条，放进 Responses `output[].content[].text` 后接受 0 条、无诊断。需先确定真实模型输出契约和唯一解析边界，再用 provider 四件套验证；本轮没有真实 provider 请求，不能推断所有 provider 的实际行为。
2. **P1：同目录多实例可破坏持久化序列。** `src/lib.rs:619` 的 open 与 append 没有跨 handle 独占。探针顺序打开两个 PendingIndex，各写一条不同内容，两次 append 均成功，随后 reopen 失败。并不需要并发交错即可复现；必须由 store owner 保证独占或一致的多写者协议。
3. **P1：撤回操作未影响有效召回。** `src/organization.rs:381` 从全部 raw entries 构造 snapshot，未应用 operation/target 的有效状态。探针先 add 再 retract，full organization 后仍得到 2 条 snapshot entries，原事实仍在 recall。不能将原始事实和撤回记录都投影成普通事实；修复应落在知识投影 owner。
4. **P1：运行时缺少晋升与快照更新入口。** `src/runtime.rs:38` 仅 open 时创建 snapshot，handle 公开 API 没有组织事务或刷新；旧 runtime/server 内 `organize_pending_generation` 命中仅在测试预置。不能把手工预填 knowledge 的绿测作为持续学习证据。
5. **P1：历史 marker 能抑制当前轮注入。** 保存的 `memory_req04.rs:149` 扫描整个输入历史中的 user message，而不是当前调用的 typed 注入状态。旧 recall marker 存在时会跳过当前 snapshot 的注入。此项为源码审计结论，未在新树运行 runtime 复现。

额外待核实：非 add 的目标合法性与跨 scope 约束；admission/pending 容量上限；ToolCall future-claim 校验目前只是英文子串，不能作为事件来源证明；buffered Responses 对 `finish_reason=stop` 的要求与原生协议是否匹配。尚未完成这些问题的实际入口验证。

## 本轮验证

- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-agent-memory --lib`：**45 passed, 0 failed**，在新 worktree 实测。
- `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-agent-memory --test takeover_audit`：**3 passed, 0 failed**，分别复现以上前三项缺口。
- `git diff --check`：通过。
- scoped `rustfmt --check`：继承的 `src/runtime.rs` 存在格式差异；保持来源逐字搬运，没有顺手改写。新增审计测试已经 rustfmt。
- 未执行 runtime/server 集成测试、完整 architecture CI、安装、重启、health 或真实 replay；当前只有独立 Core 编译/测试证据。
- 按共享 review standards 做只读自审；上述 P1 未修复，**功能验收 FAIL**。未调用外部 AGY，不声称 external review PASS。无 commit、merge 或 remote receipt。

## 后续顺序

先确认第二来源并完成选择性搬运、校验和差异审计，再决定旧 worktree 清理。进入新开发后，先用真实合法短样本锁定业务输出/采集契约，再处理持久化独占、知识 operation 投影和晋升快照生命周期，最后接入当前 main 的 typed hooks 并更新当前 maps。旧 maps 和混合 patch 只能作为依赖参考，不得恢复旧框架覆盖当前实现。

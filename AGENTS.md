# RouteCodex Project AGENTS（Routing Edition）

## 索引概要
- L1-L9 `purpose`：项目 AGENTS 仅保留入口和硬护栏。
- L11-L28 `hard-guards`：不可违背的项目级底线。
- L30-L45 `route-map`：分类路由（文档路径 + 作用）。
- L47-L54 `execution-flow`：任务执行顺序。
- L56-L60 `maintenance`：维护原则。

## 项目硬护栏（Hard Guards）
1. **单一路径真源**：`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`，禁止旁路。
2. **llmswitch-core 主导工具与路由**：Host/Provider 不得重建工具治理与路由语义。
3. **Rust runtime 语义真源**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`。
4. **Fail-fast + no fallback**：严禁一切 fallback/降级/兜底逻辑，错误必须显式暴露，禁止静默失败。
5. **先验证后结论**：无文件/日志/测试证据，不得宣称完成。
6. **非授权不破坏**：未获明确授权，不做删除/回滚/迁移/发布类破坏动作。审计/只读任务中，仅允许执行只读 git 命令（`git show`、`git diff`、`git log` 等），禁止任何会修改磁盘状态的写操作，包括但不限于：`git checkout`（单文件路径除外）、`git reset`、`git stash`、`git clean`、`git rm`、`git revert`；禁止 `rm -rf`；禁止 `npm install`/`npm uninstall` 修改依赖。
7. **禁止进程杀戮命令**：禁用 `kill/pkill/killall/taskkill/lsof|xargs kill` 等。
8. **llmswitch-core 禁止新增 TS 功能代码**：不允许再增加任何 TypeScript 功能实现；如有必要，一律转为 Rust 实现，TS 仅允许保留最小调用壳层。
9. **Hub Pipeline / Chat Process 必须 Rust-only**：凡属 `llmswitch-core Hub Pipeline / chat process / req_process / resp_process / servertool followup orchestration` 的语义、判定、修复、兼容、sanitize、tool list 注入与裁剪，唯一真源必须在 Rust `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`；发现 TS 存在并行实现、补丁式判定或第二语义面，必须当场迁回 Rust，并把 TS 收缩为薄壳转发。
10. **真实 payload 不可裁剪**：proxy 主传输链中的请求/响应 payload 必须保持语义等价，禁止以 budget/history/media placeholder/自动续接 等方式裁剪或改写真实传输内容；性能优化只能发生在算法/处理路径。仅允许**内部派生 followup 链**做显式设计的能力桥接（附件仅当前请求存在、不入历史；非视觉模型可注入 vision summary），但这类桥接不得冒充主链 payload，也不得作为 fallback/静默补偿。
11. **技能沉淀规则（按需精华更新）**：仅当出现新的可复用经验、或发现现有规则需要修正时，更新本项目 local skills（如 `.agents/skills/*/SKILL.md`）；内容必须是“经验精华”（可复用规则/反模式/触发信号/边界条件），可一两句，禁止流水账式过程记录。
12. **文本 harvest 容器优先**：文本工具收割必须先锁定显式 wrapper/container（如 RCC heredoc / XML 顶层壳）并仅解析顶层工具壳；禁止解析 shell/patch 正文、禁止凭正文猜工具。
13. **stopless / reasoning.stop 禁止伪造工具面**：严禁为了逼出 `reasoning.stop` 而缩减、替换或伪造 followup tools；禁止 `replace_tools`、`force_tool_choice`、`only reasoning.stop`、补“标准假工具”、注入“工具缺失/只允许自查”文案。只能保留真实 tools，并坚持“未调用 `reasoning.stop` 不得停止”。
14. **禁止未授权扩 scope**：未获 Jason 明确要求，不主动附加额外目标或动作（如顺手加约束、加提示词、加兜底、加测试、build/install/restart、提交/清理等）；只做当前被要求的事，并先回报证据再推进下一步。
15. **Qwen / QwenChat 禁止混淆**：`qwen` 与系统安装的 **Qwen Code** / DashScope OAuth 链路同源；`qwenchat` 是另一条独立 Web 链路。调试 `qwen` 时，禁止拿 `qwenchat` 的成功/鉴权/UA/header 结论冒充 `qwen` 证据。
16. **发现即修（最小切片）**：本次任务触达范围内，凡发现 fallback 或静默失败代码，必须顺手修复并补充验证证据；禁止“先记账后放过”。
17. **默认全局安装 rcc（除非用户明确拒绝）**：凡涉及 build/dev/install/restart/可执行验证，默认执行“编译 + 全局安装 rcc/routecodex + 健康检查”；只有当 Jason 明确要求“不全局安装”时才可跳过。
18. **HubPipeline 强制 Rust 规则**：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**` 与 `sharedmodule/llmswitch-core/src/conversion/hub/process/**` 涉及的 HubPipeline 语义（消息处理、tool_calls 处理、clock/heartbeat 指令语义、session usage 语义、marker 语义）必须由 Rust 真源实现；禁止在上述 TS 路径新增或扩展业务语义逻辑。TS 仅允许薄壳 native 调用（参数/返回桥接）与不改写 payload 语义的运行时基础设施编排。发现 TS 语义实现时，必须迁回 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/` 并将 TS 收缩为薄壳。

## 分类路由（路径 + 作用）
1. 入口总览：`docs/agent-routing/00-entry-routing.md`
   - 作用：从任务类型快速分发到对应文档/skill。
2. 运行时与架构真源：`docs/agent-routing/10-runtime-ssot-routing.md`
   - 作用：核心分层职责、真源边界、禁止跨层修补。
3. 构建/验证/发布：`docs/agent-routing/20-build-test-release-routing.md`
   - 作用：build/dev/release/install 的顺序与最小验证栈。
4. servertool / stopMessage / heartbeat / clock：`docs/agent-routing/30-servertool-lifecycle-routing.md`
   - 作用：自动续轮、tmux 注入、心跳巡检、定时回查约束。
5. 任务跟踪与记忆：`docs/agent-routing/40-task-memory-routing.md`
   - 作用：BD、MEMORY、CACHE、memsearch 的职责边界。
6. 现有权威细节文档（按需跳转）：
   - `docs/ARCHITECTURE.md`
   - `docs/error-handling-v2.md`
   - `docs/routing-instructions.md`
   - `docs/stop-message-auto.md`
   - `docs/design/servertool-stopmessage-lifecycle.md`
   - `docs/hubpipeline-rust-boundary.md`
   - `docs/design/servertool-followup-rebuild-from-origin.md`
7. 用户纠偏路由（全局）：`~/.codex/docs/agent-routing/10-alignment-and-profile.md`
   - 说明：`user-correction-alignment` 是 **skill 名称**，不是 shell 命令。

## 标准执行顺序
1. 读本文件（项目入口 + 护栏）。
2. 读 `docs/agent-routing/00-entry-routing.md` 选路。
3. 打开对应路由文档与相关 skill 文档执行。
4. 执行后用证据回报：变更、验证、剩余缺口、下一步。

## 维护原则
- 本文件保持短小：只保留入口、护栏、路径。
- 细节写到 `docs/agent-routing/*` 或技能文档，不回灌本文件。
- 每个路由文档必须包含“索引概要（行号 + 关键字）”。

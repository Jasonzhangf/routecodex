# RouteCodex Project AGENTS（入口与路由索引）

## 全局硬护栏（Hard Guards）
1. **单一路径真源**：`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`，禁止旁路。
2. **llmswitch-core 主导工具与路由**：Host/Provider 不得重建工具治理与路由语义。
3. **Rust runtime 语义真源**：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`。
4. **Fail-fast + no fallback**：严禁一切 fallback/降级/兜底逻辑，错误必须显式暴露，禁止静默失败。
5. **先验证后结论**：无文件/日志/测试证据，不得宣称完成。
6. **非授权不破坏**：未获明确授权，不做删除/回滚/迁移/发布类破坏动作。
7. **禁止进程杀戮命令**：禁用 `kill/pkill/killall/taskkill/lsof|xargs kill` 等。
8. **llmswitch-core 禁止新增 TS 功能代码**：如有必要，一律转为 Rust 实现，TS 仅允许保留最小调用壳层。
9. **Hub Pipeline / Chat Process 必须 Rust-only**：凡属 Hub Pipeline / chat process / req_process / resp_process / servertool followup orchestration 的语义、判定、修复、兼容、sanitize、tool list 注入与裁剪，唯一真源必须在 Rust，TS 收缩为薄壳转发。
10. **只写必要代码，且必须最小合规**：新增/修改代码前，先证明它是完成当前需求所必需的；禁止加入用户未要求、问题未证明需要、或不影响验收的代码。实现必须保持最小合规面，能删则删，能不加就不加。
11. **Windsurf 工具禁止伪装 native**：Windsurf 中只有已证明完全等价的工具才能 native-map；`apply_patch` 不得映射到 `write_to_file/propose_code`，必须走 RCC 文本收割或显式 servertool。
12. **Hub Pipeline / Virtual Router 禁止 provider 特例**：Hub Pipeline 与 Virtual Router 永远只承载协议、路由、工具治理的通用语义；禁止写入任何 provider-specific 分支、shape 修补、上下文补偿或 Windsurf/Cascade 特例。provider 差异只能在对应 Provider runtime 内解决。

## 分类路由（按需跳转）
1. 入口总览：`docs/agent-routing/00-entry-routing.md`
2. 运行时与架构真源：`docs/agent-routing/10-runtime-ssot-routing.md`
3. 构建/验证/发布：`docs/agent-routing/20-build-test-release-routing.md`
4. servertool / stopMessage / heartbeat / clock：`docs/agent-routing/30-servertool-lifecycle-routing.md`
5. 任务跟踪与记忆：`docs/agent-routing/40-task-memory-routing.md`
6. 权威细节文档：
   - Windsurf 当前事实入口：`.agents/skills/rcc-dev-skills/SKILL.md` 的 Windsurf 章节 + `docs/providers/windsurf-chat-provider-design.md`
   - `docs/ARCHITECTURE.md`
   - `docs/error-handling-v2.md`
   - `docs/routing-instructions.md`
   - `docs/stop-message-auto.md`
   - `docs/design/servertool-stopmessage-lifecycle.md`
   - `docs/design/servertool-followup-rebuild-from-origin.md`
   - `docs/design/windsurf-cascade-tool-protocol.md`
   - `docs/providers/windsurf-chat-provider-design.md`

## 标准执行顺序
1. 读本文件（项目入口 + 护栏）。
2. 读 `docs/agent-routing/00-entry-routing.md` 选路。
3. 打开对应路由文档与相关 skill 文档执行。
4. 执行后用证据回报：变更、验证、剩余缺口、下一步。

## 维护原则
- 本文件保持短小：只保留入口、护栏、路径。
- 细节写到 `docs/agent-routing/*` 或技能文档，不回灌本文件。

## 当日事实更新（2026-05-27）
1. 5555 主备问题当前已证实：Rust Virtual Router 的 priority 选路语义正常；“主 provider 未命中”优先排查 health/quota/runtime init 状态，不先改 selection。
2. provider health 的 `__http_503_daily_cooldown__` 为 persisted 状态（canonical key 生效，`key1 -> 1`）；启动后应先重新校验可恢复性，若首个真实请求仍不可恢复（如 503）则再次冷却。
3. 启动排障必须区分：`checkHealth=false`、`VR success hook 不可用`、`success 后再次失败重写冷却` 三个分支；不得混为“路由器错误”。
4. 本项目该类问题调试先看 `.agents/skills/rcc-dev-skills/SKILL.md` 的“2026-05-27 调试精华（5555 主备/health/stopless）”章节，再执行改动。
5. 错误处理主链真相：provider/local error 先归一到 `src/providers/core/runtime/provider-error-catalog.ts`，再进入 `provider-failure-policy-impl.ts` 分类；`request-retry-helpers` / `request-executor-retry-decision` / `request-executor-session-storm-backoff` / `retry-engine` 只消费统一码与分类结果，禁止新增 message-only 分叉。

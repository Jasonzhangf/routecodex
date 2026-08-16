# V3 骨架收敛与表驱动 Codec 实现计划

Feature family: `v3-skeleton-and-table-driven-codec-20260808-r1`
Claim: `feature_id:v3-skeleton-and-table-driven-codec`（run `20260808T021953Z-Macstudio-31041-skeleton-table-codec`）
状态：**执行中**（阶段 0-3 ✅、阶段 4 里程碑 1-2 ✅、阶段 4 剩余 / 阶段 5-6 ⏳）
相关文档：`docs/goals/v3-table-driven-codec-migration-spec.md`（阶段 3 迁移规格，本计划引用不重复）

---

## 1. 目标与验收标准

### 目标
把 V3 流水线收敛为「大骨架 + 小骨架 + codec 查表」结构：
- **骨架是真源**：direct / relay 各一个统一主循环，生命周期（VR 重试 loop、错误策略循环、provider action recovery、SSE unfold）只存在于骨架/edge；骨架上的逻辑（共享辅助、codec 方法）不持有生命周期。
- **协议差异 = codec**：不同分支（openai chat / responses / anthropic / gemini × direct / relay）走同一骨架，只是 codec 不同，流程一模一样。
- **转换 = 查表**：inbound（协议→hub 归一化）与 outbound（hub→协议反向投影）的字段/类型/角色/finish_reason/白名单映射以 JSON 表为真源；表按模块拆分；`transform` 用注册函数名兜底少数复杂转换。

### 验收标准（DoD 摘要）
1. **direct**：chat 已走 `execute_v3_direct_runtime_kernel_core<V3ChatDirectCodec>`；responses 切泛型骨架（依赖 v3_direct_core 能力补齐）。
2. **relay**：gemini 已走 `execute_v3_relay_runtime_core<V3GeminiRelayCodec>`；openai_chat / anthropic 切换（Mode B web-search 差异经 trait 扩展）；responses 延后（增强版失败处理，需先统一 failure 结构）。
3. **表**：7 张 JSON 表（finish_reason / role / part_type / field / tool_choice / usage / request_field）+ 加载器/校验器/执行器 + transform 注册表；M1-M5 已迁移（9 处手写→查表，行为零变化）；M6（SSE 模板表，随骨架）与 M7（resp 分派表，待 transform context 扩展）延后。
4. **server**：分派样板收敛（4 relay 分支 → 共享）；openai_chat Direct 空洞已修复；`runtime_owner_symbol` 存在性校验（红测静态扫描）。
5. **全绿**：`cargo check --workspace --all-targets`、`cargo test`（lib + 集成）、红测、在线旧样本复测。

---

## 2. 范围与边界

### In Scope
- `v3/crates/routecodex-v3-runtime/src/kernel/`（direct 骨架接线）
- `v3/crates/routecodex-v3-runtime/src/protocol_tables.rs` + `tables/`（JSON 表基础设施）
- `v3/crates/routecodex-v3-runtime/src/hub_v1/`（relay 骨架收敛 + codec 查表化 + relay_runtime_shared / relay_runtime_core）
- `v3/crates/routecodex-v3-server/src/lib.rs`（分派收敛）
- `v3/crates/routecodex-v3-config/src/defaults.rs` / `validate.rs`（空洞修复与校验）

### Out of Scope
- **servertool 骨架**（`servertool_hooks.rs` 的 req04/resp03 语义）：已基本完成，禁止改造其语义；codec 骨架只负责调用其 hooks。
- provider runtime 内部协议兼容（provider 差异只在对应 Provider runtime 内解决）
- 已物理删除 provider 的复活
- 非 V3 链路（TS/sharedmodule 旧实现，禁止新增 TS 功能代码）

---

## 3. 设计原则（落地不跑偏）

0. **系统本质是两个骨架**（Jason 2026-08-08）：
   - **codec 骨架**（本次改造范围）：direct / relay 统一主循环 + codec（协议差异收敛）+ JSON 查表转换；生命周期（VR loop / 错误策略 / provider action recovery / SSE unfold）只在骨架。
   - **servertool 骨架**（已基本完成，范围外）：servertool / stopless / web-search 的 req04 注入与 resp03 剥离语义（`servertool_hooks.rs`：`govern_v3_servertool_request_at_req04` / `apply_v3_tool_call_servertool_hook_at_resp03` / `apply_v3_stop_servertool_hook_at_resp03` / `apply_v3_stopless_request_hook_at_req04` / `apply_v3_web_search_request_hook_at_req04`）。**不改造其语义**；codec 骨架通过 hooks 链（`compile_v3_hub_relay_request_hooks` / response hooks registry）驱动它执行。
1. **骨架唯一真源**：direct / relay 主循环是唯一生命周期载体；禁止协议 runtime 各写一套编排。
2. **转换 = 查表**：映射表达位置在 JSON 表；表缺失/格式错/互逆不对称/未注册 transform 启动 fail-fast。
3. **表是数据不是代码**：`include_str!` + serde_json + OnceLock 加载；红测兜底 JSON 内容（编译期不检查）。
4. **行为零变化迁移**：手写→查表 / 独立编排→共享骨架，只改表达位置不改语义；fallback 保留原字面量；每步跑行为一致性测试。
5. **错误形状 = 协议 wire 差异**：`V3RelayProviderFailure` 携带 `error_type_fn`/`error_message_fn`（fn 指针），提取逻辑共享、body 构造留协议本地。
6. **P0 合规**：禁止脚本批量替换（逐文件 apply_patch）；控制语义不进 payload；禁止 fallback/静默失败。

---

## 4. 技术方案（文件清单）

### 4.1 已完成
| 文件 | 内容 |
|---|---|
| `tables/schema/protocol_tables.schema.json` | 3 种 kind：protocol_value_map / bidi_field_map / field_whitelist_map |
| `tables/{finish_reason,role,part_type,field,tool_choice,usage,request_field}_map.json` | 7 张映射表 |
| `src/protocol_tables.rs` | 加载/校验（inbound 唯一性、outbound 折叠合法）/执行器/transform 注册表；`map_value`/`map_field`/`is_whitelisted`/`whitelisted_fields` |
| `src/hub_v1/relay_runtime_shared.rs` | 共享辅助：server_routing_group / provider_target（expected_provider_type 参数化）/ handle_provider_failure / error_output / V3RelayProviderFailure（fn 指针字段）+ extract_*_style 提取 + push_sse_response_chain_trace |
| `src/hub_v1/relay_runtime_core.rs` | `V3RelayProtocolCodec`（12 方法）+ `execute_v3_relay_runtime_core<C,T>` 统一主循环 + `V3RelayCoreError` |
| 各协议 codec 迁移 | M1-M5 查表化（openai_chat_codec / anthropic_relay_runtime_codec / request_outbound_format / responses_openai_codec / responses_to_anthropic / anthropic_codec_tool_projection）；gemini/anthropic/openai_chat 共享辅助迁移；gemini 骨架切换 |

### 4.2 待做
| 文件 | 内容 |
|---|---|
| `relay_runtime_core.rs` | trait 扩展：`request_hook_profile`（Mode B web-search enabled/disabled）、web_search_state 透传 |
| `openai_chat_relay_runtime.rs` | `V3OpenAiChatRelayCodec` impl（无 endpoint model 提取，model 从 payload；Mode B profile）+ inner 委托骨架 |
| `anthropic_relay_runtime.rs` | `V3AnthropicRelayCodec` impl + inner 委托骨架 |
| `responses_relay_runtime.rs` | 延后：先统一 `V3ResponsesRelayProviderFailure` 结构（policy_error_type/policy_error_message/observability 字段）与共享 `V3RelayProviderFailure`，再迁移 |
| `v3-server/src/lib.rs` | 4 个 relay 分支样板收敛（失败投影 + 输出函数 → 共享） |
| `v3/crates/routecodex-v3-config/src/validate.rs` | `runtime_owner_symbol` 存在性校验（红测静态扫描，避免 config crate 文件系统依赖） |
| `kernel/v3_direct_core.rs` | responses direct 切泛型骨架（能力补齐：continuation/stopless/web-search/SSE 流观测/timing）——与并行 worker 协作 |

---

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| 并行 worker 活跃修改 relay/codec 文件（40+ active claim） | `.agent-collab` claim + handoff；forward-only 行为零变化迁移；阶段 6 统一复核 |
| responses 增强版失败处理与共享结构不兼容 | 延后 + 先统一 failure 结构（单独计划） |
| openai_chat Mode B web-search 请求侧差异 | trait 扩展 request_hook_profile / web_search_state（先分析后落地） |
| JSON 表运行时数据无编译期类型检查 | 启动 fail-fast + 红测（schema/互逆/一致性） |
| v3_direct_core 能力补齐与并行 worker 重叠 | handoff 跟踪；respones 切换待能力补齐后验证 |

---

## 6. 测试计划

### 6.1 单元测试（已落地 11 个）
- 表加载、双向映射（finish_reason/role/part_type/field/tool_choice/usage）、方向隔离、inbound 唯一性校验（坏表拒绝）、field 歧义拒绝、whitelist 查询、transform 注册生命周期。

### 6.2 集成测试（协议行为一致性，迁移前后同输入同输出）
- responses / anthropic / openai_chat / gemini 各 relay runtime integration + codec characterization + wire integration + continuation/stopless/web-search 专用文件（全绿清单见 evidence）。

### 6.3 红测 / 结构 gate
- 新增协议映射必须出现在 JSON 表（禁止手写新映射）——静态扫描 codec 文件；
- 互逆映射成对同表（schema 校验）；
- 主循环/骨架禁止协议字段名——架构 gate 扫描；
- `runtime_owner_symbol` 存在性——validate 校验。

### 6.4 全量验证
- `cargo check --workspace --all-targets`（零 error）
- `cargo test --workspace`（lib + tests）
- 安装 `routecodex restart --port <locator>` 一次 + 全部成员端口 `/health`
- 在线重放旧错误样本（同协议 + 跨协议，证明无回归）
- `codex-review` 架构 review PASS

---

## 7. 实施步骤（顺序，当前进度标注）

| 步骤 | 状态 |
|---|---|
| 阶段 0：run/claim/基线锁 | ✅ |
| 阶段 1：direct 骨架接线（chat 已接、responses 待能力补齐） | ✅（chat）/ ⏳（responses） |
| 阶段 2：JSON 表基础设施（7 表 + 加载/校验/执行器） | ✅ |
| 阶段 3：M1-M5 查表化迁移（9 处）；M6/M7 延后 | ✅ / ⏳ |
| 阶段 4：relay 骨架——里程碑 1 共享辅助（gemini/anthropic/openai）✅；里程碑 2 trait+骨架+gemini 切换 ✅；openai/anthropic 切换 ⏳；responses 延后 ⏳ | 进行中 |
| 阶段 5：server 分派收敛 + validate 符号校验 | ⏳ |
| 阶段 6：全量编译/测试/红测/在线复测 + codex-review | ⏳ |

---

## 8. 完成定义（DoD）

1. 4 个 relay 入口（gemini/openai_chat/anthropic 走统一骨架；responses 明确延后依据）中，本 claim 范围内全部切换并验证；
2. 7 张 JSON 表为映射真源，M1-M5 迁移无行为回归；
3. server 分派样板收敛；无空洞声明；
4. `cargo check --workspace --all-targets` 零 error；lib + 集成测试全绿；红测 gate 通过；
5. 在线旧样本复测无回归；codex-review PASS；
6. 全程 `.agent-collab` 记录；P0 合规（无脚本批量替换，违规已自报一次并修正）。

# HubPipeline Rust Shared Helper Closeout Plan

## 索引概要
- L1-L11 `purpose`：目标与文档定位。
- L13-L40 `acceptance`：验收标准。
- L42-L69 `scope`：范围与边界。
- L71-L101 `principles`：设计原则。
- L103-L186 `module-map`：建议收口模块与函数归属。
- L188-L242 `migration-order`：实施顺序与每步输出。
- L244-L278 `verification`：验证矩阵。
- L280-L294 `dod`：完成定义。

## Purpose

本计划用于收口 HubPipeline Rust 周边的重复 helper，实现更稳定的：

```text
shared functions -> blocks / semantic modules -> orchestration
```

当前判断结论：

1. `hub_pipeline.rs` 主文件已经基本是编排壳，不是当前第一优先级。
2. 当前最主要的结构债是多个 Rust 语义模块里仍物理复制了同类 helper。
3. 本轮 closeout 的主目标不是继续拆 orchestrator，而是把重复 helper 收成单点 shared Rust 真源。

本文是实施计划文档；事实边界仍以：

- `AGENTS.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`
- `~/.codex/skills/rustify-the-code/SKILL.md`

为上位约束。

## Acceptance Criteria

### Functional acceptance

- HubPipeline Rust 周边重复 helper 被收口为单点 shared 模块。
- `hub_reasoning_tool_normalizer.rs` 与 `hub_text_markup_normalizer.rs` 不再各自维护同类 XML / CDATA / JSON-scan / RCC-fence helper。
- tool canonicalization 不再在多个模块中手写轻变体；`websearch/web-search -> web_search`、`execute/shell/bash -> exec_command` 等规则只保留一个 shared 真源。
- `hub_pipeline.rs` 保持纯编排定位，不额外回流 payload 语义逻辑。

### Structural acceptance

- shared helper 必须落到已存在或明确必要的新 shared Rust 模块。
- 语义模块只保留该模块独有的决策、组合、分支、输出结构。
- orchestration 层不再复制 shared helper 实现。

### Safety acceptance

- 不引入 fallback / 双路径 / 第二真源。
- 不改变现有协议语义，只收口重复实现。
- 不顺手修改 provider / TS 壳层逻辑。

## Scope

### In scope

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_text_markup_normalizer.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/tool_harvester.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/streaming_tool_extractor.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tooling.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_mapping.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_args_mapping.rs`

### Out of scope

- TS runtime / host shell 改造。
- provider-specific 语义迁移。
- `hub_pipeline.rs` 之外的大规模 orchestrator 重写。
- unrelated tool schema / followup / provider routing 修复。

## Design Principles

1. **先 shared，再 blocks，再 orchestration**
   - 纯 helper 必须先下沉。
   - 语义模块只保留自身专属分支与输出结构。

2. **不猜语义，只收重复实现**
   - 本轮不是重新定义协议。
   - 只把已存在、已验证的等价 helper 收成单点。

3. **优先复用现有 shared 模块**
   - 能进 `shared_json_utils.rs` / `shared_tooling.rs` / `shared_tool_mapping.rs` / `shared_args_mapping.rs` 的，不新造模块。

4. **主文件保持薄壳**
   - `hub_pipeline.rs` 继续只做编排，不吸回 helper 细节。

## Module Map

### 1. `shared_json_utils.rs`

建议吸收：

- balanced JSON object scan helper
- balanced JSON array scan helper（若本轮命中）

候选来源：

- `hub_reasoning_tool_normalizer.rs`
  - `extract_balanced_json_object_at`
- `hub_text_markup_normalizer.rs`
  - `extract_balanced_json_object_at`
- `tool_harvester.rs`
  - `extract_balanced_json_candidate_at`

收口后职责：

- 只提供纯 JSON 扫描/抽取 helper；
- 不包含 tool-specific 判断；
- 不包含 markup / protocol 名称知识。

### 2. `shared_tooling.rs`

建议吸收：

- `unwrap_xml_cdata_sections`
- `decode_basic_xml_entities`
- `extract_rcc_tool_call_fence_segments`
- `value_to_string`
- `is_image_path`
- 命令字符串 split helper（若证明等价）

候选来源：

- `hub_reasoning_tool_normalizer.rs`
- `hub_text_markup_normalizer.rs`
- `tool_harvester.rs`
- `streaming_tool_extractor.rs`

收口后职责：

- 文本/markup/tooling 通用 helper；
- 不直接依赖具体 tool 决策；
- 不做模块特定 branch。

### 3. `shared_tool_mapping.rs`

建议吸收并成为唯一真源：

- `normalize_tool_name`
- `normalize_tool_key`
- `functions.` 前缀清洗
- legacy alias：
  - `websearch`
  - `web-search`
  - `execute`
  - `execute_command`
  - `shell_command`
  - `shell`
  - `bash`
  - `terminal`

候选来源：

- `hub_reasoning_tool_normalizer.rs`
- `hub_bridge_actions/history.rs`
- `shared_tool_mapping.rs`（保留为最终归宿）

收口后职责：

- tool canonical name 唯一真源；
- 所有 tool identity / alias 归一统一经过这里；
- 其他模块只调用，不再各写一份。

### 4. `shared_args_mapping.rs`

建议视等价性第二阶段吸收：

- `read_tool_name_hint_from_args`
- command split / command string coercion 的通用部分

候选来源：

- `hub_reasoning_tool_normalizer.rs`
- `hub_text_markup_normalizer.rs`
- `tool_harvester.rs`
- `streaming_tool_extractor.rs`

注意：

- 只有在参数语义完全一致时才收；
- 若某函数混有 module-specific salvage 逻辑，则先不迁。

### 5. 语义模块保留内容

以下文件在收口后仍保留其专属职责，不应被清空成空壳：

- `hub_reasoning_tool_normalizer.rs`
  - reasoning text harvest / merge / tool_call 归并 / reasoning-content 映射
- `hub_text_markup_normalizer.rs`
  - markup family 解析策略、top-level tool object salvage、text protocol 决策
- `tool_harvester.rs`
  - signal-based harvest orchestration、dedupe、delta events 生成
- `streaming_tool_extractor.rs`
  - streaming buffer/state machine、incremental extraction
- `hub_bridge_actions/history.rs`
  - bridge history 结构决策，不负责重复 canonicalization 细节

## Migration Order

### Step 1: 收 `shared_tool_mapping.rs`

目标：

- 先统一 tool canonicalization 真源。

原因：

- 风险最低；
- 调用面清晰；
- 能先消掉 `web_search` / `exec_command` alias 分叉。

输出：

- 单点 `normalize_*tool*` helper；
- 原调用点改为引用 shared helper；
- 红测覆盖 legacy alias。


## Progress Notes

- 2026-05-24：已物理删除未接线 servertool skeleton stub 与多处双证据真死 helper。
- 2026-05-24：`shared_json_utils.rs` 已成为 balanced JSON scanner 真源，`tool_call_entry.rs` 本地扫描副本已收口。
- 2026-05-24：`shared_responses_conversation_utils.rs` 已删除本地 `read_string_array_command`、`read_trimmed_string`、`clone_object` 副本，改用 `shared_json_utils.rs` 真源。
- 2026-05-24：`resp_process_stage1_tool_governance_blocks/exec_command_args.rs` 已删除 `read_workdir_from_args` 透传包装，调用点改为直连 `shared_json_utils.rs` 真源。

### Step 2: 收 `shared_tooling.rs`

目标：

- 抽走重复 XML / CDATA / RCC fence / text value / image-path helper。

原因：

- 当前重复最多；
- 纯 helper 特征最强；
- 最符合 “shared functions” 收口目标。

输出：

- 两个大模块明显减重；
- helper 不再物理复制。

### Step 3: 收 `shared_json_utils.rs`

目标：

- 统一 balanced JSON scan helper。

原因：

- JSON 扫描逻辑本质是基础工具，不应藏在具体 harvest 模块中。

输出：

- `hub_reasoning_tool_normalizer.rs`
- `hub_text_markup_normalizer.rs`
- `tool_harvester.rs`

都改为吃 shared helper。

### Step 4: 评估 `shared_args_mapping.rs`

## 2026-05-24 进度记录

- 已先按用户要求处理“死代码优先”。
- 已物理删除 `servertool_skeleton` 内未接线 Patch1 stub：
  - `request_prepare.rs`
  - `internal_dispatch.rs`
  - `response_detect.rs`
  - `outcome_resolve.rs`
  - `registry.rs`
- 已同步删除 `servertool_skeleton_config.rs` 中仅描述上述 stub 的残影配置：
  - `skeleton.requestPrepare`
  - `skeleton.internalDispatch`
- 已删除当前 shared 收口范围内、经编译器与全仓 grep 共同证实未使用的私有死函数：
  - `shared_args_mapping.rs::normalize_tool_name`
  - `shared_args_mapping.rs::extract_tool_function_name`
  - `shared_responses_tool_utils.rs::normalize_responses_call_id`
  - `shared_tooling.rs::read_string_value`
  - `shared_tool_mapping.rs::rewrite_builtin_tool_description`
- 已完成一处“完全同形重复”收口：
  - `resp_process_stage1_tool_governance_blocks/tool_call_entry.rs::{extract_balanced_json_object_at, extract_balanced_json_array_at}`
  - 现改为委托 `shared_json_utils.rs`

## 当前明确不并的候选

- `tool_harvester.rs::normalize_tool_name`
  - 不可直接并到 `shared_tool_mapping`
  - 原因：其 `execute -> shell`，而 shared canonical 是 `execute -> exec_command`，合同不同

目标：

- 只在语义完全等价时，继续收参数 hint / command split helper。

原因：

- 这一步耦合度更高，必须晚于前三步。

输出：

- 能收则收；
- 不能收则明确保留理由，不做半拉子迁移。

## Verification

### 定向红测

- tool canonicalization：
  - `websearch/web-search -> web_search`
  - `execute/shell/bash -> exec_command`
- 文本 helper：
  - CDATA unwrap
  - XML entity decode
  - RCC fence extract
  - balanced JSON scan

### 回归

- `hub_reasoning_tool_normalizer` 现有定向测试
- `hub_text_markup_normalizer` 现有定向测试
- `tool_harvester` / `streaming_tool_extractor` 定向测试
- 命中的 `req_process` / `resp_process` 回归

### 编译

- `cargo test -p router-hotpath-napi <targeted tests>`
- 至少一次 crate 级最小编译通过

### 验收信号

- shared helper 单点存在；
- 原重复实现被物理删除；
- 调用点全部指向 shared 真源；
- 定向红测与回归通过。

## Definition of Done

- 主重复 helper 已从语义模块中迁出。
- `shared_tool_mapping.rs` 成为 tool canonicalization 单一真源。
- `shared_tooling.rs` / `shared_json_utils.rs` 成为文本与 JSON 基础 helper 真源。
- `hub_pipeline.rs` 保持薄编排，不回流 helper 细节。
- 所有变更有红测、定向回归和最小编译证据支撑。
- 2026-05-24：继续只收完全同形 helper；`shared_responses_response_utils.rs`、`hub_req_outbound_context_merge.rs`、`hub_req_inbound_tool_output_snapshot.rs`、`virtual_router_stop_message_state_codec.rs` 的本地 `read_trimmed_string` 副本已删除，统一指向 `shared_json_utils.rs` 真源。
- 2026-05-24：已补 deletion gate `shared_read_trimmed_string_deletion_gate_removed_local_clones_from_selected_modules`，锁住上述 4 处不再回长本地同形 helper。
- 2026-05-25：第二批继续只收完全同形 helper；`virtual_router_engine/routing/metadata.rs`、`hub_pipeline_target_utils.rs`、`chat_governance_context.rs` 的本地 `read_trimmed_string` 副本已删除，统一指向 `shared_json_utils.rs`。
- 2026-05-25：`req_process_stage2_route_select.rs` 的本地 `(map, key) -> Option<String>` 版 `read_trimmed_string` 已删除，调用点统一改用 `shared_json_utils::read_object_trimmed_string`。
- 2026-05-25：已补第二条 deletion gate `shared_read_object_trimmed_string_deletion_gate_removed_local_map_key_clone`，锁住 route_select 不再回长本地 map-key 副本。

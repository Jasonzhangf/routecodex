# V3 Anthropic Protocol Matrix Projection Completion Plan

## 1. 目标与验收标准

完成 V3 Anthropic 协议投影矩阵的语义闭合，重点修复 Anthropic provider response
终止状态过度归一、Responses tool output 错误语义未投影到 `tool_result.is_error`，并把
Anthropic response content block 全枚举登记为精确映射、已登记兼容映射或显式
unsupported。所有变化必须发生在既有 Rust Hub codec 唯一 owner 内，不得在 handler、
SSE、provider transport、Virtual Router、MetadataCenter 或请求清理层补偿。

验收标准：

- Anthropic 每个已支持 `stop_reason` 都有唯一、可逆或显式有损声明的 Responses、
  OpenAI Chat、Anthropic client 投影，不再把所有非 `tool_use` 原因统一写成
  `status=completed`。
- `max_tokens`、`stop_sequence`、`pause_turn`、`refusal`、`end_turn`、`tool_use` 和未知值
  均有正向与反向测试；未知值不得静默成功。
- tool output 的错误状态只从已登记的 Chat tool-result semantic 投影到 Anthropic
  `tool_result.is_error`，禁止从文本、HTTP 状态、MetadataCenter 或错误消息猜测。
- Anthropic response content block 的活跃协议枚举逐项登记处理策略；未支持项 fail-fast，
  不得静默删除或文本化。
- Direct same-protocol Anthropic passthrough 不进入 Relay 投影；Relay 仍只走固定 Hub 节点链。
- 现有 Anthropic characterization、JSON/SSE runtime integration、其他协议矩阵回归全部通过。

## 2. 范围与边界

### In Scope

- Anthropic provider JSON response -> Hub response semantic -> Responses/OpenAI Chat/Anthropic
  client terminal projection。
- Anthropic SSE `message_delta.stop_reason`、`message_stop` 与最终 JSON truth 的一致性。
- Responses/Chat tool-result semantic -> Anthropic `tool_result.is_error`。
- Anthropic response content block 的全枚举审计与机器可验证矩阵。
- 对应 resource/function/mainline/verification map、测试设计和架构 gate 的同步。

### Out of Scope

- V4。
- provider health、retry、cooldown、routing pool 或 key selection。
- Responses continuation owner、session scope、MetadataCenter 控制语义。
- 通过 prompt、文本占位、silent strip 或 provider special-case 掩盖不支持字段。
- 修改 Direct same-protocol passthrough 语义。
- 为尚无目标协议精确字段的内容制造伪映射。

## 3. 设计原则

1. 先更新闭合矩阵，再实现；不得凭字段名猜映射。
2. 协议数据只走相邻 typed payload 节点，控制状态只走 typed side-channel/Error 链。
3. Anthropic codec 是协议投影唯一 owner；SSE 层只传输已投影 frame，不决定终止语义。
4. target 无精确字段时使用显式 `unsupported/fail-fast`，禁止 silent loss、文本降级和 fallback。
5. 终止状态必须由统一 terminal semantic 表达，JSON 与 SSE 共用同一映射函数。
6. tool error 必须来自 typed tool-result status/error semantic；普通文本内容不能触发 `is_error`。
7. 每项修复必须有正反成对回归，并证明不会把正常完成误投成错误，也不会把异常终止投成成功。

## 4. 技术方案与文件清单

### 4.1 先闭合协议矩阵

更新：

- `docs/design/v3-protocol-request-field-projection.md`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`

要求：

- 为 Anthropic `stop_reason` 枚举建立源值、Hub terminal semantic、各 client target 字段、
  terminality 和 unknown policy 的逐项表。
- 明确 `stop_sequence` 的独立身份，不能只塞进通用 `finish_reason`。
- 为 tool-result error 建立 source status/error -> Hub semantic -> Anthropic `is_error` 的唯一映射。
- 为 Anthropic response content block 建立完整枚举表，逐项标记
  `mapped_exact`、`mapped_compatible_registered`、`source_roundtrip_only` 或
  `unsupported_fail_fast`。

### 4.2 统一 terminal 投影 owner

主要实现 owner：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/response_projection.rs`
- 必要时在同一 Hub response semantic 模块内增加唯一 typed terminal helper；不得放入
  `anthropic_relay_runtime.rs`、server frame builder 或 SSE transport。

把当前“`tool_use` 之外全部 `completed`”的局部判断替换为矩阵驱动的唯一 terminal 映射。
JSON 和 SSE materialized final truth 必须调用同一 owner。需要覆盖：

- `end_turn`
- `tool_use`
- `max_tokens`
- `stop_sequence` + exact `stop_sequence` value
- `pause_turn`
- `refusal`
- `model_context_window_exceeded`
- `null`/缺失（仅在协议允许的非终止阶段）
- unknown value（fail-fast）

不要预设目标枚举；以当前固定 SDK/协议文档和项目矩阵为准。无法精确表达的目标字段必须
显式 unsupported 或进入已登记的 Error 链，不能伪造 `completed`。

### 4.3 tool-result error 投影

主要实现 owner：

- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/responses_to_anthropic.rs`
- 如 Chat tool-result typed semantic 缺少错误状态，先在其 owning Hub node 中补字段和相邻
  builder，禁止读取 raw Responses payload 越级重建。
- Responses inbound bridge 以已登记的数据面字段
  `routecodex_chat_extension.responses_tool_output_status` 保留通过校验的 completed/incomplete；
  Anthropic outbound codec 消费该字段并与直接 Responses semantic 共用唯一 status projector。
  carrier 不得进入 provider wire，也不得进入 MetadataCenter。

规则：

- 成功 tool result 不输出 `is_error` 或按协议精确输出 `false`。
- 已登记失败状态精确输出 `is_error=true`。
- 未知、冲突或多真源状态 fail-fast。
- 不得根据 `output` 文本、tool 名、HTTP 状态或 provider id 推断错误。
- 保持 `tool_use_id`、内容顺序、图片/文件 content blocks 和原始输出语义不变。

### 4.4 response content block 枚举闭合

审计并登记当前 Anthropic SDK/协议中的 response content block：

- `text`
- `thinking`
- `redacted_thinking`
- `tool_use`
- `server_tool_use`
- `web_search_tool_result`
- `web_fetch_tool_result`
- `code_execution_tool_result`
- `bash_code_execution_tool_result`
- `text_editor_code_execution_tool_result`
- `tool_search_tool_result`
- `container_upload`

现有支持路径保持；新增支持只能在目标协议有精确或正式登记兼容语义时实现。其他项返回带
canonical path/content type 的显式错误，禁止统一模糊成 `provider response content type` 后
丢失具体证据。

### 4.5 SSE 一致性

相关验证 owner：

- `v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs`
- Anthropic SSE codec/relay 的现有相邻节点文件。

验证 `message_delta.stop_reason`、usage delta、`message_stop` 的顺序和最终 terminal semantic。
SSE 层不得自己映射、补写或覆盖 terminal truth；缺 terminal、重复 terminal、delta 与 final
冲突必须显式失败。

## 5. 风险与规避

- **把 Anthropic 特例放入通用 handler/SSE**：用 owner/gate 阻止，只允许 codec 与 typed
  terminal semantic 变化。
- **错误改变 Direct passthrough**：增加 direct same-protocol 反向测试，证明 Relay 修复不进入
  Direct。
- **把 `max_tokens` 等错误投成 HTTP/provider failure**：terminal response 与 Error 链分离；
  正常上游终止原因仍是业务响应语义。
- **从 Responses raw payload 越级读取 tool error**：先补 Hub typed semantic，再做相邻投影。
- **未知 content block 被吞掉**：逐类型 fail-fast，并保留类型与 canonical path 诊断。
- **SSE/JSON 两套映射漂移**：共用一个 terminal mapping owner，测试两种 transport 等价。

## 6. 测试计划

### 白盒

- 每个 Anthropic stop reason 的正向映射。
- unknown、缺失、冲突 stop reason 的反向测试。
- 成功/失败/未知 tool-result status 到 `is_error` 的正反测试。
- 每个 content block 类型的 mapped/unsupported 测试。

### 模块黑盒

- `hub_anthropic_codec_characterization` 全量。
- `anthropic_relay_runtime_integration` JSON/SSE 全量。
- Responses -> Anthropic request field parity matrix。
- Anthropic -> Responses response field parity matrix。
- Direct same-protocol passthrough 不进入 Relay codec。

### 项目黑盒

- V3 workspace 定向 build/check。
- resource/function/mainline/verification map gates。
- `npm run install:v3`。
- 只用 `routecodex restart --config /Volumes/extension/.rcc/config.v3.toml` 聚合重启。
- 4444/7777/10000 `/health` 运行版本一致。
- Anthropic JSON 与 SSE 真实旧样本/受控样本在线重放，至少覆盖正常完成、token 截断、
  stop sequence、tool error 和 unsupported content type。

### Review

- 安装、重启、在线验证完成后再做 DSH Review。
- Review 后若改代码，重新执行受影响验证、安装、重启、在线样本和 Review。

## 7. 实施步骤

1. 读取项目 memory、resource map、function map、mainline call map、verification map 和本计划。
2. 固化当前错误行为为红测：terminal 过度 completed、tool error 丢失、unknown content type
   诊断不足。
3. 更新协议矩阵和 owner/gate 登记，确认方案不越界。
4. 在唯一 terminal semantic owner 实现 JSON/SSE 共用映射。
5. 在 typed tool-result semantic 邻接边实现 `is_error` 投影。
6. 闭合 content block 类型表和显式 unsupported 错误。
7. 执行模块边界自检、定向测试、矩阵 gate 和 build。
8. 安装 V3、聚合重启、验证所有 listener、在线重放。
9. 执行 DSH Review；修复后重新闭环。
10. 定向提交并推送；不清理、不提交用户或其他 worker 的无关脏改动，V4 不动。

## 8. 完成定义（DoD）

- 三个已确认重大分歧都有实现、正反回归和矩阵登记。
- JSON/SSE terminal 投影共用唯一 owner，无重复判断。
- tool-result error 不再丢失，也不产生文本猜测。
- Anthropic response content type 枚举闭合，unsupported 明确可诊断。
- 架构 gate、定向测试、build、安装、聚合重启和在线样本全部通过。
- DSH Review 给出 PASS；相关提交已推送到 main。
- V4、无关工作树和用户脏改动未被触碰。
